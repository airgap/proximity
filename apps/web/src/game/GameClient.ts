import { Application, Container, Graphics, Text } from "pixi.js";
import { Facing, isBlocked, unpackCollision } from "@proximity/protocol";
import { Connection, type PresentationState, type Remote } from "../net/connection.ts";
import { Input } from "./input.ts";
import { ProximityMedia } from "../media/ProximityMedia.ts";
import { AnnotationOverlay } from "../media/AnnotationOverlay.ts";

export interface PresentationUiState {
  active: boolean;
  isPresenter: boolean;
  presenterName?: string;
  recording?: boolean;
}

/** Render remotes this many ms in the past so we always interpolate between two known samples. */
const INTERP_DELAY = 100;
/** Cap outbound move messages to this rate (ms between sends). */
const MOVE_SEND_INTERVAL = 100;
/** Avatar collision half-extent in tiles (keeps the body out of walls). */
const BODY_RADIUS = 0.35;

interface AvatarView {
  container: Container;
  label: Text;
}

export interface MediaState {
  connected: boolean;
  mic: boolean;
  cam: boolean;
  screen: boolean;
}

export class GameClient {
  readonly app = new Application();
  private readonly world = new Container();
  private readonly conn: Connection;
  private readonly input = new Input();

  private readonly self = { x: 0, y: 0, facing: Facing.Down as number, moving: false };
  private collision = new Uint8Array(0);
  private tileSize = 32;
  private mapW = 0;
  private mapH = 0;

  private readonly avatars = new Map<number, AvatarView>();
  private selfView: AvatarView | null = null;

  private lastSendAt = 0;
  private lastSent = { x: 0, y: 0, facing: 0, moving: false };

  // Media
  private media: ProximityMedia | null = null;
  private parent: HTMLElement | null = null;
  private overlay: HTMLDivElement | null = null;
  private screenPanel: HTMLDivElement | null = null;
  private readonly videoEls = new Map<string, HTMLVideoElement>();
  private readonly screenEls = new Map<string, HTMLVideoElement>();
  private localVideoEl: HTMLVideoElement | null = null;
  private readonly screenPos = new Map<string, { x: number; y: number }>();

  // Presentation
  private presenterId: string | null = null;
  private annotation: AnnotationOverlay | null = null;
  private stageEl: HTMLDivElement | null = null;
  private stageVideoHolder: HTMLDivElement | null = null;

  onChat?: (name: string, body: string) => void;
  onChatHistory?: (messages: { name: string; body: string }[]) => void;
  onStatus?: (s: string) => void;
  onMedia?: (s: MediaState) => void;
  onPresentation?: (s: PresentationUiState) => void;
  readonly displayName: string;

  constructor(url: string, name: string, avatarId: number, spaceId = "default", token?: string) {
    this.displayName = name;
    this.conn = new Connection(url, name, avatarId, spaceId, token);
    this.conn.onWelcome = () => this.onWelcome();
    this.conn.onCorrection = (x, y, f) => {
      this.self.x = x;
      this.self.y = y;
      this.self.facing = f;
    };
    this.conn.onChat = (n, b) => this.onChat?.(n, b);
    this.conn.onChatHistory = (msgs) => this.onChatHistory?.(msgs);
    this.conn.onStatus = (s) => this.onStatus?.(s);
    this.conn.onPresentation = (state) => this.onPresentationState(state);
    this.conn.onStroke = (d) => this.annotation?.applyDelta(d.strokeId, d.color, d.width, d.points);
    this.conn.onStrokeSnapshot = (list) => this.annotation?.applySnapshot(list);
    this.conn.onStrokeClear = () => this.annotation?.clear();
  }

  // --- Presentation controls (called from the UI) ---
  startPresentation(record: boolean): void {
    this.conn.sendPresentation("start", record);
  }
  stopPresentation(): void {
    this.conn.sendPresentation("stop");
  }
  clearAnnotations(): void {
    this.conn.sendStrokeClear();
    this.annotation?.clear();
  }
  setAnnotationColor(color: string): void {
    if (this.annotation) this.annotation.color = color;
  }

  async mount(parent: HTMLElement): Promise<void> {
    this.parent = parent;
    await this.app.init({ background: "#12121e", resizeTo: parent, antialias: true });
    parent.appendChild(this.app.canvas);

    // HTML overlay layer for video bubbles, above the WebGL canvas.
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:2;";
    parent.appendChild(overlay);
    this.overlay = overlay;

    // Fixed panel (top-center) for nearby screenshares.
    const screenPanel = document.createElement("div");
    screenPanel.style.cssText =
      "position:absolute;top:52px;left:50%;transform:translateX(-50%);display:flex;gap:8px;" +
      "z-index:3;pointer-events:none;max-width:96vw;flex-wrap:wrap;justify-content:center;";
    parent.appendChild(screenPanel);
    this.screenPanel = screenPanel;

    this.app.stage.addChild(this.world);
    this.app.ticker.add((ticker) => this.update(ticker.deltaMS));
  }

