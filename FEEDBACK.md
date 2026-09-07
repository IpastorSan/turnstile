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
