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

// or, from a real mandate issued by the warm tier (MOV-228):
const pay = paidFetchForMandate(mandate, [hederaSigner, arcSigner], { ledger });

const res = await pay('https://seller.example/analyze/0x88e6...');
const { verdict } = await res.json();
```

**Correction (2026-09-07, MOV-228):** the `Mandate` type this file used to
describe is now called `SpendingLimits`, and the real mandate — spend cap,
per-query ceiling, rail preference, seller allowlist, `verified_operator_only` —
lives in `buyer/mandate/mandate.ts`. `SpendingLimits` is that object's projection
onto one 402 challenge, built by `mandateSpendingLimits()`. Nothing about the
enforcement changed; the example above still works, and two new optional fields
(a seller allowlist and a remaining-spend check) were added.

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

`hedera-signer.ts` is the first real one (MOV-220). Two things in it are worth
copying rather than reinventing:

- it builds the payment with **`@x402/hedera`'s own client signer**, not with our
  reading of the spec — the facilitator validates transaction shape strictly, and
  the reference implementation is the cheaper way to match it;
- it computes `usdPerUnit` from a rate the **buyer** reads, not from the seller's
  `extra.usdPerUnit`. A seller quoting 12 HBAR for "seven cents" alongside a rate
  that makes 12 HBAR look like seven cents would otherwise pass a cap computed
  from its own arithmetic. A cap the counterparty can move is not a cap.

`arc-signer.ts` is the second (MOV-225), and it is smaller because the rail is
simpler in the two places that matter: USDC is a dollar, so there is no rate to
read; and signing is a local EIP-712 operation that opens no connection and sends
no transaction. The one thing worth copying from it is what it does **not** do —
it never constructs a wallet client for the agent key, because the agent's whole
value as evidence is that its nonce is 0, and a wallet client in scope is how a
later edit spends that.

It keeps the `usdPerUnit` discipline anyway: the `1` is a constant this repo owns
and the seller's `extra.usdPerUnit` is ignored, because a seller quoting
`usdPerUnit: 0.01` on a USDC rail is the same trick with different numbers.

## Still to come

- The watchdog loop itself — poll pools, decide when a verdict is worth buying.
- ~~Real signers, with MOV-220~~ — done, `hedera-signer.ts`.
  ~~Still to come with MOV-225 (Arc)~~ — done, `arc-signer.ts`.
- ~~Mandate issuance and the Privy warm tier.~~ **Done (2026-09-07, MOV-228)** —
  `buyer/org/` and `buyer/mandate/`. `scripts/arc-setup.ts` now calls
  `depositFor()` from a Privy server wallet owned by a key quorum and capped by a
  Privy policy; MOV-225's note here predicted MOV-228 would replace the key and
  not the mechanism, and that is what happened. See `docs/privy-mandate.md`.
