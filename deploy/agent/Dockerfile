# ==============================================================================
# xchat-agent-harness — Kubernetes image for tatanbot
#
# Build context is a STAGED tree produced by deploy.sh:
#   - harness repo (apps/agent, bin, skills, package.json, …)
#   - packages/xchat-sdk + packages/drone-core as REAL copies (not symlinks)
#
#   docker build --platform linux/amd64 \
#     -t docker-releases-local.artifactory.twitter.biz/users/$USER/xchat-agent-harness:TAG \
#     -f deploy/agent/Dockerfile .
# ==============================================================================

FROM node:22-alpine AS builder
RUN npm install -g pnpm@9.15.4
WORKDIR /app

# Manifests first for layer cache
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/agent/package.json ./apps/agent/
# SDK package manifests
COPY packages/xchat-sdk/package.json ./packages/xchat-sdk/
COPY packages/drone-core/package.json ./packages/drone-core/

RUN pnpm install --no-frozen-lockfile

# Full sources
COPY . ./

# ── Runtime ──────────────────────────────────────────────────────────
FROM oven/bun:1.2-alpine
WORKDIR /app

# git: brain + skills; ffmpeg: media; curl/jq: linear + sourcegraph CLIs
RUN apk add --no-cache git ffmpeg curl jq bash

COPY --from=builder /app /app

# harness bin (linear, sourcegraph) on PATH
ENV PATH="/app/bin:${PATH}"
ENV HOME=/data
RUN mkdir -p /data

COPY deploy/agent/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh /app/bin/* 2>/dev/null || true

CMD ["bash", "/app/entrypoint.sh"]
