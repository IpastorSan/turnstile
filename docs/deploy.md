# Deploying Turnstile

One host runs everything: the Next.js app, the x402 seller service, the evidence
server the CRE enclave fetches from, and Caddy in front of all three.

## Live since 2026-09-11

**<https://turnstile.moveseventyeight.com>** is served from a GCP Compute Engine
VM, `turnstile` (e2-medium, `europe-southwest1-a`, static IP `34.175.99.87`),
running `deploy/compose.yaml` from `main` at `5feaec2`, with Caddy holding a
Let's Encrypt certificate.

Verified 2026-09-11 from outside the box, over real TLS (re-checked 07:30 UTC):

| Request | Status |
|---|---|
| `GET /` | 200 |
| `GET /api/health` | 200 |
| `GET /seller-health` | 200 |
| `GET /analyze/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640` | **402 Payment Required** |
| `GET http://…/` | 308 → `https://` |
| `GET /liquidity.turnstile.eth/sse` — the URL in `agent-endpoint[mcp]` | ~~**404** — see [Known gap](#known-gap-the-published-endpoint-path-serves-nothing)~~ **Now serves MCP/SSE** (2026-09-11, same day): GET with `Accept: text/event-stream` opens the stream and names its `POST …/messages` return path. See the gap section, now closed. |

The host is up and the paid service answers. So does the URL the ENS record
publishes (as of 2026-09-11; see "Known gap" below, closed).

## Why one box rather than a serverless frontend

Turnstile is not a frontend with an API. Two of its three services are
long-running processes, and one of them is the thing the chain points at:

| Service | What it is | Public? |
|---|---|---|
| `web` | Next.js. Market page, seller pages, `/api/sellers`, `/api/offer/:name` | yes |
| `seller` | The x402-gated service. **This is what a buyer pays.** | yes |
| `mcp` | The four MCP tools over HTTP/SSE. **This is what `agent-endpoint[mcp]` resolves to.** No credentials by design — it quotes, never pays. | yes |
| `evidence` | Serves the evidence bundle the CRE enclave fetches. Bearer-gated | yes, for CRE |

Deploying only the web app would leave the ENS record just as dead as it is now
while looking finished, because the record does not point at the web app.

Three further reasons the box wins here:

- **Node version is ours to pick.** `web/lib/discovery.ts` imports `node:sqlite`.
  That is importable on Node 22.18+ but only stable from 24, and a managed
  platform's runtime is not something we choose. Both images were tested on
  2026-09-08: 22 works with an `ExperimentalWarning`, 24 is clean. The images pin
  24.
- **x402 does facilitator round-trips** to Blocky402 and Circle Gateway. Cold
  starts and function timeouts are a live risk during a recorded demo, and that
  recording *is* the Hedera submission.
- **Bazantic needs two stable public HTTPS URLs** for `--spec-url` and
  `--endpoint`. One host serves both.

## Local

```bash
cd deploy
docker compose up --build
```

Then <http://localhost>. No certificate, no DNS, nothing to provision: Caddy
serves plain HTTP because `TURNSTILE_SITE_ADDRESS` defaults to
`http://localhost`, and the `http://` prefix is what stops it trying to get a
certificate for a name Let's Encrypt cannot validate.

Credentials come from the **repo-root `.env`**, the same file every npm script
reads. There is no second copy to keep in sync.

Check it came up:

```bash
curl -s localhost/api/health            # web: which data dependencies it can reach
curl -s localhost/seller-health         # seller service
curl -si localhost/analyze/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640 | head -1   # expect 402
```

That last one returning `402 Payment Required` is the whole product in one line:
the service is up, it knows its price, and it will not answer until it is paid.

## The redeploy loop

```bash
gcloud compute ssh turnstile --zone=europe-southwest1-a --command=\
  'cd /opt/turnstile && git pull --ff-only origin main && cd deploy && sudo docker compose up -d --build'
```

**The Caddy trap, learned the hard way (2026-09-11).** `./Caddyfile` is
bind-mounted into the container as a **single file**, not a directory. `git
pull` replaces the file rather than editing it in place, which swaps its inode
— and a bind mount follows the *inode it was created with*, not the path. The
container keeps serving the old config forever, `docker compose ps` says
"Up (healthy)", `up -d` says "configuration unchanged" and does nothing, and
the site silently runs the previous Caddyfile. The SSE routes went live on the
containers and not through Caddy for exactly this reason.

The fix is to recreate the proxy, not restart it:

```bash
sudo docker compose up -d --force-recreate caddy
```

And the verification is to ask the running config, not the file:

```bash
sudo docker exec turnstile-caddy-1 caddy adapt --config /etc/caddy/Caddyfile | grep -c liquidity
```

Anything nonzero proves the container actually sees the new file. `reload`
would also re-read the path — but only if the mount still resolves it, which
is precisely what a single-file mount does not guarantee after a pull. If a
future Caddyfile change must be safe by construction, mount the *directory*
(`./caddy:/etc/caddy:ro`) instead of the file; directory mounts follow the
path.

## Live

1. Point an A record at the box. The hostname must match what
   `agent-endpoint[mcp]` publishes on chain, currently
   `turnstile.moveseventyeight.com`.
2. `cp deploy/.env.example deploy/.env` and set
   `TURNSTILE_SITE_ADDRESS=turnstile.moveseventyeight.com` — a **bare** hostname,
   no scheme. That is what switches Caddy into automatic HTTPS.
3. Copy the repo-root `.env` to the box. It is gitignored and never travels in
   an image.
4. `cd deploy && docker compose up -d --build`

Caddy provisions the certificate on the first request. Set the A record *before*
starting, or issuance fails and backs off.

### Do not set the bare hostname until DNS resolves

Caddy will keep retrying a certificate it cannot get, and the site stays down
while it does. Local mode has no such failure mode, which is why it is the
default rather than something you opt into.

## Routing

Caddy sends the paths each service actually serves, rather than a catch-all:

| Path | Goes to |
|---|---|
| `/analyze/*`, `/receipts/*` | `seller:4021` |
| `/seller-health` | `seller:4021` `/health` |
| `/liquidity.turnstile.eth/sse`, `/liquidity.turnstile.eth/messages*` | `mcp:4030` |
| `/evidence/*` | `evidence:8787` |
| everything else | `web:3210` |

**A path nothing serves gets a 404 from the web app**, which is the honest
outcome. That matters for one path in particular, below.

## Known gap: the published endpoint path serves nothing

**CLOSED 2026-09-11 (this branch).** `mcp-turnstile/http-server.ts` serves the
same four tools over HTTP/SSE, `deploy/compose.yaml` runs it as `mcp`, and
Caddy routes `…/liquidity.turnstile.eth/sse` and its `POST …/messages` return
path to it. The section below is kept as written, because the record was on
chain claiming a 404 for most of the build and the reasoning for why the gap
survived so long is the useful part.

`agent-endpoint[mcp]` publishes:

```
https://turnstile.moveseventyeight.com/liquidity.turnstile.eth/sse
```

**Nothing in this repository serves `/…/sse`, and nothing is planned to.**
`mcp-turnstile/server.ts` is a **stdio** MCP server — `StdioServerTransport`,
run through `npx` — and there is no HTTP or SSE transport anywhere in the tree.
The path was inherited from the placeholder URL and carried over unexamined when
the host was repointed on 2026-09-08 (MOV-010).

So even after this stack is live, an agent that follows the ENS record to that
exact URL gets a 404 from the web app. The seller service is reachable and
payable at `/analyze/:pool`; the record does not say so.

**Update (2026-09-11, MOV-273):** the paragraph above was written as a
prediction, before the stack was live. It is live now and the prediction held.
Checked 2026-09-11 07:30 UTC against the public host:

```
GET https://turnstile.moveseventyeight.com/liquidity.turnstile.eth/sse                        404
GET https://turnstile.moveseventyeight.com/analyze/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640  402
```

The same day, `cast call` against the resolver still returned
`"https://turnstile.moveseventyeight.com/liquidity.turnstile.eth/sse"` for
`agent-endpoint[mcp]`. The gap closed at the host and stays open at the path.

Three ways to close it, none of them done:

1. **Repoint the record to the base URL** and let clients use `/analyze/:pool`.
   One hot-key write. Honest, but then the `[mcp]` protocol tag oversells what
   is at the other end, because plain HTTP + x402 is not MCP.
2. ~~**Serve MCP over HTTP/SSE** at that path, wrapping the same four tools.
   Real work, and it makes the record true as published.~~ **Done (2026-09-11):
   option 2 was built.** See the update at the top of this section, and
   `mcp-turnstile/http-app.ts` for the custody and SSRF story — the process
   gets no `.env`, so the public endpoint can quote and discover but not pay.
3. **Publish `agent-endpoint[web]`** alongside, per ENSIP-26's extensible key,
   and leave `[mcp]` for whenever a remote transport exists.

This is written down rather than quietly fixed because the record is already on
chain and the choice costs a transaction either way.
