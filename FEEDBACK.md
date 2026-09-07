# Uniswap developer feedback

Written continuously, not reconstructed at the end. Every time we hit a rough
edge in the Uniswap docs, SDKs, APIs or subgraphs, it gets a dated entry below —
that is checklist item 13.

Append-only (`merge=union`): add at the end, never rewrite an existing entry.

At submission time this file's link goes into the form at
https://developers.uniswap.org/hackathon-feedback — the prize requires the
submitted form, not just the file.

**Entry format**

```
### YYYY-MM-DD — one-line summary
- **Surface:** docs page / SDK / API / subgraph, with the URL or package
- **Expected:** what we thought would happen
- **Actual:** what happened
- **Cost:** how long it took to get past, and how
- **Fix we'd suggest:**
```

---

## Docs

## SDKs

## APIs and quoting

## Subgraphs and data

## Everything else

## Trading API and QuoterV2 — MOV-216 (2026-09-07)

Written while building `seller/analyst/`, a liquidity analyst that answers "is
this pool safe to LP?" from Uniswap v3 depth plus subgraph history. Everything
below was hit for real and re-verified before being written down.

### 2026-09-07 — `/v1/quote` validates the request body before it checks auth, so a 401 looks like a 400

- **Surface:** API — `POST https://trade-api.gateway.uniswap.org/v1/quote`
- **Expected:** an unauthenticated request answers `401` regardless of body, so
  "you need a key" is the first thing you learn.
- **Actual:** authentication is checked *after* body validation. A request with
  one field wrong comes back as a field error:

  ```
  400 {"errorCode":"RequestValidationError",
       "detail":"\"routingPreference\" must be one of [BEST_PRICE, FASTEST]"}
  ```

  Only once every field is correct does the real answer appear:

  ```
  401 {"errorCode":"Unauthorized","detail":"Unauthenticated api key or session"}
  ```

- **Cost:** two rounds of "nearly working". A 400 with a specific, helpful,
  correct field message is a strong signal that you are authenticated and merely
  malformed, so the natural response is to keep fixing fields. We only learned a
  key was needed by getting the body completely right. Perhaps 25 minutes, and
  it would have been much worse for someone who assumed the endpoint was open
  because it was answering in detail.
- **Fix we'd suggest:** check auth first and return 401 before validating the
  body. It is also the safer order — detailed field-level validation errors are
  free schema disclosure to an unauthenticated caller.

### 2026-09-07 — `docs.uniswap.org/api/quote/overview` redirects to a 404

- **Surface:** docs — `https://docs.uniswap.org/api/quote/overview`
- **Expected:** the old docs host redirects to the equivalent page on the new one.
- **Actual:** `301` to `https://developers.uniswap.org/api/quote/overview`, which
  is a `404`. Verified with `curl -o /dev/null -w '%{http_code} %{redirect_url}'`
  on both hops. The live page is under a different path entirely
  (`/docs/trading/swapping-api/...`), so the redirect points at a URL that has
  never existed on the new host rather than at the page's new home.
- **Cost:** ~10 minutes and a detour through `llms.txt` to find the real path.
  A redirect that lands on a 404 is worse than no redirect, because the 301
  reads as "we know where this went".
- **Fix we'd suggest:** map the old `/api/quote/*` prefix onto
  `/docs/trading/swapping-api/*`, or drop the redirect so the old URL 404s
  honestly on the old host and search results are corrected faster.

### 2026-09-07 — the QuoterV2 "not a view function" quirk is documented only in an ethers guide

- **Surface:** docs — `https://developers.uniswap.org/docs/sdks/v3/guides/swapping/quoting`
- **Expected:** a protocol-level note, on the QuoterV2 reference, that the quote
  functions are `nonpayable` and simulated.
