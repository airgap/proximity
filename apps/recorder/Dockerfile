# Proximity egress recorder template — static page loaded by LiveKit Egress (headless Chrome).
# Build context = repo root:  docker build -f apps/recorder/Dockerfile -t proximity-recorder .
# Set VITE_WORLD_WS at build time to the world-server WS URL reachable from the egress container.
FROM ghcr.io/airgap/parabun:latest AS build
WORKDIR /app
ARG VITE_WORLD_WS
ENV VITE_WORLD_WS=${VITE_WORLD_WS}
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY packages ./packages
COPY apps/recorder ./apps/recorder
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/loadgen/package.json ./apps/loadgen/package.json
RUN bun install --frozen-lockfile && cd apps/recorder && bun run build

FROM nginx:alpine AS runtime
COPY --from=build /app/apps/recorder/dist /usr/share/nginx/html
EXPOSE 80
