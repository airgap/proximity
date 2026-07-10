#!/usr/bin/env bash
# CI redeploy of the app containers on the spatial.lyku.co droplet. Run from CI
# under `doppler run` so the secrets below arrive in the environment. Redeploys
# ONLY the stateless app services (server, web, worker) from GHCR — never the
# stateful ones (postgres, redis, livekit) or the locally-built recorder.
#
# Required env (from Doppler):
#   DEPLOY_HOST      droplet host/IP
#   DEPLOY_USER      ssh user
#   DEPLOY_PATH      dir on the droplet holding the repo (its deploy/ is synced)
#   DEPLOY_SSH_KEY   private key (full PEM)
# From the workflow: OWNER (github org), SHA (commit). Optional: DEPLOY_COMPOSE
# (override the -f list), DEPLOY_SERVICES (override which services redeploy).
set -euo pipefail

: "${DEPLOY_HOST:?}" "${DEPLOY_USER:?}" "${DEPLOY_PATH:?}" "${DEPLOY_SSH_KEY:?}" "${OWNER:?}" "${SHA:?}"

key="$(mktemp)"; known="$(mktemp)"
trap 'rm -f "$key" "$known"' EXIT
printf '%s\n' "$DEPLOY_SSH_KEY" > "$key"; chmod 600 "$key"
ssh_opts=(-i "$key" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$known")

prefix="ghcr.io/${OWNER}/"
tag="${SHA:0:12}"
compose="${DEPLOY_COMPOSE:-docker compose -f docker-compose.yml -f docker-compose.app.yml -f docker-compose.cfdo.yml}"
services="${DEPLOY_SERVICES:-server web worker}"

echo "[deploy] syncing deploy/ to ${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_PATH}/deploy (keeping the droplet's .env)"
rsync -az --delete -e "ssh ${ssh_opts[*]}" \
  --exclude='.env' --exclude='*.local.*' \
  deploy/ "${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_PATH}/deploy/"

echo "[deploy] pulling + restarting: ${services} (image ${prefix}proximity-web:${tag})"
ssh "${ssh_opts[@]}" "${DEPLOY_USER}@${DEPLOY_HOST}" bash -s <<REMOTE
set -euo pipefail
cd "${DEPLOY_PATH}/deploy"
export IMAGE_PREFIX="${prefix}" TAG="${tag}"
${compose} pull ${services}
${compose} up -d --no-deps ${services}
docker image prune -f >/dev/null 2>&1 || true
echo "[deploy] running images:"
${compose} images ${services}
REMOTE
echo "[deploy] done."
