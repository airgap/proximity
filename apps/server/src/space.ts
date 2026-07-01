import type { ServerWebSocket } from "bun";
import { AUDIO_INNER_RADIUS, DEFAULT_SPACE_CONFIG, RADIUS_HYSTERESIS } from "@proximity/config";
import {
  EntityFlags,
  Facing,
  encodeJson,
  encodeSnapshot,
  isBlocked,
  unpackCollision,
  type ChatMessage,
  type FullStroke,
  type MapDescriptor,
  type MoveMessage,
  type PresentationControlMessage,
  type ProximityGrant,
  type ProximityMessage,
  type ProximityPeer,
  type ServerMessage,
  type SnapshotEntity,
  type SpaceConfig,
  type StrokeMessage,
} from "@proximity/protocol";
import { falloffGain, Grid } from "@proximity/spatial";
import { generateDefaultMap } from "./map.ts";
import type { MediaProvider } from "./livekit.ts";
import type { ChatStore } from "./db.ts";

/** Data attached to each WebSocket connection. */
export interface WSData {
  client: ClientState | null;
  /** Grant resolved from the HTTP upgrade request (trusted_proxy / bearer), if any. */
  pendingGrant: ProximityGrant | null;
}

export type ProximitySocket = ServerWebSocket<WSData>;

/** Per-connected-user authoritative state. */
export interface ClientState {
  nid: number;
  id: string; // stable user id (== LiveKit identity in phase 2)
  name: string;
  avatarId: number;
  ws: ProximitySocket;
  space: Space;
  observer: boolean;
  /** Capabilities from the access grant (present/record/annotate). */
  caps: Set<string>;

  x: number;
  y: number;
  facing: Facing;
  moving: boolean;

  lastSeq: number;
  lastMoveAt: number; // ms epoch of last accepted move (for speed validation)
  aoi: Set<number>; // nids currently within this client's area of interest
  dirty: boolean; // position changed since last grid sync

  /** Current media-relevant peers keyed by peer userId: their audio gain + whether video is on. */
  prox: Map<string, { gain: number; video: boolean }>;
  proxSeq: number;
}

function send(ws: ProximitySocket, msg: ServerMessage): void {
  ws.send(encodeJson(msg));
}

/**
 * One authoritative space (single-writer). Owns all avatar state, runs the fixed-timestep tick,
 * and fans out AOI-tailored enter/leave events + binary position snapshots to each client.
 */
export class Space {
  readonly id: string;
  readonly config: SpaceConfig = { ...DEFAULT_SPACE_CONFIG };
  readonly map: MapDescriptor;

  private readonly collision: Uint8Array;
  private readonly grid: Grid;
  private readonly clients = new Map<number, ClientState>();
  private nextNid = 1;
  private tick = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Active presentation (space-wide screenshare elevation), or null. */
  private presentation: {
    presenterId: string;
    presenterName: string;
    recording: boolean;
    egressId?: string;
  } | null = null;
  /** Current annotation strokes for the active presentation, keyed by strokeId. */
  private readonly strokes = new Map<string, FullStroke>();

  /** Reused buffers to keep the broadcast hot path allocation-free. */
  private readonly snapshotScratch = new Uint8Array(64 * 1024);
  private readonly neighborScratch: number[] = [];

  constructor(
    id: string,
    private readonly media: MediaProvider | null = null,
    private readonly chat: ChatStore | null = null,
  ) {
    this.id = id;
    this.map = generateDefaultMap();
    this.collision = unpackCollision(this.map.collisionB64, this.map.width * this.map.height);
    // Cell size == audio radius so audible neighbors are always in the 3×3 Moore block.
    this.grid = new Grid(this.map.width, this.map.height, this.config.audioRadius);
  }

