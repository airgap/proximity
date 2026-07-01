import {
  RemoteAudioTrack,
  RemoteVideoTrack,
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrack,
} from "livekit-client";
import type { ProximityMessage, ProximityPeer } from "@proximity/protocol";

interface PeerMedia {
  identity: string;
  gain: number;
  wantVideo: boolean;
  audioTrack?: RemoteAudioTrack;
  audioEl?: HTMLAudioElement;
  videoTrack?: RemoteVideoTrack;
  videoEl?: HTMLVideoElement;
  screenTrack?: RemoteVideoTrack;
  screenEl?: HTMLVideoElement;
}

/**
 * Client-side media control for proximity.
 *
 * Connects to the space's LiveKit room with autoSubscribe OFF, publishes the mic, and then
 * subscribes/unsubscribes to peers' audio+video and sets per-peer volume STRICTLY in response to
 * the world server's `proximity` diffs. LiveKit stays a dumb SFU; all "who do I hear/see" logic
 * lives server-side and arrives as add/update/remove.
 *
 * Identity contract: LiveKit participant.identity == world userId, so `ProximityPeer.id` maps
 * directly to a RemoteParticipant.
 */
export class ProximityMedia {
  private room: Room | null = null;
  private readonly peers = new Map<string, PeerMedia>();

  micEnabled = true;
  camEnabled = false;
  screenEnabled = false;

  /** Called when a peer's camera video element appears/disappears (null = removed). */
  onVideo?: (peerId: string, el: HTMLVideoElement | null) => void;
  /** Called when a peer's screenshare video element appears/disappears (null = removed). */
  onScreenShare?: (peerId: string, el: HTMLVideoElement | null) => void;
  /** Called when the local camera preview element appears/disappears. */
  onLocalVideo?: (el: HTMLVideoElement | null) => void;
  onError?: (err: unknown) => void;

  async connect(url: string, token: string): Promise<void> {
    const room = new Room({ adaptiveStream: true, dynacast: true });
    this.room = room;

    room
      .on(RoomEvent.TrackSubscribed, (t, pub, p) => this.onTrackSubscribed(t, pub, p))
      .on(RoomEvent.TrackUnsubscribed, (t, pub, p) => this.onTrackUnsubscribed(t, pub, p))
      .on(RoomEvent.ParticipantConnected, (p) => this.reconcileParticipant(p))
      .on(RoomEvent.TrackPublished, (_pub, p) => this.reconcileParticipant(p))
      .on(RoomEvent.LocalTrackPublished, (pub) => {
        if (pub.source === Track.Source.Camera && pub.track) {
          this.onLocalVideo?.(pub.track.attach() as HTMLVideoElement);
        }
      })
      .on(RoomEvent.LocalTrackUnpublished, (pub) => {
        if (pub.source === Track.Source.Camera) this.onLocalVideo?.(null);
      });

    try {
      await room.connect(url, token, { autoSubscribe: false });
      await room.localParticipant.setMicrophoneEnabled(this.micEnabled);
      // Best-effort: resume audio playback if the browser suspended it (the join click is the
      // originating gesture). If it's still blocked, callers can invoke resumeAudio() from a click.
      if (!room.canPlaybackAudio) await room.startAudio().catch(() => {});
    } catch (err) {
      this.onError?.(err);
      throw err;
    }
  }

  /** Resume audio playback from a user gesture if the browser blocked autoplay. */
  async resumeAudio(): Promise<void> {
    await this.room?.startAudio().catch(() => {});
  }

  /** Apply a proximity diff from the world server. */
  applyProximity(msg: ProximityMessage): void {
    if (!this.room) return;
    for (const p of msg.add) {
      this.peers.set(p.id, { identity: p.id, gain: p.audioGain, wantVideo: p.video });
      this.reconcileById(p.id);
    }
    for (const p of msg.update) this.updatePeer(p);
    for (const id of msg.remove) this.dropPeer(id);
  }

  async setMic(on: boolean): Promise<void> {
    this.micEnabled = on;
    await this.room?.localParticipant.setMicrophoneEnabled(on);
  }

  async setCam(on: boolean): Promise<void> {
    this.camEnabled = on;
    await this.room?.localParticipant.setCameraEnabled(on);
  }

