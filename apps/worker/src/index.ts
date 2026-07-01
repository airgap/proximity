import { S3Client, SQL } from "bun";
import { loadServerEnv } from "@proximity/config";
import { toVtt, transcribeRecording } from "./transcribe.ts";

/**
 * Recording post-processing worker.
 *
 * Polls Postgres for recordings marked `complete` (by the egress webhook), pulls the file from
 * S3-compatible storage, runs the Parabun DSP pipeline (decode -> mono/16k -> whisper transcript
 * -> WebVTT, plus an optional LLM summary), uploads artifacts, and marks the row `processed`.
 * Decoupled from the world server so it can scale (and use a GPU) independently.
 */
const env = loadServerEnv();

if (!env.PG_HOST || !env.PG_DB || !env.PG_USER) {
  console.error("[worker] Postgres not configured (PG_HOST/PG_DB/PG_USER). Exiting.");
  process.exit(1);
}
if (!env.S3_BUCKET) {
  console.error("[worker] S3 bucket not configured. Exiting.");
  process.exit(1);
}

const sql = new SQL(
  `postgres://${env.PG_USER}:${encodeURIComponent(env.PG_PASSWORD ?? "")}@${env.PG_HOST}:${env.PG_PORT}/${env.PG_DB}`,
);
const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  accessKeyId: env.S3_ACCESS_KEY,
  secretAccessKey: env.S3_SECRET_KEY,
  bucket: env.S3_BUCKET,
  region: env.S3_REGION,
});

async function summarize(text: string): Promise<string | null> {
  if (!env.LLM_MODEL) return null;
  try {
    // @ts-expect-error - parabun builtin module (no TS types)
    const llm = (await import("parabun:llm")).default;
    const model = await llm.LLM.load(env.LLM_MODEL);
    let out = "";
    for await (const piece of model.chat([
      {
        role: "user",
        content: `Summarize this meeting transcript in 3 concise bullet points:\n\n${text.slice(0, 6000)}`,
      },
    ])) {
      out += piece;
    }
    (model.close ?? model[Symbol.dispose])?.call(model);
    return out.trim() || null;
  } catch (err) {
    console.error("[worker] summary failed:", err);
    return null;
  }
}

async function processOne(row: {
  egress_id: string;
  s3_video_key: string | null;
  duration_ms: string | number | null;
}): Promise<void> {
  const { egress_id, s3_video_key } = row;
  // Nothing to transcribe without a file or a model — mark processed so we don't spin on it.
  if (!s3_video_key || !env.WHISPER_MODEL) {
    await sql`UPDATE recordings SET status='processed' WHERE egress_id=${egress_id}`;
    return;
  }
  try {
    const bytes = new Uint8Array(await s3.file(s3_video_key).arrayBuffer());
    const text = await transcribeRecording(bytes, env.WHISPER_MODEL);
    const vtt = toVtt(text, Number(row.duration_ms ?? 0));
    const transcriptKey = s3_video_key.replace(/\.[^.]+$/, "") + ".vtt";
    await s3.write(transcriptKey, vtt);

    const summary = await summarize(text);

    await sql`
      UPDATE recordings
      SET status='processed', transcript_key=${transcriptKey}, summary=${summary}
      WHERE egress_id=${egress_id}
    `;
    console.log(`[worker] processed ${egress_id}: ${text.length} chars -> ${transcriptKey}`);
  } catch (err) {
    console.error(`[worker] failed ${egress_id}:`, err);
    await sql`UPDATE recordings SET status='process_failed' WHERE egress_id=${egress_id}`;
  }
}

async function tick(): Promise<void> {
  const rows = (await sql`
    SELECT egress_id, s3_video_key, duration_ms
    FROM recordings
    WHERE status='complete'
    ORDER BY ended_at ASC NULLS LAST
    LIMIT 3
  `) as { egress_id: string; s3_video_key: string | null; duration_ms: string | number | null }[];
  for (const row of rows) await processOne(row);
}

console.log(
  `[worker] recording post-processor started` +
    (env.WHISPER_MODEL ? ` (whisper: ${env.WHISPER_MODEL})` : " (no whisper model; transcription disabled)") +
    (env.LLM_MODEL ? " (+summary)" : ""),
);
await tick();
setInterval(() => void tick(), env.WORKER_POLL_MS);
