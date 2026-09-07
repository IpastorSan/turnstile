# rails/hedera-x402

Hedera testnet x402, settled through the Blocky402 facilitator.

**Placeholder as of MOV-219 — it settles nothing.** `info.live` is `false` and
every challenge it issues carries `extra.turnstileSettlement: 'stub'`. MOV-220
replaces the body and keeps the shape.

Read `rails/README.md` first: the interface, the one rule, and the table of
values here that are **UNVERIFIED** and must be confirmed before this rail can
settle (`eip155:296` vs a `hedera:*` CAIP-2 namespace, and the testnet USDC
asset id — both are written as obvious placeholders on purpose).

The one genuinely non-standard thing about this rail is that Hedera settles
through a **partially-signed transaction co-signed by the facilitator**, not a
bare authorization. That needs no new interface method: the transaction body for
the payer to sign goes in `challenge()`'s `extra`, and the payer's part-signed
transaction comes back in `PaymentPayload.payload`. The service copies both
without reading either.

`receipt()` is what unblocks discovery's `settledVolume` ranking — see
`seller/service/README.md`.

`docs/accounts.md` records `HEDERA_OPERATOR_ID` / `HEDERA_OPERATOR_KEY` and notes
that Blocky402 needs no credential on testnet, itself marked "confirm before
depending on it".
