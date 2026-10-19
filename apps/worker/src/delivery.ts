import type { SQL } from "bun";

export const MAX_ATTEMPTS = 8;
export const LEASE_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 10_000;
export const retryDelay = (attempt: number) => Math.min(3_600_000, 30_000 * 2 ** (attempt - 1));

export interface Delivery {
  egress_id: string;
  payload: string;
  attempts: number;
  lease_token: string;
}

export class PgNoteOutbox {
  constructor(private readonly sql: SQL) {}

  /** Saving the payload and completing processing commit together, or neither does. */
  async enqueue(egressId: string, payload: unknown, transcriptKey: string, summary: string): Promise<void> {
    const body = JSON.stringify(payload);
    await this.sql`
      WITH queued AS (
        INSERT INTO note_deliveries (egress_id, payload)
        VALUES (${egressId}, ${body}) ON CONFLICT (egress_id) DO NOTHING
      )
      UPDATE recordings SET status='processed', transcript_key=${transcriptKey}, summary=${summary}
      WHERE egress_id=${egressId}
    `;
  }

  async claim(): Promise<Delivery | undefined> {
    // A worker may die during its final attempt. Retain that row for operator recovery.
    await this.sql`
      UPDATE note_deliveries SET status='failed', lease_token=NULL,
        last_error='Attempt limit reached; final delivery outcome may be uncertain'
      WHERE status='pending' AND attempts >= ${MAX_ATTEMPTS} AND next_attempt_at <= now()
    `;
    const token = crypto.randomUUID();
    const rows = await this.sql`
      WITH candidate AS (
        SELECT egress_id FROM note_deliveries
        WHERE status='pending' AND attempts < ${MAX_ATTEMPTS} AND next_attempt_at <= now()
        ORDER BY next_attempt_at, egress_id FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE note_deliveries AS d SET attempts=d.attempts+1, lease_token=${token},
        next_attempt_at=now() + ${LEASE_MS} * interval '1 millisecond'
      FROM candidate WHERE d.egress_id=candidate.egress_id
      RETURNING d.egress_id, d.payload, d.attempts, d.lease_token
    `;
    return rows[0] as Delivery | undefined;
  }

  async delivered(row: Delivery): Promise<void> {
    await this.sql`
      UPDATE note_deliveries SET status='delivered', delivered_at=now(), lease_token=NULL, last_error=NULL
      WHERE egress_id=${row.egress_id} AND lease_token=${row.lease_token} AND status='pending'
    `;
  }

  async failed(row: Delivery, error: unknown): Promise<void> {
    // Persist a bounded diagnostic, without response bodies or credential-bearing URLs.
    const message = error instanceof Error ? error.name : "DeliveryError";
    await this.sql`
      UPDATE note_deliveries SET status=${row.attempts >= MAX_ATTEMPTS ? "failed" : "pending"},
        next_attempt_at=now() + ${retryDelay(row.attempts)} * interval '1 millisecond',
        lease_token=NULL, last_error=${message}
      WHERE egress_id=${row.egress_id} AND lease_token=${row.lease_token} AND status='pending'
    `;
  }
}

export async function hmacHex(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return [...signature].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function postNote(row: Delivery, url: string, secret?: string,
  fetcher: typeof fetch = fetch, timeoutMs = REQUEST_TIMEOUT_MS): Promise<void> {
  const headers: Record<string, string> = {
    "content-type": "application/json", "idempotency-key": `proximity-note:${row.egress_id}`,
  };
  if (secret) headers["x-proximity-signature"] = await hmacHex(row.payload, secret);
  const response = await fetcher(url, {
    method: "POST", headers, body: row.payload, signal: AbortSignal.timeout(timeoutMs),
  });
  // Release the connection even when the receiver returns a large or streaming body.
  await response.body?.cancel();
  if (!response.ok) {
    const error = new Error(`Note delivery HTTP ${response.status}`);
    error.name = `DeliveryHTTP${response.status}`;
    throw error;
  }
}

export async function drainNotes(outbox: Pick<PgNoteOutbox, "claim" | "delivered" | "failed">,
  url: string | undefined, secret?: string, send = postNote): Promise<void> {
  if (!url) return; // Keep pending notes until a receiver is configured.
  for (let i = 0; i < 3; i++) {
    const row = await outbox.claim();
    if (!row) return;
    try {
      await send(row, url, secret);
      await outbox.delivered(row);
    } catch (error) {
      await outbox.failed(row, error);
      console.error(`[worker] note delivery attempt ${row.attempts} failed for ${row.egress_id}`);
    }
  }
}
