# Architecture

Date: 2026-09-07
Issue: MOV-230
Asset: [`architecture.svg`](./architecture.svg) (source) · [`architecture.png`](./architecture.png) (embedded in the root `README.md`)

![Turnstile architecture: the three key tiers, and the request path](./architecture.png)

**Correction (2026-09-08, MOV-000): the diagram was re-rendered and three of its
labels changed.** The `.svg` is the source and the `.png` was regenerated from it
with `rsvg-convert -w 1200 -h 980 docs/architecture.svg -o docs/architecture.png`.

| Was | Now | Why |
| --- | --- | --- |
| Cold row title: `Ledger Key Ring` | `Cold key, held offline` | The Ledger track is **not pursued** — no such device works here. See section A. |
| Cold row line 2: `Seals upstream API keys` | `Held offline · not hardware-backed` | Nothing seals those keys; `seller/secrets/` holds no `.enc` files. |
| Hot row line 2: `Holds zero native token — Paymaster pays gas` | `Signs offchain, never submits — pays zero gas` | **Found while doing the above.** This is the exact Paymaster wording MOV-225 corrected as wrong on 2026-09-07 in `CLAUDE.md`, `README.md` and section A of this file — the diagram was missed at the time, so the picture kept asserting it for a day after the prose stopped. There is no Paymaster in Turnstile. |

The `<desc>` accessibility text was updated to match. Nothing else in the
diagram changed: both panels, the invariant banner and the whole request path
are as MOV-230 drew them.

**Correction (2026-09-08, MOV-005): the diagram was re-rendered again, and the
two Cold rows above were superseded within hours of being written.** The MOV-000
row replaced a false vendor claim with a false *custody* claim, so the labels it
introduced are themselves now wrong.

| Was (MOV-000) | Now (MOV-005) | Why |
| --- | --- | --- |
| Cold row title: `Cold key, held offline` | `Operator key, role-scoped` | The key is not held offline. `addresses.turnstile.sepolia.json` records `coldKey` and `deployer` as the same address, and its private key is `DEPLOYER_PRIVATE_KEY` in `.env`. |
| Cold row line 2: `Held offline · not hardware-backed` | `Only key that may move the payout` | States what the chain enforces instead of what a laptop supposedly does. Provable: MOV-218's `setAddr` revert. |

The `<desc>` text was updated a second time for the same reason.

**This is the third correction to this diagram in two days, and the second where
the picture outlived a fix to the prose it illustrates** (MOV-000 caught the
Paymaster wording a day late; this one caught custody wording within hours).
A `.png` is a claim surface that no `grep` can audit, so it needs checking by
eye whenever a tier or a mechanism changes. Re-render with:

```
rsvg-convert -w 1200 docs/architecture.svg -o docs/architecture.png
```

Two things are drawn here because they are the two things a reader has to hold
at once: **where the keys sit**, and **what happens when an agent buys an
answer**. They are not independent — step 05 of the request path is the only
step the hot key touches, and it is the reason the hot key is allowed to exist
at all.

---

## A. The three key tiers

Three wallet vendors is not three ways to do one thing. Each sits where it is
actually best, and together they are one cold/warm/hot hierarchy.

| Tier | Vendor | Holds | Frequency | May authorize |
|---|---|---|---|---|
| **Cold** | A separate key. Custody is **not** cold today, see below | Seller operator identity; owns the ENSv2 name | Once per lifecycle | Hot-key rotation, payout address change, price-ceiling raise |
| **Warm** | Privy | Buyer **organization** wallet + mandate policy | Occasional | Issuing a mandate, raising a cap (quorum), adding an agent |
| **Hot** | Circle / Arc Agent Stack | Buyer agent's spending wallet | Every query | Nothing. Spends *within* the mandate; **signs offchain and never submits a transaction**, so it pays exactly zero gas |

**Correction (2026-09-08, MOV-000):** the Cold row previously named **Ledger Key
Ring (`wallet-cli ring`)** as the vendor and claimed it "seals upstream API
keys". Both are withdrawn — **we do not use a Ledger device and never got one
working.** `wallet-cli ring init` fails on the only device available to us, a
**Ledger Nano S** (the original 2016 model, EOL, firmware capped at 2.1.0): it
creates the local member credentials and then fails at the device step with an
untyped "unknown error". LKRP is the trustchain behind Ledger Recover, which has
never supported the Nano S. It is not permissions (udev verified, `uaccess` tag
present, hidraw readable), not transport (`genuine-check` returns a *typed*
error, so the device does answer), and not the package — the model cannot do it.
The Ledger prize track is **not pursued**; see `CHECKLIST.md`.

