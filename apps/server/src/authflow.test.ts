import { afterAll, beforeAll, expect, test } from "bun:test";
import { loadServerEnv } from "@proximity/config";
import { signGrant, verifierFromEnv } from "./auth.ts";
import { startServer, type RunningServer } from "./server.ts";

const SECRET = "authflow_test_secret_32_chars_minimum_xx";
let rs: RunningServer;
let url: string;

beforeAll(() => {
  const verifier = verifierFromEnv(
    loadServerEnv({ PROXIMITY_AUTH_MODE: "shared_secret", PROXIMITY_GRANT_SECRET: SECRET }),
  );
  rs = startServer({ HOST: "127.0.0.1", PORT: 0 }, { verifier });
  url = `ws://127.0.0.1:${rs.server.port}/ws`;
});

afterAll(() => {
  rs.registry.stopAll();
  rs.server.stop(true);
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function connect() {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const events: any[] = [];
  let closedCode = 0;
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") events.push(JSON.parse(ev.data as string));
  });
  ws.addEventListener("close", (ev) => {
    closedCode = ev.code;
  });
  const opened = new Promise<void>((res) => ws.addEventListener("open", () => res()));
  return {
    ws,
    events,
    opened,
    get closedCode() {
      return closedCode;
    },
    send: (m: unknown) => ws.send(JSON.stringify(m)),
  };
}

async function grantToken(spaces: string[], caps: string[]) {
  return signGrant({ sub: "u_1", name: "Nicole", tenant: "org_7", spaces, caps: caps as any }, SECRET);
}

test("valid grant joins an allowed space", async () => {
  const token = await grantToken(["group:eng"], ["join", "present", "annotate"]);
  const c = connect();
  await c.opened;
  c.send({ t: "join", spaceId: "group:eng", name: "ignored", avatarId: 0, token });
  await wait(250);
  const welcome = c.events.find((e) => e.t === "welcome");
  expect(welcome).toBeTruthy();
  expect(welcome.selfId).toBe("u_1"); // identity comes from the grant, not the client
  c.ws.close();
});

test("grant is rejected for a space it doesn't cover", async () => {
  const token = await grantToken(["group:eng"], ["join"]);
  const c = connect();
  await c.opened;
  c.send({ t: "join", spaceId: "group:sales", name: "x", avatarId: 0, token });
  await wait(250);
  expect(c.events.some((e) => e.t === "error" && e.code === "forbidden")).toBe(true);
  expect(c.events.some((e) => e.t === "welcome")).toBe(false);
});

test("join without a token is unauthorized (non-open mode)", async () => {
  const c = connect();
  await c.opened;
  c.send({ t: "join", spaceId: "group:eng", name: "x", avatarId: 0 });
  await wait(250);
  expect(c.events.some((e) => e.t === "error" && e.code === "unauthorized")).toBe(true);
});

test("capabilities are enforced: no 'present' cap => cannot present", async () => {
  // Presenter WITHOUT the present cap, plus a viewer, in the same space.
  const viewerTok = await grantToken(["group:eng"], ["join"]);
  const presenterTok = await grantToken(["group:eng"], ["join"]); // note: no 'present'
  const viewer = connect();
  const presenter = connect();
  await Promise.all([viewer.opened, presenter.opened]);
  viewer.send({ t: "join", spaceId: "group:eng", name: "V", avatarId: 0, token: viewerTok });
  presenter.send({ t: "join", spaceId: "group:eng", name: "P", avatarId: 0, token: presenterTok });
  await wait(250);
  presenter.send({ t: "presentation", action: "start" });
  await wait(200);
  // The viewer must NOT receive an active presentation state.
  expect(viewer.events.some((e) => e.t === "presentationState" && e.active)).toBe(false);
  viewer.ws.close();
  presenter.ws.close();
});