  sendChat(body: string): void {
    this.conn.sendChat(body);
  }

  async toggleMic(): Promise<MediaState> {
    if (this.media) await this.media.setMic(!this.media.micEnabled);
    return this.mediaState();
  }

  async toggleCam(): Promise<MediaState> {
    if (this.media) await this.media.setCam(!this.media.camEnabled);
    return this.mediaState();
  }

  async toggleScreen(): Promise<MediaState> {
    if (this.media) await this.media.setScreen(!this.media.screenEnabled);
    return this.mediaState();
  }

  private mediaState(): MediaState {
    return {
      connected: !!this.media,
      mic: this.media?.micEnabled ?? false,
      cam: this.media?.camEnabled ?? false,
      screen: this.media?.screenEnabled ?? false,
    };
  }

  destroy(): void {
    void this.media?.disconnect();
    this.conn.close();
    this.teardownStage();
    this.overlay?.remove();
    this.screenPanel?.remove();
    this.app.destroy(true, { children: true });
  }

  // -------------------------------------------------------------------------

  private onWelcome(): void {
    const map = this.conn.map!;
    this.tileSize = map.tileSize;
    this.mapW = map.width;
    this.mapH = map.height;
    this.collision = unpackCollision(map.collisionB64, map.width * map.height);
    this.self.x = this.conn.spawn.x;
    this.self.y = this.conn.spawn.y;
    this.self.facing = this.conn.spawn.facing;

    this.drawMap();
    this.selfView = this.makeAvatar(this.displayName, colorFor(this.conn.selfId), true);
    this.world.addChild(this.selfView.container);

    if (this.conn.livekit) this.connectMedia(this.conn.livekit);
  }

  private connectMedia(lk: { url: string; token: string }): void {
    const media = new ProximityMedia();
    this.media = media;
    media.onVideo = (peerId, el) => {
      const existing = this.videoEls.get(peerId);
      if (existing && existing !== el) existing.remove();
      if (el) {
        styleBubble(el);
        this.overlay?.appendChild(el);
        this.videoEls.set(peerId, el);
      } else if (existing) {
        existing.remove();
        this.videoEls.delete(peerId);
      }
    };
    media.onLocalVideo = (el) => {
      this.localVideoEl?.remove();
      this.localVideoEl = el;
      if (el) {
        styleBubble(el, true);
        this.overlay?.appendChild(el);
      }
    };
    media.onScreenShare = (peerId, el) => {
      const existing = this.screenEls.get(peerId);
      if (existing) {
        existing.remove();
        this.screenEls.delete(peerId);
      }
      if (!el) return;
      if (peerId === this.presenterId && this.stageVideoHolder) {
        this.placeStageVideo(el); // route the presenter's share to the big stage
      } else {
        styleScreenShare(el);
        this.screenPanel?.appendChild(el);
        this.screenEls.set(peerId, el);
      }
    };
    media.onError = (err) => console.error("[proximity] media error:", err);
    this.conn.onProximity = (msg) => media.applyProximity(msg);
    void media.connect(lk.url, lk.token).then(() => this.onMedia?.(this.mediaState()));
  }

  private onPresentationState(state: PresentationState): void {
    if (state.active && state.presenterId) {
      this.presenterId = state.presenterId;
      const isPresenter = state.presenterId === this.conn.selfId;
      this.buildStage();
      this.media?.setPresenter(state.presenterId);
      this.annotation?.setEditable(isPresenter);
      if (isPresenter) {
        void this.media?.setScreen(true).then(() => this.onMedia?.(this.mediaState()));
      }
      // If the presenter's share was already showing in the proximity panel, move it to the stage.
      const existing = this.screenEls.get(state.presenterId);
      if (existing) {
        this.screenEls.delete(state.presenterId);
        this.placeStageVideo(existing);
      }
      this.onPresentation?.({
        active: true,
        isPresenter,
        presenterName: state.presenterName,
        recording: state.recording,
      });
    } else {
      const wasPresenter = this.presenterId === this.conn.selfId;
      this.presenterId = null;
      this.media?.setPresenter(null);
      if (wasPresenter && this.media?.screenEnabled) {
        void this.media.setScreen(false).then(() => this.onMedia?.(this.mediaState()));
      }
      this.teardownStage();
      this.onPresentation?.({ active: false, isPresenter: false });
    }
  }