  get population(): number {
    return this.clients.size;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.step(), 1000 / this.config.tickRate);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async join(
    ws: ProximitySocket,
    grant: ProximityGrant,
    avatarId: number,
    observer = false,
  ): Promise<ClientState> {
    const nid = this.nextNid++;
    const spawn = this.map.spawn;
    const client: ClientState = {
      nid,
      id: grant.sub, // authoritative identity from the grant (== LiveKit identity)
      name: (grant.name || `Guest ${nid}`).slice(0, 40),
      avatarId: avatarId | 0,
      ws,
      space: this,
      observer,
      caps: new Set(grant.caps),
      x: spawn.x,
      y: spawn.y,
      facing: Facing.Down,
      moving: false,
      lastSeq: 0,
      lastMoveAt: Date.now(),
      aoi: new Set(),
      dirty: false,
      prox: new Map(),
      proxSeq: 0,
    };
    this.clients.set(nid, client);
    // Observers are not placed on the map (no avatar, no AOI, invisible to others).
    if (!observer) this.grid.insert(nid, client.x, client.y);
    ws.data.client = client;

    // Mint a LiveKit token (identity == userId) if media is configured. Observers use the
    // recorder token supplied by egress, so they don't need one.
    let livekit: { url: string; token: string } | undefined;
    if (this.media && !observer) {
      const room = this.media.roomName(this.id);
      try {
        const token = await this.media.mintToken(client.id, client.name, room);
        livekit = { url: this.media.url, token };
      } catch (err) {
        console.error(`[proximity] token mint failed for ${client.id}:`, err);
      }
    }
    // The socket may have closed while we were awaiting the token.
    if (ws.data.client !== client) return client;

    send(ws, {
      t: "welcome",
      selfNid: nid,
      selfId: client.id,
      spaceId: this.id,
      config: this.config,
      map: this.map,
      you: { x: client.x, y: client.y, facing: client.facing },
      livekit,
    });

    // Send recent chat scrollback (if persisted). Observers skip it.
    if (this.chat && !observer) {
      try {
        const history = await this.chat.recent(this.id, 50);
        if (history.length && ws.data.client === client) {
          send(ws, { t: "chatHistory", messages: history });
        }
      } catch (err) {
        console.error(`[proximity] chat history load failed for ${this.id}:`, err);
      }
    }

    // If a presentation is live, bring the newcomer up to date.
    if (this.presentation && ws.data.client === client) {
      send(ws, {
        t: "presentationState",
        active: true,
        presenterId: this.presentation.presenterId,
        presenterName: this.presentation.presenterName,
        recording: this.presentation.recording,
      });
      if (this.strokes.size) {
        send(ws, { t: "strokeSnapshot", strokes: [...this.strokes.values()] });
      }
    }

    // Immediately populate the newcomer's AOI so they see the room without a tick of latency.
    if (ws.data.client === client && !observer) this.syncClient(client);
    return client;
  }

  leave(client: ClientState): void {
    // If the presenter drops, tear the presentation down for everyone.
    if (this.presentation?.presenterId === client.id) void this.endPresentation();
    this.clients.delete(client.nid);
    this.grid.remove(client.nid);
    // Tell anyone who could see them.
    for (const other of this.clients.values()) {
      if (other.aoi.delete(client.nid)) send(other.ws, { t: "leave", nid: client.nid });
    }
  }

  // -------------------------------------------------------------------------
  // Inbound messages
  // -------------------------------------------------------------------------

  onMove(client: ClientState, msg: MoveMessage): void {
    if (msg.seq <= client.lastSeq) return; // stale / out-of-order
    client.lastSeq = msg.seq;

    if (!this.isValidMove(client, msg.x, msg.y)) {
      send(client.ws, {
        t: "correction",
        x: client.x,
        y: client.y,
        facing: client.facing,
        seq: msg.seq,
      });
      return;
    }

    client.x = msg.x;
    client.y = msg.y;
    client.facing = msg.facing;
    client.moving = msg.moving;
    client.dirty = true;
  }

  private isValidMove(client: ClientState, x: number, y: number): boolean {
    // Bounds + tile collision at the target.
    if (isBlocked(this.collision, this.map.width, this.map.height, Math.floor(x), Math.floor(y))) {
      return false;
    }
    // Anti-teleport: distance since last accepted move must be within maxSpeed*dt (+ slack for
    // jitter). Threat model is a buggy client, not a cheater, so slack is generous.
    const now = Date.now();
    const dt = Math.max(0.001, (now - client.lastMoveAt) / 1000);
    client.lastMoveAt = now;
    const dx = x - client.x;
    const dy = y - client.y;
    const maxDist = this.config.maxSpeed * dt + 1.5;
    if (dx * dx + dy * dy > maxDist * maxDist) return false;
    return true;
  }