- **Actual:** the explanation exists and is a good one — *"In an ideal world, the
  quoter functions would be `view` functions... However, the Uniswap v3 Quoter
  contracts rely on state-changing calls designed to be reverted to return the
  desired data"* — but it lives in the ethers-flavoured v3 SDK guide, and its
  remedy is `callStatic`, an ethers method name with no viem equivalent by that
  name. Following the docs while using viem, the reasonable conclusion is that
  viem cannot call the quoter at all. It can: `readContract` simulates through
  `eth_call` and decodes a nonpayable function without complaint (verified
  against mainnet QuoterV2 at `0x61fFE014bA17989E743c5F6cB21bF9697530B21e`).
  Separately, the deep link `docs.uniswap.org/contracts/v3/reference/periphery/
  lens/QuoterV2` does not resolve to a QuoterV2 page — it `303`s to a generic
  protocols overview, which is a silent wrong answer rather than a 404.
- **Cost:** ~20 minutes, and it briefly put a false claim into our own source
  comments before we tested it.
- **Fix we'd suggest:** put the paragraph on the QuoterV2 contract reference,
  where someone reading the ABI will meet it, and state the remedy in
  library-neutral terms — "call it through `eth_call`; every library has a way
  to do that" — with the ethers and viem spellings side by side.

### 2026-09-07 — a same-token pool reverts with "Unexpected error"

- **Surface:** contracts — QuoterV2 `quoteExactInputSingle` on mainnet
- **Expected:** a revert reason that identifies the problem.
- **Actual:** `Execution reverted with reason: Unexpected error.` for every size.
  The pool in question is a scam token at `0x83cff3334e2d00d98416ad72fc383b77a242e169`
  using the symbol `USDT` with 18 decimals, paired against the real 6-decimal
  USDT — so `tokenIn` and `tokenOut` carry the same symbol and the quote is
  meaningless. The message says nothing about which of the several possible
  causes applied (pool does not exist at that fee tier, zero liquidity, identical
  tokens).
- **Cost:** small for us, because a reverting rung is a *finding* in our design
  rather than an error — the analyst records it and reports the pool as unable
  to fill. But it took an extra query to work out why.
- **Fix we'd suggest:** distinct revert strings for "no pool at this fee tier",
  "zero liquidity" and "identical tokens". Quoting is the one place in the
  protocol where a caller is explicitly probing for the boundaries, so it is the
  place where a precise revert is worth the bytecode.

### 2026-09-07 — what worked well, since feedback that is only complaints is not useful

- `initializedTicksCrossed` on QuoterV2 is the single most useful number we
  found anywhere in this build. It turns "the quote got worse" into "the trade
  walked through 126 initialized ticks", which is a mechanical, comparable
  measure of how far liquidity is spread. Our slippage-curve signal is built on
  it. Nothing in the hosted Trading API's routed response is an equivalent, and
  we would not swap it for one.
- Quoting per-pool rather than per-route turned out to be exactly right for an
  LP-facing question, which is a distinction the docs could make explicitly:
  a router wants the best execution across all of Uniswap, an LP wants what one
  specific pool will do. They are different questions and the API surface for
  each is in a different part of the docs.

## Quoting across SDK versions, and the v3/v4 observability gap — MOV-226 (2026-09-07)

Written while building `uniswap-mcp/`, a standalone MCP server over the Uniswap
stack. Everything below was reproduced against live mainnet or against an
installed package before being written down; where a claim is a version number
or a return value, the check that produced it is shown.

### 2026-09-07 — the v4 quoting guide's example cannot work: ethers v6 imports, ethers v5 `callStatic`

- **Surface:** docs — `https://developers.uniswap.org/docs/sdks/v4/guides/swapping/quoting`
- **Expected:** the code on the page runs against the `ethers` it tells you to import.
- **Actual:** the page is internally inconsistent across two of its own snippets.
  It imports in **ethers v6** style —

  ```typescript
  import { parseUnits, JsonRpcProvider, formatUnits } from 'ethers'
  ```

  (in v5 these live at `ethers.utils.parseUnits` and
  `ethers.providers.JsonRpcProvider`, so this import only resolves on v6) — and
  then quotes with a method **v6 removed**:

  ```typescript
  const quotedAmountOut = await quoterContract.callStatic.quoteExactInputSingle({...})
  ```

  Against `ethers@6.17.0`:

  ```
  typeof c.callStatic                       -> undefined
  typeof c.quoteExactInputSingle.staticCall -> function
  c.callStatic.quoteExactInputSingle({...})
    -> TypeError: Cannot read properties of undefined (reading 'quoteExactInputSingle')
  ```

  Verified end to end against mainnet V4Quoter
  `0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203` using the guide's own ETH/USDC
  0.05% example. viem `readContract` and ethers v6 `.staticCall` both return
  **2477.420516 USDC** for 1 ETH — agreeing to the last decimal — while the
  documented `callStatic` throws.
