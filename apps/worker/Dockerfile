# Proximity recording post-processing worker (Parabun DSP: whisper/llm).
# Build context = repo root:  docker build -f apps/worker/Dockerfile -t proximity-worker .
#
# Models (whisper ggml / LLM gguf) are NOT baked in — mount them and point WHISPER_MODEL /
# LLM_MODEL at the mounted paths. For GPU transcode/inference, run with docker-compose.gpu.yml.
FROM ghcr.io/airgap/parabun:latest
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY packages ./packages
COPY apps/worker ./apps/worker
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/loadgen/package.json ./apps/loadgen/package.json
COPY apps/recorder/package.json ./apps/recorder/package.json
RUN bun install --frozen-lockfile
USER bun
ENV NODE_ENV=production
CMD ["bun", "run", "apps/worker/src/index.ts"]
