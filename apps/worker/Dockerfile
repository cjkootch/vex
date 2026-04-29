# syntax=docker/dockerfile:1.7
# Multi-stage build for apps/worker in the pnpm workspace.
# Mirrors apps/api/Dockerfile — only the app filter, source copy,
# and final CMD differ. Worker has no HTTP surface (no EXPOSE, no
# PORT), it consumes BullMQ + Temporal queues.

ARG CACHE_BUSTER=2026-04-29-crm-note-executor

FROM node:20-bookworm-slim AS base
ARG CACHE_BUSTER
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Reference CACHE_BUSTER in a layer so changing the ARG actually
# invalidates Docker's cache (declaring an ARG without using it is
# a no-op for cache-key purposes).
RUN echo "cache-buster=$CACHE_BUSTER" > /tmp/cache-buster.txt
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
# Temporal's Rust SDK-core (NativeConnection in @temporalio/worker) uses
# rustls + rustls-native-certs, which reads /etc/ssl/certs. The slim base
# image doesn't guarantee a populated CA bundle, so TLS to Temporal Cloud
# fails with InvalidCertificate(UnknownIssuer). Install ca-certificates
# and point OpenSSL/rustls at it explicitly so the worker can connect.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && update-ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_DIR=/etc/ssl/certs
WORKDIR /app
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/worker/dist ./dist
COPY --from=build /repo/packages ./packages
CMD ["node", "dist/main.js"]
