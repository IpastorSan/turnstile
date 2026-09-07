# The x402 service, as it actually answers

MOV-219, captured 2026-09-07 from a real run of `seller/service/` against the two
placeholder rails. Reproduce with `npm run serve` and `curl`, or read
`seller/service/x402.test.ts`, which asserts everything below.

> **Correction (2026-09-07, MOV-220): the Hedera half of this document is now
> history.** This file said "**both rails are placeholders and settle nothing**".
> That was true when it was written and is no longer. `hedera-x402` settles real
> value on Hedera testnet through Blocky402: `info.live` is `true`, its
> challenges carry `extra.turnstileSettlement: "live"`, and `/health` reports
> `settlementLive: true`.
>
> Three values in the transcript below are superseded, and one of them was
> **wrong**, not merely a placeholder:
>
> | Shown below | Actually | |
> |---|---|---|
> | `"network": "eip155:296"` | `"hedera:testnet"` | wrong — the facilitator rejects `eip155:296` |
> | `"asset": "PLACEHOLDER-hedera-testnet-usdc"` | `"0.0.0"` (native HBAR, 8 decimals) | |
> | `"amount": "70000"` | `"84367844"` tinybars | HBAR is not a dollar; the rail prices through an FX rate |
>
> **Everything else in this document is unchanged and still correct** — the
> header table, the v1/v2 differences, the two-rail `accepts[]`, the tier
> pricing, `extra.resource`, the receipt lookup, and the whole Interoperability
> section. `arc-usdc` is still a placeholder (MOV-225).
>
> For the live Hedera flow, the setup, and the on-chain transaction, read
> **`docs/payment-flow.md`**. The transcript below is kept as the MOV-219
> record rather than rewritten, because it is what the service did before any
> rail settled and that is worth being able to see.

**Both rails were placeholders when this was captured, and settled nothing.** The
402 flow, the header encoding and the receipts are real; no value moved. That was
stated on the wire (`extra.turnstileSettlement: "stub"`) and at `/health`
(`settlementLive: false`) rather than left for someone to discover. MOV-220
brought Hedera/Blocky402; MOV-225 brings Arc.

---

## The protocol version matters

This is x402 **v2**. The headers are:

| Header | Direction | Carries |
|---|---|---|
| `PAYMENT-REQUIRED` | 402 response | base64 of the `PaymentRequired` object |
| `PAYMENT-SIGNATURE` | retried request | base64 of the `PaymentPayload` |
| `PAYMENT-RESPONSE` | paid 200 | base64 of the `SettleResponse` |

**Not** v1's `X-PAYMENT` / `X-PAYMENT-RESPONSE`. Both spellings exist in
`@x402/core` 2.25.0 because it still speaks v1; anything new should be v2. The v2
`PaymentRequirements` also renames v1's `maxAmountRequired` to `amount` and drops
`resource`/`description` from each entry into a single `resource` object on the
response — worth knowing, because `seller/service/discovery.ts` normalises
`maxAmountRequired` when it probes *other* sellers' 402s, and those may be v1.

The challenge appears in the header **and** as the JSON body. The header is what
the protocol reads; the body is what a human with `curl` sees. Same object — a
test asserts they are deep-equal.

---

## Transcript

Ports and the fixture verdict aside, this is verbatim output.

