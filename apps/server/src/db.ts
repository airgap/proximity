import { SQL } from "bun";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ServerEnv } from "@proximity/config";

export type Db = SQL;

/** Build a Postgres connection from env, or null if not configured. */
export function dbFromEnv(env: ServerEnv): Db | null {
  if (!env.PG_HOST || !env.PG_DB || !env.PG_USER) return null;
  const pw = env.PG_PASSWORD ?? "";
  const url = `postgres://${env.PG_USER}:${encodeURIComponent(pw)}@${env.PG_HOST}:${env.PG_PORT}/${env.PG_DB}`;
  return new SQL(url);
}

/** Apply any unapplied SQL files in infra/migrations, tracked in a _migrations table. */
export async function migrate(sql: Db): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS _migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;
  const dir = fileURLToPath(new URL("../../../infra/migrations/", import.meta.url));
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const appliedRows = (await sql`SELECT name FROM _migrations`) as { name: string }[];
  const applied = new Set(appliedRows.map((r) => r.name));

  for (const file of files) {
    if (applied.has(file)) continue;
    const content = readFileSync(dir + file, "utf8");
    await sql.unsafe(content);
    await sql`INSERT INTO _migrations (name) VALUES (${file})`;
    console.log(`[migrate] applied ${file}`);
  }
}

// ---------------------------------------------------------------------------
// Chat store
// ---------------------------------------------------------------------------

export interface ChatRecord {
  from: { id: string; name: string };
  channel: string;
  body: string;
  ts: number;
}

export interface ChatStore {
  /** Persist a message (fire-and-forget; errors are logged, never thrown at callers). */
  append(spaceId: string, authorId: string, authorName: string, channel: string, body: string): void;
  /** Most recent messages for a space, oldest-first. */
  recent(spaceId: string, limit: number): Promise<ChatRecord[]>;
}

/** Postgres-backed chat store. */
export class PgChatStore implements ChatStore {
  constructor(private readonly sql: Db) {}

  append(spaceId: string, authorId: string, authorName: string, channel: string, body: string): void {
    this.sql`
      INSERT INTO chat_messages (space_id, author_id, author_name, channel, body)
      VALUES (${spaceId}, ${authorId}, ${authorName}, ${channel}, ${body})
    `.catch((err: unknown) => console.error("[chat] persist failed:", err));
  }

  async recent(spaceId: string, limit: number): Promise<ChatRecord[]> {
    const rows = (await this.sql`
      SELECT author_id, author_name, channel, body, created_at
      FROM chat_messages
      WHERE space_id = ${spaceId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `) as {
      author_id: string;
      author_name: string;
      channel: string;
      body: string;
      created_at: Date;
    }[];
    return rows
      .map((r) => ({
        from: { id: r.author_id, name: r.author_name },
        channel: r.channel,
        body: r.body,
        ts: new Date(r.created_at).getTime(),
      }))
      .reverse(); // oldest-first for display
  }
}
