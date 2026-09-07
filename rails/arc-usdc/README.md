# rails/arc-usdc

Circle / Arc Agent Stack — USDC, Paymaster, nanopayments.

**Placeholder as of MOV-219 — it settles nothing.** `info.live` is `false` and
every challenge carries `extra.turnstileSettlement: 'stub'`. MOV-225 replaces the
body and keeps the shape.

Read `rails/README.md` first. Both the network (`eip155:0-PLACEHOLDER-arc`) and
the asset here are deliberate placeholders: Arc's CAIP-2 identifier is
**unverified as of 2026-09-07**, and `CHECKLIST.md` item 10 records that we are
still waiting on Circle to confirm whether the Launch track accepts a testnet
plus mainnet config at all.

The buyer's wallet on this rail is the **hot tier** from `CLAUDE.md` — the Arc
Agent Stack wallet that spends within a mandate and holds zero native token, gas
sponsored by a Paymaster. None of that is visible to the seller: the Paymaster
arrangement is between the buyer and Circle and appears nowhere in the challenge.
The seller side sees a facilitator URL in `extra` and an authorization in
`payload`, exactly as it does for Hedera.

Payout defaults to `ARC_PAYOUT_ADDRESS`, then to the `addr(60)` record on
`liquidity.turnstile.eth` (`0x0Adca6e14bA956201D221feC767e4f24194bf5F2`, read live
off Sepolia 2026-09-07). That address is the cold tier's to change; a hot key
trying to move it reverts on-chain — see `docs/ens-offer-records.md`.
