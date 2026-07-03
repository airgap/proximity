import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BinaryTag, binaryTagOf } from "@proximity/protocol";
import { originMatches, startServer, type RunningServer } from "./server.ts";

let rs: RunningServer;
let url: string;

beforeAll(() => {
  rs = startServer({ HOST: "127.0.0.1", PORT: 0 });
  url = `ws://127.0.0.1:${rs.server.port}/ws`;
});

afterAll(() => {
  rs.registry.stopAll();
  rs.server.stop(true);
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function connect(name: string) {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const events: any[] = [];
  let snapshots = 0;
  let selfNid = -1;
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") {
      const m = JSON.parse(ev.data as string);
      if (m.t === "welcome") selfNid = m.selfNid;
      events.push(m);
    } else if (binaryTagOf(new Uint8Array(ev.data as ArrayBuffer)) === BinaryTag.Snapshot) {
      snapshots++;
    }
  });
  const opened = new Promise<void>((res) => ws.addEventListener("open", () => res()));
  return {
    ws,
    events,
    opened,
    get snapshots() {
      return snapshots;
    },
    get selfNid() {
      return selfNid;
    },
    join() {
      ws.send(JSON.stringify({ t: "join", spaceId: "itest", name, avatarId: 0 }));
    },
    move(x: number, y: number, seq: number) {
      ws.send(JSON.stringify({ t: "move", x, y, facing: 0, moving: true, seq }));
    },
  };
}

test("two clients: mutual AOI enter, leave on distance, and move corrections", async () => {
  const a = connect("Alice");
  const b = connect("Bob");
  await Promise.all([a.opened, b.opened]);
  a.join();
  b.join();
  await wait(300);

  // Both joined with valid ids and see each other (spawn at the same tile).
  expect(a.selfNid).toBeGreaterThan(0);
  expect(b.selfNid).toBeGreaterThan(0);
  expect(a.events.some((e) => e.t === "enter" && e.name === "Bob")).toBe(true);
  expect(b.events.some((e) => e.t === "enter" && e.name === "Alice")).toBe(true);

  // Bob walks out of Alice's AOI -> Alice receives a leave.
  for (let i = 1; i <= 25; i++) {
    b.move(4.5 + i * 0.8, 4.5, i);
    await wait(25);
  }
  await wait(300);
  expect(a.events.some((e) => e.t === "leave")).toBe(true);

  // Invalid move into a wall -> server sends a correction.
  b.move(0.5, 0.5, 1000);
  await wait(150);
  expect(b.events.some((e) => e.t === "correction")).toBe(true);

  // Binary snapshots were flowing.
  expect(a.snapshots).toBeGreaterThan(0);

  a.ws.close();
  b.ws.close();
});

describe("originMatches (HOST_ORIGINS wildcard entries)", () => {
  test("exact origins still match exactly", () => {
    expect(originMatches("https://lyku.co", "https://lyku.co")).toBe(true);
    expect(originMatches("https://lyku.co", "https://www.lyku.co")).toBe(false);
  });

  test("*.domain matches any subdomain, any scheme", () => {
    expect(originMatches("https://acme.lyku.co", "*.lyku.co")).toBe(true);
    expect(originMatches("http://a.b.lyku.co", "*.lyku.co")).toBe(true);
  });

  test("scheme-pinned wildcard enforces the scheme", () => {
    expect(originMatches("https://acme.lyku.co", "https://*.lyku.co")).toBe(true);
    expect(originMatches("http://acme.lyku.co", "https://*.lyku.co")).toBe(false);
  });

  test("wildcard never matches the apex or lookalike hosts", () => {
    expect(originMatches("https://lyku.co", "*.lyku.co")).toBe(false);
    expect(originMatches("https://evil-lyku.co", "*.lyku.co")).toBe(false);
    expect(originMatches("https://lyku.co.evil.com", "*.lyku.co")).toBe(false);
  });

  test("garbage origins never match", () => {
    expect(originMatches("null", "*.lyku.co")).toBe(false);
    expect(originMatches("", "*.lyku.co")).toBe(false);
  });
});