  onChat(client: ClientState, msg: ChatMessage): void {
    const body = msg.body.slice(0, 2000);
    if (!body) return;
    const channel = msg.channel || "space";
    const out: ServerMessage = {
      t: "chat",
      from: { nid: client.nid, id: client.id, name: client.name },
      channel,
      body,
      ts: Date.now(),
    };
    // Deliver to everyone currently in the sender's AOI, plus the sender (echo).
    send(client.ws, out);
    for (const nid of client.aoi) {
      const other = this.clients.get(nid);
      if (other) send(other.ws, out);
    }
    // Persist for scrollback / compliance (fire-and-forget).
    this.chat?.append(this.id, client.id, client.name, channel, body);
  }

  // -------------------------------------------------------------------------
  // Presentation mode + annotations (space-wide)
  // -------------------------------------------------------------------------

  onPresentation(client: ClientState, msg: PresentationControlMessage): void {
    if (msg.action === "start") {
      if (!client.caps.has("present")) return; // not authorized to present
      if (this.presentation) return; // one active presentation per space (MVP)
      this.presentation = {
        presenterId: client.id,
        presenterName: client.name,
        recording: !!msg.record,
      };
      const recording = !!msg.record && client.caps.has("record");
      this.presentation.recording = recording;
      this.broadcastAll({
        t: "presentationState",
        active: true,
        presenterId: client.id,
        presenterName: client.name,
        recording,
      });
      if (recording) void this.startRecording();
    } else if (this.presentation?.presenterId === client.id) {
      void this.endPresentation();
    }
  }

  private async startRecording(): Promise<void> {
    if (!this.presentation || !this.media?.canRecord) return;
    try {
      const egressId = await this.media.startEgress(
        this.media.roomName(this.id),
        this.id,
        this.presentation.presenterId,
      );
      if (this.presentation) this.presentation.egressId = egressId;
    } catch (err) {
      console.error(`[proximity] egress start failed for ${this.id}:`, err);
    }
  }

  private async endPresentation(): Promise<void> {
    const p = this.presentation;
    this.presentation = null;
    this.strokes.clear();
    this.broadcastAll({ t: "presentationState", active: false });
    this.broadcastAll({ t: "strokeClear" });
    if (p?.egressId && this.media?.canRecord) {
      try {
        await this.media.stopEgress(p.egressId);
      } catch (err) {
        console.error(`[proximity] egress stop failed for ${this.id}:`, err);
      }
    }
  }

  onStroke(client: ClientState, msg: StrokeMessage): void {
    if (this.presentation?.presenterId !== client.id) return; // presenter annotates (MVP)
    if (!client.caps.has("annotate")) return;
    let s = this.strokes.get(msg.strokeId);
    if (!s) {
      if (this.strokes.size > 5000) return; // memory guard
      s = { strokeId: msg.strokeId, color: msg.color, width: msg.width, points: [] };
      this.strokes.set(msg.strokeId, s);
    }
    for (const p of msg.points) s.points.push(p);
    this.broadcastAll(
      {
        t: "stroke",
        strokeId: msg.strokeId,
        color: msg.color,
        width: msg.width,
        points: msg.points,
        done: msg.done,
      },
      client.nid,
    );
  }

  onStrokeClear(client: ClientState): void {
    if (this.presentation?.presenterId !== client.id) return;
    this.strokes.clear();
    this.broadcastAll({ t: "strokeClear" }, client.nid);
  }

  private broadcastAll(msg: ServerMessage, exceptNid?: number): void {
    for (const c of this.clients.values()) {
      if (c.nid !== exceptNid) send(c.ws, msg);
    }
  }

  // -------------------------------------------------------------------------
  // Tick + broadcast
  // -------------------------------------------------------------------------

  private step(): void {
    this.tick++;
    // Sync grid buckets for anyone who moved.
    for (const c of this.clients.values()) {
      if (c.dirty) {
        this.grid.move(c.nid, c.x, c.y);
        c.dirty = false;
      }
    }
    // Broadcast position snapshots at snapshotRate (a fraction of tickRate).
    const every = Math.max(1, Math.round(this.config.tickRate / this.config.snapshotRate));
    if (this.tick % every === 0) {
      for (const c of this.clients.values()) this.syncClient(c);
    }
  }

