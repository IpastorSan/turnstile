# Turnstile

**A paid lane for onchain data agents. Sell the answer, keep the method.**

ETHOnline 2026 · From Scratch · [IpastorSan/turnstile](https://github.com/IpastorSan/turnstile)

Agents that sell onchain analysis have no way to be discovered, priced or
trusted, and no way to sell an *edge* — publishing the analyst reveals the
method. Buyers have no way to let an agent spend without handing it a key.
Turnstile fixes both ends: sellers publish a priced service at an ENSv2 subname
where the resolver record *is* the offer, and buyers issue a mandate their agent
spends inside but can never widen.

## The three key tiers

Three wallet vendors is not three ways to do one thing. Each sits where it is
actually best, and together they are one cold/warm/hot hierarchy.

| Tier | Vendor | Holds | Frequency | May authorize |
|---|---|---|---|---|
| **Cold** | Ledger Key Ring (`wallet-cli ring`) | Seller operator identity; owns the ENSv2 name; seals upstream API keys | Once per lifecycle | Hot-key rotation, payout address change, price-ceiling raise |
| **Warm** | Privy | Buyer **organization** wallet + mandate policy | Occasional | Issuing a mandate, raising a cap (quorum), adding an agent |
| **Hot** | Circle / Arc Agent Stack | Buyer agent's spending wallet | Every query | Nothing. Spends *within* the mandate, holds zero native token (Paymaster) |

The property that matters: **the key that spends can never raise its own limit.**

## Architecture

![Turnstile architecture: the three key tiers, and the request path](./docs/architecture.png)

Two panels: where the keys sit, and what happens when an agent buys an answer.
Full walkthrough, including which steps are live today and which are not, in
[`docs/architecture.md`](./docs/architecture.md).

The short version of the request path:

```
01 Discover  →  02 Read the offer  →  03 Ask  →  04 402  →  05 Pay  →  06 Answer
   ERC-8004      ENSv2 resolver       MCP        quote     x402 /      result, not
   Substreams    turnstile:price                           USDC on Arc  the method
```

**Steps 01 and 02 are live and browsable.** The market and seller pages run on
them against real registrations. Steps 03–06 are the settlement half and are not
built yet; `docs/architecture.md` says which issue delivers each.

## The web app

```bash
cd web && npm install
npm run dev        # http://localhost:3210
```

| Route | What it does |
|---|---|
| `/` | Market. All 197 real ERC-8004 registrations across Base, mainnet and Sepolia, filterable by capability, chain, price ceiling and x402 support. |
| `/seller/[name]` | One seller's ENSv2 records, read from Sepolia on every request. Nothing cached, nothing hard-coded. |
| `/mandate`, `/onboard` | Labelled placeholders. Blocked on MOV-228 and MOV-223; deliberately not faked. |
| `GET /api/sellers` | The discovery query over HTTP — the same engine the MCP tool calls. |
| `GET /api/offer/:name` | One seller's offer, read live from chain. |
| `GET /api/health` | Which of the two data dependencies this deployment can actually reach. |

`SEPOLIA_RPC_URL` must be set for the seller page to read anything; without it
the page says so rather than serving a cached price.

**One agent in 197 publishes a price anyone can read, and it is ours.** That
contrast is the product, so the market page gives "no knowable price" three
distinct states — posted on chain, askable but unanswered, nothing published —
instead of a blank cell. See [`docs/discovery-api.md`](./docs/discovery-api.md).

## Repository layout

| Path | What lives here |
|---|---|
| `contracts/` | Foundry. ENSv2 subname registry + registrar (Sepolia) |
| `graph/subgraph/` | Messari DEX AMM Extended v4.0.1 conformant subgraph |
| `graph/substreams/` | Rust. Authored ERC-8004 agent-registry normalization module |
| `seller/` | x402-gated service, Liquidity Analyst, CRE confidential workflow, Ledger-sealed secrets |
| `rails/` | `PaymentRail.ts` seam + Hedera x402 and Arc USDC implementations |
| `buyer/` | Mandate policy, Privy org wallet, the watchdog agent |
| `mcp-turnstile/` | MCP server + `SKILL.md` — the reusable-infrastructure artifact |
| `identity/` | World Selfie Check, nullifier ↔ cold key binding |
| `web/` | Next.js frontend and backend — market + seller pages, live ENS and discovery reads |
| `docs/` | Architecture notes, submission copy, on-chain evidence |
| `scripts/` | `wt.sh`, the worktree helper the git workflow runs on |

## Working in this repo

Read [`CLAUDE.md`](./CLAUDE.md) first — the branching workflow is mandatory and
not optional, and [`CHECKLIST.md`](./CHECKLIST.md) is the list of binary prize
gates. Feedback goes in [`FEEDBACK.md`](./FEEDBACK.md) (Uniswap) and
[`WORLD-FEEDBACK.md`](./WORLD-FEEDBACK.md) (World) as it happens.

```bash
cp .envrc.example .envrc   # then fill it in; .envrc and .env are gitignored
scripts/wt.sh new MOV-215 messari-subgraph
```

## License

MIT.
