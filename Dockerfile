# syntax=docker/dockerfile:1
#
# Node 24 is the active LTS, and the line that runs TypeScript by stripping
# types — no build step for the server, which is why the migration can be
# file by file. One ARG so the next bump is one line.
#
# One image for the whole tracker: the API serves the built front end, so
# there is one origin, one container and one lock.

# ----------------------------------------------------------- front end ---
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS web
WORKDIR /build
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ------------------------------------------------- server dependencies ---
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /build
COPY server/package.json server/package-lock.json ./
# Production only: vite and supertest have no business in the running image.
RUN npm ci --omit=dev

# -------------------------------------------------------------- runtime ---
FROM node:${NODE_VERSION}-bookworm-slim

# tini as PID 1 so Swarm's SIGTERM reaches node during a rolling update.
# Also: security updates for the base system, and a current npm (the bundled
# one carries known advisories; npm stays for `npm run db:upgrade`).
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g npm@latest \
 && npm cache clean --force

ENV NODE_ENV=production
ENV PORT=4000

WORKDIR /app
COPY server/ ./server/
COPY --from=deps /build/node_modules ./server/node_modules
COPY --from=web /build/dist ./web/dist

USER node
EXPOSE 4000

# start.js applies any pending db/migrations (and views.sql when needed),
# then starts the API; a failed migration stops the container instead.
# `npm run migrate` drops every table, so it is never run here. A brand-new
# database still gets schema.sql once, by hand, before the first deploy.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/src/start.js"]
