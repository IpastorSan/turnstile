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

FROM node:22-alpine AS builder
WORKDIR /repo

COPY package.json package-lock.json ./
RUN npm ci

COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci

# Only what the web build actually reads.
COPY graph/sink ./graph/sink
COPY seller/service ./seller/service
COPY contracts/addresses.turnstile.sepolia.json ./contracts/
COPY web ./web

RUN cd web && npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3210 HOSTNAME=0.0.0.0

# The standalone bundle carries its own node_modules; static assets are not
# part of it and have to be placed alongside.
COPY --from=builder /repo/web/.next/standalone ./
COPY --from=builder /repo/web/.next/static ./web/.next/static

EXPOSE 3210
CMD ["node", "web/server.js"]
