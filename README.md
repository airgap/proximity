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
