# Proximity web client — build the static SPA, serve with nginx.
# Build context = repo root:  docker build -f apps/web/Dockerfile -t proximity-web .
FROM registry.digitalocean.com/parabun/parabun:latest AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
COPY apps/server/package.json ./apps/server/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/loadgen/package.json ./apps/loadgen/package.json
COPY apps/recorder/package.json ./apps/recorder/package.json
RUN bun install --frozen-lockfile && cd apps/web && bun run build

FROM nginx:alpine AS runtime
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
# SPA fallback: serve index.html for client routes.
RUN printf 'server {\n\
  listen 80;\n\
  root /usr/share/nginx/html;\n\
  location / { try_files $uri /index.html; }\n\
}\n' > /etc/nginx/conf.d/default.conf
EXPOSE 80
