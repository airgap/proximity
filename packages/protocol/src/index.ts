/**
 * @proximity/protocol — the single source of truth for the client <-> world-server wire format.
 *
 * Transport: one WebSocket per client.
 *   - TEXT frames  = JSON control messages (this file's `ClientMessage` / `ServerMessage`).
 *   - BINARY frames = compact fixed-layout records, first byte = `BinaryТag`.
 *
 * Only the high-frequency, high-fanout position snapshot uses the binary channel; everything
 * else is JSON (readable, debuggable, cheap at low rates). Both sides import the encode/decode
 * helpers below so the layout can never drift.
 */

// ---------------------------------------------------------------------------
// Tunable wire constants
// ---------------------------------------------------------------------------

/**
 * Fixed-point subpixels per tile for snapshot coordinates. Positions are sent as
 * int16 = round(tileCoord * POS_SCALE), giving a world range of ±(32767 / POS_SCALE) tiles
 * and a precision of 1/POS_SCALE tile. At 64: range ±511 tiles, precision ~0.016 tile.
 */
export const POS_SCALE = 64;

/** Max tile coordinate representable in a snapshot (exclusive-ish bound; clamp to this). */
export const POS_MAX_TILE = 32767 / POS_SCALE;

/** Binary frame message tags (first byte of a binary WS frame). */
export const BinaryTag = {
  Snapshot: 1,
} as const;
export type BinaryTag = (typeof BinaryTag)[keyof typeof BinaryTag];

/** Entity flag bits packed into the snapshot `flags` byte. */
export const EntityFlags = {
  Moving: 1 << 0,
  Speaking: 1 << 1, // reserved for phase 2 (active-speaker highlight)
} as const;

/** Four-direction avatar facing (indexes a sprite sheet). */
export const Facing = {
  Down: 0,
  Up: 1,
  Left: 2,
  Right: 3,
} as const;
export type Facing = (typeof Facing)[keyof typeof Facing];

// ---------------------------------------------------------------------------
// Shared value shapes
// ---------------------------------------------------------------------------

/** A tile-space rectangle (used for zones, spawn areas, etc.). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Static map description sent in `welcome`. MVP loads this from the space record. */
export interface MapDescriptor {
  name: string;
  /** Map width/height in tiles. */
  width: number;
  height: number;
  /** Pixels per tile (render scale). */
  tileSize: number;
  /** Row-major 1-bit-per-tile collision mask, base64-encoded (1 = blocked). */
  collisionB64: string;
  /** Where new avatars spawn. */
  spawn: { x: number; y: number };
}

/** Live spatial + media tuning the client needs. Mirrors world-server config. */
export interface SpaceConfig {
  /** Simulation ticks per second (server-authoritative). */
  tickRate: number;
  /** Position snapshot broadcasts per second. */
  snapshotRate: number;
  /** Audio audible radius, in tiles. */
  audioRadius: number;
  /** Video connect radius, in tiles (< audioRadius). */
  videoRadius: number;
  /** Area-of-interest radius: entities within this appear on screen. */
  aoiRadius: number;
  /** Max avatar move speed, tiles/second (server validation clamp). */
  maxSpeed: number;
}

// ---------------------------------------------------------------------------
// Client -> Server (JSON / text frames)
// ---------------------------------------------------------------------------

export interface JoinMessage {
  t: "join";
  spaceId: string;
  /** Display name; auth token optional in MVP (added in phase 2). */
  name: string;
  avatarId: number;
  token?: string;
}

export interface MoveMessage {
  t: "move";
  /** Tile-space position (floats). */
  x: number;
  y: number;
  facing: Facing;
  moving: boolean;
  /** Monotonic client sequence for reconciliation/corrections. */
  seq: number;
}

export interface ChatMessage {
  t: "chat";
  /** "space" for whole-space, or a zone id later. */
  channel: string;
  body: string;
}

export interface PingMessage {
  t: "ping";
  cTime: number;
}

/** A point in the shared surface's normalized 0..1 coordinate space (resolution-independent). */
export interface StrokePoint {
  x: number;
  y: number;
}

/** Start/stop presentation mode (elevates the caller's screenshare to the whole space). */
export interface PresentationControlMessage {
  t: "presentation";
  action: "start" | "stop";
  /** Request server-side recording (LiveKit Egress) for this presentation. */
  record?: boolean;
}

