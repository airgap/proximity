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

Every push to `main` builds the app images to public GHCR
(`ghcr.io/<owner>/proximity-{server,web,worker}`) and then redeploys the app
containers on the droplet — no manual SSH. The `deploy` job
(`.github/workflows/build.yml` → `deploy/ci-deploy.sh`) SSHes in, derives the
compose invocation from the running `web` container's own labels (so it always
matches how the box is actually run, including the droplet-only
`docker-compose.co.yml` overlay), and for the stateless services only runs:

```bash
docker compose <the droplet's -f list> pull web world-server
docker compose <the droplet's -f list> up -d --no-deps web world-server
```

It never rsyncs over or rewrites the droplet's compose files or `.env`, and never
touches the stateful services (postgres, redis, livekit) or the locally-built
`recorder`. The images it pulls are whatever the droplet's `docker-compose.co.yml`
pins `web` + `world-server` to — see the cutover below.

### One-time setup

1. **Registry auth for the build.** The app Dockerfiles build `FROM
   registry.digitalocean.com/parabun/parabun`, so CI needs
   `DIGITALOCEAN_ACCESS_TOKEN` (repo secret) to pull the base image. Without it
   the whole `images` job's push step is skipped and no images are published.
2. **Make the GHCR packages public** so the droplet can pull without logging in:
   for each of `proximity-web`, `proximity-server` (and `proximity-worker` if you
   deploy it elsewhere) under the owner's Packages → Package settings → Change
   visibility → Public. (Packages only exist after the first successful build.)
3. **Point the droplet at GHCR (DOCR→GHCR cutover).** The live droplet historically
   pulled `registry.digitalocean.com/lyku/proximity-{web,server}:latest`. Once the
   public GHCR images exist (steps 1–2), edit the droplet's
   `/opt/proximity/deploy/docker-compose.co.yml` so `web.image` and
   `world-server.image` are `ghcr.io/<owner>/proximity-{web,server}:latest`
   (keep `pull_policy: always`), then `docker compose … pull web world-server &&
   … up -d --no-deps web world-server` once by hand to confirm the pull works.
   Do **not** do this before the GHCR images are public — a restart would fail to
   pull and take the app down.
4. **Doppler deploy secrets.** In project `ci` / config `prd`, set:
   - `API_IP` — droplet host or IP
   - `API_USER` — ssh user (must be in the `docker` group)
   - `API_SSH_KEY` — the private key (full PEM), whose public half is in the
     droplet user's `authorized_keys`

   Then add a Service Token for `ci`/`prd` as the GitHub repo secret
   `DOPPLER_TOKEN`.

Without `DOPPLER_TOKEN` the `deploy` job is a no-op (forks and un-configured
clones just build images), matching how `DIGITALOCEAN_ACCESS_TOKEN` gates the
build step. Until the step-3 cutover is done, the `deploy` job would pull the
droplet's still-DOCR `:latest`, so complete the cutover before relying on CI.
