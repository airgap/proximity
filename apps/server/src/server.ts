import type { Server } from "bun";
import type { WebhookReceiver } from "livekit-server-sdk";
import type { ServerEnv } from "@proximity/config";
import { decodeClientJson, type ClientMessage } from "@proximity/protocol";
import { SpaceRegistry, type ProximitySocket, type WSData } from "./space.ts";
import type { MediaProvider } from "./livekit.ts";
import type { ChatStore, RecordingStore } from "./db.ts";

export interface RunningServer {
  server: Server;
  registry: SpaceRegistry;
}

export interface ServerDeps {
  media?: MediaProvider | null;
  chat?: ChatStore | null;
  recordings?: RecordingStore | null;
  webhook?: WebhookReceiver | null;
}

function handleMessage(ws: ProximitySocket, registry: SpaceRegistry, msg: ClientMessage): void {
  // The first message must be `join`; everything else requires an established client.
  if (msg.t === "join") {
    if (ws.data.client) return; // already joined
    const space = registry.getOrCreate(msg.spaceId || "default");
    // join is async (mints a LiveKit token); fire-and-forget, welcome is sent when ready.
    void space.join(ws, msg.name, msg.avatarId);
    return;
  }

  const client = ws.data.client;
  if (!client) {
    ws.send(JSON.stringify({ t: "error", code: "not_joined", msg: "send a join message first" }));
    return;
  }

  switch (msg.t) {
    case "move":
      client.space.onMove(client, msg);
      break;
    case "chat":
      client.space.onChat(client, msg);
      break;
    case "presentation":
      client.space.onPresentation(client, msg);
      break;
    case "stroke":
      client.space.onStroke(client, msg);
      break;
    case "strokeClear":
      client.space.onStrokeClear(client);
      break;
    case "ping":
      ws.send(JSON.stringify({ t: "pong", cTime: msg.cTime, sTime: Date.now() }));
      break;
  }
}

/** Handle a verified LiveKit egress webhook, persisting recording state. */
async function handleEgressWebhook(
  event: { event: string; egressInfo?: any },
  recordings: RecordingStore,
): Promise<void> {
  const info = event.egressInfo;
  if (!info?.egressId) return;
  const spaceId = String(info.roomName ?? "").replace(/^space:/, "");

  if (event.event === "egress_started") {
    await recordings.started(info.egressId, spaceId, null);
  } else if (event.event === "egress_ended" || event.event === "egress_updated") {
    // Only finalize on a terminal status.
    const status: string = String(info.status ?? "");
    const terminal = /COMPLETE|FAILED|ABORTED/i.test(status) || event.event === "egress_ended";
    if (!terminal) return;
    const file = info.fileResults?.[0] ?? info.file;
    const key: string | null = file?.filename ?? file?.location ?? null;
    const durationMs = file?.duration ? Math.round(Number(file.duration) / 1e6) : null; // ns -> ms
    const outStatus = /FAILED|ABORTED/i.test(status) ? "failed" : "complete";
    await recordings.ended(info.egressId, outStatus, key, durationMs);
  }
}

/** Start the world server. Pass PORT: 0 for an ephemeral port (tests). */
export function startServer(env: Pick<ServerEnv, "HOST" | "PORT">, deps: ServerDeps = {}): RunningServer {
  const registry = new SpaceRegistry(deps.media ?? null, deps.chat ?? null);
  const { recordings = null, webhook = null } = deps;

  const server = Bun.serve<WSData, {}>({
    hostname: env.HOST,
    port: env.PORT,
    idleTimeout: 60,

    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") {
        return new Response("ok", { headers: { "content-type": "text/plain" } });
      }
      // LiveKit egress webhook (signed). Persists recording lifecycle.
      if (url.pathname === "/livekit/webhook" && req.method === "POST") {
        if (!webhook || !recordings) return new Response("recording not configured", { status: 501 });
        try {
          const body = await req.text();
          const event = await webhook.receive(body, req.headers.get("Authorization") ?? undefined);
          await handleEgressWebhook(event as any, recordings);
          return new Response("ok");
        } catch (err) {
          console.error("[proximity] webhook error:", err);
          return new Response("bad webhook", { status: 400 });
        }
      }
      if (url.pathname === "/ws") {
        if (server.upgrade(req, { data: { client: null } })) return undefined;
        return new Response("expected a websocket upgrade", { status: 426 });
      }
      return new Response("proximity world-server", { status: 200 });
    },

    websocket: {
      maxPayloadLength: 1 << 20, // 1 MiB
      idleTimeout: 120,
      open() {
        // No-op: we wait for the client's `join` message before allocating state.
      },
      message(ws, message) {
        if (typeof message !== "string") return; // client -> server is JSON in this phase
        let msg: ClientMessage;
        try {
          msg = decodeClientJson(message);
        } catch {
          return;
        }
        handleMessage(ws, registry, msg);
      },
      close(ws) {
        const client = ws.data.client;
        if (client) {
          client.space.leave(client);
          ws.data.client = null;
        }
      },
    },
  });

  return { server, registry };
}
