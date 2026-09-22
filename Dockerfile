# syntax=docker/dockerfile:1
#
# One image for the whole tracker: the API serves the built front end, so
# there is one origin, one container and one lock.

# ----------------------------------------------------------- front end ---
FROM node:22-bookworm-slim AS web
WORKDIR /build
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ------------------------------------------------- server dependencies ---
FROM node:22-bookworm-slim AS deps
WORKDIR /build
COPY server/package.json server/package-lock.json ./
# Production only: vite and supertest have no business in the running image.
RUN npm ci --omit=dev

# -------------------------------------------------------------- runtime ---
FROM node:22-bookworm-slim

# tini as PID 1 so Swarm's SIGTERM reaches node during a rolling update, plus
# security updates for the base system.
#
# npm and corepack are removed: nothing in the running container uses them.
# The API starts with `node`, start.js applies migrations itself, and the one
# manual command is `node server/scripts/db.js upgrade` (db.js resolves its
# paths from import.meta.url, so any working directory will do). Their own
# bundled packages were the only CRITICAL/HIGH findings in the image scan,
# and they were being skipped rather than fixed.
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

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
