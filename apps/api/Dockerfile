# syntax=docker/dockerfile:1
# API + worker image (T197). Build from the repo root (npm workspaces):
#   docker build -f apps/api/Dockerfile -t wbm-api .
# Run the API (default command) or the worker from the same image:
#   docker run --env-file .env -p 4000:4000 wbm-api
#   docker run --env-file .env wbm-api node dist/worker.js
# Database migrations run from the `migrate` stage before a release:
#   docker build -f apps/api/Dockerfile --target migrate -t wbm-migrate .
#   docker run --env-file .env wbm-migrate
ARG NODE_VERSION=26

FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
# Every workspace manifest is needed for `npm ci` to accept the shared lockfile.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY tools/mock-meta/package.json tools/mock-meta/
RUN npm ci --workspace @wbm/shared --workspace @wbm/api --include-workspace-root

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w @wbm/shared \
 && npm run db:generate -w @wbm/api \
 && npm run build -w @wbm/api

FROM build AS migrate
WORKDIR /app/apps/api
CMD ["npx", "prisma", "migrate", "deploy"]

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY tools/mock-meta/package.json tools/mock-meta/
RUN npm ci --omit=dev --workspace @wbm/shared --workspace @wbm/api \
 && npm cache clean --force
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/dist apps/api/dist
COPY apps/api/healthcheck.mjs apps/api/healthcheck.mjs
WORKDIR /app/apps/api
USER node
# 4000: API (/api/*, /metrics); 4001: worker ops server (/health, /metrics). Both need X-Ops-Token.
EXPOSE 4000 4001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "healthcheck.mjs"]
CMD ["node", "dist/main.js"]
