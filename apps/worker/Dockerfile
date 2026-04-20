# syntax=docker/dockerfile:1.7
# Multi-stage build for apps/worker in the pnpm workspace.
# Mirrors apps/api/Dockerfile — only the app filter, source copy,
# and final CMD differ. Worker has no HTTP surface (no EXPOSE, no
# PORT), it consumes BullMQ + Temporal queues.

ARG CACHE_BUSTER=2026-04-20-worker-init

FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

# ---- deps ----
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY tsconfig.base.json tsconfig.base.json
COPY packages/config/package.json packages/config/
COPY packages/domain/package.json packages/domain/
COPY packages/ui/package.json packages/ui/
COPY packages/telemetry/package.json packages/telemetry/
COPY packages/db/package.json packages/db/
COPY packages/integrations/package.json packages/integrations/
COPY packages/agents/package.json packages/agents/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile

# ---- build ----
FROM deps AS build
COPY packages ./packages
COPY apps/worker ./apps/worker
RUN pnpm --filter @vex/config --filter @vex/domain --filter @vex/ui \
        --filter @vex/telemetry --filter @vex/db --filter @vex/integrations \
        --filter @vex/agents --filter @vex/worker run build

RUN pnpm --filter @vex/worker --prod deploy /out

# ---- runtime ----
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/worker/dist ./dist
COPY --from=build /repo/packages ./packages
CMD ["node", "dist/main.js"]
