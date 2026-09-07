# rails

The payment abstraction. **Read this before implementing MOV-220 or MOV-225.**

`PaymentRail.ts` landed in MOV-219 and is the seam two issues build on in
parallel. Everything below is the contract; the file itself is the normative
version and is commented at length.

---

## The one rule

> **The service speaks US dollars and opaque strings. The rail speaks chains.**

`seller/service/` hands a rail a dollar amount and a URL. The rail returns
something the service copies onto the wire without reading. When a payment comes
back, the service routes it to the rail that issued it and hands over the whole
payload untouched.

That is why two settlement models this different fit down one code path:

| | Hedera (MOV-220) | Arc (MOV-225) |
|---|---|---|
| Settles via | Blocky402, co-signing a partially-signed transaction | Circle / Arc Agent Stack facilitator |
| Payer authorization | a transaction the payer part-signs | an authorization object |
| Payout account format | `0.0.10403961` | `0x0Adc…5F2` |

Neither shape appears in `seller/service/`. Both live inside two `Record<string,
unknown>` bags:

- **`PaymentRequirement.extra`** — written by the rail in `challenge()`, copied
  onto the wire, handed back to the rail. Put the transaction body to co-sign
  here, the facilitator URL, the token decimals, an EIP-712 domain.
- **`PaymentPayload.payload`** — the payer's signature, authorization or
  part-signed transaction. The service never opens it.

**If you want to add a field to `PaymentRequirement` so the service can branch on
it, the abstraction is failing.** Put it in `extra` and give the rail a method.

`seller/service/no-chain-code.test.ts` enforces this mechanically: no file on the
payment path may name a chain, vendor, asset or signature format, and exactly one
file — `server.ts`, the composition root — may import a concrete rail. It will
fail your branch rather than let the rule erode quietly.

---

## The interface

```ts
interface PaymentRail {
  readonly id: string;          // 'hedera-x402' — matches the directory
  readonly info: RailInfo;      // scheme, network, asset, ensRailToken, live

  challenge(req: ChallengeRequest): Promise<PaymentRequirement>;
  verify(payload: PaymentPayload, context?: VerifyContext): Promise<VerifyResult>;
  settle(payload: PaymentPayload): Promise<Receipt>;
  receipt(id: string): Promise<Receipt | null>;
}
```

### `challenge(req)`

`req` is `{ resource, description, priceUsd, maxTimeoutSeconds? }`. `priceUsd` is
decimal dollars — `0.07`, not `"70000"`. Converting to your asset's smallest unit
is your job; `usdToAtomic(priceUsd, decimals, usdPerUnit)` does it through an
integer, because `0.07 * 1e6` in IEEE 754 is `69999.99999999999` and a payment
one unit light is rejected by a facilitator, on a rail nobody is watching, during
a demo.

Async on purpose: an HBAR-denominated rail needs an FX rate, and an Arc rail may
want to probe its facilitator's `/supported`.

### `verify(payload, context?)`

Returns `{ valid, reason, payer, detail? }`, **not a boolean**. The reason is not
decoration: the buyer's next move differs between `insufficient_funds` (give up)
and `unsupported_rail` (retry the other entry in `accepts[]`), and collapsing
both to `false` destroys that at the one boundary where it cannot be recovered.
`VerifyFailureReason` lists the codes the buyer helper understands.

Must not move value, and must be safe to call twice.

`context` carries `{ resource, offered }` — the URL being bought right now and
every requirement currently on offer for it. It is optional and a rail that
ignores it still works, but it is how you bind a challenge to its resource. The
service cannot do that for you: the binding lives in your `extra`, which the
service must not read.

`rails/stub-rail.ts` shows the shape, with a warning worth repeating here: the
requirement it compares is the *payer's* copy, so a payer can delete
`extra.resource` and skip the check. A stub signs nothing and has no honest way
to detect that. **On a real rail the requirement must be covered by the payer's
signature**, which is what makes the comparison load-bearing rather than
advisory. The tier-downgrade attack is blocked either way by the amount check in
`seller/service/x402.ts` — which is why that check lives in the service and is
not delegated to rails.

### `settle(payload)`

Called only after `verify` succeeded **and** the work succeeded. Return
`{ success: false, error }` rather than throwing when settlement fails — the
service has an answer in hand at that point, and a settlement failure is an
accounting problem rather than a crash.

### `receipt(id)`

