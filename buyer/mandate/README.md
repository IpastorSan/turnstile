# buyer/mandate

The mandate: what the buyer organization has authorized its agent to do. One
object, five fields, and every one of them is a refusal the agent will hit rather
than a preference it may weigh.

Full writeup: `docs/privy-mandate.md`.

```ts
import { demoMandate, paidFetchForMandate, MandateLedger } from './index.ts';

const mandate = demoMandate();          // $0.25 cap, $0.10 per query, two rails
const ledger = new MandateLedger(mandate);
const pay = paidFetchForMandate(mandate, [arcSigner, hederaSigner], { ledger });

const res = await pay('https://seller.example/analyze/0x88e6…');
```

## The five fields

| Field | What it refuses |
|---|---|
| `spendCapUsd` | cumulative overspend — **and the org's deposit**, at Privy |
| `maxPerQueryUsd` | one answer costing too much |
| `railPreference` | an offer on a rail this org does not pay on |
| `sellerAllowlist` | a payee the org did not name |
| `verifiedOperatorOnly` | MOV-223's seam — see below |

`sellerAllowlist: []` allows **nobody**. A mandate that widens when a field is
left blank is a mandate that widens by accident.

## Enforced in two places, and only one of them is ours

| File | Stops | Enforced by |
|---|---|---|
| `enforce.ts` | the agent overspending | our code, before a signature exists |
| `policy.ts` | anyone over-*funding* the agent | Privy's enclave |

That is not duplication. `enforce.ts` is code we could delete; the Privy policy
is not. A server holding our app secret still cannot deposit a dollar more than
the mandate says, and still cannot raise the mandate without two operators'
authorization keys the server never held.

## `verified_operator_only` refuses while it is wired to nothing

MOV-223 binds this to World proof-of-personhood and is blocked on World Sandbox
approval. Until it can check something, an enabled flag **refuses**: a gate wired
to nothing that returns "allowed" reads as a control in the demo and is not one.

## The decision that shapes this directory

MOV-225 verified against live Circle Gateway that **no rail can settle below the
authorized amount** — an EIP-3009 authorization signs `value` into the EIP-712
digest, so `35000` against a `70000` authorization returns `amount_mismatch`.
Hedera is the same, because Blocky402 co-signs a frozen transaction.

So a mandate has to decide **before** a signature exists. Everything here is a
pre-signature check on the 402 challenge, and there is deliberately no
partial-settlement or refund seam. The agent refuses and stops; it never silently
downgrades to a cheaper tier.

## Two things Privy's policy engine does that its docs do not say

Both verified live 2026-09-07, both cost real time — see `policy.ts`'s header and
the rough-edges section of `docs/privy-mandate.md`.

1. A catch-all `{ method: '*', action: 'DENY' }` rule **denies everything**,
   including requests an earlier `ALLOW` matched. Privy is deny-by-default
   already, so there is none in our policy.
2. Address comparisons are **case-sensitive**, and the API stores your rule's
   address checksummed. Everything here goes through viem's `getAddress()`.
