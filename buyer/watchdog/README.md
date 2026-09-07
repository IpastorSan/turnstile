# buyer/watchdog

The buyer agent.

`pay.ts` (MOV-219) is the client half of x402: a `fetch` that answers a 402 by
paying it, instead of failing on it.

```ts
import { createPaidFetch } from './pay.ts';

const pay = createPaidFetch({
  mandate: { preferredRails: ['hedera-x402', 'arc-usdc'], maxPerPaymentUsd: 0.10 },
  signers: [hederaSigner, arcSigner],
});

const res = await pay('https://seller.example/analyze/0x88e6...');
const { verdict } = await res.json();
```

It is `@x402/fetch`'s wrapper with the two decisions that are ours rather than
the SDK's wired in:

1. **Which rail to pay on.** The seller advertises several; the mandate picks
   one. That choice is the entire reason a 402 carries more than one `accepts[]`
   entry.
2. **Whether to pay at all.** The mandate's per-payment cap is enforced before a
   signature exists. Over-cap raises `MandateViolation` — the agent stops rather
   than improvising, and never silently downgrades to a cheaper tier.

## The invariant this defends

From `CLAUDE.md`: **the key that spends can never raise its own limit.** The
mandate is issued by the warm tier (the organization's Privy wallet); this agent
is the hot tier and only spends inside it. So `Mandate` is an argument, never
built from the agent's own state, and `enforceMandate` is a pure function of
`(accepts, mandate, signers)` — it is the piece a reviewer has to be able to read
in one sitting and be sure of.

The SDK's own `spendControls` are switched **off** rather than configured. They
are denominated through a default-asset table that only recognises mainstream
stablecoins on mainstream chains, so a rail whose asset it does not know would be
silently uncapped. Capping it ourselves means an unrecognised asset is *rejected*
instead, which is the right direction to fail in.

## `RailSigner`

The buyer-side mirror of `PaymentRail`, and deliberately as small: `railId`,
`scheme`, `network`, `decimals`, and `sign(requirement)` returning the
rail-private authorization. MOV-220 and MOV-225 each add one next to their seller
rail without touching `pay.ts`.

`stub-signer.ts` is the placeholder that pairs with `rails/stub-rail.ts`. It
signs nothing, and its name says so.

## Still to come

- The watchdog loop itself — poll pools, decide when a verdict is worth buying.
- Real signers, with MOV-220 and MOV-225.
- Mandate issuance and the Privy warm tier.