```
=== UNPAID: HTTP 402 ===
PAYMENT-REQUIRED: eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQYXltZW50IHJlcXVpcmVkIiwicmVz...  (1948 bytes base64)
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "http://127.0.0.1:36683/analyze/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
    "description": "Liquidity Analyst verdict for pool 0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640 (subgraph only)",
    "mimeType": "application/json",
    "serviceName": "liquidity.turnstile.eth"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:296",
      "asset": "PLACEHOLDER-hedera-testnet-usdc",
      "amount": "70000",
      "payTo": "0.0.10403961",
      "maxTimeoutSeconds": 300,
      "extra": {
        "facilitator": "https://facilitator.blocky402.dev",
        "settlementModel": "facilitator-cosigned-transaction",
        "decimals": 6,
        "symbol": "USDC",
        "priceUsd": 0.07,
        "resource": "http://127.0.0.1:36683/analyze/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
        "turnstileSettlement": "stub",
        "turnstileNote": "PLACEHOLDER: hedera-x402 advertises the shape of a real exact payment and settles nothing."
      }
    },
    {
      "scheme": "exact",
      "network": "eip155:0-PLACEHOLDER-arc",
      "asset": "PLACEHOLDER-arc-usdc",
      "amount": "70000",
      "payTo": "0x0Adca6e14bA956201D221feC767e4f24194bf5F2",
      "maxTimeoutSeconds": 300,
      "extra": {
        "facilitator": "https://facilitator.arc.circle.com",
        "settlementModel": "facilitator-authorization",
        "decimals": 6,
        "symbol": "USDC",
        "priceUsd": 0.07,
        "resource": "http://127.0.0.1:36683/analyze/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
        "turnstileSettlement": "stub",
        "turnstileNote": "PLACEHOLDER: arc-usdc advertises the shape of a real exact payment and settles nothing."
      }
    }
  ],
  "extensions": {
    "turnstileTier": "standard"
  }
}

=== PAID: HTTP 200 ===
PAYMENT-RESPONSE (decoded): {
  "success": true,
  "transaction": "stub:hedera-x402:000001",
  "network": "eip155:296",
  "payer": "0.0.9999001",
  "amount": "70000"
}
body.tier = standard  body.verdict.rating = ACCEPTABLE  body.verdict.confidence = 0.75
body keys: tier, verdict

=== PREMIUM: HTTP 200 ===
PAYMENT-RESPONSE (decoded): {"success":true,"transaction":"stub:arc-usdc:000001","network":"eip155:0-PLACEHOLDER-arc","payer":"0xBuyerAgentWallet","amount":"350000"}
body keys: tier, verdict, analystInput, attestation
analystInput serializes to 712 bytes (fixture, not a real pool)

=== HEALTH ===
{
  "service": "liquidity.turnstile.eth",
  "settlementLive": false,
  "rails": [
    {
      "id": "hedera-x402",
      "label": "Hedera testnet USDC, settled through Blocky402",
      "scheme": "exact",
      "network": "eip155:296",
      "asset": {
        "id": "PLACEHOLDER-hedera-testnet-usdc",
        "symbol": "USDC",
        "decimals": 6
      },
      "ensRailToken": "x402",
      "live": false
    },
    {
      "id": "arc-usdc",
      "label": "Arc USDC, settled through the Circle Agent Stack facilitator",
      "scheme": "exact",
      "network": "eip155:0-PLACEHOLDER-arc",
      "asset": {
        "id": "PLACEHOLDER-arc-usdc",
        "symbol": "USDC",
        "decimals": 6
      },
      "ensRailToken": "usdc-arc",
      "live": false
    }
  ],
  "tiers": [
    {
      "id": "standard",
      "priceUsd": 0.07,
      "description": "Liquidity Analyst verdict — is this pool safe to LP? Answered from the subgraph."
    },
    {
      "id": "premium",
      "priceUsd": 0.35,
      "description": "Liquidity Analyst verdict with a live depth ladder, plus the full scorer input so the verdict can be re-derived."
    }
  ]
}
```

---

## What to notice

**`accepts[]` has two entries, on two networks.** The buyer's mandate picks one;
the seller does not choose. `buyer/watchdog/pay.ts` does the picking, and
`x402-interop.test.ts` asserts that a mandate preferring the *second* entry pays
on the second — i.e. that the order the seller lists them in does not decide it.

**`amount` is `"70000"`, not `0.07`.** An integer string in the asset's smallest
unit, always. `usdToAtomic()` scales through an integer because `0.07 * 1e6` in
IEEE 754 is `69999.99999999999`, and a payment one unit light gets rejected by a
facilitator, on a rail nobody is watching, during a demo.

