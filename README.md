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
| **Hot** | Circle / Arc Agent Stack | Buyer agent's spending wallet | Every query | Nothing. Spends *within* the mandate; **signs offchain and never submits a transaction**, so it pays exactly zero gas |

**Correction (2026-09-07, MOV-225):** the Hot row previously read "holds zero
native token (Paymaster)". That is **wrong on Arc** — it names a mechanism that
does not exist in this design, and it cannot be true on a chain where USDC *is*
the gas token. The row above replaces it with a stronger claim, and the evidence
for it is on chain.

**The claim, and how to falsify it.** The hot wallet signs an EIP-3009
authorization offchain and **never submits a transaction**, so it pays exactly
zero gas — Circle Gateway's batcher submits, and pays. The proof is the wallet's
**nonce**, because a wallet that has never broadcast a transaction has never paid
a wei of gas, and a nonce cannot be faked or back-dated. After **eleven** settled
payments:

```
agent 0x0633a193017939Bb1eB242982397224c66948e2F
  eth_getTransactionCount   0        <-- never submitted anything
  eth_getBalance            0
  USDC.balanceOf            0
                            read at block 60943091, 2026-09-07T17:33:02Z
```

Anyone can re-run that against `https://rpc.testnet.arc.network` and get the same
answer at that block. `scripts/arc-paid-request.ts` prints it before and after
every run, so a regression fails visibly instead of quietly.

**Why the old wording was incoherent** (supporting detail, not the claim). USDC
is Arc's native gas token, so `eth_getBalance(a)` and `USDC.balanceOf(a)` are two
views of one balance at two precisions — the ERC-20 view truncates 18 dp to 6.
Measured on **our own** org wallet, one block before it funded the mandate:

```
0xdFe3088aC34e7329006407C246C9F6D7534B2aC5
  eth_getBalance   20000000000000000000   (18 dp) = 20.000000 USDC
  USDC.balanceOf              20000000   ( 6 dp) = 20.000000 USDC
                   read at block 60938781, 2026-09-07T16:56:10Z
```

A wallet holding zero native token therefore holds zero USDC and can pay nobody.
There is no Paymaster anywhere in Turnstile, and there never was one — the word
was carried over from a chain where gas and payment are different assets.

The hot wallet's Gateway balance is funded by the **warm tier** calling
`depositFor(amount, agent)`: the org pays the deposit's gas and the resulting
balance belongs to the agent. That is this table's own hierarchy expressed in one
contract call — the hot key cannot deposit, withdraw or widen its allowance,
because each is a transaction and it has no gas for one.

**What is unchanged:** every other row, and the invariant below the table. Only
the mechanism named in the Hot row was wrong.


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

## Sell the answer, keep the method

The tagline is a mechanism, not a slogan. The Liquidity Analyst
([`seller/analyst/`](./seller/analyst)) answers one question — *is this pool
safe to LP?* — and if we published it, we would have published the answer to
every future query along with it.

So the scoring runs inside an attested AWS Nitro enclave, through a **Chainlink
CRE confidential workflow** ([`seller/cre/`](./seller/cre)):

```
seller's calibration ──Vault DON secret──┐
                                          ├─▶ [ enclave: assess() ] ──┐
evidence bundle ──confidential HTTP───────┘                           │
 (9,218 bytes; the endpoint 401s without the sealed token)            │
                                             usingTheDons() ◀─────────┘
                                                   ▼  one-way door
                       rating · confidence · failMask · warnMask · keccak256(evidence)
                                                   ▼  writeReport
                                       VerdictConsumer, Sepolia
```

The buyer gets a verdict they can **verify** and cannot **reproduce**. The hash
is what makes it verifiable: hash the evidence bundle you paid for, ask the
chain whether the attested verdict commits to those exact bytes. Someone who has
not paid learns nothing from a hash.

What stays public is the *shape* of the judgement — seven named signals, which
are structural, how one structural failure forces `AVOID` — because that is what
makes a verdict auditable rather than an oracle. What stays sealed is the
*calibration*, which is what live data actually buys.

Read [`docs/cre-confidential-workflow.md`](./docs/cre-confidential-workflow.md)
for the terminal output, the on-chain addresses, and an explicit list of what has
**not** been exercised — real attestation among it, because deployment access is
gated.

## Repository layout

| Path | What lives here |
|---|---|
| `contracts/` | Foundry. ENSv2 subname registry + registrar, and `VerdictConsumer` — where the enclave's verdict settles (Sepolia) |
| `graph/subgraph/` | Messari DEX AMM Extended v4.0.1 conformant subgraph |
| `graph/substreams/` | Rust. Authored ERC-8004 agent-registry normalization module |
| `seller/` | x402-gated service, Liquidity Analyst, CRE confidential workflow, Ledger-sealed secrets |
| `rails/` | `PaymentRail.ts` seam + Hedera x402 and Arc USDC implementations |
| `buyer/` | `org/` the Privy org wallet and its key quorums, `mandate/` what the agent may spend, `watchdog/` the agent |
| `mcp-turnstile/` | MCP server + `SKILL.md` — the reusable-infrastructure artifact |
| `uniswap-mcp/` | Standalone MCP server + `SKILL.md` over the Uniswap stack. No repo imports, no API key |
| `identity/` | World Selfie Check, nullifier ↔ cold key binding |
| `web/` | Next.js frontend and backend — market + seller pages, live ENS and discovery reads |
| `docs/` | Architecture notes, submission copy, on-chain evidence |
| `scripts/` | `wt.sh`, the worktree helper the git workflow runs on; the end-to-end paid request on each rail (`hedera-paid-request.ts`, `arc-paid-request.ts`) |

## Uniswap contributions

Three separable contributions, each of which stands on its own —
[`docs/uniswap-contributions.md`](./docs/uniswap-contributions.md) has the full
account, with the code links and the evidence for every claim.

1. **A standardized AMM subgraph** ([`graph/subgraph/`](./graph/subgraph)) —
   Messari DEX AMM Extended v4.0.1 over Uniswap v3, deployed and answering. One
   query document runs byte-identical against four AMMs by four teams on two
   chains, which is what makes cross-protocol comparison arithmetic rather than
   archaeology. It is also more correct than Messari's own published v3
   subgraphs, which return a constant for `Tick.prices` and zero for
   `Position.liquidityUSD`.
2. **`uniswap-mcp`** ([`uniswap-mcp/`](./uniswap-mcp)) — an MCP server and
   `SKILL.md` for depth-at-size, per-pool quoting and Messari AMM history.
   Copy the directory out and it runs: nothing in it imports anything else in
   this repo, and it needs no API key. Its flagship output is
   `initializedTicksCrossed` across a size ladder, which is the difference
   between a pool that is deep and one that merely has a large TVL attached.
3. **An upstream fix** to `Uniswap/uniswap-ai`, Uniswap's official agent-tooling
   repo: its v4 quoting skill mandates ethers v5's `callStatic`, which v6
   removed and viem never had — in a skill whose every other snippet is viem.
   Its eval rubrics grade for it too.

Rough edges are recorded in [`FEEDBACK.md`](./FEEDBACK.md) as we hit them.

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
