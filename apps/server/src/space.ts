import type { ServerWebSocket } from "bun";
import { DEFAULT_SPACE_CONFIG } from "@proximity/config";
import {
  EntityFlags,
  Facing,
  encodeJson,
  encodeSnapshot,
  isBlocked,
  unpackCollision,
  type ChatMessage,
  type MapDescriptor,
  type MoveMessage,
  type ServerMessage,
  type SnapshotEntity,
  type SpaceConfig,
} from "@proximity/protocol";
import { Grid } from "@proximity/spatial";
import { generateDefaultMap } from "./map.ts";

/** Data attached to each WebSocket connection. */
export interface WSData {
  client: ClientState | null;
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

  x: number;
  y: number;
  facing: Facing;
  moving: boolean;

  lastSeq: number;
  lastMoveAt: number; // ms epoch of last accepted move (for speed validation)
  aoi: Set<number>; // nids currently within this client's area of interest
  dirty: boolean; // position changed since last grid sync
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

  /** Reused buffers to keep the broadcast hot path allocation-free. */
  private readonly snapshotScratch = new Uint8Array(64 * 1024);
  private readonly neighborScratch: number[] = [];

  constructor(id: string) {
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

  join(ws: ProximitySocket, name: string, avatarId: number): ClientState {
    const nid = this.nextNid++;
    const spawn = this.map.spawn;
    const client: ClientState = {
      nid,
      id: `u_${nid}`,
      name: name.slice(0, 40) || `Guest ${nid}`,
      avatarId: avatarId | 0,
      ws,
      space: this,
      x: spawn.x,
      y: spawn.y,
      facing: Facing.Down,
      moving: false,
      lastSeq: 0,
      lastMoveAt: Date.now(),
      aoi: new Set(),
      dirty: false,
    };
    this.clients.set(nid, client);
    this.grid.insert(nid, client.x, client.y);
    ws.data.client = client;

    send(ws, {
      t: "welcome",
      selfNid: nid,
      selfId: client.id,
      spaceId: this.id,
      config: this.config,
      map: this.map,
      you: { x: client.x, y: client.y, facing: client.facing },
    });

    // Immediately populate the newcomer's AOI so they see the room without a tick of latency.
    this.syncClientAOI(client);
    return client;
  }

  leave(client: ClientState): void {
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
    const out: ServerMessage = {
      t: "chat",
      from: { nid: client.nid, id: client.id, name: client.name },
      channel: msg.channel,
      body,
      ts: Date.now(),
    };
    // Deliver to everyone currently in the sender's AOI, plus the sender (echo).
    send(client.ws, out);
    for (const nid of client.aoi) {
      const other = this.clients.get(nid);
      if (other) send(other.ws, out);
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
      for (const c of this.clients.values()) this.syncClientAOI(c);
    }
  }

  /** Diff a client's AOI (enter/leave) and send them a fresh binary position snapshot. */
  private syncClientAOI(client: ClientState): void {
    const neighbors = this.grid.queryWithin(
      client.x,
      client.y,
      this.config.aoiRadius,
      client.nid,
      this.neighborScratch,
    );

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

    // Binary position snapshot of the current AOI.
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
    const buf = encodeSnapshot(this.tick, entities, this.snapshotScratch);
    client.ws.send(buf);
  }
}

/** Lazily-created registry of live spaces. */
export class SpaceRegistry {
  private readonly spaces = new Map<string, Space>();

  getOrCreate(id: string): Space {
    let s = this.spaces.get(id);
    if (!s) {
      s = new Space(id);
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
