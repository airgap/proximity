/**
 * @proximity/config — one env surface for every deployment (local / on-prem / AWS / CF+DO).
 *
 * The server/worker call `loadServerEnv()` at boot; it validates with zod and FAILS FAST with a
 * readable error if anything required is missing. This is the guardrail that makes "same
 * container, different .env" safe. Feature groups (Postgres, Redis, LiveKit, S3) are optional so
 * the movement-only walking skeleton boots with zero external services.
 */
import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const ServerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // World server
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(8080),
  /** Comma-free public origin allowed for browser CORS/WS (dev default permits localhost). */
  PUBLIC_WEB_ORIGIN: z.string().default("http://localhost:5173"),

  // Redis (presence/pubsub + multi-node). Optional: single-node skeleton runs without it.
  REDIS_URL: z.string().optional(),

  // Postgres (durable data). Optional until phase 2.
  PG_HOST: z.string().optional(),
  PG_PORT: z.coerce.number().int().positive().default(5432),
  PG_DB: z.string().optional(),
  PG_USER: z.string().optional(),
  PG_PASSWORD: z.string().optional(),

  // LiveKit (media). Optional until phase 2.
  LIVEKIT_URL: z.string().optional(),
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),

  // S3-compatible object storage (recordings/assets). Optional until phase 4.
  // Endpoint empty => AWS S3 virtual-hosted; set + force-path-style for MinIO/DO Spaces.
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default("false"),
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

export function loadServerEnv(source: Record<string, string | undefined> = process.env): ServerEnv {
  const parsed = ServerEnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Gameplay / spatial tunables (defaults; a space may override via its DB record).
// Kept here so the client (via `welcome`) and server share one source of truth.
// ---------------------------------------------------------------------------

export const DEFAULT_SPACE_CONFIG = {
  tickRate: 20,
  snapshotRate: 10,
  audioRadius: 8,
  videoRadius: 5,
  aoiRadius: 12,
  maxSpeed: 6,
} as const;

/** Hysteresis: an entity must move this many tiles PAST a radius before the exit fires. */
export const RADIUS_HYSTERESIS = 1.5;

/** Flat full-volume inner radius for the audio falloff curve, in tiles. */
export const AUDIO_INNER_RADIUS = 1.5;