/** Append points to an annotation stroke drawn over the shared surface. */
export interface StrokeMessage {
  t: "stroke";
  strokeId: string;
  color: string;
  width: number;
  /** New points appended since the last message for this stroke. */
  points: StrokePoint[];
  /** True on the final delta for this stroke. */
  done: boolean;
}

/** Clear all annotations. */
export interface StrokeClearMessage {
  t: "strokeClear";
}

export type ClientMessage =
  | JoinMessage
  | MoveMessage
  | ChatMessage
  | PingMessage
  | PresentationControlMessage
  | StrokeMessage
  | StrokeClearMessage;

// ---------------------------------------------------------------------------
// Server -> Client (JSON / text frames)
// ---------------------------------------------------------------------------

export interface WelcomeMessage {
  t: "welcome";
  /** Numeric entity id of the joining client (used in binary snapshots). */
  selfNid: number;
  /** Stable string user id (== LiveKit identity). */
  selfId: string;
  spaceId: string;
  config: SpaceConfig;
  map: MapDescriptor;
  /** Authoritative starting position. */
  you: { x: number; y: number; facing: Facing };
  /** LiveKit connection info for media (absent if media is not configured). */
  livekit?: { url: string; token: string };
}

/** An entity entered this client's area of interest (or just joined the space nearby). */
export interface EnterMessage {
  t: "enter";
  nid: number;
  id: string;
  name: string;
  avatarId: number;
  x: number;
  y: number;
  facing: Facing;
}

/** An entity left this client's area of interest (or left the space). */
export interface LeaveMessage {
  t: "leave";
  nid: number;
}

export interface ChatBroadcast {
  t: "chat";
  from: { nid: number; id: string; name: string };
  channel: string;
  body: string;
  ts: number;
}

/** Recent chat scrollback sent to a client on join. */
export interface ChatHistoryMessage {
  t: "chatHistory";
  messages: { from: { id: string; name: string }; channel: string; body: string; ts: number }[];
}

/** Authoritative position snap when the server rejects a client move. */
export interface CorrectionMessage {
  t: "correction";
  x: number;
  y: number;
  facing: Facing;
  seq: number;
}

/** One peer entry in a proximity diff. */
export interface ProximityPeer {
  /** LiveKit identity == world userId. */
  id: string;
  /** 0..1 spatial audio gain from the falloff curve. */
  audioGain: number;
  /** Whether this peer is within video radius (client applies its own budget). */
  video: boolean;
}

/** Edge-triggered, debounced proximity diff that drives client media subscription. */
export interface ProximityMessage {
  t: "proximity";
  seq: number;
  add: ProximityPeer[];
  update: ProximityPeer[];
  remove: string[];
}

/** Current presentation state for the space (broadcast on change + on join). */
export interface PresentationStateMessage {
  t: "presentationState";
  active: boolean;
  presenterId?: string;
  presenterName?: string;
  recording?: boolean;
}

/** A full annotation stroke (used in snapshots for late joiners). */
export interface FullStroke {
  strokeId: string;
  color: string;
  width: number;
  points: StrokePoint[];
}

/** Rebroadcast of an annotation stroke delta to other viewers. */
export interface StrokeBroadcast {
  t: "stroke";
  strokeId: string;
  color: string;
  width: number;
  points: StrokePoint[];
  done: boolean;
}

/** All current annotation strokes, sent when a client enters an active presentation. */
export interface StrokeSnapshotMessage {
  t: "strokeSnapshot";
  strokes: FullStroke[];
}

/** Clear-all rebroadcast. */
export interface StrokeClearBroadcast {
  t: "strokeClear";
}

export interface PongMessage {
  t: "pong";
  cTime: number;
  sTime: number;
}

export interface ErrorMessage {
  t: "error";
  code: string;
  msg: string;
}

export type ServerMessage =
  | WelcomeMessage
  | EnterMessage
  | LeaveMessage
  | ChatBroadcast
  | ChatHistoryMessage
  | CorrectionMessage
  | ProximityMessage
  | PresentationStateMessage
  | StrokeBroadcast
  | StrokeSnapshotMessage
  | StrokeClearBroadcast
  | PongMessage
  | ErrorMessage;

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

