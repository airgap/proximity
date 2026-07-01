import { Application, Container, Graphics, Text } from "pixi.js";
import { Facing, isBlocked, unpackCollision } from "@proximity/protocol";
import { Connection, type Remote } from "../net/connection.ts";
import { Input } from "./input.ts";

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

  onChat?: (name: string, body: string) => void;
  onStatus?: (s: string) => void;
  readonly displayName: string;

  constructor(url: string, name: string, avatarId: number) {
    this.displayName = name;
    this.conn = new Connection(url, name, avatarId);
    this.conn.onWelcome = () => this.onWelcome();
    this.conn.onCorrection = (x, y, f) => {
      this.self.x = x;
      this.self.y = y;
      this.self.facing = f;
    };
    this.conn.onChat = (n, b) => this.onChat?.(n, b);
    this.conn.onStatus = (s) => this.onStatus?.(s);
  }

  async mount(parent: HTMLElement): Promise<void> {
    await this.app.init({ background: "#12121e", resizeTo: parent, antialias: true });
    parent.appendChild(this.app.canvas);
    this.app.stage.addChild(this.world);
    this.app.ticker.add((ticker) => this.update(ticker.deltaMS));
  }

  sendChat(body: string): void {
    this.conn.sendChat(body);
  }

  destroy(): void {
    this.conn.close();
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
    // Subtle grid overlay for a sense of motion.
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

    // --- Send move to server (rate-capped, only on change) ---
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

    // --- Render self ---
    const ts = this.tileSize;
    this.selfView.container.x = this.self.x * ts;
    this.selfView.container.y = this.self.y * ts;

    // --- Remotes: spawn/despawn views, interpolate positions ---
    const renderT = now - INTERP_DELAY;
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
    }
    for (const [nid, view] of this.avatars) {
      if (!this.conn.remotes.has(nid)) {
        this.world.removeChild(view.container);
        view.container.destroy({ children: true });
        this.avatars.delete(nid);
      }
    }

    // --- Camera follows self ---
    this.world.x = this.app.screen.width / 2 - this.self.x * ts;
    this.world.y = this.app.screen.height / 2 - this.self.y * ts;
  }

  private blocked(x: number, y: number): boolean {
    // Sample the body's four extents so we can't clip a wall corner.
    return (
      isBlocked(this.collision, this.mapW, this.mapH, Math.floor(x - BODY_RADIUS), Math.floor(y)) ||
      isBlocked(this.collision, this.mapW, this.mapH, Math.floor(x + BODY_RADIUS), Math.floor(y)) ||
      isBlocked(this.collision, this.mapW, this.mapH, Math.floor(x), Math.floor(y - BODY_RADIUS)) ||
      isBlocked(this.collision, this.mapW, this.mapH, Math.floor(x), Math.floor(y + BODY_RADIUS))
    );
  }
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

/** Deterministic pleasant color from a user id string. */
function colorFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return hslToHex(hue, 65, 55);
}

function hslToHex(h: number, s: number, l: number): number {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const r = Math.round(f(0) * 255);
  const g = Math.round(f(8) * 255);
  const b = Math.round(f(4) * 255);
  return (r << 16) | (g << 8) | b;
}
