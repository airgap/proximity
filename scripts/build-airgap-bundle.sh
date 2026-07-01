#!/usr/bin/env bash
# Build an offline bundle for air-gapped installs: saves all images + the deploy dir + checksums.
# Usage: scripts/build-airgap-bundle.sh [version]
#   Prereq: build/pull the app images first (docker compose ... build), so they exist locally.
set -euo pipefail

VERSION="${1:-$(git describe --tags --always 2>/dev/null || echo dev)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/airgap"
STAGE="$OUT/proximity-$VERSION"
mkdir -p "$STAGE"

# Images to ship. Pin app images by the tag you built; third-party by digest in production.
IMAGES=(
  "proximity-server:${TAG:-latest}"
  "proximity-web:${TAG:-latest}"
  "proximity-worker:${TAG:-latest}"
  "livekit/livekit-server:latest"
  "livekit/egress:latest"
  "coturn/coturn:latest"
  "caddy:2"
  "postgres:16-alpine"
  "redis:7-alpine"
  "minio/minio:latest"
  "registry.digitalocean.com/parabun/parabun:latest"
)

echo "[airgap] saving ${#IMAGES[@]} images (this is large)…"
docker save "${IMAGES[@]}" -o "$STAGE/images.tar"

echo "[airgap] copying deploy config…"
cp -r "$ROOT/deploy" "$STAGE/deploy"
cp "$ROOT/deploy/.env.example" "$STAGE/.env.example" 2>/dev/null || true

cat > "$STAGE/LOAD.sh" <<'LOAD'
#!/usr/bin/env bash
# Load images on the air-gapped host, then bring the stack up.
set -euo pipefail
cd "$(dirname "$0")"
docker load -i images.tar
echo "Images loaded. Configure deploy/.env, then:"
echo "  cd deploy && docker compose -f docker-compose.yml -f docker-compose.app.yml \\"
echo "    -f docker-compose.onprem.yml --profile storage up -d"
LOAD
chmod +x "$STAGE/LOAD.sh"

echo "[airgap] checksums…"
( cd "$STAGE" && sha256sum images.tar > SHA256SUMS )

echo "[airgap] compressing…"
( cd "$OUT" && tar -I 'zstd -19 -T0' -cf "proximity-$VERSION-airgap.tar.zst" "proximity-$VERSION" )
echo "[airgap] done -> $OUT/proximity-$VERSION-airgap.tar.zst"
