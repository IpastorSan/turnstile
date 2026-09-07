# Accounts and keys

Every credential the build depends on, what it unlocks, and where it came from.
Values live in `.env` (gitignored). `.env.example` carries the names only.

| Variable | Service | Unlocks | Notes |
|---|---|---|---|
| `GRAPH_DEPLOY_KEY` | Subgraph Studio | MOV-215 | Deploy key, distinct from the gateway key |
| `GRAPH_GATEWAY_API_KEY` | Subgraph Studio | MOV-215, MOV-216 | Sent as `Authorization: Bearer` to Subgraph MCP |
| `SUBSTREAMS_API_TOKEN` | The Graph Market | MOV-221 | JWT, from Dashboard → Create New Key |
| `CRE_API_KEY` | Chainlink CRE | MOV-227 | The CLI also authenticates by login |
| `HEDERA_OPERATOR_ID` | Hedera portal | MOV-220 | `0.0.10403961` |
| `HEDERA_OPERATOR_KEY` | Hedera portal | MOV-220 | **Raw 64-hex ECDSA**, not the DER form the portal also shows |
| `HEDERA_PAYOUT_ACCOUNT` | — | MOV-220 | `0.0.10403961` — the operator. Confirmed 2026-09-07: it received a real payment |
| `HEDERA_BUYER_ID` | `scripts/hedera-setup.ts` | MOV-220 | `0.0.10408012`, the buyer agent's hot wallet, funded 50 HBAR |
| `HEDERA_BUYER_KEY` | `scripts/hedera-setup.ts` | MOV-220 | Raw 64-hex ECDSA. Hot tier — it may spend within a mandate and authorize nothing else |
| `HEDERA_RECEIPT_TOPIC_ID` | `scripts/hedera-setup.ts` | MOV-220 | `0.0.10408013`, HCS settlement receipts. No submit key, so anyone can read it |
| `BLOCKY402_URL` | — | MOV-220 | `https://api.testnet.blocky402.com`. Not a credential; a default |
| `HEDERA_HBAR_USD` | — | MOV-220 | Optional. Pins the HBAR/USD rate instead of reading the network exchange rate |
| `CIRCLE_API_KEY` | Circle console | MOV-225 | Testnet |
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET` | Privy dashboard | MOV-228 | |
| `WORLD_APP_ID` | World Developer Portal | MOV-223 | `app_8094ddfd…` |
| `WORLD_SANDBOX_KEY` | World Sandbox | MOV-223 | **Pending human approval** — the only queue-gated credential |
| `SEPOLIA_RPC_URL` | Alchemy | MOV-217, MOV-218 | |
| `DEPLOYER_PRIVATE_KEY` | — | MOV-217, MOV-218 | `0x0Adca6e1…4bf5F2`, ~0.19 Sepolia ETH |
| `ETHERSCAN_API_KEY` | Etherscan | `forge --verify` | |
| `CARGO_TARGET_DIR` | — | MOV-221 | Shared cache; parallel worktrees otherwise rebuild from scratch |

## Gotchas that already cost time

- **`DEPLOYER_PRIVATE_KEY` must carry the `0x` prefix.** `cast` accepts it without; `vm.envUint` fails with "missing hex prefix" and the whole deploy reverts before broadcasting.
- **Hedera's portal shows two private keys.** Take the raw 64-hex one, not the longer DER-encoded one. Verify with `cast wallet address --private-key` — the derived EVM address must match the mirror node's `evm_address` for the account.
- **An unbalanced quote anywhere breaks the entire file**, and bash reports the error at the *last* line rather than the offending one, because the parser only gives up at EOF. To find the real culprit:
  `awk '{n=gsub(/"/,"\""); if (n%2==1) print NR": "$0}' .env`
- **No credential is needed for Blocky402 on testnet** — it is an open facilitator. **Confirmed 2026-09-07 (MOV-220):** this line previously said "confirm before depending on it". It is now confirmed. An unauthenticated `GET https://api.testnet.blocky402.com/supported` answers, and a real payment settled through `/verify` and `/settle` with no key and no `Authorization` header. `BLOCKY402_URL` is a default, not a secret.
- **The buyer needs its own Hedera account (MOV-220).** The seller's payout is the operator, and a transfer from that account to itself nets to zero, which Blocky402 rejects — `payTo` must receive a positive net transfer. `scripts/hedera-setup.ts` creates one. It also matches the tier model: the hot wallet holds a small balance and nothing else.
- **A Hedera transaction id is written two ways and they are not interchangeable (MOV-220).** The SDK and HashScan use `0.0.7162784@1788791855.758948636`; the mirror node REST API wants `0.0.7162784-1788791855-758948636` in a path segment. The wrong one gives a 404 that is indistinguishable from "no such transaction". `toMirrorNodeTransactionId()` converts.

## Not credentials, but required

- `turnstile.eth` on Sepolia — owned by the deployer, expiry 2027-09. See `scripts/register-turnstile-eth.sh`.
- Free-mint MockUSDC `0xd3322b29a7bdee707d1684676f149bf41aa3422f` pays ENS registration; `mint()` is permissionless.