**`extra` is where the chains live.** `settlementModel`,
`facilitator`, the transaction body a payer must co-sign — all opaque to
`seller/service/`, which copies the object onto the wire and hands it back to the
rail untouched. This is the whole trick that lets Hedera's facilitator-cosigned
transaction and Arc's authorization travel down one code path.

**`extra.resource` binds the challenge to the URL it was issued for.** A payment
authorized for `/analyze/:pool` cannot buy `/analyze/:pool/attested`: the service
rejects it on price (`70000 < 350000`) and the rail rejects it on the binding.
Both checks exist because they fail in different directions — the service cannot
read `extra`, and the rail does not know which URL is being requested unless it
is told.

**The receipt is retrievable.** `GET /receipts/stub:hedera-x402:000001` returns
the settlement. That lookup is `PaymentRail.receipt(id)`, and it is what
discovery's `settledVolume` ranking needs before it can stop calling itself a
placeholder. **Correction (2026-09-07, MOV-220):** it no longer needs to wait —
`rails/hedera-x402/hcs.ts` writes an HCS receipt per settled payment and
`graph/sink/ingest-receipts.ts` reads the topic into `settlement_receipt`, so
discovery ranks by settled volume as soon as one payment has landed. On the live
rail the id is a Hedera transaction id, not `stub:…`.

**The premium body carries `analystInput`.** On a real pool it is about 9.2KB
(measured on USDC/WETH 0.05%, 2026-09-07 — see `seller/analyst/README.md`); the
712 bytes above is the test fixture, which has no hourly snapshots and no depth
ladder. Why that matters has its own section below.

---

## What makes the premium tier checkable, and the one way to break it

This is the Chainlink claim, and it is worth being exact about because it looks
like an implementation detail and is not.

Turnstile's pitch is **sell the answer, keep the method**. The premium tier hands
over a verdict *and* the complete `AnalystInput` that produced it, while
`seller/analyst/scoring.ts` — the actual judgement — is never disclosed. What
stops that being "trust us" is that the buyer can verify the verdict came from an
attested run over exactly the input they are holding, without ever seeing the
scorer.

Two properties of `seller/analyst/` carry that, both measured rather than
assumed, on a real run against Uniswap v3 USDC/WETH 0.05% on 2026-09-07:

1. **`assess()` is pure** — a total function of `AnalystInput`, with no clock, no
   network, no filesystem and no module state. `now` is a field on the input, not
   a call to `Date.now()`.
2. **A complete `AnalystInput` serializes to 9,210 bytes and round-trips
   losslessly.** `assess(JSON.parse(JSON.stringify(input)))` is byte-identical to
   `assess(input)`.

Together they mean the enclave's argument and the premium payload are **one
object**. That is why attestation needed no new tier, no new field and no second
fetch.

### The failure mode, stated plainly

**An implementation must hash exactly the bytes the buyer receives in
`analystInput`.**

Hash a normalized form, a re-fetched input, a re-serialization with different key
ordering, or anything carrying a timestamp the buyer cannot reconstruct — and the
premium tier silently stops being checkable. It becomes an assertion with extra
steps.

Nothing would fail. No test would go red, no error would surface, the service
would keep returning 200s. The only person who would ever find out is a buyer who
tried to verify and found the hash never matches — or a judge who tried the same
thing. That is why the seam is written to make the correct thing the easy thing:
`seller/service/app.ts` passes the *same object reference* to the attestation
port that it serializes into the response, and
`seller/service/attestation.test.ts` asserts that the two serialize identically.

### The seam

`seller/service/attestation.ts`:

```ts
interface Attestation {
  status: 'unattested' | 'attested' | 'failed';
  note?: string;
  [key: string]: unknown;    // MOV-227's fields — consumer, pool key, evidence hash
}

interface AttestationPort {
  attest(input: AnalystInput, verdict: Verdict): Promise<Attestation>;
}
```

