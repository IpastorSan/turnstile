# rails/hedera-x402

Hedera testnet, settled through the **Blocky402** facilitator. **Live — this rail
moves real value.**

**Correction (2026-09-07, MOV-220):** this file previously said the rail was a
placeholder that settled nothing, and listed `eip155:296` and a USDC asset id as
values to confirm. All of that is superseded. The network value in particular was
**wrong**, not merely unverified.

A real paid request settled on 2026-09-07:
`0.0.7162784@1788791855.758948636` — 0.84367844 HBAR ($0.07) from `0.0.10408012`
to `0.0.10403961`, buyer gas zero. **Read `docs/payment-flow.md`**; it is the
setup guide, the architecture, the transcript and the verification commands.

```bash
node scripts/hedera-setup.ts          # once: buyer account + HCS receipt topic
node scripts/hedera-paid-request.ts   # the end-to-end run
```

---

## What this rail is

| | |
|---|---|
| Network | `hedera:testnet` (CAIP-2 — **not** `eip155:296`) |
| Asset | `0.0.0`, native HBAR, 8 decimals |
| Facilitator | `https://api.testnet.blocky402.com` — MIT, open source, no API key on testnet |
| Fee payer | `0.0.7162784`, Blocky402's, read off `/supported` |
| Receipts | one HCS message per payment, topic `0.0.10408013` |
| ENS token | `x402` in `turnstile:rails` — see `RailInfo.ensRailToken` |

## The one thing that is not like EVM

x402's `exact` scheme on an EVM chain is an EIP-3009 authorization. Hedera has no
EIP-3009, so the payer signs a **`TransferTransaction` naming the facilitator as
its fee payer** and hands over the frozen bytes. The transaction is valid in
shape and unsubmittable until Blocky402 adds the second signature — so the payer
spends no gas, cannot broadcast it themselves, and we cannot alter it.

That needs no new interface method. The transaction the payer must build is
described by `challenge()`'s `extra`, and the signed bytes come back in
`PaymentPayload.payload`. The service copies both without reading either, and
**landing this rail changed no file under `seller/service/`.**

## Files

| | |
|---|---|
| `index.ts` | the four `PaymentRail` methods |
| `config.ts` | verified constants, and why HBAR rather than USDC |
| `facilitator.ts` | the Blocky402 client and the reason-code table |
| `rate.ts` | HBAR/USD from Hedera's own network exchange rate |
| `hcs.ts` | the receipt topic — writes with a key, reads without one |
| `testing.ts` | fixtures copied from real responses, so tests run offline |

## Two things to know before changing it

**The binding in `extra.resource` is advisory here, not load-bearing.** A Hedera
transaction commits to `payTo`, `amount`, `asset` and the fee payer — not to a
URL — so a payer can edit their copy. `rails/README.md` used to state the
opposite as a general rule and is corrected. What actually stops a payment buying
the wrong resource is the service's amount check and the **replay guard** in
`verify()`.

**`@x402/hedera` pins `@hiero-ledger/sdk` at 2.85.0 exactly.** Install a newer one
at the top level and npm nests a second copy, which is how `instanceof` checks
start failing in ways that read as protocol errors. `package.json` pins it with
`--save-exact`. See the dependency note in `docs/payment-flow.md`.
