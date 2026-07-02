import { SQL } from "bun";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ServerEnv } from "@proximity/config";

export type Db = SQL;

/** Build a Postgres connection from env, or null if not configured. */
export function dbFromEnv(env: ServerEnv): Db | null {
  if (env.PG_URL) return new SQL(env.PG_URL);
  if (!env.PG_HOST || !env.PG_DB || !env.PG_USER) return null;
  const pw = env.PG_PASSWORD ?? "";
  const url = `postgres://${env.PG_USER}:${encodeURIComponent(pw)}@${env.PG_HOST}:${env.PG_PORT}/${env.PG_DB}`;
  return new SQL(url);
}

/**
 * Apply any unapplied SQL files in infra/migrations, tracked in "proximityMigrations".
 * In a host-shared database (PG_MIGRATE=false) the host's Lockstep pg-models own the schema
 * and this is skipped entirely; the DDL is IF NOT EXISTS + shape-identical either way.
 */
export async function migrate(sql: Db): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS "proximityMigrations" (
    "name" text PRIMARY KEY,
    "applied" timestamptz NOT NULL DEFAULT now()
  )`;
  const dir = fileURLToPath(new URL("../../../infra/migrations/", import.meta.url));
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const appliedRows = (await sql`SELECT "name" FROM "proximityMigrations"`) as { name: string }[];
  const applied = new Set(appliedRows.map((r) => r.name));

  for (const file of files) {
    if (applied.has(file)) continue;
    const content = readFileSync(dir + file, "utf8");
    await sql.unsafe(content);
    await sql`INSERT INTO "proximityMigrations" ("name") VALUES (${file})`;
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
      INSERT INTO "proximityRecordings" ("egressId", "spaceId", "presenterId", "status")
      VALUES (${egressId}, ${spaceId}, ${presenterId}, 'recording')
      ON CONFLICT ("egressId") DO UPDATE SET "status" = 'recording'
    `;
  }

  async ended(
    egressId: string,
    status: string,
    s3VideoKey: string | null,
    durationMs: number | null,
  ): Promise<void> {
    await this.db`
      UPDATE "proximityRecordings"
      SET "status" = ${status}, "s3VideoKey" = ${s3VideoKey}, "durationMs" = ${durationMs}, "ended" = now()
      WHERE "egressId" = ${egressId}
    `;
  }

  async pendingPostProcess(limit: number): Promise<RecordingRow[]> {
    const rows = (await this.db`
      SELECT "egressId", "spaceId", "status", "s3VideoKey", "durationMs", "started", "ended"
      FROM "proximityRecordings"
      WHERE "status" = 'complete'
      ORDER BY "ended" ASC NULLS LAST
      LIMIT ${limit}
    `) as any[];
    return rows.map((r) => ({
      egressId: r.egressId,
      spaceId: r.spaceId,
      status: r.status,
      s3VideoKey: r.s3VideoKey,
      durationMs: r.durationMs ? Number(r.durationMs) : null,
      startedAt: new Date(r.started).getTime(),
      endedAt: r.ended ? new Date(r.ended).getTime() : null,
    }));
  }

  async markPostProcessed(
    egressId: string,
    transcriptKey: string | null,
    thumbnailKey: string | null,
    summary: string | null,
  ): Promise<void> {
    await this.db`
      UPDATE "proximityRecordings"
      SET "status" = 'processed', "transcriptKey" = ${transcriptKey},
          "thumbnailKey" = ${thumbnailKey}, "summary" = ${summary}
      WHERE "egressId" = ${egressId}
    `;
  }
}

/** Postgres-backed chat store. */
export class PgChatStore implements ChatStore {
  constructor(private readonly sql: Db) {}

  append(spaceId: string, authorId: string, authorName: string, channel: string, body: string): void {
    this.sql`
      INSERT INTO "proximityChatMessages" ("spaceId", "authorId", "authorName", "channel", "body")
      VALUES (${spaceId}, ${authorId}, ${authorName}, ${channel}, ${body})
    `.catch((err: unknown) => console.error("[chat] persist failed:", err));
  }

  async recent(spaceId: string, limit: number): Promise<ChatRecord[]> {
    const rows = (await this.sql`
      SELECT "authorId", "authorName", "channel", "body", "created"
      FROM "proximityChatMessages"
      WHERE "spaceId" = ${spaceId}
      ORDER BY "created" DESC
      LIMIT ${limit}
    `) as {
      authorId: string;
      authorName: string;
      channel: string;
      body: string;
      created: Date;
    }[];
    return rows
      .map((r) => ({
        from: { id: r.authorId, name: r.authorName },
        channel: r.channel,
        body: r.body,
        ts: new Date(r.created).getTime(),
      }))
      .reverse(); // oldest-first for display
  }
}
