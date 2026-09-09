# Turnstile web — market and seller pages, plus the discovery and offer APIs.
#
# Built from the REPOSITORY ROOT, not from web/:
#
#   docker build -f web/Dockerfile -t turnstile-web .
#   docker run -p 3210:3210 -e SEPOLIA_RPC_URL=... turnstile-web
#
# The app imports seller/service/discovery.ts and graph/sink/ens.ts directly
# rather than vendoring copies, and reads contracts/addresses.turnstile.sepolia.json
# for seller identity, so the build context has to be the whole repo.

FROM node:24-alpine AS builder
WORKDIR /repo

# .npmrc carries legacy-peer-deps=true; `npm ci` fails without it. See
# deploy/Dockerfile.services for the full reason.
COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY web/package.json web/package-lock.json ./web/
COPY .npmrc ./web/
RUN cd web && npm ci

# The whole import graph, not just what the pages import at runtime.
#
# This used to copy only graph/sink, seller/service and one addresses file, on
# the theory that it was "only what the web build actually reads". It is not:
# `next build` runs TypeScript over the transitive graph, which reaches the
# co-located *.test.ts files, and those import rails/, buyer/ and
# seller/analyst/. The build failed with a wall of TS2307 until these were added
# (first actually built in a container 2026-09-08).
COPY graph ./graph
COPY rails ./rails
COPY buyer ./buyer
COPY seller ./seller
COPY mcp-turnstile ./mcp-turnstile
COPY identity ./identity
COPY contracts/addresses.turnstile.sepolia.json ./contracts/
COPY web ./web

RUN cd web && npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3210 HOSTNAME=0.0.0.0

# The standalone bundle carries its own node_modules; static assets are not
# part of it and have to be placed alongside.
COPY --from=builder /repo/web/.next/standalone ./
COPY --from=builder /repo/web/.next/static ./web/.next/static

EXPOSE 3210
CMD ["node", "web/server.js"]