  private buildStage(): void {
    if (this.stageEl || !this.parent) return;
    const stage = document.createElement("div");
    stage.style.cssText =
      "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;" +
      "z-index:4;pointer-events:none;padding:64px 16px;";
    const holder = document.createElement("div");
    holder.style.cssText =
      "position:relative;width:min(72vw,1100px);aspect-ratio:16/9;background:#000;" +
      "border-radius:12px;overflow:hidden;border:2px solid #eab308;pointer-events:auto;" +
      "box-shadow:0 12px 50px rgba(0,0,0,0.7);";
    const ann = new AnnotationOverlay();
    ann.onStroke = (id, color, width, points, done) =>
      this.conn.sendStroke(id, color, width, points, done);
    holder.appendChild(ann.canvas);
    stage.appendChild(holder);
    this.parent.appendChild(stage);
    this.stageEl = stage;
    this.stageVideoHolder = holder;
    this.annotation = ann;
    window.addEventListener("resize", this.onStageResize);
    requestAnimationFrame(() => ann.resize());
  }

  private placeStageVideo(el: HTMLVideoElement): void {
    if (!this.stageVideoHolder) {
      styleScreenShare(el);
      this.screenPanel?.appendChild(el);
      this.screenEls.set(el.id || "presenter", el);
      return;
    }
    el.autoplay = true;
    el.playsInline = true;
    el.muted = true;
    el.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;";
    // Insert before the annotation canvas so the canvas stays on top.
    this.stageVideoHolder.insertBefore(el, this.stageVideoHolder.firstChild);
    el.addEventListener("loadedmetadata", () => this.annotation?.resize());
    requestAnimationFrame(() => this.annotation?.resize());
  }

  private onStageResize = (): void => this.annotation?.resize();

  private teardownStage(): void {
    window.removeEventListener("resize", this.onStageResize);
    this.annotation?.destroy();
    this.annotation = null;
    this.stageEl?.remove();
    this.stageEl = null;
    this.stageVideoHolder = null;
  }

  private drawMap(): void {
    const ts = this.tileSize;
    const g = new Graphics();
    g.rect(0, 0, this.mapW * ts, this.mapH * ts).fill(0x1b1b2b);
    for (let y = 0; y < this.mapH; y++) {
      for (let x = 0; x < this.mapW; x++) {
        if (this.collision[y * this.mapW + x]) {
          g.rect(x * ts, y * ts, ts, ts).fill(0x3a3a5c);
        }
      }
    }
    g.setStrokeStyle({ width: 1, color: 0xffffff, alpha: 0.04 });
    for (let x = 0; x <= this.mapW; x++) g.moveTo(x * ts, 0).lineTo(x * ts, this.mapH * ts);
    for (let y = 0; y <= this.mapH; y++) g.moveTo(0, y * ts).lineTo(this.mapW * ts, y * ts);
    g.stroke();
    this.world.addChildAt(g, 0);
  }

  private makeAvatar(name: string, color: number, isSelf: boolean): AvatarView {
    const container = new Container();
    const r = this.tileSize * 0.4;
    const g = new Graphics();
    g.circle(0, 0, r).fill(color);
    g.circle(0, 0, r).stroke({ width: 2, color: isSelf ? 0xffffff : 0x000000, alpha: 0.6 });
    const label = new Text({
      text: name,
      style: { fill: 0xffffff, fontSize: 12, fontFamily: "ui-sans-serif, system-ui, sans-serif" },
    });
    label.anchor.set(0.5, 1);
    label.y = -r - 3;
    container.addChild(g);
    container.addChild(label);
    return { container, label };
  }

