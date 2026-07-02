import { S3Client, SQL } from "bun";
import { loadServerEnv } from "@proximity/config";
import { toVtt, transcribeRecording } from "./transcribe.ts";
import { generateNote, noteToMarkdown } from "./notetaker.ts";

/**
 * Recording post-processing worker.
 *
 * Polls Postgres for recordings marked `complete` (by the egress webhook), pulls the file from
 * S3-compatible storage, runs the Parabun DSP pipeline (decode -> mono/16k -> whisper transcript
 * -> WebVTT, plus an optional LLM summary), uploads artifacts, and marks the row `processed`.
 * Decoupled from the world server so it can scale (and use a GPU) independently.
 */
const env = loadServerEnv();

if (!env.PG_URL && (!env.PG_HOST || !env.PG_DB || !env.PG_USER)) {
  console.error("[worker] Postgres not configured (PG_URL or PG_HOST/PG_DB/PG_USER). Exiting.");
  process.exit(1);
}
if (!env.S3_BUCKET) {
  console.error("[worker] S3 bucket not configured. Exiting.");
  process.exit(1);
}

const sql = new SQL(
  env.PG_URL ??
    `postgres://${env.PG_USER}:${encodeURIComponent(env.PG_PASSWORD ?? "")}@${env.PG_HOST}:${env.PG_PORT}/${env.PG_DB}`,
);
const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  accessKeyId: env.S3_ACCESS_KEY,
  secretAccessKey: env.S3_SECRET_KEY,
  bucket: env.S3_BUCKET,
  region: env.S3_REGION,
});

async function hmacHex(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** POST the generated note to the host's receiver (lyku channel bot, on-prem sink, …), signed. */
async function postNote(payload: unknown): Promise<void> {
  if (!env.NOTETAKER_WEBHOOK_URL) return;
  try {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (env.PROXIMITY_GRANT_SECRET) {
      headers["x-proximity-signature"] = await hmacHex(body, env.PROXIMITY_GRANT_SECRET);
    }
    await fetch(env.NOTETAKER_WEBHOOK_URL, { method: "POST", headers, body });
  } catch (err) {
    console.error("[worker] notetaker webhook failed:", err);
  }
}

interface Row {
  egress_id: string;
  space_id: string | null;
  presenter_id: string | null;
  s3_video_key: string | null;
  duration_ms: string | number | null;
}

async function processOne(row: Row): Promise<void> {
  const { egress_id, s3_video_key, space_id, presenter_id } = row;
  // Nothing to transcribe without a file or a model — mark processed so we don't spin on it.
  if (!s3_video_key || !env.WHISPER_MODEL) {
    await sql`UPDATE recordings SET status='processed' WHERE egress_id=${egress_id}`;
    return;
  }
  try {
    const bytes = new Uint8Array(await s3.file(s3_video_key).arrayBuffer());
    const text = await transcribeRecording(bytes, env.WHISPER_MODEL);
    const base = s3_video_key.replace(/\.[^.]+$/, "");

    const transcriptKey = `${base}.vtt`;
    await s3.write(transcriptKey, toVtt(text, Number(row.duration_ms ?? 0)));

    // Notetaker: structured note (LLM if configured, else extractive) -> markdown artifact.
    const note = await generateNote(text, { llmModel: env.LLM_MODEL });
    const notesKey = `${base}.notes.md`;
    await s3.write(notesKey, noteToMarkdown(note, { spaceId: space_id ?? undefined, transcriptRef: transcriptKey }));

    await sql`
      UPDATE recordings
      SET status='processed', transcript_key=${transcriptKey}, summary=${note.summary}
      WHERE egress_id=${egress_id}
    `;
    await postNote({ egressId: egress_id, spaceId: space_id, presenterId: presenter_id, note, transcriptKey, notesKey });
    console.log(
      `[worker] processed ${egress_id}: ${text.length} chars, ${note.actionItems.length} action item(s) [${note.engine}] -> ${notesKey}`,
    );
  } catch (err) {
    console.error(`[worker] failed ${egress_id}:`, err);
    await sql`UPDATE recordings SET status='process_failed' WHERE egress_id=${egress_id}`;
  }
}

async function tick(): Promise<void> {
  const rows = (await sql`
    SELECT egress_id, space_id, presenter_id, s3_video_key, duration_ms
    FROM recordings
    WHERE status='complete'
    ORDER BY ended_at ASC NULLS LAST
    LIMIT 3
  `) as Row[];
  for (const row of rows) await processOne(row);
}

console.log(
  `[worker] recording post-processor started` +
    (env.WHISPER_MODEL ? ` (whisper: ${env.WHISPER_MODEL})` : " (no whisper model; transcription disabled)") +
    ` (notetaker: ${env.LLM_MODEL ? "llm" : "extractive"}${env.NOTETAKER_WEBHOOK_URL ? " ->webhook" : ""})`,
);
await tick();
setInterval(() => void tick(), env.WORKER_POLL_MS);