- **Cost:** ~30 minutes, most of it spent doubting our own setup rather than the
  page. A guide that is wrong in a way that *looks* like a local problem is
  expensive out of proportion to the size of the error, because the reader's
  first hypothesis is always themselves.
- **Fix we'd suggest:** state the rule library-neutrally — the quoter is not
  `view`, so **simulate it through `eth_call`** — and then give the spellings
  side by side: `readContract` (viem), `.staticCall` (ethers v6),
  `callStatic` (ethers v5). The prose on that page explaining *why* the quoter
  reverts is genuinely good and should stay; it is only the remedy that has
  aged. `V4Quoter.sol` already carries the reason in its own NatSpec
  ("not marked view because they rely on calling non-view functions and
  reverting to compute the result"), and quoting it makes the instruction
  survive the next library change.

### 2026-09-07 — the official AI skill repeats it, and its evals grade for it

- **Surface:** repo — `Uniswap/uniswap-ai`,
  `packages/plugins/uniswap-trading/skills/v4-sdk-integration/`
- **Expected:** an official Uniswap **agent skill** emits code that runs.
- **Actual:** the skill mandates the ethers-v5 spelling as a strict rule —
  *"NEVER call Quoter onchain (gas expensive) — ALWAYS use `callStatic` for
  offchain simulation"* — while its own install line is
  `@uniswap/v4-sdk @uniswap/sdk-core @uniswap/universal-router-sdk` with **no
  ethers at all**, and every other snippet in the same file is viem
  (`walletClient.writeContract`, `functionName`/`args`). So the only library its
  quoting section assumes is the one it never installs, and the spelling it
  mandates exists in neither library it actually uses.

  It also reaches the eval suite: `evals/suites/v4-sdk-integration/rubrics/correctness.txt`
  awards points for *"Uses Quoter contract with callStatic"*. The grader
  therefore rewards generating code that throws on ethers v6 and on viem.
- **Cost:** none to us directly — we had already worked out the real answer for
  v3 — but this is the failure mode that matters most in an agent skill, because
  the wrong line is copied without a human reading it.
- **Fix we'd suggest:** we wrote it.
  `fix(uniswap-trading): quote through eth_call, not ethers v5 callStatic`,
  branch `IpastorSan:fix/quoter-static-call-ethers-v6` against
  `Uniswap/uniswap-ai` — prose only, 5 files, +42/−10, `markdownlint-cli2` and
  the repo's pinned `prettier@2.8.8` both clean. It states the neutral rule,
  quotes the NatSpec, gives all three spellings, and updates both rubrics.

### 2026-09-07 — V4Quoter drops `initializedTicksCrossed`, and nothing replaces it

- **Surface:** contracts — `V4Quoter` vs `QuoterV2`
- **Expected:** v4's quoter to report at least as much about execution as v3's.
- **Actual:** QuoterV2 returns
  `(amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate)`.
  V4Quoter returns `(amountOut, gasEstimate)`. Both the tick count *and* the
  post-swap sqrt price are gone.
- **Cost:** it is the reason `uniswap-mcp`'s depth profiling is v3-only. We can
  build a v4 price curve, but not the explanation underneath it.
- **Why it matters more than it looks:** `initializedTicksCrossed` is the single
  most useful number we found anywhere in this build, and we say so having gone
  looking for a substitute. It converts "the price got worse" into "the trade
  walked through 164 initialized ticks where a trade 10,000x smaller crossed 1",
  which is mechanical and comparable across pools and chains. Live, against the
  mainnet WETH/USDC 0.05% pool at block 25926800:

  ```
    sizeIn                 out    impact  ticks
         1         2479.761982    0.000%  1
        10        24795.448845    0.009%  1
       100       247735.449049    0.097%  3
      1000      2455419.048573    0.982%  20
     10000      22453014.79877    9.455%  164
  ```

  That last column is the difference between a pool that is deep and one that
  merely has a large TVL attached to it, and it is exactly what an LP-facing
  tool needs. Without it, a v4 depth reading is a curve with no account of why
  it bends. Concentrated liquidity is the thing v4 inherited from v3 and
  intensified — dropping the field that measures how concentrated it actually
  is seems like the wrong direction for LP tooling.
- **Fix we'd suggest:** add `initializedTicksCrossed` (and `sqrtPriceX96After`)
  to V4Quoter's return tuple. If the omission is deliberate because a v4 swap
  can route through hooks that make a tick count ambiguous, say that in the
  contract's NatSpec — right now the field's absence reads as an oversight
  rather than as a decision, and someone porting v3 LP tooling to v4 will spend
  time looking for where it moved to.

### 2026-09-07 — official docs links are two redirect hops stale, including inside Uniswap's own repos

- **Surface:** docs — the `docs.uniswap.org` → `developers.uniswap.org` migration
- **Actual:** every `docs.uniswap.org/sdk/v4/*` and `docs.uniswap.org/contracts/v4/*`
  link takes **two** 301 hops to arrive:

  ```
  docs.uniswap.org/sdk/v4/overview
    -> developers.uniswap.org/sdk/v4/overview
    -> developers.uniswap.org/docs/sdks/v4/overview   [200]
  ```

  All five links we checked do eventually resolve `200`, so this is a much
  milder problem than the `/api/quote/overview` case recorded above, which 301s
  to a 404. What makes it worth an entry is where the stale form appears:
  `Uniswap/uniswap-ai`'s own `v4-sdk-integration` skill links to
  `docs.uniswap.org/sdk/v4/*` and `docs.uniswap.org/contracts/v4/deployments`.
  An agent given `WebFetch` and a two-hop redirect is a coin flip.
- **Cost:** small, but it compounds: an agent that fails to follow the chain
  concludes the page is gone rather than moved.
- **Fix we'd suggest:** collapse the redirects to a single hop, and sweep the
  first-party repos for `docs.uniswap.org` links.

### 2026-09-07 — what worked well

Feedback that is only complaints is not useful, and two of these are genuinely
better than the alternatives we have used elsewhere.

- **`llms.txt` and `/llms.mdx/<path>` are excellent and under-advertised.**
  `developers.uniswap.org/llms.txt` is a complete annotated index, and any docs
  URL rewritten to `/llms.mdx/<path>` returns clean Markdown. For an agent this
  is dramatically better than scraping the rendered React page — it is how we
  read every docs page in this issue, and it is the reason the redirect
  problems above were cheap to diagnose rather than expensive. Worth linking
  from the docs homepage, not just serving.
- **The per-chain v3 deployment pages are accurate.** We independently derived
  the factory and QuoterV2 addresses for five chains and checked all fifteen
  with `eth_getCode`; every one matches its deployment page exactly, including
  the case most likely to be got wrong — **Base is the exception**, with both a
  different factory (`0x33128a8f…`) and a different QuoterV2
  (`0x3d4e44Eb…`), where mainnet, Arbitrum, Optimism and Polygon share
  `0x1F98431c…` and `0x61fFE014…`. Splitting deployments into one page per
  chain rather than one big table is the right call precisely because of cases
  like that: it makes the exception impossible to skim past.
- **QuoterV2 needs no API key.** This is the reason `uniswap-mcp` is reusable
  infrastructure anyone can run rather than something gated behind our
  credentials. It is easy to under-value how much a keyless endpoint enables,
  particularly against the Trading API's 401-behind-validation behaviour
  recorded above.
