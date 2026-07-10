# Deploying Proximity

One portable Docker Compose stack, four targets. The **base** is `docker-compose.yml`
(LiveKit, Egress, and — under the `storage` profile — Postgres/Redis/MinIO). The **app** layer
is `docker-compose.app.yml` (world-server, worker, web, Caddy). Each environment adds one override.

## The one rule that governs everything: media cannot be proxied

WebRTC media is SRTP over **UDP** (with ICE/TCP fallback). Reverse proxies — and **Cloudflare's
proxy and Tunnel** — do not carry it. In every environment the browser must reach **LiveKit/TURN
directly on a reachable IP**, and the firewall/LB must pass:

| Port | Proto | Purpose | Through Caddy/CF? |
|------|-------|---------|-------------------|
| 443 | TCP | web + WSS signaling | yes |
| 7881 | TCP | LiveKit ICE/TCP fallback | **no** |
| 7882 | UDP | LiveKit media (ICE/UDP mux) | **no** |
| 3478 / 5349(→443) | UDP/TCP | STUN/TURN/TURNS | **no** |

For locked-down corporate networks, run **TURNS on 443 on a dedicated IP**. Validate with
`iceTransportPolicy: 'relay'` from a representative office network before launch.

## Local dev

Backing services in Docker, app run natively (hot reload):
```bash
cd deploy && docker compose -f docker-compose.yml -f docker-compose.local.yml --profile storage up -d
# then, from repo root:  parabun run dev:server   and   parabun run dev:web
```
Or the full stack in containers:
```bash
cd deploy && docker compose -f docker-compose.yml -f docker-compose.app.yml \
  -f docker-compose.local.yml --profile storage up --build
```

## AWS (pure)

EC2 running the same containers; managed RDS + ElastiCache + S3 (no `storage` profile).
```bash
docker compose -f docker-compose.yml -f docker-compose.app.yml -f docker-compose.aws.yml up -d
```
`.env`: `PG_HOST=<rds>`, `REDIS_URL=redis://<elasticache>`, `S3_ENDPOINT=` (empty → AWS S3),
`S3_FORCE_PATH_STYLE=false`, `PUBLIC_HOST=<app domain>`, `LIVEKIT_URL=wss://media.<domain>`,
`LIVEKIT_API_SECRET=<strong>`. LB: **ALB** (WebSocket) → Caddy:443; **NLB** (L4) → LiveKit
UDP 7882 + TCP 7881/5349 (ALB can't do UDP). Edit `livekit/livekit.prod.yaml` keys/TURN domain.

## Cloudflare + DigitalOcean

DO Droplets + DO Spaces + DO Managed DBs.
```bash
docker compose -f docker-compose.yml -f docker-compose.app.yml -f docker-compose.cfdo.yml up -d
```
`.env`: `S3_ENDPOINT=https://<region>.digitaloceanspaces.com`, `S3_FORCE_PATH_STYLE=true`,
`PG_HOST=<managed>`, `REDIS_URL=redis://<managed>`, `PUBLIC_HOST=<app domain>`,
`LIVEKIT_URL=wss://media.<domain>`. **Cloudflare**: orange-cloud the web app + signaling;
the media host **must be a DNS-only (grey-cloud) A record to the media droplet's public IP**
(UDP Spectrum is Enterprise-only).

## On-prem / air-gapped

Everything inside the perimeter; recordings stay in MinIO (`storage` profile on).
```bash
docker compose -f docker-compose.yml -f docker-compose.app.yml -f docker-compose.onprem.yml \
  --profile storage up -d
```
TLS: Caddy internal CA (distribute its root) or mount enterprise PKI certs (see
`caddy/Caddyfile.onprem`). Offline images: `scripts/build-airgap-bundle.sh` → carry the
`.tar.zst` through the airlock → `LOAD.sh`.

## GPU (optional, additive)

Append `-f docker-compose.gpu.yml` to accelerate worker whisper/LLM and egress transcode.
Requires the NVIDIA driver + `nvidia-container-toolkit`. Omit it and the same images run CPU-only
(Parabun dlopen's CUDA lazily).

## Recording post-processing models

The `worker` transcribes recordings with whisper and (optionally) summarizes with an LLM. Mount
model files and set `WHISPER_MODEL` / `LLM_MODEL` (and `MODELS_DIR` for the mount). Without a
whisper model, recordings are still stored — just not transcribed.

## CI redeploy (spatial.lyku.co)

Every push to `main` builds the app images to GHCR
(`ghcr.io/<owner>/proximity-{server,web,worker}`) and then redeploys them on the
droplet — no manual SSH. The `deploy` job (`.github/workflows/build.yml` →
`deploy/ci-deploy.sh`) rsyncs the current `deploy/` config to the droplet (keeping
its `.env`) and, for the stateless services only, runs:

```bash
IMAGE_PREFIX=ghcr.io/<owner>/ TAG=<sha> \
  docker compose -f docker-compose.yml -f docker-compose.app.yml -f docker-compose.cfdo.yml \
  pull server web worker && ... up -d --no-deps server web worker
```

Stateful services (postgres, redis, livekit) and the locally-built `recorder`
(env-specific `VITE_WORLD_WS` build arg) are never touched. The compose image refs
gained an `${IMAGE_PREFIX-}` prefix that is **empty by default**, so a local
`docker compose ... build` / air-gapped install is unchanged; only CI sets it.

### One-time setup

1. **Make the GHCR packages public** so the droplet can pull without logging in:
   for each of `proximity-server`, `proximity-web`, `proximity-worker` under the
   org's Packages, Package settings → Change visibility → Public. (Or run the
   droplet `docker login ghcr.io` instead and keep them private.)
2. **Doppler**: put the droplet's deploy secrets in a config, then add its Service
   Token as the GitHub repo secret `DOPPLER_TOKEN`. Required Doppler keys:
   - `DEPLOY_HOST` — droplet host or IP
   - `DEPLOY_USER` — ssh user (must be in the `docker` group)
   - `DEPLOY_PATH` — dir on the droplet holding this repo (its `deploy/` is synced)
   - `DEPLOY_SSH_KEY` — the private key (full PEM), whose public half is in the
     droplet user's `authorized_keys`
   - optional `DEPLOY_COMPOSE` / `DEPLOY_SERVICES` to override the `-f` file list
     or which services redeploy.

Without `DOPPLER_TOKEN` the `deploy` job is a no-op (forks and un-configured
clones just build images), matching how `DIGITALOCEAN_ACCESS_TOKEN` gates the
build step.
