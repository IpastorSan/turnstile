# rails/arc-usdc

Arc testnet — USDC, gasless, batched. Settled through **Circle Gateway
Nanopayments** (`@circle-fin/x402-batching`).

**Correction (2026-09-07, MOV-225):** this file previously said *"Placeholder as
of MOV-219 — it settles nothing"*, gave the network as `eip155:0-PLACEHOLDER-arc`,
and described the buyer's wallet as holding *"zero native token, gas sponsored by
a Paymaster"*. The first two were honest placeholders and are now resolved. The
third was **wrong**, not merely unverified, and is corrected below and in
`CLAUDE.md`, `README.md` and `docs/architecture.md`.

The rail is **live**: `info.live` is `true` and every challenge carries
`extra.turnstileSettlement: 'live'`. Real USDC moved on 2026-09-07 —
`docs/arc-nanopayments.md` has the transcript, the verified/not-verified table
and the reproduction commands.

Read `rails/README.md` first.

---

## The shape of a payment here

| | |
|---|---|
| Network (x402 wire) | `eip155:5042002` |
| Network (Circle SDK) | `arcTestnet` — **not interchangeable**, see `config.ts` |
| Asset | `0x3600000000000000000000000000000000000000`, 6 decimals |
| Facilitator | `https://gateway-api-testnet.circle.com`, no API key |
| Payer signs | EIP-3009 `TransferWithAuthorization`, **verifying contract = the GatewayWallet, not USDC** |
| `settle()` returns | an **authorization id** (a UUID), not a transaction hash |
| The hash | arrives minutes later, shared with every other payment in the batch |

That last pair is the whole rail. Gateway credits the seller immediately and
Circle's batcher mines many authorizations together afterwards, which is what
makes a $0.0005 payment possible at all. `PaymentRail.receipt` returns
`Receipt | null` for exactly this: between `settle()` and the batch there is a
real, correct state — paid, credited, no transaction yet.

## Zero gas, stated so it can be falsified

**USDC is Arc's native gas token.** `eth_getBalance(a)` and `USDC.balanceOf(a)`
are two views of one balance at two precisions (18 dp and 6 dp; the ERC-20 view
truncates). So "holds zero native token" and "holds zero USDC" are the same
sentence, and a wallet in that state can pay nobody. There is no Paymaster here.

What is true:

> The hot wallet signs offchain and **never submits a transaction**, so it pays
> exactly zero gas. Circle's batcher submits.

The proof is `eth_getTransactionCount(agent)` staying **0** across every settled
payment. `wallet.ts` reads it and `scripts/arc-paid-request.ts` prints it before
and after, so the claim is re-checked on every run.

The agent's Gateway balance is funded by the warm tier calling
`depositFor(amount, agent)`: the org pays the gas, the agent gets the balance.
The hot key cannot deposit, withdraw or transfer — each is a transaction and it
has no gas for one. `CLAUDE.md`'s "the key that spends can never raise its own
limit", enforced by the chain rather than by our code.

## Two traps

Both found by asking the live API rather than reading the docs, both verified
2026-09-07.

1. **`/verify` does not check the payer's balance.** An authorization from an
   empty wallet returns `{"isValid":true}` and then fails `/settle` with
   `insufficient_balance`. So `verify()` here never returns `insufficient_funds`,
   and a seller that does the work between verify and settle — as x402 intends —
   can do it for free. Blocky402 catches this at verify; Gateway does not.
2. **`/verify` and `/settle` require `paymentPayload.resource`** or answer a 400.
   Our `PaymentPayload` does not carry one, so the rail synthesizes it. It is
   **not** covered by the payer's signature, so like the Hedera rail's resource
   binding it is advisory rather than a security boundary.

## Can it settle below the authorized amount?

**No**, and not because Gateway chooses not to. EIP-3009 signs a fixed `value`
into the EIP-712 digest; a different amount is a different message the signature
does not cover. Verified: quoting `35000` against an authorization signed for
`70000` returns `amount_mismatch`, and so does quoting `350000`.

The same is true on Hedera for the same reason, so this is not a per-rail branch.
See `docs/arc-nanopayments.md` for what that means for the premium tier.

## Files

`config.ts` verified constants · `gateway.ts` the Gateway client and reason-code
table · `index.ts` the `PaymentRail` · `wallet.ts` nonce/balance reads, not on
the payment path · `testing.ts` captured responses so tests run offline ·
`arc-usdc.test.ts`.

Buyer side: `buyer/watchdog/arc-signer.ts`.
