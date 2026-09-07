# scripts

Repo tooling. `wt.sh` is the worktree helper the whole git workflow runs on.

| | |
|---|---|
| `wt.sh` | worktree + branch off `dev`, then push and `--no-ff` merge back. See `CLAUDE.md` |
| `register-turnstile-eth.sh` | one-time ENS registration (MOV-217) |
| `hedera-setup.ts` | **one-time.** Creates the buyer agent's Hedera account and the HCS receipt topic, then prints the `.env` lines. Does not edit `.env` |
| `hedera-paid-request.ts` | the end-to-end paid request: real service, real `@x402/fetch`, real Blocky402, real network. This is the demo take |

```bash
npm run hedera:setup    # once
npm run hedera:pay      # the paid request
npm run hedera:pay -- --fixture   # same payment, fixture analyst instead of the subgraph
```

Both Hedera scripts need `.env` sourced (`set -a; . ./.env; set +a`). See
`docs/payment-flow.md`.
