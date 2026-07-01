import { afterAll, beforeAll, expect, test } from "bun:test";
import { HostHooks, hmacHex } from "./hosthooks.ts";
import { startServer, type RunningServer } from "./server.ts";

const SECRET = "bridge_test_secret_32_chars_minimum_xx";
let rs: RunningServer;
let base: string;

beforeAll(() => {
  // open verifier (default) + host bridge enabled with a known secret.
  rs = startServer({ HOST: "127.0.0.1", PORT: 0 }, { host: new HostHooks(SECRET, undefined) });
  base = `http://127.0.0.1:${rs.server.port}`;
});
afterAll(() => {
  rs.registry.stopAll();
  rs.server.stop(true);
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("hmac verify round-trips and rejects tampering", async () => {
  const hooks = new HostHooks(SECRET, undefined);
  const body = JSON.stringify({ from: { id: "u_1", name: "Bot" }, body: "hi" });
  const sig = await hmacHex(body, SECRET);
  expect(await hooks.verify(body, sig)).toBe(true);
  expect(await hooks.verify(body + "x", sig)).toBe(false);
  expect(await hooks.verify(body, null)).toBe(false);
});

test("presence count + HMAC-signed host chat inject reaches a joined client", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${rs.server.port}/ws`);
  ws.binaryType = "arraybuffer";
  const events: any[] = [];
  ws.addEventListener("message", (e) => {
    if (typeof e.data === "string") events.push(JSON.parse(e.data as string));
  });
  await new Promise<void>((res) => ws.addEventListener("open", () => res()));
  ws.send(JSON.stringify({ t: "join", spaceId: "bridgetest", name: "Alice", avatarId: 0 }));
  await wait(250);

  // Presence reflects the one joined client (open mode => space id == "bridgetest").
  const pres = await fetch(`${base}/api/spaces/bridgetest/presence`).then((r) => r.json());
  expect(pres.count).toBe(1);

  // Host injects a chat with a valid signature -> Alice receives it.
  const payload = JSON.stringify({ from: { id: "sys", name: "Notetaker" }, body: "meeting starts now" });
  const good = await fetch(`${base}/api/spaces/bridgetest/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-proximity-signature": await hmacHex(payload, SECRET) },
    body: payload,
  });
  expect(good.status).toBe(200);
  await wait(150);
  expect(events.some((e) => e.t === "chat" && e.from.name === "Notetaker" && e.body.includes("meeting starts"))).toBe(true);

  // Bad signature is rejected.
  const bad = await fetch(`${base}/api/spaces/bridgetest/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-proximity-signature": "deadbeef" },
    body: payload,
  });
  expect(bad.status).toBe(401);

  ws.close();
});
