import { loadServerEnv } from "@proximity/config";
import { startServer } from "./server.ts";
import { mediaProviderFromEnv } from "./livekit.ts";
import { dbFromEnv, migrate, PgChatStore, type ChatStore } from "./db.ts";

const env = loadServerEnv();
const media = mediaProviderFromEnv(env);

let chat: ChatStore | null = null;
const db = dbFromEnv(env);
if (db) {
  try {
    await migrate(db);
    chat = new PgChatStore(db);
  } catch (err) {
    console.error("[proximity] database init failed; continuing without persistence:", err);
  }
}

const { server } = startServer(env, media, chat);

console.log(
  `[proximity] world-server on ws://${server.hostname}:${server.port}/ws` +
    (media ? ` (media: LiveKit @ ${media.url})` : " (no media)") +
    (chat ? " (chat: persisted)" : " (chat: in-memory)"),
);
