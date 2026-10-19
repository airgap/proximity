# Proximity

Gather.town-style spatial collaboration for on-prem / corporate networks: a 2D world you walk
an avatar around, with proximity-based audio/video, text chat, screenshare, and a presentation
mode (screenshare + collaborative draw-over annotation + recording).

Built to run **the same containers** locally, on-prem (incl. air-gapped), on pure AWS, or on
Cloudflare + DigitalOcean.

## Architecture

Three subsystems bound by one contract (`userId` == LiveKit participant `identity`):

1. **World server** (`apps/server`, Parabun `Bun.serve` WS) — authoritative avatar positions,
   presence, chat, annotation relay. Computes the proximity graph and pushes edge-triggered
   diffs to clients.
2. **Media** (LiveKit SFU) — one room per space; clients selectively subscribe + set audio gain
   driven by the world server's proximity events. Screenshare, presentation, and recording live
   in that same room.
3. **Deployment** (`deploy/`) — portable Docker Compose with per-environment overrides.

See `docs/` and the plan for full detail.

## Workspace layout

```
packages/protocol  — wire types + binary snapshot codec (single source of truth)
packages/spatial   — AOI grid, falloff math, computeGains (CPU / pmap / gpu backends)
packages/config    — zod-validated env loader
apps/server        — real-time world server (Parabun)
apps/web           — React + PixiJS client
apps/recorder      — custom LiveKit egress template (screenshare + annotations)
apps/worker        — async recording post-processing (Parabun DSP)
apps/loadgen       — synthetic WS clients for load testing
deploy/            — docker-compose + Caddy + LiveKit + coturn config
```

## Requirements

- [Parabun](https://github.com/airgap/parabun) (a Bun fork) — `parabun` / `pb` on PATH
- Docker + Docker Compose (for the backing services)

## Quick start (dev)

```bash
parabun install                    # install workspace deps
parabun run infra:up               # postgres + redis + livekit + minio (background services)
parabun run dev:server             # world server on :8080
parabun run dev:web                # web client on :5173
```

Open two browser tabs at the web client and walk the avatars together.

## Reliable meeting-note delivery

The worker commits a `note_deliveries` outbox payload together with the recording's
`processed` status. `processed` means artifacts are ready, not that the host has
received them. Delivery runs at startup and on every poll, including when there are
no new recordings. With no `NOTETAKER_WEBHOOK_URL`, notes stay pending for later.
Apply `infra/migrations/002_note_deliveries.sql` through the normal migration workflow
before running this worker. This change does not apply migrations itself.

Each poll drains at most six notes (three before and three after processing).
Requests time out after 10 seconds; any non-2xx response or network failure is retried
with persisted exponential backoff (30 seconds up to one hour), at most eight
attempts. A 60-second lease prevents normal concurrent workers from claiming the
same row; an expired lease recovers after restart. Failed rows retain the payload
for inspection and deliberate operator retry. Inspect `status`, `attempts`,
`next_attempt_at`, and `last_error` in `note_deliveries`; resetting a failed row to
`pending` with `attempts=0` and `next_attempt_at=now()` is a deliberate replay.

**Receiver coordination is required:** every retry sends the same signed body,
`deliveryId` and `Idempotency-Key: proximity-note:<egressId>`. The host must durably
deduplicate that ID atomically with inserting the host-chat note, and acknowledge
only after durable acceptance. A lost acknowledgement or expired lease can cause
duplicate requests; this worker provides at-least-once attempts, not exactly-once
chat insertion. Confirm the receiver contract before rollout. The receiver lives
outside this repository. Already processed recordings predate the outbox and are
not automatically backfilled; recovering those notes needs a separate reviewed
replay plan using their existing stored artifacts.

**Before scaling recording processing:** run one recording-processing worker.
The poll loop prevents overlap within one process, but the existing selection of
`complete` recordings does not claim them across workers. Concurrent processors
can overwrite the same S3 transcript/note keys while the outbox retains the first
accepted payload and metadata. Add recording-level claims or immutable artifact
keys before scaling processing across workers. Outbox delivery leases alone do
not resolve this existing artifact race.

Focused tests (no network/model/services):

```sh
parabun test apps/worker/src/delivery.test.ts
```

`delivery.pg.test.ts` additionally exercises the actual PostgreSQL migration,
atomic rollback, competing claims, expired/stale leases, persisted retry limits,
and a fresh connection after restart. It runs only with
`PROXIMITY_TEST_PG_SOCKET` pointing at an owned
`/tmp/proximity-outbox-<alphanumeric>/socket/.s.PGSQL.5432` cluster initialized with
user `outbox_test`. It ignores ambient database connection variables. Never point
it at a shared database.