export function encodeJson(msg: ServerMessage | ClientMessage): string {
  return JSON.stringify(msg);
}

export function decodeClientJson(data: string): ClientMessage {
  return JSON.parse(data) as ClientMessage;
}

export function decodeServerJson(data: string): ServerMessage {
  return JSON.parse(data) as ServerMessage;
}

// ---------------------------------------------------------------------------
// Binary position snapshot codec
// ---------------------------------------------------------------------------
//
// Layout (little-endian):
//   [u8  tag = BinaryTag.Snapshot]
//   [u32 serverTick]
//   [u16 count]
//   count × {
//     [u16 nid]
//     [i16 x]     // round(tileX * POS_SCALE)
//     [i16 y]     // round(tileY * POS_SCALE)
//     [u8  facing]
//     [u8  flags]
//   }
// => 7-byte header + 8 bytes/entity.

export interface SnapshotEntity {
  nid: number;
  x: number; // tile-space float
  y: number; // tile-space float
  facing: Facing;
  flags: number;
}

const SNAPSHOT_HEADER = 7;
const SNAPSHOT_ENTITY = 8;

function clampFixed(tile: number): number {
  const v = Math.round(tile * POS_SCALE);
  return v < -32768 ? -32768 : v > 32767 ? 32767 : v;
}

/**
 * Encode a position snapshot into a binary buffer.
 * Pass a preallocated `into` buffer to avoid per-tick allocation on the hot path.
 */
export function encodeSnapshot(
  serverTick: number,
  entities: readonly SnapshotEntity[],
  into?: Uint8Array,
): Uint8Array {
  const count = entities.length;
  const size = SNAPSHOT_HEADER + count * SNAPSHOT_ENTITY;
  const buf = into && into.byteLength >= size ? into.subarray(0, size) : new Uint8Array(size);
  const dv = new DataView(buf.buffer, buf.byteOffset, size);

  dv.setUint8(0, BinaryTag.Snapshot);
  dv.setUint32(1, serverTick >>> 0, true);
  dv.setUint16(5, count, true);

  let off = SNAPSHOT_HEADER;
  for (let i = 0; i < count; i++) {
    const e = entities[i]!;
    dv.setUint16(off, e.nid, true);
    dv.setInt16(off + 2, clampFixed(e.x), true);
    dv.setInt16(off + 4, clampFixed(e.y), true);
    dv.setUint8(off + 6, e.facing);
    dv.setUint8(off + 7, e.flags);
    off += SNAPSHOT_ENTITY;
  }
  return buf;
}

export interface DecodedSnapshot {
  tick: number;
  entities: SnapshotEntity[];
}

/** Decode a binary snapshot frame. Accepts ArrayBuffer or a typed-array view. */
export function decodeSnapshot(data: ArrayBuffer | Uint8Array | DataView): DecodedSnapshot {
  const dv =
    data instanceof DataView
      ? data
      : data instanceof Uint8Array
        ? new DataView(data.buffer, data.byteOffset, data.byteLength)
        : new DataView(data);

  const tag = dv.getUint8(0);
  if (tag !== BinaryTag.Snapshot) {
    throw new Error(`unexpected binary tag ${tag}, expected snapshot`);
  }
  const tick = dv.getUint32(1, true);
  const count = dv.getUint16(5, true);

  const entities: SnapshotEntity[] = new Array(count);
  let off = SNAPSHOT_HEADER;
  for (let i = 0; i < count; i++) {
    entities[i] = {
      nid: dv.getUint16(off, true),
      x: dv.getInt16(off + 2, true) / POS_SCALE,
      y: dv.getInt16(off + 4, true) / POS_SCALE,
      facing: dv.getUint8(off + 6) as Facing,
      flags: dv.getUint8(off + 7),
    };
    off += SNAPSHOT_ENTITY;
  }
  return { tick, entities };
}

/** Peek the binary tag of a frame without fully decoding it. */
export function binaryTagOf(data: ArrayBuffer | Uint8Array): number {
  return data instanceof Uint8Array ? data[0]! : new Uint8Array(data, 0, 1)[0]!;
}

// ---------------------------------------------------------------------------
// Map collision helpers
// ---------------------------------------------------------------------------

export { packCollision, unpackCollision, isBlocked } from "./map.ts";
