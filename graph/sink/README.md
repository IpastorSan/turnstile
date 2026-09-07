# graph/sink — the discovery store

The Substreams module in `../substreams/` answers *who exists*. This turns that
stream into something you can query, and fills in the two things the module
cannot see.

```
substreams (map_agent_registrations)          ┐
   ↓  sink.ts                                 │  who exists, cross-chain
agent                                         ┘

agent_uri (ipfs:// https://)                  ┐
   ↓  resolve-cards.ts                        │  what they do
agent_card, agent_endpoint, agent_capability  ┘

liquidity.turnstile.eth (ENSv2 resolver)      ┐
   ↓  hydrate-sellers.ts                      │  what OUR sellers cost
turnstile_seller                              ┘

an agent's endpoint, over HTTP                ┐
   ↓  probe-x402.ts                           │  what ANYONE ELSE costs
x402_quote                                    ┘
```

`agent_current` is the view that joins all four. `seller/service/discovery.ts`
reads it; nothing else should read the base tables directly.

## Why SQLite

`node:sqlite` ships with Node, so the store goes from `git clone` to a query
with no server, no container and no native build. The schema is ordinary SQL —
the only SQLite-specific lines are the `PRAGMA`s at the top — so it ports to
Postgres the day one process is not enough.

## Running it

```bash
source .env                      # SUBSTREAMS_API_TOKEN, SEPOLIA_RPC_URL

# 1. who exists. One command per chain.
node graph/sink/sink.ts --network base    --start 41700000 --stop 41716000
node graph/sink/sink.ts --network mainnet --start 25000000 --stop 25015000
node graph/sink/sink.ts --network sepolia --start 11653700 --stop 11653730

# 2. what they do — the ~72% the module cannot decode
node graph/sink/resolve-cards.ts --concurrency 10

# 3. what our sellers cost, from their ENSv2 records
node graph/sink/hydrate-sellers.ts

# 4. optional: what everyone else costs, by asking for a 402
node graph/sink/probe-x402.ts --limit 40

# query it
node seller/service/discovery-cli.ts --capability liquidity --max-price 0.10
```

The store lands at `graph/sink/data/discovery.db` (gitignored). Every step is
idempotent and re-runnable.

### Chains cannot be sunk in parallel

The Graph Market plan caps concurrent streams at two:

```
Error: unable to complete work within backoff time limit: rpc error:
  code = ResourceExhausted desc = Concurrent stream limit exceeded (active sessions: 2/2)
```

Three chains at once fails on the third. Run them one at a time.

## Design notes

**`map_agent_registrations`, not `map_agent_directory`.** The directory module
reads `store_agent_wallets`, and a store must be backfilled from its
`initialBlock` before it can answer anything — 37,000 blocks of Base to read a
200-block window. The map module is a pure function of the block, so it streams
the requested range and nothing else. The wallet join it gives up is recovered
in SQL by `foldWallets()`: the sink is a store, so it can do the fold the store
module was doing.

**Failures are rows.** A 404, a timeout, a dead IPFS gateway — each is written
to `agent_card` with its status. A directory that dropped what it could not
reach would report a resolution rate it has not earned, and would tell a buyer's
agent "this seller advertises no capabilities" when the truth is "we could not
ask". `document_state` in `agent_current` distinguishes `in_module`,
`off_module`, `failed`, `no_uri`, `not_fetchable` and `pending`.

**`agentURI` is attacker-controlled.** Anyone can register an ERC-8004 agent
whose document URI points at `http://169.254.169.254/` or at something on the
sink's own network. `card.ts` refuses loopback, link-local, RFC1918 and CGNAT
destinations, re-checking on every redirect hop rather than letting `fetch`
follow one past the guard, and caps each body at 1 MiB so one endpoint that
streams forever cannot hang the run.

**Prices are not in the registry.** There is no price column on `agent`, because
EIP-8004 registration-v1 has no price field and a survey of 1,200 live
registrations found zero carrying one. `x402_support` is the real signal, and it
means *ask the endpoint*. See `../../docs/discovery-api.md`.

## Commands

| Command | What it does |
|---|---|
| `sink.ts --network N [--start B] [--stop B]` | Stream a chain into `agent`. `--from-file f.jsonl` replays a captured stream offline. |
| `resolve-cards.ts` | Fetch the documents the module could not. `--retry-failed` retries errors, `--force` refetches everything, `--reindex` re-derives capabilities from stored documents with no network calls. |
| `hydrate-sellers.ts` | Read Turnstile sellers' ENSv2 records. Seller identity comes from `contracts/addresses.turnstile.sepolia.json`, not from a constant. |
| `probe-x402.ts` | Ask x402 endpoints for a quote. `--url U` probes one by hand. |

## Tables

| Table | Holds |
|---|---|
| `agent` | Current state per `agent_uid`, folded from the event stream. |
| `agent_wallet_update` | `agentWallet` history — who gets paid, and since when. |
| `agent_card` | Off-module fetch outcome, successes and failures alike. |
| `agent_endpoint` | Services from whichever document won. |
| `agent_capability` | Normalized capability tokens, so filtering is an index lookup. |
| `turnstile_seller` | Our sellers' ENSv2 offer: price, ceiling, rails, MCP endpoint, payout. |
| `x402_quote` | Live 402 quotes, with the timestamp that makes them perishable. |
| `settlement_receipt` | **Empty.** MOV-220 seam — the intended ranking signal. |
| `world_verification` | **Empty.** MOV-223 seam, blocked on World Sandbox approval. |
| `sink_cursor` | How far each chain has been consumed. |
