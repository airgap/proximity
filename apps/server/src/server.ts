import type { Server } from "bun";
import type { WebhookReceiver } from "livekit-server-sdk";
import type { ServerEnv } from "@proximity/config";
import { decodeClientJson, type ClientMessage } from "@proximity/protocol";
import { SpaceRegistry, type ProximitySocket, type WSData } from "./space.ts";
import type { MediaProvider } from "./livekit.ts";
import type { ChatStore, RecordingStore } from "./db.ts";
import { grantAllowsSpace, OpenVerifier, tenantScopedKey, type GrantVerifier } from "./auth.ts";
import type { HostHooks } from "./hosthooks.ts";

export interface RunningServer {
  server: Server;
  registry: SpaceRegistry;
}

export interface ServerDeps {
  media?: MediaProvider | null;
  chat?: ChatStore | null;
  recordings?: RecordingStore | null;
  webhook?: WebhookReceiver | null;
  verifier?: GrantVerifier | null;
  host?: HostHooks | null;
  /** Comma-separated CORS allow-list ("*" for dev). */
  corsOrigins?: string;
}

/**
 * Does `origin` match an allow-list entry? Entries are exact origins, or wildcard-subdomain
 * forms — "*.lyku.co" (any scheme) / "https://*.lyku.co" (scheme-pinned). A wildcard matches
 * subdomains only, never the apex, and hosts that merely end with the same string
 * ("evil-lyku.co") don't match — the suffix includes the dot.
 */
export function originMatches(origin: string, entry: string): boolean {
  if (entry === origin) return true;
  if (!entry.includes("*.")) return false;
  let scheme: string | null = null;
  let host = entry;
  const idx = entry.indexOf("://");
  if (idx !== -1) {
    scheme = entry.slice(0, idx);
    host = entry.slice(idx + 3);
  }
  if (!host.startsWith("*.")) return false;
  try {
    const o = new URL(origin);
    if (scheme && o.protocol !== `${scheme}:`) return false;
    return o.hostname.endsWith(host.slice(1)); // ".lyku.co" — dot included
  } catch {
    return false;
  }
}

function corsHeaders(req: Request, allow: string): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const list = allow.split(",").map((s) => s.trim());
  const ok = allow === "*" || list.some((entry) => originMatches(origin, entry));
  return {
    "access-control-allow-origin": allow === "*" ? "*" : ok ? origin : "null",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-proximity-signature",
    vary: "origin",
  };
}

function wsError(ws: ProximitySocket, code: string, msg: string): void {
  ws.send(JSON.stringify({ t: "error", code, msg }));
}

async function handleJoin(
  ws: ProximitySocket,
  registry: SpaceRegistry,
  verifier: GrantVerifier,
  msg: Extract<ClientMessage, { t: "join" }>,
): Promise<void> {
  if (ws.data.client) return; // already joined

  // Resolve a grant: from the upgrade request (trusted_proxy / bearer), then the join token,
  // then anonymous (open mode only).
  let grant =
    ws.data.pendingGrant ??
    (msg.token ? await verifier.fromToken(msg.token) : null) ??
    verifier.anonymous(msg.name);

  if (ws.data.client) return; // raced with another join while awaiting

  if (!grant) {
    wsError(ws, "unauthorized", "a valid access grant is required to join");
    ws.close(4401, "unauthorized");
    return;
  }
  if (!grantAllowsSpace(grant, msg.spaceId)) {
    wsError(ws, "forbidden", `not authorized for space ${msg.spaceId}`);
    ws.close(4403, "forbidden");
    return;
  }

  const space = registry.getOrCreate(tenantScopedKey(grant, msg.spaceId));
  void space.join(ws, grant, msg.avatarId, msg.observer ?? false);
}

function handleMessage(
  ws: ProximitySocket,
  registry: SpaceRegistry,
  verifier: GrantVerifier,
  msg: ClientMessage,
): void {
  if (msg.t === "join") {
    void handleJoin(ws, registry, verifier, msg);
    return;
  }

  const client = ws.data.client;
  if (!client) {
    wsError(ws, "not_joined", "send a join message first");
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
    const status: string = String(info.status ?? "");
    const terminal = /COMPLETE|FAILED|ABORTED/i.test(status) || event.event === "egress_ended";
    if (!terminal) return;
    const file = info.fileResults?.[0] ?? info.file;
    const key: string | null = file?.filename ?? file?.location ?? null;
    const durationMs = file?.duration ? Math.round(Number(file.duration) / 1e6) : null;
    const outStatus = /FAILED|ABORTED/i.test(status) ? "failed" : "complete";
    await recordings.ended(info.egressId, outStatus, key, durationMs);
  }
}

/** Start the world server. Pass PORT: 0 for an ephemeral port (tests). */
export function startServer(env: Pick<ServerEnv, "HOST" | "PORT">, deps: ServerDeps = {}): RunningServer {
  const registry = new SpaceRegistry(deps.media ?? null, deps.chat ?? null, deps.host ?? null);
  const { recordings = null, webhook = null, host = null } = deps;
  const verifier = deps.verifier ?? new OpenVerifier();
  const cors = deps.corsOrigins ?? "*";

  const server = Bun.serve<WSData, {}>({
    hostname: env.HOST,
    port: env.PORT,
    idleTimeout: 60,

    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") {
        return new Response("ok", { headers: { "content-type": "text/plain" } });
      }
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
      // CORS preflight for the host-facing HTTP API.
      if (req.method === "OPTIONS" && url.pathname.startsWith("/api/spaces/")) {
        return new Response(null, { status: 204, headers: corsHeaders(req, cors) });
      }
      // Presence: GET /api/spaces/:id/presence -> { count }. Count-only, CORS-open so the host UI
      // can poll a badge without a grant. (Full occupant list would require the grant.)
      const presenceMatch = url.pathname.match(/^\/api\/spaces\/(.+)\/presence$/);
      if (presenceMatch && req.method === "GET") {
        const space = registry.get(decodeURIComponent(presenceMatch[1]!));
        return Response.json(
          { count: space?.population ?? 0 },
          { headers: corsHeaders(req, cors) },
        );
      }
      // Chat bridge inbound: POST /api/spaces/:id/chat (HMAC-signed by the host) -> inject.
      const chatMatch = url.pathname.match(/^\/api\/spaces\/(.+)\/chat$/);
      if (chatMatch && req.method === "POST") {
        if (!host) return new Response("bridge not configured", { status: 501 });
        const bodyText = await req.text();
        if (!(await host.verify(bodyText, req.headers.get("x-proximity-signature")))) {
          return new Response("bad signature", { status: 401, headers: corsHeaders(req, cors) });
        }
        try {
          const { from, body } = JSON.parse(bodyText) as { from: { id: string; name: string }; body: string };
          registry.get(decodeURIComponent(chatMatch[1]!))?.injectHostChat(from, body);
          return new Response("ok", { headers: corsHeaders(req, cors) });
        } catch {
          return new Response("bad request", { status: 400, headers: corsHeaders(req, cors) });
        }
      }
      if (url.pathname === "/ws") {
        // Resolve any request-level grant (trusted_proxy headers / bearer) before upgrading.
        const pendingGrant = await verifier.fromRequest(req);
        if (server.upgrade(req, { data: { client: null, pendingGrant } })) return undefined;
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
        handleMessage(ws, registry, verifier, msg);
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
