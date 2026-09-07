# The x402 service, as it actually answers

MOV-219, captured 2026-09-07 from a real run of `seller/service/` against the two
placeholder rails. Reproduce with `npm run serve` and `curl`, or read
`seller/service/x402.test.ts`, which asserts everything below.

**Both rails are placeholders and settle nothing.** The 402 flow, the header
encoding and the receipts are real; no value moves. That is stated on the wire
(`extra.turnstileSettlement: "stub"`) and at `/health`
(`settlementLive: false`) rather than left for someone to discover. MOV-220
brings Hedera/Blocky402, MOV-225 brings Arc.

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
placeholder.

**The premium body carries `analystInput`.** `scoring.ts` is a pure function of
it, so the buyer can re-derive the verdict and get the same bytes. On a real pool
it is about 9.2KB (measured on USDC/WETH 0.05%, 2026-09-07 — see
`seller/analyst/README.md`); the 712 bytes above is the test fixture, which has
no hourly snapshots and no depth ladder. MOV-227 runs `assess()` over exactly
this object inside a Chainlink TEE and fills in `attestation`.

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
