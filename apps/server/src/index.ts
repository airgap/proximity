import { loadServerEnv } from "@proximity/config";
import { startServer } from "./server.ts";
import { mediaProviderFromEnv, webhookReceiverFromEnv } from "./livekit.ts";
import { verifierFromEnv } from "./auth.ts";
import { hostHooksFromEnv } from "./hosthooks.ts";
import { dbFromEnv, migrate, PgChatStore, PgRecordingStore, type ChatStore, type RecordingStore } from "./db.ts";

const env = loadServerEnv();
const media = mediaProviderFromEnv(env);
const verifier = verifierFromEnv(env);
const host = hostHooksFromEnv(env);

let chat: ChatStore | null = null;
let recordings: RecordingStore | null = null;
const db = dbFromEnv(env);
if (db) {
  // Retry briefly so we tolerate Postgres still starting (no hard depends_on across profiles).
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      // PG_MIGRATE=false when the schema is owned by a host's Lockstep models (shared database).
      if (env.PG_MIGRATE) await migrate(db);
      chat = new PgChatStore(db);
      recordings = new PgRecordingStore(db);
      break;
    } catch (err) {
      if (attempt === 10) {
        console.error("[proximity] database init failed; continuing without persistence:", err);
      } else {
        await Bun.sleep(1000);
      }
    }
  }
}

// Webhook receiver only useful when recording (media) + persistence are both available.
const webhook = media?.canRecord && recordings ? webhookReceiverFromEnv(env) : null;

const { server } = startServer(env, {
  media,
  chat,
  recordings,
  webhook,
  verifier,
  host,
  corsOrigins: env.HOST_ORIGINS,
});

console.log(
  `[proximity] world-server on ws://${server.hostname}:${server.port}/ws` +
    ` (auth: ${verifier.mode})` +
    (media ? ` (media: LiveKit${media.canRecord ? " +recording" : ""})` : " (no media)") +
    (chat ? " (chat: persisted)" : " (chat: in-memory)") +
    (host ? " (host bridge)" : ""),
);
