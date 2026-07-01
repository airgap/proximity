import type { Server } from "bun";
import type { ServerEnv } from "@proximity/config";
import { decodeClientJson, type ClientMessage } from "@proximity/protocol";
import { SpaceRegistry, type ProximitySocket, type WSData } from "./space.ts";
import type { MediaProvider } from "./livekit.ts";
import type { ChatStore } from "./db.ts";

export interface RunningServer {
  server: Server;
  registry: SpaceRegistry;
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
    case "ping":
      ws.send(JSON.stringify({ t: "pong", cTime: msg.cTime, sTime: Date.now() }));
      break;
  }
}

/** Start the world server. Pass PORT: 0 for an ephemeral port (tests). */
export function startServer(
  env: Pick<ServerEnv, "HOST" | "PORT">,
  media: MediaProvider | null = null,
  chat: ChatStore | null = null,
): RunningServer {
  const registry = new SpaceRegistry(media, chat);

  const server = Bun.serve<WSData, {}>({
    hostname: env.HOST,
    port: env.PORT,
    idleTimeout: 60,

    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") {
        return new Response("ok", { headers: { "content-type": "text/plain" } });
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
