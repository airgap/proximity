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

// ---------------------------------------------------------------------------
// Recording store (LiveKit Egress metadata)
// ---------------------------------------------------------------------------

export interface RecordingRow {
  egressId: string;
  spaceId: string;
  status: string;
  s3VideoKey: string | null;
  durationMs: number | null;
  startedAt: number;
  endedAt: number | null;
}

export interface RecordingStore {
  /** Called from the egress_started webhook. Idempotent. */
  started(egressId: string, spaceId: string, presenterId: string | null): Promise<void>;
  /** Called from the egress_ended webhook. */
  ended(egressId: string, status: string, s3VideoKey: string | null, durationMs: number | null): Promise<void>;
  /** Rows whose post-processing hasn't run yet (status = 'complete'). */
  pendingPostProcess(limit: number): Promise<RecordingRow[]>;
  markPostProcessed(egressId: string, transcriptKey: string | null, thumbnailKey: string | null, summary: string | null): Promise<void>;
  get sql(): Db;
}

export class PgRecordingStore implements RecordingStore {
  constructor(private readonly db: Db) {}

  get sql(): Db {
    return this.db;
  }

  async started(egressId: string, spaceId: string, presenterId: string | null): Promise<void> {
    await this.db`
      INSERT INTO recordings (egress_id, space_id, presenter_id, status)
      VALUES (${egressId}, ${spaceId}, ${presenterId}, 'recording')
      ON CONFLICT (egress_id) DO UPDATE SET status = 'recording'
    `;
  }

  async ended(
    egressId: string,
    status: string,
    s3VideoKey: string | null,
    durationMs: number | null,
  ): Promise<void> {
    await this.db`
      UPDATE recordings
      SET status = ${status}, s3_video_key = ${s3VideoKey}, duration_ms = ${durationMs}, ended_at = now()
      WHERE egress_id = ${egressId}
    `;
  }

  async pendingPostProcess(limit: number): Promise<RecordingRow[]> {
    const rows = (await this.db`
      SELECT egress_id, space_id, status, s3_video_key, duration_ms, started_at, ended_at
      FROM recordings
      WHERE status = 'complete'
      ORDER BY ended_at ASC NULLS LAST
      LIMIT ${limit}
    `) as any[];
    return rows.map((r) => ({
      egressId: r.egress_id,
      spaceId: r.space_id,
      status: r.status,
      s3VideoKey: r.s3_video_key,
      durationMs: r.duration_ms ? Number(r.duration_ms) : null,
      startedAt: new Date(r.started_at).getTime(),
      endedAt: r.ended_at ? new Date(r.ended_at).getTime() : null,
    }));
  }

  async markPostProcessed(
    egressId: string,
    transcriptKey: string | null,
    thumbnailKey: string | null,
    summary: string | null,
  ): Promise<void> {
    await this.db`
      UPDATE recordings
      SET status = 'processed', transcript_key = ${transcriptKey},
          thumbnail_key = ${thumbnailKey}, summary = ${summary}
      WHERE egress_id = ${egressId}
    `;
  }
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
