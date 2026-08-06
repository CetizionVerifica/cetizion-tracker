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

# tini as PID 1 so Swarm's SIGTERM reaches node during a rolling update.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=4000

WORKDIR /app
COPY server/ ./server/
COPY --from=deps /build/node_modules ./server/node_modules
COPY --from=web /build/dist ./web/dist

USER node
EXPOSE 4000

# `npm run migrate` drops every table, so it is deliberately not run here.
# The schema is applied once, by hand, against the database.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/src/index.js"]