  /**
   * Force-subscribe a presenter's screenshare regardless of proximity (presentation mode).
   * Pass null to release; the peer then reverts to normal proximity gating (or drops when it
   * next leaves range).
   */
  setPresenter(id: string | null): void {
    if (!id) return;
    if (!this.peers.has(id)) this.peers.set(id, { identity: id, gain: 0, wantVideo: false });
    this.reconcileById(id);
  }

  async setScreen(on: boolean): Promise<void> {
    try {
      await this.room?.localParticipant.setScreenShareEnabled(on);
      this.screenEnabled = on;
    } catch (err) {
      // User cancelled the picker, or capture failed.
      this.screenEnabled = false;
      this.onError?.(err);
    }
  }

  async disconnect(): Promise<void> {
    await this.room?.disconnect();
    this.room = null;
    this.peers.clear();
  }

  // -------------------------------------------------------------------------

  private updatePeer(p: ProximityPeer): void {
    const peer = this.peers.get(p.id);
    if (!peer) {
      // Treat a stray update as an add.
      this.peers.set(p.id, { identity: p.id, gain: p.audioGain, wantVideo: p.video });
      this.reconcileById(p.id);
      return;
    }
    peer.gain = p.audioGain;
    peer.audioTrack?.setVolume(p.audioGain);
    if (peer.wantVideo !== p.video) {
      peer.wantVideo = p.video;
      this.reconcileById(p.id); // (un)subscribe the camera track
    }
  }

  private dropPeer(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    const rp = this.room?.remoteParticipants.get(id);
    if (rp) {
      for (const pub of rp.trackPublications.values()) pub.setSubscribed(false);
    }
    peer.audioEl?.remove();
    if (peer.videoEl) this.onVideo?.(id, null);
    if (peer.screenEl) this.onScreenShare?.(id, null);
    this.peers.delete(id);
  }

  /** Ensure the given participant's subscriptions match our desired peer state. */
  private reconcileParticipant(rp: RemoteParticipant): void {
    if (this.peers.has(rp.identity)) this.reconcileById(rp.identity);
  }

  private reconcileById(id: string): void {
    const peer = this.peers.get(id);
    const rp = this.room?.remoteParticipants.get(id);
    if (!peer || !rp) return; // participant may connect later; ParticipantConnected re-runs this
    for (const pub of rp.trackPublications.values()) {
      if (pub.source === Track.Source.Microphone) pub.setSubscribed(true);
      else if (pub.source === Track.Source.Camera) pub.setSubscribed(peer.wantVideo);
      else if (pub.source === Track.Source.ScreenShare) pub.setSubscribed(true); // always show shares
    }
  }

  private onTrackSubscribed(
    track: RemoteTrack,
    pub: { source: Track.Source },
    participant: RemoteParticipant,
  ): void {
    const peer = this.peers.get(participant.identity);
    if (!peer) return;
    if (track instanceof RemoteAudioTrack) {
      if (pub.source !== Track.Source.Microphone) return; // ignore screenshare audio for now
      peer.audioTrack = track;
      const el = track.attach() as HTMLAudioElement;
      el.style.display = "none";
      document.body.appendChild(el);
      peer.audioEl = el;
      track.setVolume(peer.gain); // distance-based volume
    } else if (track instanceof RemoteVideoTrack) {
      const el = track.attach() as HTMLVideoElement;
      if (pub.source === Track.Source.ScreenShare) {
        peer.screenTrack = track;
        peer.screenEl = el;
        this.onScreenShare?.(participant.identity, el);
      } else {
        peer.videoTrack = track;
        peer.videoEl = el;
        this.onVideo?.(participant.identity, el);
      }
    }
  }

  private onTrackUnsubscribed(
    track: RemoteTrack,
    pub: { source: Track.Source },
    participant: RemoteParticipant,
  ): void {
    const peer = this.peers.get(participant.identity);
    if (!peer) return;
    track.detach();
    if (track instanceof RemoteAudioTrack) {
      peer.audioEl?.remove();
      peer.audioEl = undefined;
      peer.audioTrack = undefined;
    } else if (pub.source === Track.Source.ScreenShare) {
      peer.screenEl = undefined;
      peer.screenTrack = undefined;
      this.onScreenShare?.(participant.identity, null);
    } else {
      peer.videoEl = undefined;
      peer.videoTrack = undefined;
      this.onVideo?.(participant.identity, null);
    }
  }
}
