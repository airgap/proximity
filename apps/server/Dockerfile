# Proximity world-server. Build context = repo root:
#   docker build -f apps/server/Dockerfile -t proximity-server .
FROM registry.digitalocean.com/parabun/parabun:latest
WORKDIR /app
# Workspace manifests (all members must be present for the workspace install to resolve).
COPY package.json bun.lock bunfig.toml ./
COPY packages ./packages
COPY apps/server ./apps/server
COPY apps/web/package.json ./apps/web/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/loadgen/package.json ./apps/loadgen/package.json
COPY apps/recorder/package.json ./apps/recorder/package.json
COPY infra ./infra
# Install AFTER copying source so Bun creates the per-package @proximity/* symlinks in place.
RUN bun install --frozen-lockfile
USER bun
ENV NODE_ENV=production
EXPOSE 8080
CMD ["bun", "run", "apps/server/src/index.ts"]
