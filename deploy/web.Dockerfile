# syntax=docker/dockerfile:1
FROM oven/bun:1.4.4-alpine AS build
ARG VERSION=production
ARG COMMIT_SHA=unknown

WORKDIR /app

COPY package.json bun.lock tsconfig.base.json ./
COPY types ./types
COPY packages/contracts ./packages/contracts
COPY packages/crypto ./packages/crypto
COPY packages/peer-core ./packages/peer-core
COPY apps/server/package.json ./apps/server/package.json
COPY apps/cli/package.json ./apps/cli/package.json
COPY apps/web ./apps/web

RUN bun install --frozen-lockfile && bun run build:web
RUN VERSION="$VERSION" COMMIT_SHA="$COMMIT_SHA" bun -e \
  "await Bun.write('apps/web/dist/version.json', JSON.stringify({ version: process.env.VERSION, sha: process.env.COMMIT_SHA }));"

FROM nginx:1.28-alpine AS runtime
ARG VERSION=production
ARG COMMIT_SHA=unknown
LABEL org.opencontainers.image.title="simpleim-web" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$COMMIT_SHA

COPY deploy/web.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=3s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
