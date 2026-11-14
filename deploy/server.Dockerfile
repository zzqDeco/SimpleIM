# syntax=docker/dockerfile:1
FROM oven/bun:1.4.4-alpine AS build
WORKDIR /app

COPY package.json bun.lock tsconfig.base.json ./
COPY types ./types
COPY packages/contracts ./packages/contracts
COPY packages/crypto ./packages/crypto
COPY packages/peer-core/package.json ./packages/peer-core/package.json
COPY apps/cli/package.json ./apps/cli/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/server ./apps/server

RUN bun install --frozen-lockfile --production && \
    mkdir -p /app/dist && \
    bun build apps/server/src/main.ts --target=bun --outfile=/app/dist/server.js

FROM oven/bun:1.4.4-alpine AS runtime
ARG VERSION=production
ARG COMMIT_SHA=unknown
LABEL org.opencontainers.image.title="simpleim-server" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$COMMIT_SHA

WORKDIR /app

RUN mkdir -p /data && chown bun:bun /data /app
COPY --chown=bun:bun --from=build /app/dist/server.js /app/server.js

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

CMD ["bun", "run", "/app/server.js"]