  private update(dtMs: number): void {
    const cfg = this.conn.config;
    if (!cfg || !this.selfView) return;
    const ts = this.tileSize;

    // --- Self: input-driven prediction with per-axis local collision (wall sliding) ---
    const { dx, dy } = this.input.axis();
    let facing = this.self.facing;
    const moving = dx !== 0 || dy !== 0;
    if (moving) {
      const len = Math.hypot(dx, dy) || 1;
      const dist = cfg.maxSpeed * (dtMs / 1000);
      const nx = this.self.x + (dx / len) * dist;
      const ny = this.self.y + (dy / len) * dist;
      if (!this.blocked(nx, this.self.y)) this.self.x = nx;
      if (!this.blocked(this.self.x, ny)) this.self.y = ny;
      facing =
        Math.abs(dx) > Math.abs(dy)
          ? dx < 0
            ? Facing.Left
            : Facing.Right
          : dy < 0
            ? Facing.Up
            : Facing.Down;
    }
    this.self.facing = facing;
    this.self.moving = moving;

    // --- Send move (rate-capped, only on change) ---
    const now = performance.now();
    if (
      now - this.lastSendAt >= MOVE_SEND_INTERVAL &&
      (this.self.x !== this.lastSent.x ||
        this.self.y !== this.lastSent.y ||
        facing !== this.lastSent.facing ||
        moving !== this.lastSent.moving)
    ) {
      this.conn.sendMove(this.self.x, this.self.y, facing, moving);
      this.lastSent = { x: this.self.x, y: this.self.y, facing, moving };
      this.lastSendAt = now;
    }

    // --- Camera (centered on self) + self sprite ---
    this.world.x = this.app.screen.width / 2 - this.self.x * ts;
    this.world.y = this.app.screen.height / 2 - this.self.y * ts;
    this.selfView.container.x = this.self.x * ts;
    this.selfView.container.y = this.self.y * ts;

    // --- Remotes: spawn/despawn views, interpolate, record screen positions ---
    const renderT = now - INTERP_DELAY;
    this.screenPos.clear();
    for (const [nid, r] of this.conn.remotes) {
      let view = this.avatars.get(nid);
      if (!view) {
        view = this.makeAvatar(r.name, colorFor(r.id), false);
        this.avatars.set(nid, view);
        this.world.addChild(view.container);
      }
      const p = interpolate(r, renderT);
      view.container.x = p.x * ts;
      view.container.y = p.y * ts;
      this.screenPos.set(r.id, { x: p.x * ts + this.world.x, y: p.y * ts + this.world.y });
    }
    for (const [nid, view] of this.avatars) {
      if (!this.conn.remotes.has(nid)) {
        this.world.removeChild(view.container);
        view.container.destroy({ children: true });
        this.avatars.delete(nid);
      }
    }

    // --- Video bubbles follow their avatars ---
    const avatarR = ts * 0.4;
    for (const [peerId, el] of this.videoEls) {
      const pos = this.screenPos.get(peerId);
      if (!pos) {
        el.style.display = "none";
        continue;
      }
      el.style.display = "block";
      el.style.left = `${pos.x}px`;
      el.style.top = `${pos.y - avatarR - 6}px`;
    }
    if (this.localVideoEl) {
      this.localVideoEl.style.left = `${this.app.screen.width / 2}px`;
      this.localVideoEl.style.top = `${this.app.screen.height / 2 - avatarR - 6}px`;
    }
  }

  private blocked(x: number, y: number): boolean {
    return (
      isBlocked(this.collision, this.mapW, this.mapH, Math.floor(x - BODY_RADIUS), Math.floor(y)) ||
      isBlocked(this.collision, this.mapW, this.mapH, Math.floor(x + BODY_RADIUS), Math.floor(y)) ||
      isBlocked(this.collision, this.mapW, this.mapH, Math.floor(x), Math.floor(y - BODY_RADIUS)) ||
      isBlocked(this.collision, this.mapW, this.mapH, Math.floor(x), Math.floor(y + BODY_RADIUS))
    );
  }
}

function styleBubble(el: HTMLVideoElement, isLocal = false): void {
  el.autoplay = true;
  el.playsInline = true;
  el.muted = true; // audio is handled separately via RemoteAudioTrack; avoid double playback
  el.style.cssText = [
    "position:absolute",
    "width:112px",
    "height:84px",
    "object-fit:cover",
    "border-radius:10px",
    `border:2px solid ${isLocal ? "#4ade80" : "#8ab4ff"}`,
    "transform:translate(-50%,-100%)",
    "box-shadow:0 6px 20px rgba(0,0,0,0.5)",
    "background:#000",
    "pointer-events:none",
  ].join(";");
}

function styleScreenShare(el: HTMLVideoElement): void {
  el.autoplay = true;
  el.playsInline = true;
  el.muted = true;
  el.style.cssText = [
    "width:min(46vw,640px)",
    "height:auto",
    "border-radius:10px",
    "border:2px solid #facc15",
    "box-shadow:0 8px 30px rgba(0,0,0,0.6)",
    "background:#000",
    "pointer-events:none",
  ].join(";");
}

function interpolate(r: Remote, t: number): { x: number; y: number } {
  const s = r.samples;
  if (s.length === 0) return { x: r.x, y: r.y };
  if (s.length === 1 || t <= s[0]!.t) return { x: s[0]!.x, y: s[0]!.y };
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i]!;
    const b = s[i + 1]!;
    if (t >= a.t && t <= b.t) {
      const f = (t - a.t) / (b.t - a.t || 1);
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
  }
  const last = s[s.length - 1]!;
  return { x: last.x, y: last.y };
}

function colorFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return hslToHex(h % 360, 65, 55);
}

function hslToHex(h: number, s: number, l: number): number {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}
