import { expect, test } from "bun:test";
import { SQL } from "bun";
import { readFile } from "node:fs/promises";
import { PgNoteOutbox, MAX_ATTEMPTS, drainNotes } from "./delivery.ts";

// Never use ambient DATABASE_URL/PG* settings. Only an explicitly owned temporary
// Unix socket is accepted; normal unit-test runs do not connect to any database.
const socket = process.env.PROXIMITY_TEST_PG_SOCKET;
if (socket && !/^\/tmp\/proximity-outbox-[A-Za-z0-9]+\/socket\/\.s\.PGSQL\.5432$/.test(socket)) {
  throw new Error("Expected an isolated /tmp/proximity-outbox-* Unix socket");
}
const integration = socket ? test : test.skip;
integration("Postgres outbox: atomic enqueue, concurrent leases, restart recovery, bounded retries", async () => {
  const connect = () => new SQL({ adapter: "postgres", path: socket!, username: "outbox_test", database: "postgres", max: 2 });
  let db = connect();
  try {
    await db.unsafe(await readFile(new URL("../../../infra/migrations/001_init.sql", import.meta.url), "utf8"));
    await db.unsafe(await readFile(new URL("../../../infra/migrations/002_note_deliveries.sql", import.meta.url), "utf8"));
    await db`INSERT INTO recordings (egress_id,space_id,status) VALUES ('fixture','space','complete')`;
    let outbox = new PgNoteOutbox(db);
    // A storage error must not commit processed status without a pending payload.
    await db.unsafe(`CREATE FUNCTION reject_note() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$;
      CREATE TRIGGER reject_note BEFORE INSERT ON note_deliveries FOR EACH ROW EXECUTE FUNCTION reject_note();`);
    await expect(outbox.enqueue("fixture", { note: "fixture" }, "vtt", "summary")).rejects.toThrow();
    expect((await db`SELECT status FROM recordings WHERE egress_id='fixture'`)[0].status).toBe("complete");
    expect((await db`SELECT * FROM note_deliveries`).length).toBe(0);
    await db.unsafe("DROP TRIGGER reject_note ON note_deliveries; DROP FUNCTION reject_note()");
    await outbox.enqueue("fixture", { note: "fixture" }, "vtt", "summary");
    await outbox.enqueue("fixture", { note: "changed duplicate" }, "changed-vtt", "changed-summary");
    expect((await db`SELECT status FROM recordings WHERE egress_id='fixture'`)[0].status).toBe("processed");
    expect((await db`SELECT payload FROM note_deliveries`)[0].payload).toBe('{"note":"fixture"}');
    const recording = (await db`SELECT transcript_key,summary FROM recordings WHERE egress_id='fixture'`)[0];
    expect(recording.transcript_key).toBe("vtt");
    expect(recording.summary).toBe("summary");
    const claims = (await Promise.all([outbox.claim(), outbox.claim()])).filter(x => x !== undefined);
    expect(claims.length).toBe(1);
    const crashed = claims[0]!;
    // Simulate process death: close the entire pool and construct a new worker.
    await db.close();
    db = connect(); outbox = new PgNoteOutbox(db);
    expect(await outbox.claim()).toBeUndefined();
    await db`UPDATE note_deliveries SET next_attempt_at=now()-interval '1 second'`;
    const recovered = (await outbox.claim())!;
    expect(recovered.attempts).toBe(2);
    expect(recovered.payload).toBe(crashed.payload);
    await outbox.delivered(crashed); // stale worker cannot acknowledge the new lease
    expect((await db`SELECT status FROM note_deliveries`)[0].status).toBe("pending");
    await outbox.failed(recovered, new Error("offline"));
    expect(await outbox.claim()).toBeUndefined(); // persisted backoff, no busy loop
    for (let attempt = 3; attempt <= MAX_ATTEMPTS; attempt++) {
      await db`UPDATE note_deliveries SET next_attempt_at=now()-interval '1 second'`;
      const next = (await outbox.claim())!;
      expect(next.attempts).toBe(attempt);
      await outbox.failed(next, new Error("offline"));
    }
    expect((await db`SELECT status FROM note_deliveries`)[0].status).toBe("failed");
    expect(await outbox.claim()).toBeUndefined();
    // Operator reset for fixture; verify final-attempt crash and successful restart.
    await db`UPDATE note_deliveries SET status='pending',attempts=${MAX_ATTEMPTS},next_attempt_at=now()-interval '1 second'`;
    expect(await outbox.claim()).toBeUndefined();
    expect((await db`SELECT status FROM note_deliveries`)[0].status).toBe("failed");
    await db`UPDATE note_deliveries SET status='pending',attempts=0,next_attempt_at=now()-interval '1 second'`;
    await db.close(); db = connect(); outbox = new PgNoteOutbox(db);
    await drainNotes(outbox, "fixture", undefined, async () => {});
    expect((await db`SELECT status, delivered_at FROM note_deliveries`)[0].status).toBe("delivered");
    expect(await outbox.claim()).toBeUndefined();
  } finally { await db.close(); }
});
