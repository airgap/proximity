-- Proximity initial schema.
-- Phase 3 uses chat_messages; the rest are created now so later phases have them ready.

CREATE TABLE IF NOT EXISTS spaces (
  id          text PRIMARY KEY,
  name        text NOT NULL DEFAULT '',
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id          bigserial PRIMARY KEY,
  space_id    text NOT NULL,
  author_id   text NOT NULL,
  author_name text NOT NULL,
  channel     text NOT NULL DEFAULT 'space',
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_messages_space_created_idx
  ON chat_messages (space_id, created_at DESC);

-- Recordings metadata (populated in phase 4 via LiveKit Egress webhooks).
CREATE TABLE IF NOT EXISTS recordings (
  id             bigserial PRIMARY KEY,
  space_id       text NOT NULL,
  egress_id      text UNIQUE,
  presenter_id   text,
  status         text NOT NULL DEFAULT 'starting',
  s3_video_key   text,
  s3_audio_key   text,
  transcript_key text,
  thumbnail_key  text,
  summary        text,
  duration_ms    bigint,
  started_at     timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz
);