**What is unchanged: the cold tier itself, and every other row.** Ledger was only
ever going to be *where the cold key lives*, never *what makes it cold*. The
cold/hot split is enforced by the resolver's role checks, and it is proven on
chain rather than in prose — MOV-218 demonstrated the hot key's `setAddr` payout
change **reverting** with `EACUnauthorizedAccountRoles`, live on Sepolia, with
passing Forge tests and a fork test behind it. What falls is only the custody
story: the cold key is **not** hardware-backed. No substitute vendor is
claimed.

**Correction (2026-09-08, MOV-005): "held offline" was not true, and this row
said it in four files.** When the Ledger track was dropped, the Cold row's vendor
became "A cold key held offline". That traded an unverifiable vendor claim for an
unverifiable *custody* claim. `contracts/addresses.turnstile.sepolia.json` records
`coldKey` and `deployer` as the **same address**
(`0x0Adca6e14bA956201D221feC767e4f24194bf5F2`), and its private key is
`DEPLOYER_PRIVATE_KEY` in `.env` on the working laptop, loaded by every deploy
script. It is not offline in any sense.

**What is true, and is the claim worth making.** The tiers are a separation of
*authority*, not of custody, and that separation is real and enforced by the
chain rather than by our prose:

- Two distinct keys exist. `0x0Adca6e1…f5F2` holds the root roles on
  `liquidity.turnstile.eth`. The hot key `0x16244874…6367` holds roles scoped to
  exactly two records, `agent-endpoint[mcp]` and `turnstile:price`.
- The hot key **cannot** move the payout address. MOV-218 demonstrated its
  `setAddr` reverting with `EACUnauthorizedAccountRoles`, live on Sepolia, with
  Forge tests and a fork test behind it.

So: say "a separate key holds the only roles that can move the payout address,
and the chain enforces it". Do **not** say cold storage, hardware, or offline.
Making the custody genuinely cold means generating that key on an offline machine
and keeping it out of `.env` entirely, signing the rare cold-tier transactions
air-gapped. That is not done, and claiming it would be the same mistake twice.



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


### The invariant

**The key that spends can never raise its own limit.**

Authority flows downward only. If a change would let the hot tier widen its own
mandate, rotate a key, or move a payout address, the change is wrong — take it
to the tier above. The tier separation is central here, not decorative; there is
no "convenience" path that bypasses the cold key.

**Correction (2026-09-08, MOV-000):** this paragraph previously read
"Device-backed security is central here … bypasses the Ledger". There is no
device — see the correction under the table in section A. The invariant itself
is **unchanged and still enforced on chain**, by the resolver's role checks; only
the appeal to hardware is gone.

This is visible on chain rather than only in prose. `turnstile:price` is written
by the hot key; `turnstile:price-ceiling` is written by the cold key. A hot key
that tries to price above the ceiling is rejected by the resolver's write
permissions, not by a policy document. See
[`ens-offer-records.md`](./ens-offer-records.md).

### Where each tier is implemented today