  /**
   * Per-client tick work: diff AOI (enter/leave), send a binary position snapshot, and emit an
   * edge-triggered proximity diff (who to hear/see + audio gains) that drives client media.
   */
  private syncClient(client: ClientState): void {
    const neighbors = this.grid.queryWithin(
      client.x,
      client.y,
      this.config.aoiRadius,
      client.nid,
      this.neighborScratch,
    );

    // --- AOI enter/leave ---
    const next = new Set<number>();
    for (let i = 0; i < neighbors.length; i++) {
      const nid = neighbors[i]!;
      next.add(nid);
      if (!client.aoi.has(nid)) {
        const o = this.clients.get(nid)!;
        send(client.ws, {
          t: "enter",
          nid: o.nid,
          id: o.id,
          name: o.name,
          avatarId: o.avatarId,
          x: o.x,
          y: o.y,
          facing: o.facing,
        });
      }
    }
    for (const nid of client.aoi) {
      if (!next.has(nid)) send(client.ws, { t: "leave", nid });
    }
    client.aoi = next;

    // --- Binary position snapshot of the current AOI ---
    const entities: SnapshotEntity[] = new Array(neighbors.length);
    for (let i = 0; i < neighbors.length; i++) {
      const o = this.clients.get(neighbors[i]!)!;
      entities[i] = {
        nid: o.nid,
        x: o.x,
        y: o.y,
        facing: o.facing,
        flags: o.moving ? EntityFlags.Moving : 0,
      };
    }
    client.ws.send(encodeSnapshot(this.tick, entities, this.snapshotScratch));

    // --- Proximity (media) diff ---
    this.diffProximity(client, neighbors);
  }

  /**
   * Compute the audible/visible peer set with distance-based audio gains and send only the
   * delta vs the client's previous set. Hysteresis (keep until dist exceeds radius + margin)
   * prevents subscribe/unsubscribe flapping at radius boundaries.
   */
  private diffProximity(client: ClientState, neighbors: readonly number[]): void {
    const cfg = this.config;
    const nextProx = new Map<string, { gain: number; video: boolean }>();
    const add: ProximityPeer[] = [];
    const update: ProximityPeer[] = [];

    for (let i = 0; i < neighbors.length; i++) {
      const o = this.clients.get(neighbors[i]!)!;
      const dx = o.x - client.x;
      const dy = o.y - client.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const prev = client.prox.get(o.id);

      const audioLimit = prev ? cfg.audioRadius + RADIUS_HYSTERESIS : cfg.audioRadius;
      if (dist > audioLimit) continue; // not (or no longer) audible

      const gain = falloffGain(dist, AUDIO_INNER_RADIUS, cfg.audioRadius);
      const videoLimit = prev?.video ? cfg.videoRadius + RADIUS_HYSTERESIS : cfg.videoRadius;
      const video = dist <= videoLimit;
      nextProx.set(o.id, { gain, video });

      if (!prev) {
        add.push({ id: o.id, audioGain: gain, video });
      } else if (Math.abs(prev.gain - gain) > 0.02 || prev.video !== video) {
        update.push({ id: o.id, audioGain: gain, video });
      }
    }

    const remove: string[] = [];
    for (const id of client.prox.keys()) if (!nextProx.has(id)) remove.push(id);
    client.prox = nextProx;

    if (add.length || update.length || remove.length) {
      const msg: ProximityMessage = { t: "proximity", seq: ++client.proxSeq, add, update, remove };
      send(client.ws, msg);
    }
  }
}

/** Lazily-created registry of live spaces. */
export class SpaceRegistry {
  private readonly spaces = new Map<string, Space>();

  constructor(
    private readonly media: MediaProvider | null = null,
    private readonly chat: ChatStore | null = null,
  ) {}

  getOrCreate(id: string): Space {
    let s = this.spaces.get(id);
    if (!s) {
      s = new Space(id, this.media, this.chat);
      s.start();
      this.spaces.set(id, s);
    }
    return s;
  }

  get all(): IterableIterator<Space> {
    return this.spaces.values();
  }

  stopAll(): void {
    for (const s of this.spaces.values()) s.stop();
    this.spaces.clear();
  }
}