Looks up by `Receipt.transaction`. `null` when this rail has never settled that
id — a buyer polling for a receipt that has not landed yet is not an error.

This is also what unblocks discovery's ranking. `seller/service/discovery.ts`
currently reports `ranking.basis: 'registration_recency'` with
`placeholder: true`, because settled volume is the one number an agent cannot
fake and there are no receipts yet. It switches itself over the moment
`settlement_receipt` has rows.

---

## What MOV-219 shipped, and what it did not

Two **placeholder** rails, `hedera-x402/` and `arc-usdc/`, both built on
`stub-rail.ts`. They speak the whole interface and settle nothing.

They exist because the 402 has to advertise more than one way to pay from day
one — the buyer's mandate choosing *between* rails is the interesting behaviour,
and a single-entry `accepts[]` never exercises it. The service is written against
a list of rails, not against Hedera with an Arc branch bolted on later.

**They never claim to be live.** `info.live` is `false`, every challenge carries
`extra.turnstileSettlement: 'stub'`, and `/health` reports
`settlementLive: false`. A service that advertises a rail and settles nothing,
without saying so, looks identical from the outside to one that works — which is
precisely the failure a demo must not walk into.

### Values MOV-220 and MOV-225 must verify

Written as obvious placeholders rather than plausible-looking real values, on
purpose. A wrong-but-believable asset address is far more expensive to discover
than an obviously fake one.

| | Value as shipped | Status |
|---|---|---|
| `hedera-x402` network | `eip155:296` | **UNVERIFIED** (2026-09-07). Hedera testnet's EVM chain id. Hedera also has its own CAIP-2 namespace (`hedera:testnet`); which one Blocky402 expects is unknown. Read its `/supported`. |
| `hedera-x402` asset | `PLACEHOLDER-hedera-testnet-usdc` | **PLACEHOLDER**, deliberately not an address |
| `arc-usdc` network | `eip155:0-PLACEHOLDER-arc` | **PLACEHOLDER**. Arc's CAIP-2 identifier is unknown to us as of 2026-09-07 |
| `arc-usdc` asset | `PLACEHOLDER-arc-usdc` | **PLACEHOLDER**, deliberately not an address |
| `hedera-x402` payout | `0.0.10403961` (`HEDERA_PAYOUT_ACCOUNT`) | From `docs/accounts.md`. Confirm it is the account you want paid |
| `arc-usdc` payout | `0x0Adca6e14bA956201D221feC767e4f24194bf5F2` (`ARC_PAYOUT_ADDRESS`) | The `addr(60)` record on `liquidity.turnstile.eth`, read live off Sepolia 2026-09-07 |

`docs/accounts.md` also records that Blocky402 needs no credential on testnet,
itself marked "confirm before depending on it".

---

## `ensRailToken` — why a rail has two names

The on-chain `turnstile:rails` text record on `liquidity.turnstile.eth` reads:

```
x402,usdc-arc          # verified live on Sepolia, 2026-09-07
```

Those tokens are **not** the rail ids. The mapping is:

| ENS token | Rail id | Directory |
|---|---|---|
| `x402` | `hedera-x402` | `rails/hedera-x402/` |
| `usdc-arc` | `arc-usdc` | `rails/arc-usdc/` |

A buyer that discovered us through ENS filters on the token; one that read a live
402 matches on the rail. `RailInfo.ensRailToken` carries the first,
`PaymentRail.id` the second, and `registry.test.ts` asserts the two sets
reconcile — so the record and the wire cannot drift apart unnoticed.

The record is **cold-key-written**, so it cannot be corrected from a hot key.
Changing `x402` to something that names a chain would need a Ledger session; that
is a judgement call for MOV-220, not something to do in passing. See
`docs/ens-offer-records.md`.

---

## Adding a rail

1. Implement `PaymentRail` in `rails/<id>/index.ts`.
2. Give it a `(scheme, network)` pair no other rail claims — `RailRegistry`
   throws at construction otherwise, because x402 carries nothing else back from
   the payer and two rails sharing that pair could not be told apart at
   settlement.
3. Add it to the list in `seller/service/server.ts`. That is the only line in
   `seller/service/` that should change.
4. Add a `RailSigner` next to it for the buyer side (`buyer/watchdog/pay.ts`).

If step 3 needs more than a list entry, say so loudly — that means the seam is
wrong, not that your rail is unusual.

## Test

```bash
npm test           # includes rails/registry.test.ts and seller/service/x402*.test.ts
npx tsc --noEmit
```
