#!/usr/bin/env bash
# CI redeploy of the proximity APP containers on the spatial.lyku.co droplet.
# Called by the proximity Jenkins job's Deploy stage under `doppler run` (a ci/prd
# service token supplies the secrets below). Redeploys ONLY the stateless app services by pulling the
# :latest images pinned in the droplet's own docker-compose.co.yml, then
# recreating them. Never touches the stateful services (postgres, redis,
# livekit) or the locally-built recorder, and never rewrites the droplet's
# compose files or .env.
#
# Required env (Doppler project ci / config prd):
#   API_IP        droplet host/IP
#   API_USER      ssh user
#   API_SSH_KEY   private key (full PEM)
#
# Prereq: the droplet's docker-compose.co.yml must pin web + world-server to the
# registry CI pushes to (public GHCR: ghcr.io/airgap/proximity-{web,server}).
# See DEPLOY.md ("CI redeploy") for the one-time DOCR->GHCR cutover.
set -euo pipefail

: "${API_IP:?}" "${API_USER:?}" "${API_SSH_KEY:?}"

key="$(mktemp)"; known="$(mktemp)"
trap 'rm -f "$key" "$known"' EXIT
printf '%s\n' "$API_SSH_KEY" > "$key"; chmod 600 "$key"

echo "[deploy] redeploying web + world-server on ${API_USER}@droplet…"
ssh -i "$key" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$known" \
    -o ConnectTimeout=20 "$API_USER@$API_IP" 'bash -s' <<'REMOTE'
set -euo pipefail
services="web world-server"

# Derive the exact compose invocation the droplet already uses, from the running
# web container's labels — no hard-coded paths, no compose-file drift.
cid="$(docker ps -q --filter label=com.docker.compose.service=web | head -1)"
[ -n "$cid" ] || { echo "[deploy] ERROR: no running 'web' container to derive compose config from"; exit 3; }
wd="$(docker inspect "$cid" --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}')"
cf="$(docker inspect "$cid" --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}')"
cd "$wd"
flags=""; IFS=','; for f in $cf; do flags="$flags -f $f"; done; unset IFS
echo "[deploy] dir=$wd  services=$services"

# shellcheck disable=SC2086
docker compose $flags pull $services
# shellcheck disable=SC2086
docker compose $flags up -d --no-deps $services
docker image prune -f >/dev/null 2>&1 || true
echo "[deploy] running images:"
# shellcheck disable=SC2086
docker compose $flags ps $services
REMOTE
echo "[deploy] finished."
