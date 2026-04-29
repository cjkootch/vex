# syntax=docker/dockerfile:1.7
# Multi-stage build for apps/api in the pnpm workspace.
# Keeps the runtime image small by discarding devDeps + source after build.

# CACHE_BUSTER — bump when Depot's layer cache is serving stale code even
# though packages/** or apps/api/** changed. Value isn't consumed by any
# layer; its presence just forces a fresh hash for the base stage.
ARG CACHE_BUSTER=2026-04-29-prompt-v7.22

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
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile

# ---- build ----
FROM deps AS build
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm --filter @vex/config --filter @vex/domain --filter @vex/ui \
        --filter @vex/telemetry --filter @vex/db --filter @vex/integrations \
        --filter @vex/agents --filter @vex/api run build

# Prune dev deps so the final image only carries production node_modules.
RUN pnpm --filter @vex/api --prod deploy /out

# ---- runtime ----
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/packages ./packages
EXPOSE 8080
CMD ["node", "dist/main.js"]
