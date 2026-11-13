# syntax=docker/dockerfile:1
FROM oven/bun:1.4.4-alpine AS deps
WORKDIR /app

COPY package.json bun.lock ./
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/crypto/package.json ./packages/crypto/package.json
COPY packages/peer-core/package.json ./packages/peer-core/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY apps/cli/package.json ./apps/cli/package.json
COPY apps/web/package.json ./apps/web/package.json

RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.4-alpine AS runtime
ARG VERSION=production
ARG COMMIT_SHA=unknown
LABEL org.opencontainers.image.title="simpleim-server" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$COMMIT_SHA

WORKDIR /app

COPY --from=deps /app /app
COPY tsconfig.base.json ./
COPY types ./types
COPY packages/contracts ./packages/contracts
COPY packages/crypto ./packages/crypto
COPY apps/server ./apps/server

RUN mkdir -p /data && chown -R bun:bun /data /app

USER bun

ENV NODE_ENV=production \
    APP_VERSION=$VERSION \
    COMMIT_SHA=$COMMIT_SHA \
    HOST=0.0.0.0 \
    PORT=3000 \
    SQLITE_PATH=/data/simpleim.sqlite \
    SECURE_COOKIES=true \
    TRUST_PROXY=true

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=5 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:3000/healthz'); if (!r.ok) process.exit(1);"

CMD ["bun", "run", "apps/server/src/main.ts"]
