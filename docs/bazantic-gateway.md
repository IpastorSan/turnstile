# Bazantic — gateway, Recipe, and what is blocking them

Date: 2026-09-07
Issue: MOV-231
Target: **"Best Recipe that uses ETHGlobal Hackathon Sponsor APIs"** ($1,000, 3 places)
Bazantic account: **`IpastorSan`** (signed in via GitHub) — this handle must appear
in the submission notes for Recipe attribution. It is a hard requirement, not a nicety.

**Status: registered 2026-09-11, live.** Everything that could be authored
is in this branch. What remains is the Recipe (web UI), a funded payer for one
live `baz curl` payment, and the screen recording. The blockers below were true
on 2026-09-07; #1–#3 are dead as of the deploy, and #4/#5 remain by nature.
See [What is blocking](#what-is-blocking).

---

## The tool is `@bazantic/cli`, and its surface is smaller than the marketing page

Verified 2026-09-07 by installing `@bazantic/cli@0.8.0` from npm and reading the
published bundle. The binary is `baz`.

```
baz login [--[no-]browser]   sign in this device to manage your gateways (no money)
baz gateway add|list         manage your gateways (requires login)
baz curl <url>               make an HTTP request; auto-pay a 402 (USDC)
baz wallet <cmd>             self-custody wallet (a payer you hold and fund)
baz grant <cmd>              let a device pay from your hosted balance (capped, revocable)
```

Three findings that shape everything below:

1. **`baz login` is browser-approval only.** It prints an approval URL and blocks
   until a human approves it. `--no-browser` only suppresses auto-opening the URL;
   it does not provide a headless path. There is no API-key, token or environment-
   variable authentication anywhere in the bundle. `baz whoami` on this machine
   reports `not signed in` — the `IpastorSan` session lives in the user's browser,
   not here.

2. **`baz gateway add` needs two publicly reachable HTTPS URLs.**

   | Flag | Meaning |
   |---|---|
   | `--spec-url` | OpenAPI or OpenRPC document, **fetched and parsed server-side** by Bazantic. Must declare at least one operation. |
   | `--endpoint` | our API's base URL. **https only** — the gateway forwards a provider credential to it. |
   | `--auth-type` | how the gateway authenticates to *our* API: `api-key \| jwt \| x402-mpp \| basic`. Default `x402-mpp`. |
   | `--status` | `draft \| active` |
   | `--json` | structured result: `{ ok, id, slug, mcpUrl }` |

   The default `--auth-type x402-mpp` is the correct one for us and not merely the
   default: our service *is* x402-protected, so the gateway pays it the same way any
   other x402 client would. Nothing bespoke is needed on our side.

   The CLI's own help ends with a warning worth repeating: **never hand-build a
   gateway URL.** Read `endpointUrl` from `baz gateway list --json`; every upstream
   path hangs off it verbatim, and its MCP server sits at `/mcp`.

3. **Recipes are not in the CLI at all.** The string `recipe` does not occur
   anywhere in the published bundle (`grep -roi 'recipe[a-z]*'` returns nothing).
   Recipe authoring is a web-app action at bazantic.com. The copy in
   [The Recipe](#the-recipe) below is written to be pasted into that UI.

---

## What is blocking

| # | Blocker | Why the agent could not clear it |
|---|---|---|
| 1 | `baz login` needs browser approval | No headless auth path exists in the CLI. **The user runs this themselves** — an agent should not initiate it even to hand over the approval URL, because approving binds the user's Bazantic account in their browser and that is theirs to start. |
| 2 | `--endpoint` must be a public HTTPS URL | The seller service is localhost-only. `docs/deploy.md` (MOV-230, 2026-09-07) states no hosting credentials exist on this machine — no Vercel, Netlify, Fly or Cloudflare CLI and no token for any of them. |
| 3 | `--spec-url` must be publicly fetchable | The spec now exists (`seller/service/openapi.yaml`) but the repo is still **private**, so a raw.githubusercontent URL will not resolve for Bazantic's server-side fetch. |
| 4 | Recipe authoring is web-app only | See finding 3 above. |
| 5 | Screen recording | A human action in all cases. |

**#2 and #3 are one missing thing, and it is the same one blocking MOV-230:** a
public HTTPS deployment of the service. One deployment clears the ENS live-demo
gate and this gateway together. Do not design around its absence.

Flipping the repo public — already a hard gate in `CHECKLIST.md` before submitting
— clears #3 on its own, since the spec is then fetchable from raw.githubusercontent.

> **Correction (2026-09-07, MOV-231):** an earlier revision of this file, in this
> same branch, proposed `tailscale funnel` as "the one lever that clears #2 and #3
> together". **Do not do that.** A funnel dies when this machine sleeps, so a
> gateway registered against a funnel URL would break the moment Bazantic's own
> fetcher or a judge touched it — trading a visible blocker for an invisible one,
> which is worse. It is also an outward-facing action nobody authorised.
>
> Still true: `tailscale` is the only tunnel present on this machine (verified
> 2026-09-07; `cloudflared`, `ngrok` and `localtunnel` are not installed), and no
> hosting CLI or token exists here either. The conclusion that changed is what to
> do about it — wait for a real deployment, not a tunnel.

---

## The registration run, once a public URL exists

Serve the spec and the API from the same public origin so the two flags agree.

```bash
# 0. the origin the seller service is deployed at — a real deployment, not a tunnel.
#    See docs/deploy.md; this is the MOV-230 blocker too.
export TURNSTILE_PUBLIC=https://<the deployment>

# 1. sanity-check that Bazantic will be able to fetch both, from outside this machine
curl -fsS "$TURNSTILE_PUBLIC/health"      | head -c 200
curl -fsS "$TURNSTILE_PUBLIC/openapi.yaml" | head -c 200

# 2. sign in — prints an approval URL and waits for a human
npx -y @bazantic/cli@0.8.0 login --name turnstile-build --no-browser
npx -y @bazantic/cli@0.8.0 whoami              # must report IpastorSan

# 3. register the gateway
npx -y @bazantic/cli@0.8.0 gateway add \
  --spec-url  "$TURNSTILE_PUBLIC/openapi.yaml" \
  --endpoint  "$TURNSTILE_PUBLIC" \
  --name      "Turnstile Liquidity Analyst" \
  --auth-type x402-mpp \
  --status    active \
  --json

# 4. read back the callable URL — do not construct it
npx -y @bazantic/cli@0.8.0 gateway list --json   # endpointUrl, and its MCP server at /mcp
```

Step 3 needs the spec reachable at a URL. `seller/service/openapi.yaml` is the
document; serving it at `$TURNSTILE_PUBLIC/openapi.yaml` is one static route on the
seller service, or any public file host will do — Bazantic only fetches it.

**Record the `{ id, slug, mcpUrl }` from step 3 and the `endpointUrl` from step 4
back into this file when the run happens.** Per `CLAUDE.md`, capture every
transaction the first time it works; re-running it later for the demo is not
always possible.

---

## The OpenAPI spec

`seller/service/openapi.yaml` — OpenAPI 3.1.0, validated 2026-09-07 with
`@apidevtools/swagger-parser`. Four operations:

| Operation | Route | Price | Sources it reads |
|---|---|---|---|
| `analyzePoolStandard` | `GET /analyze/{pool}` | $0.07 | The Graph only |
| `analyzePoolAttested` | `GET /analyze/{pool}/attested` | $0.35 | The Graph **and** Uniswap QuoterV2 |
| `getReceipt` | `GET /receipts/{transaction}` | free | the settling rail's records / HCS |
| `getHealth` | `GET /health` | free | — |

The prices come from `seller/service/tiers.ts` and are not invented there either:
`$0.07` is the live value of the `turnstile:price` text record on
`liquidity.turnstile.eth`, read off Sepolia on 2026-09-07.

**Write the descriptions as agent documentation, because that is what they become.**
Bazantic generates the hosted MCP server from this document, so each operation's
`description` is the tool doc an agent reads when deciding whether to call it. The
spec is therefore written in when/why/how form — when to reach for a tier, why the
expensive one costs five times more, and how to read `caveats` and `confidence`
before acting on `rating` — rather than as a field-by-field restatement of the
response shape.

---

## The Recipe

Bazantic's framing is that a Recipe explains to an agent **when, why and how** to
use a service, not that it wraps an endpoint. The copy below is written that way and
is ready to paste into the Recipe UI.

### Why this Recipe and not a synthetic one

It mirrors what `seller/analyst/` already does in production, so the Recipe
documents real behaviour rather than inventing a flow for the demo. That matters
for this prize specifically: the brief asks for a Recipe *other builders can reuse*,
not a one-off connection created only to satisfy the judging.

### Services chained

| Step | Service | Sponsor | Contributes |
|---|---|---|---|
| 1 | **The Graph** — Messari-conformant Uniswap v3 subgraph at `https://api.studio.thegraph.com/query/1758854/turnstile-uniswap-v-3-messari/v0.1.0` | The Graph | the pool's history and its **claimed TVL** |
| 2 | **Turnstile Liquidity Analyst** (this gateway), `analyzePoolAttested` | — | a **live Uniswap QuoterV2 depth ladder** at the current block, and the verdict |

Step 1 is a service from a different sponsor, which is what the brief requires —
"at least one other service already available through Bazantic or available from a
sponsor of the ETHGlobal Online Hackathon".

### Recipe copy

> **Name:** Is this Uniswap pool actually safe to LP?
>
> **When to use this.** An agent is about to provide liquidity, or is ranking pools
> for someone who will. The obvious move — sort by TVL and take the top — is wrong
> often enough to lose money, and neither a subgraph nor a quoter can tell you so on
> its own. Reach for this Recipe whenever a decision depends on how much capital a
> pool can *actually* absorb, as opposed to how much it reports holding.
>
> **Why two services.** They fail in opposite directions, and that is the point.
>
> The Graph knows what the pool *has been*: realized fee revenue, trading
> continuity, age, LP count. It cannot know what the pool is right now — it is
> indexed, therefore behind — and its USD prices are derived from pools, so checking
> a pool against them is circular.
>
> Uniswap's QuoterV2 knows what the pool *will do* at this block: depth at size,
> slippage, initialized ticks crossed. It knows nothing about whether this instant
> is typical. A quote cannot tell you the pool only trades for one hour a day;
> cumulative volume cannot tell you it emptied yesterday.
>
> The answer lives in the gap. Ask both.
>
> **How.**
>
> 1. Query the Messari-conformant Uniswap v3 subgraph on The Graph for the pool:
>    `totalValueLockedUSD`, `cumulativeSupplySideRevenueUSD`, reserves per token,
>    `createdTimestamp`, and the hourly snapshots. Note that the hourly buckets are
>    **sparse** — an hour with no activity produces no row rather than a row of
>    zeroes — so measure activity against elapsed hours, never against the row count.
>    Carry forward the **claimed TVL**.
> 2. Call `analyzePoolAttested` on the Turnstile gateway with the same pool address.
>    It quotes the pool live against Uniswap QuoterV2 at the current block and walks
>    a depth ladder — $1k, $10k, $100k, $1M, $10M — reporting executed output,
>    realized slippage, and **initialized ticks crossed** for each rung. Ticks
>    crossed is the load-bearing number: in concentrated liquidity it says how much
>    of the range the trade ate through, and therefore how much worse the next trade
>    will be. Carry forward the **largest notional that fills within 1% slippage**.
> 3. Divide. `reachable depth ÷ claimed TVL` is the finding, and it is arithmetically
>    impossible from either step alone. Read it alongside `rating`, `confidence` and
>    `caveats`; where the live quote and the history disagree, **believe the quote**,
>    and use `provenance.subgraphLagSeconds` to see how stale the history was.
>
> **What it looks like on real data.** Uniswap v3 USDC/WETH 0.05%
> (`0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640`), at mainnet block 25,925,794 on
> 2026-09-07, returned **ACCEPTABLE at 75% confidence** — and only **0.944%** of
> its claimed TVL was reachable within 1% slippage. $1.00M filled inside 1%
> (0.385% slippage, 9 initialized ticks crossed); $10.00M cost 4.837% and crossed
> 125. **Re-derive these live rather than quoting them** — see the note on drift
> below. In concentrated liquidity a small ratio is
> normal, since most capital sits outside the active range by design — but it does
> mean the headline number overstates fee-earning capital by two orders of magnitude,
> and an LP sizing a position off TVL will be disappointed.
>
> Neither service produces that sentence. The Graph supplies the claimed TVL and
> cannot see the ladder; the quoter supplies the ladder and has never heard of the
> claimed TVL. The verdict is the ratio between them.
>
> **Cost and escalation.** Screen broadly with `analyzePoolStandard` ($0.07,
> subgraph only — it says in `caveats` that it took no live quote and lowers
> `confidence` accordingly), then spend $0.35 on `analyzePoolAttested` for the
> shortlist. Do not pay for a live quote on a pool that history alone already
> rejects.
>
> **When *not* to use it.** If you only need TVL or 24h volume, query The Graph
> directly and skip this — you are not making a decision that depends on
> executability, so you are paying for evidence you will not use.

### The interdependence, stated plainly for the judges

The headline number — 0.944% at mainnet block 25,925,794 — is a quotient with one
operand from each service. Remove The Graph and there is no denominator; remove
Uniswap and there is no numerator. The prize asks that "the final result depend
meaningfully on both services", and here the dependence is arithmetic rather than
rhetorical.

**Derive it on camera rather than quoting it.** It is a live figure and it drifts
(see below), so a number recited in a Recipe or a video is wrong by the time a
judge re-runs it — and worse, it makes the one claim the prize turns on look
fabricated. Showing the two operands arrive from two services and the division
happen is also a better demonstration of interdependence than any number.

---

## Demo script for the screen recording

The acceptance criterion is a recording of the completed task start to finish.
Suggested take, ~3 minutes:

1. `baz login` → approve in the browser → `baz whoami` shows `IpastorSan`.
2. `baz gateway add …` → the `{ ok, id, slug, mcpUrl }` JSON.
3. `baz gateway list --json` → the `endpointUrl`.
4. The Recipe open in the Bazantic UI.
5. The flow running end to end: the subgraph query returning claimed TVL, then
   `analyzePoolAttested` paying its 402 and returning the ladder, then the ratio
   falling out of the two **computed on camera, not read from these notes**.
6. `baz curl` against the gateway paying a 402 live, and `getReceipt` resolving the
   transaction afterwards — this is the part that shows the money is real.

Turnstile already settles real value: transaction `0.0.7162784@1788791855.758948636`
on Hedera testnet, with HCS receipts on topic `0.0.10408013`. See
`docs/payment-flow.md`.

---

## Submission notes

- **Bazantic username: `IpastorSan`** (GitHub sign-in). Required for Recipe attribution.
- **Registered 2026-09-11 09:42 UTC, status active:**
  `{ id: a2313406-eb44-4a51-af1f-ce668dff514f, slug: uiytibxlirffdly7zzti372rj4 }`
  — `mcpUrl`: `https://uiytibxlirffdly7zzti372rj4.bazgateway.com/mcp`,
  `endpointUrl`: `https://uiytibxlirffdly7zzti372rj4.bazgateway.com` (read back
  from `baz gateway list --json`, never hand-built). `--spec-url` is the
  public-repo raw URL
  `https://raw.githubusercontent.com/IpastorSan/turnstile/main/seller/service/openapi.yaml`;
  `--auth-type x402-mpp`. The gateway's MCP `initialize` answers and names the
  server "Turnstile Liquidity Analyst" — verified from outside the same day.
- Recipe: *web-app paste at bazantic.com, copy in "The Recipe" above — still to do.*
- Live payment through the gateway (`baz curl`, needs a funded payer via
  `baz wallet` or `baz grant`): *still to do; record the transaction here the
  first time it settles.*
- Recording: *record its URL here.*

## Open items

- [x] ~~A public HTTPS deployment of the seller service~~ — live since
  2026-09-11: `https://turnstile.moveseventyeight.com` (blockers #2 and #3 are
  dead: the endpoint is public HTTPS and the repo is public, so the spec is
  fetchable). The gateway is registered against it.
- [ ] A funded payer (`baz wallet` funding or a `baz grant`) for the live
  `baz curl` 402 payment. Human action — it moves money.
- [x] ~~`baz login` approved in a browser as `IpastorSan`~~ — done 2026-09-11,
  `baz whoami` confirms (blocker #1 dead).
- [x] ~~`baz gateway add` run~~ — done 2026-09-11, output recorded above.
- [ ] Recipe created in the Bazantic web app from the copy above (blocker #4)
- [ ] Screen recording captured (blocker #5)

## Not verified by the agent

- **Bazantic's Recipe UI** — its fields, length limits and whether it accepts
  Markdown are unknown. The copy above is structured with headings and may need
  reflowing to fit the form. Nobody on this branch could open the app.
- **Whether a Recipe can reference a raw subgraph endpoint** as step 1, or whether
  both steps must be registered Bazantic gateways. If the latter, step 1 becomes
  "The Graph's own Bazantic service, if one is listed" — check the catalogue when
  the browser is open. This is the single most likely reason the Recipe as written
  needs reshaping.
- **Every live figure above.** They were true at their stated block and are not
  constants.

  > **Correction (2026-09-07, MOV-231):** an earlier revision of this file treated
  > `$105.9M` claimed TVL as a figure merely awaiting confirmation. It is not — it
  > came from a MOV-216 report that never landed in a file, and chasing it showed
  > the number is not stable enough to quote at all. The same pool read **$106.68M,
  > $105.9M and $105.72M within three hours** on 2026-09-07, and the reachable-
  > within-1% ratio moved **0.944% → 0.946%**.
  >
  > Still true: the derivation is sound — $1.00M reachable at 0.944% does imply
  > ≈$105.9M, which is why the brief's number was plausible. What changed is the
  > conclusion. Per the `CHECKLIST.md` gate on live figures, every number in
  > submission copy carries its capture timestamp and block, or is derived live on
  > camera. The figures in this file and in `seller/service/openapi.yaml` are now
  > anchored to mainnet block 25,925,794 (2026-09-07); the Recipe copy and the
  > demo script prefer live derivation.