| Tier | State on 2026-09-07 |
|---|---|
| Cold | **Live.** `liquidity.turnstile.eth` on Sepolia, resolver `0xb1B4Da2C49814c8CbF975E7a48fbB014EA0b075B`, operator proof published as a resolver record. **Correction (2026-09-08, MOV-000):** the published string is `ledger-key-ring` and this row used to quote it without comment. It is a **stale label** — the Ledger track is not pursued and no Ledger is used; the code now publishes `cold-key-offline` instead. The tier is still live and the split still enforced; only the label is wrong. See `ens-offer-records.md`. |
| Warm | **Live (MOV-228).** A Privy server wallet at `0x3De96375140717193f52c220Df5Ec460971cbE84` (Privy id `w0cxyoh1lnc1lqfyi9tb5yej`), owned by a 1-of-2 operations key quorum and governed by a mandate policy owned by a separate 2-of-2 board quorum. It signed the `depositFor()` that funds the agent, on chain. **Correction (2026-09-07, MOV-228):** this row previously read "Not built. MOV-228 (Privy) has not been started. `/mandate` in the web app is a labelled placeholder." The first two sentences are now wrong; the third is unchanged and still true — the web app's `/mandate` page is still a placeholder, and the mandate lives in `buyer/mandate/` and in the Privy policy, not in the UI. See `docs/privy-mandate.md`. |
| Hot | **Built (MOV-225), and it is the Arc rail's buyer half.** `buyer/watchdog/arc-signer.ts` is the spending wallet: it signs EIP-3009 authorizations against Circle Gateway and submits nothing, so its nonce stays 0. Funded by the warm tier through `depositFor`. **Correction (2026-09-07, MOV-225):** this row previously read "Not built. The Arc/Circle spending wallet lands with the rails work." — that was accurate when written and the rails work has now landed. **Correction (2026-09-07, MOV-228):** MOV-225's note added here that "the `depositFor` caller is a plain key today rather than an org wallet with a quorum" — that is no longer true, and the Warm row above now says what replaced it. Everything else in this row is unchanged: the hot wallet's nonce is still 0, verified by `buyer/watchdog/hot-wallet.test.ts` after MOV-228's changes. |

---

## B. The request path

```
01 Discover  →  02 Read the offer  →  03 Ask  →  04 402  →  05 Pay  →  06 Answer
```

| Step | What happens | Where it lives | State |
|---|---|---|---|
| **01 Discover** | ERC-8004 Identity Registry registrations, streamed cross-chain via Substreams into a queryable store | `graph/substreams/`, `graph/sink/` | **Live** — 197 agents, 3 chains |
| **02 Read the offer** | The seller's ENSv2 resolver is read for `turnstile:price`, `turnstile:rails`, `agent-endpoint[mcp]` | `graph/sink/ens.ts`, `web/lib/ens.ts` | **Live** — read from Sepolia per request |
| **03 Ask** | Buyer's agent calls the MCP endpoint named in `agent-endpoint[mcp]` | `mcp-turnstile/`, `seller/service/` | **Live locally** — the service runs from the repo; the hosted address is not deployed until Sept 14 |
| **04 402** | The endpoint answers `HTTP 402 Payment Required` with a quote that must match the posted price | `seller/service/` | **Live** (MOV-220) |
| **05 Pay** | The hot key settles on x402 or USDC on Arc, inside the mandate | `rails/PaymentRail.ts` | **Live on both rails, with real money** (MOV-220, MOV-225) |
| **06 Answer** | The result is returned. The method that produced it is not. | `seller/analyst/`, `seller/cre/` | **Live**, premium tier through the CRE enclave (MOV-227) |

**Correction (2026-09-08).** Rows 03 to 06 above read **Not built** until today,
and the paragraph below them said so twice. That was accurate when written and
stopped being accurate on 2026-09-07, when MOV-220 settled real HBAR through
Blocky402 and MOV-225 settled real USDC on Arc. The table had become the
*pessimistic* lie rather than the optimistic one, which is the rarer failure and
just as wrong: a judge reading it would have concluded the settlement half did
not exist.

All six steps run today. The one real gap is deployment, not capability: the
address in `agent-endpoint[mcp]` has no DNS record until the Sept 14 deploy, so
step 03 works from the repo and not yet from the open internet. `CHECKLIST.md`
tracks that as a live gap rather than a cosmetic one.

### Step 02 is the leg the registry cannot supply

This is the load-bearing claim of the whole project, and it is measured rather
than asserted.

EIP-8004 registration-v1 **has no price field**, and under x402 the quote is
returned dynamically in the HTTP 402 response, so there is nothing on-chain for
a registry to carry. Of the 197 live agents in the discovery store:

| Price source | Agents |
| --- | ---: |
| `turnstile` — an ENSv2 `turnstile:price` record | **1** |
| `x402` — a live 402 quote we fetched | 0 |
| `document` — a price in the registration document | 0 |
| `ask_x402` — advertises x402, price knowable but unquoted | 97 |
| `none` — no price and no way to get one | 99 |

The one readable price is ours. 97 agents advertise `x402Support`; only 13
publish an endpoint that can be asked, and **none of the 13 returned a 402**.

