# syntax=docker/dockerfile:1
# Multi-stage build. Two final images:
#   --target api   Node API + ingestion worker (same code, different command)
#   --target web   Caddy serving the built React app and proxying /api to the API

ARG NODE_IMAGE=node:26-slim

# ---------- API dependencies (production only) ----------
FROM ${NODE_IMAGE} AS api-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @documind/api --omit=dev --no-audit --no-fund

# ---------- API runtime ----------
# Node 26 runs the TypeScript sources directly (type stripping): no build step, and stack
# traces point at the real source lines.
FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production \
    UPLOAD_DIR=/data/uploads
WORKDIR /app
COPY --from=api-deps /app/node_modules ./node_modules
COPY apps/api/package.json apps/api/
COPY apps/api/src apps/api/src
COPY apps/api/migrations apps/api/migrations
# Upload volume owned by the unprivileged user the process runs as.
RUN mkdir -p /data/uploads && chown -R node:node /data
USER node
WORKDIR /app/apps/api
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://localhost:4000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "src/server.ts"]

# ---------- Web build ----------
FROM ${NODE_IMAGE} AS web-build
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @documind/web --no-audit --no-fund
COPY apps/web apps/web
RUN npm run build --workspace @documind/web

# ---------- Web runtime: Caddy ----------
FROM caddy:2-alpine AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /app/apps/web/dist /srv
