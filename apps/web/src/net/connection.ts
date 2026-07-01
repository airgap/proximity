import {
  BinaryTag,
  binaryTagOf,
  decodeSnapshot,
  EntityFlags,
  type ClientMessage,
  type Facing,
  type MapDescriptor,
  type ProximityMessage,
  type ServerMessage,
  type SpaceConfig,
} from "@proximity/protocol";

export interface RemoteSample {
  t: number; // client arrival time (performance.now)
  x: number;
  y: number;
  facing: number;
  moving: boolean;
}

export interface Remote {
  nid: number;
  id: string;
  name: string;
  avatarId: number;
  samples: RemoteSample[];
  // Latest known values (used before the first snapshot arrives).
  x: number;
  y: number;
  facing: number;
  moving: boolean;
}

export type ConnectionStatus = "connecting" | "open" | "closed" | "error";

const MAX_SAMPLES = 8;

/**
 * Owns the single WebSocket to the world server. Parses control (JSON) + snapshot (binary)
 * frames, maintains the remote-entity table with a small per-remote sample buffer for
 * interpolation, and exposes typed send helpers. Rendering/prediction lives in GameClient.
 */
export class Connection {
  status: ConnectionStatus = "connecting";
  selfNid = -1;
  selfId = "";
  map: MapDescriptor | null = null;
  config: SpaceConfig | null = null;
  spawn = { x: 0, y: 0, facing: 0 as Facing };
  livekit: { url: string; token: string } | null = null;
  readonly remotes = new Map<number, Remote>();

  onWelcome?: () => void;
  onCorrection?: (x: number, y: number, facing: number) => void;
  onChat?: (name: string, body: string) => void;
  onChatHistory?: (messages: { name: string; body: string }[]) => void;
  onStatus?: (s: ConnectionStatus) => void;
  onProximity?: (msg: ProximityMessage) => void;

  private readonly ws: WebSocket;
  private seq = 0;

  constructor(
    url: string,
    private readonly name: string,
    private readonly avatarId: number,
    private readonly spaceId = "default",
  ) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => {
      this.send({ t: "join", spaceId: this.spaceId, name: this.name, avatarId: this.avatarId });
    };
    this.ws.onclose = () => this.setStatus("closed");
    this.ws.onerror = () => this.setStatus("error");
    this.ws.onmessage = (ev) => this.handleMessage(ev);
  }

  private setStatus(s: ConnectionStatus): void {
    this.status = s;
    this.onStatus?.(s);
  }

  private handleMessage(ev: MessageEvent): void {
    if (typeof ev.data === "string") {
      let m: ServerMessage;
      try {
        m = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      this.handleControl(m);
    } else {
      const buf = new Uint8Array(ev.data as ArrayBuffer);
      if (binaryTagOf(buf) === BinaryTag.Snapshot) this.applySnapshot(buf);
    }
  }

  private handleControl(m: ServerMessage): void {
    switch (m.t) {
      case "welcome":
        this.selfNid = m.selfNid;
        this.selfId = m.selfId;
        this.map = m.map;
        this.config = m.config;
        this.spawn = { x: m.you.x, y: m.you.y, facing: m.you.facing };
        this.livekit = m.livekit ?? null;
        this.setStatus("open");
        this.onWelcome?.();
        break;
      case "enter":
        this.remotes.set(m.nid, {
          nid: m.nid,
          id: m.id,
          name: m.name,
          avatarId: m.avatarId,
          samples: [],
          x: m.x,
          y: m.y,
          facing: m.facing,
          moving: false,
        });
        break;
      case "leave":
        this.remotes.delete(m.nid);
        break;
      case "chat":
        this.onChat?.(m.from.name, m.body);
        break;
      case "chatHistory":
        this.onChatHistory?.(m.messages.map((x) => ({ name: x.from.name, body: x.body })));
        break;
      case "correction":
        this.onCorrection?.(m.x, m.y, m.facing);
        break;
      case "proximity":
        this.onProximity?.(m);
        break;
      case "pong":
      case "error":
        break;
    }
  }

  private applySnapshot(buf: Uint8Array): void {
    const { entities } = decodeSnapshot(buf);
    const now = performance.now();
    for (const e of entities) {
      if (e.nid === this.selfNid) continue;
      const r = this.remotes.get(e.nid);
      if (!r) continue; // enter not processed yet
      const moving = (e.flags & EntityFlags.Moving) !== 0;
      r.samples.push({ t: now, x: e.x, y: e.y, facing: e.facing, moving });
      if (r.samples.length > MAX_SAMPLES) r.samples.shift();
      r.x = e.x;
      r.y = e.y;
      r.facing = e.facing;
      r.moving = moving;
    }
  }

  sendMove(x: number, y: number, facing: number, moving: boolean): void {
    this.send({ t: "move", x, y, facing: facing as Facing, moving, seq: ++this.seq });
  }

  sendChat(body: string): void {
    this.send({ t: "chat", channel: "space", body });
  }

  close(): void {
    this.ws.close();
  }

  private send(m: ClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }
}