*(Counts verified 2026-09-07 against the live store; see the correction note in
[`discovery-api.md`](./discovery-api.md) — they drift by a few agents between
runs as unreachable document origins come back.)*

**The registry tells you who exists; Turnstile tells you what they cost.**

---

## What sits where

| Path | Role in the diagram |
|---|---|
| `graph/substreams/` | Step 01 — the ERC-8004 normalization module |
| `graph/sink/` | Step 01 — the store, plus off-module document resolution and ENS hydration |
| `seller/service/discovery.ts` | Step 01 — `find_sellers`, the ranked query |
| `mcp-turnstile/` | Step 03 — the MCP tool a buyer's agent calls |
| `contracts/` | Step 02 — the ENSv2 name, resolver and ENSIP-25/26 offer records |
| `rails/PaymentRail.ts` | Step 05 — the rail seam |
| `web/` | Steps 01–02 as a browsable surface: market and seller pages, live reads |

---

## Not verified

- **The MCP endpoint published on chain does not answer.**
  `agent-endpoint[mcp]` resolves to
  `https://turnstile.moveseventyeight.com/liquidity.turnstile.eth/sse`, which has
  no DNS record until the deploy. The ENS record is real and readable; the
  service behind it runs from this repo and is not hosted. The seller page says
  so on the page rather than only here. **Changed 2026-09-08 (MOV-010)** from
  `mcp-eu.turnstile.xyz`, a host on a domain we do not own.
- ~~**Steps 04–06 have never been executed end to end.** There is no settlement
  receipt anywhere in the system, which is also why discovery's ranking is a
  labelled placeholder rather than settled volume.~~
  **Correction (2026-09-07, MOV-229):** the first sentence is wrong and the
  second is half wrong. Steps 04–06 *have* run end to end, more than once —
  MOV-220 settled real HBAR through Blocky402, and
  `mcp-turnstile/examples/discover-pay-reason.ts` does the whole discovery →
  quote → payment → audit loop from an MCP client. There are settlement receipts:
  twelve on HCS topic `0.0.10408013` as of 2026-09-07, every one of them
  cross-checked against the ledger by the `receipts` MCP tool (`verify: true`).
  Read them yourself with no key:
  `curl -s https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10408013/messages`.

  What is still true: **discovery's ranking is still a labelled placeholder.**
  The receipts exist on chain but have not been ingested into the SQLite store,
  so `settlement_receipt` is empty and `find_sellers` still reports
  `ranking.placeholder: true`. `npm run ingest-receipts` closes that gap and the
  ranking flips to `settled_volume` on its own.

  **Addition (2026-09-07, MOV-225):** and on the Arc rail too, which the MOV-229
  note above predates. One run paid the **same query over both rails** — Arc
  returned authorization `fa4ca648-863c-4f61-9a1e-2953eb789f7f`, Hedera returned
  `0.0.7162784@1788800327.098234984`, same verdict. Eleven Arc payments have
  settled in two batch transactions; see `docs/arc-nanopayments.md`. The ranking
  sentence is unaffected: Arc receipts are not ingested either.
- ~~**The warm and hot tiers are drawn from the design, not from running code.**
  Panel A describes where each vendor sits; only the cold tier is deployed.~~

  **Correction (2026-09-07, MOV-225):** the **hot** tier is running code —
  `buyer/watchdog/arc-signer.ts` signs the authorizations that bought real
  answers, and its nonce is 0 on Arc testnet, which is the diagram's claim about
  it made checkable. ~~The **warm** tier is still not Privy: `scripts/arc-setup.ts`
  calls `depositFor()` from a plain key where an org wallet with a quorum belongs.
  So the *position* in Panel A is real and the *vendor* is not, and MOV-228
  replaces the key rather than the mechanism.~~

  **Correction (2026-09-07, MOV-228):** the struck sentences above are now wrong.
  The **warm** tier *is* Privy: `scripts/arc-setup.ts` calls `depositFor()` from a
  Privy server wallet owned by a key quorum and capped by a Privy policy, and the
  two transactions it signed are linked in `docs/privy-mandate.md`. MOV-228 did
  replace the key rather than the mechanism, exactly as predicted. What is still
  true from MOV-225's note: only the **cold** tier is deployed under a
  device-held key, and Panel A's *positions* were always real.
