-- Proximity initial schema.
-- Lockstep-style naming (quoted camelCase, proximity* prefix) so the SAME tables can live either
-- in Proximity's own database (standalone/on-prem) or inside a host's shared database, where the
-- host defines them as Lockstep pg-models (lyku.org monolith DB, lyku.co backend DB). Keep this
-- file shape-equivalent to those models.

CREATE TABLE IF NOT EXISTS "proximitySpaces" (
  "id"      text PRIMARY KEY,
  "name"    text NOT NULL DEFAULT '',
  "config"  jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "proximityChatMessages" (
  "id"         bigserial PRIMARY KEY,
  "spaceId"    text NOT NULL,
  "authorId"   text NOT NULL,
  "authorName" text NOT NULL,
  "channel"    text NOT NULL DEFAULT 'space',
  "body"       text NOT NULL,
  "created"    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_proximityChatMessages_space_created"
  ON "proximityChatMessages" ("spaceId", "created" DESC);

-- Recordings metadata (populated via LiveKit Egress webhooks).
CREATE TABLE IF NOT EXISTS "proximityRecordings" (
  "id"            bigserial PRIMARY KEY,
  "spaceId"       text NOT NULL,
  "egressId"      text UNIQUE,
  "presenterId"   text,
  "status"        text NOT NULL DEFAULT 'starting',
  "s3VideoKey"    text,
  "s3AudioKey"    text,
  "transcriptKey" text,
  "thumbnailKey"  text,
  "summary"       text,
  "durationMs"    bigint,
  "started"       timestamptz NOT NULL DEFAULT now(),
  "ended"         timestamptz
);
