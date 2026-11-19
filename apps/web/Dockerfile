# syntax=docker/dockerfile:1
# Web image (T197): Next.js standalone output. Build from the repo root (npm workspaces):
#   docker build -f apps/web/Dockerfile --build-arg API_INTERNAL_URL=http://api:4000 -t wbm-web .
#   docker run -p 3000:3000 wbm-web
# API_INTERNAL_URL is where the server proxies /api/*; standalone output fixes it at build time.
ARG NODE_VERSION=26

FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
# Every workspace manifest is needed for `npm ci` to accept the shared lockfile.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY tools/mock-meta/package.json tools/mock-meta/
RUN npm ci --workspace @wbm/shared --workspace @wbm/web --include-workspace-root

FROM deps AS build
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=${API_INTERNAL_URL} NEXT_TELEMETRY_DISABLED=1
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build -w @wbm/shared && npm run build -w @wbm/web

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
# outputFileTracingRoot is the repo root, so the server lives at apps/web/server.js.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/login').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "apps/web/server.js"]
