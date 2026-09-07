# scripts

Repo tooling. `wt.sh` is the worktree helper the whole git workflow runs on.

| | |
|---|---|
| `wt.sh` | worktree + branch off `dev`, then push and `--no-ff` merge back. See `CLAUDE.md` |
| `register-turnstile-eth.sh` | one-time ENS registration (MOV-217) |
| `hedera-setup.ts` | **one-time.** Creates the buyer agent's Hedera account and the HCS receipt topic, then prints the `.env` lines. Does not edit `.env` |
| `hedera-paid-request.ts` | the end-to-end paid request: real service, real `@x402/fetch`, real Blocky402, real network. This is the demo take |
| `privy-org-setup.ts` | **one-time.** Onboards the human operators as Privy users with embedded wallets, creates the two key quorums, the mandate policy and the org wallet, then prints the `.env` lines. Does not edit `.env`. Refuses to run twice |
| `privy-mandate.ts` | the warm-tier demo take: the agent refused over its ceiling, the org wallet refused over its cap by **Privy**, and one operator unable to raise the cap until a second approves |
| `arc-setup.ts` | **one-time per mandate.** `depositFor()`s the allowance from the warm tier into the agent's Gateway balance, signed by the Privy org wallet under the mandate policy. The agent cannot fund itself — a deposit is a transaction and it has no gas — and that is the design, not a limitation. `--seed <usdc>` is the one-time migration off the legacy key |
| `arc-paid-request.ts` | the Arc demo take: one 402 advertising both rails, the same query paid on **both**, the agent's nonce staying 0, and N sub-cent queries |
| `arc-receipts.ts` | resolves Gateway authorization ids into the batch transaction that settled them. Separate because settlement is asynchronous — the hash arrives minutes after the payment |

```bash
npm run hedera:setup    # once
npm run hedera:pay      # the paid request
npm run hedera:pay -- --fixture   # same payment, fixture analyst instead of the subgraph

npm run privy:setup               # once: the buyer organization
npm run privy:setup -- --status   # read it back
npm run privy:mandate             # the refusal, and the quorum that answers it

npm run arc:setup                 # once per mandate: fund the agent's Gateway balance
npm run arc:pay                   # both rails, zero gas, nanopayments
npm run arc:receipts -- --ours    # later: which transaction settled them
```

All of these need `.env` sourced (`set -a; . ./.env; set +a`). See
`docs/payment-flow.md` for the Hedera rail and `docs/arc-nanopayments.md` for Arc.

The Arc scripts also need testnet USDC in the **org** wallet, from
<https://faucet.circle.com> (chain: Arc Testnet). That step is reCAPTCHA-gated
and needs a human — `CIRCLE_API_KEY` does not carry the faucet scope.

**Correction (2026-09-07, MOV-228):** the "org wallet" above is now the Privy
server wallet at `PRIVY_ORG_WALLET_ADDRESS`, not `ARC_ORG_ADDRESS`. If you
already have USDC on the legacy key, `node scripts/arc-setup.ts --seed 2` moves
it over and skips the faucet entirely. Everything else on this page is unchanged.
See `docs/privy-mandate.md`.