Injected on `ServiceOptions.attestation`, defaulting to `unattestedPort()`, which
reports `'unattested'` — not `'failed'`, because nothing was attempted and
claiming a failure we did not have is the same category of error as discovery
reporting `'unverified'` where it means `'unknown'`.

A port that throws **degrades rather than withholds**: `status: 'failed'` with the
reason, and the verdict and input are still delivered. That is deliberately the
opposite of how a settlement failure is handled, and the difference is what the
buyer still has. On a settlement failure they have nothing and have paid nothing,
so withholding is clean. Here they hold the verdict *and* the input behind it and
can re-derive the verdict themselves — which is exactly the fallback purity buys.
Throwing a delivered, checkable answer away because the notary was offline would
be the worse outcome for them.

*Open and deliberately undecided:* the buyer still paid the premium price for an
attestation they did not get. Whether to discount, refuse up front when the
enclave is known down, or leave it, is a pricing decision for MOV-227 and belongs
in Linear rather than being settled by accident in a catch block.

---

## Why `no-chain-code.test.ts` exists

If it fails your branch, it has found a boundary, not an obstacle. Please do not
route around it by adding your file to the exemption list.

`seller/service/no-chain-code.test.ts` scans every `.ts` in that directory and
fails on chain, vendor, asset and signature-format identifiers — `Sepolia`,
`eip155`, `viem`, `chainId`, `USDC`, `hedera`, `arc`. It also asserts that
exactly one file (`server.ts`, the composition root) imports a concrete rail.

The rule it enforces is the MOV-219 acceptance criterion: **the service speaks US
dollars and opaque strings; rails speak chains.** Stating that in a README does
not keep it true. Two rails land in parallel (MOV-220, MOV-225), and the cheapest
way for either to make its own life easier is a small `if` in the service — a
Hedera-shaped field on the challenge, a special case for how Arc reports a payer.
Each is individually reasonable. Together they are the abstraction gone, and by
then two implementations depend on it.

So when it fires, the answer is almost always **the code is in the wrong
directory**, not that the rule is too strict:

| You are writing | It goes in |
|---|---|
| a payment rail | `rails/<id>/` |
| an enclave, or anything reading a contract | `seller/cre/` |
| a chain-shaped client the buyer signs with | `buyer/watchdog/` |
| an interface plus an injected implementation | `seller/service/` |

`AnalystPort` and `AttestationPort` are both that last pattern, and both exist
because of this test.

The exemption list is short, by name, and each entry has a written reason —
`discovery.ts` is on it because it reads a multi-chain agent registry, so chain
identifiers are its subject matter rather than a leak. If you genuinely need an
exemption, get it agreed rather than adding yourself: the list is the audit trail
for the rule.

The matcher is self-tested, which is how it was found to miss
`payload.hederaTransaction` under a naive `\bhedera\b` — the realistic leak is a
camelCase prefix with no word boundary after it.

---

## Prices

| | | Source |
|---|---|---|
| standard | $0.07 | the `turnstile:price` record on `liquidity.turnstile.eth`, read live off Sepolia 2026-09-07 |
| premium | $0.35 | under the `turnstile:price-ceiling` of `0.50` on the same name |

`assertWithinCeiling()` runs when the app is constructed, so a seller that would
charge above its own published maximum refuses to start. Raising the ceiling is a
cold-key operation; see `docs/ens-offer-records.md`.

---

## Interoperability

`seller/service/x402-interop.test.ts` checks two things that a hand-rolled
middleware has to earn:

1. the 402 body passes `validatePaymentRequired()` — `@x402/core`'s own zod
   schema, which throws on anything the specification does not allow;
2. an **unmodified `@x402/fetch` client** completes the whole flow against this
   server and returns 200 with a decodable `PAYMENT-RESPONSE`.

If the SDK moves, those go red — which is the intended outcome, rather than a
service that has quietly stopped speaking x402 to anyone but itself.
