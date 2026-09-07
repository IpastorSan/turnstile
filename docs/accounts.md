# Accounts and keys

Every credential the build depends on, what it unlocks, and where it came from.
Values live in `.env` (gitignored). `.env.example` carries the names only.

| Variable | Service | Unlocks | Notes |
|---|---|---|---|
| `GRAPH_DEPLOY_KEY` | Subgraph Studio | MOV-215 | Deploy key, distinct from the gateway key |
| `GRAPH_GATEWAY_API_KEY` | Subgraph Studio | MOV-215, MOV-216 | Sent as `Authorization: Bearer` to Subgraph MCP |
| `SUBSTREAMS_API_TOKEN` | The Graph Market | MOV-221 | JWT, from Dashboard → Create New Key |
| ~~`CRE_API_KEY`~~ | Chainlink CRE | MOV-227 | **Wrong key — see the correction below.** Use `cre login`. |
| `HEDERA_OPERATOR_ID` | Hedera portal | MOV-220 | `0.0.10403961` |
| `HEDERA_OPERATOR_KEY` | Hedera portal | MOV-220 | **Raw 64-hex ECDSA**, not the DER form the portal also shows |
| `CIRCLE_API_KEY` | Circle console | MOV-225 | Testnet |
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET` | Privy dashboard | MOV-228 | |
| `WORLD_APP_ID` | World Developer Portal | MOV-223 | `app_8094ddfd…` |
| `WORLD_SANDBOX_KEY` | World Sandbox | MOV-223 | **Pending human approval** — the only queue-gated credential |
| `SEPOLIA_RPC_URL` | Alchemy | MOV-217, MOV-218 | |
| `DEPLOYER_PRIVATE_KEY` | — | MOV-217, MOV-218 | `0x0Adca6e1…4bf5F2`, ~0.19 Sepolia ETH |
| `ETHERSCAN_API_KEY` | Etherscan | `forge --verify` | |
| `CARGO_TARGET_DIR` | — | MOV-221 | Shared cache; parallel worktrees otherwise rebuild from scratch |

**Correction (2026-09-07, MOV-227):** this table previously listed `CRE_API_KEY`
as the Chainlink CRE credential, with the note "the CLI also authenticates by
login". That is wrong in a way that costs an hour. The value in `.env` is a
**Data Streams** key, and the `cre` CLI rejects it: every command with it set
fails `unauthorized: invalid token`, including `cre workflow simulate`, which
needs no deployment access at all. Worse, the CLI *prefers* `CRE_API_KEY` over a
saved browser login, so exporting it silently breaks a setup that was working.
It is commented out in `.env` now, with the same note.

What is still true: the CLI does authenticate by login, and that is now the only
path. `cre login` writes `~/.cre/cre.yaml`; verified against `cre whoami` on
2026-09-07 (`ignacio@moveseventyeight.com`, org `org_Js0Ll47RXcQ17Uk6`, **Deploy
Access: Not enabled**). Issue a real CRE key at app.chain.link if the
non-interactive path is wanted back.

Two variables were added for MOV-227, both consumed only by the enclave:

| Variable | Service | Unlocks | Notes |
|---|---|---|---|
| `TURNSTILE_EVIDENCE_TOKEN` | — | MOV-227 | Bearer token gating `seller/cre/evidence-server.ts`. Mapped to the `EVIDENCE_TOKEN` Vault secret. |
| `TURNSTILE_CALIBRATION` | — | MOV-227 | The seller's tuned thresholds, as JSON. Mapped to `CALIBRATION`. **This is the method** — in production it exists only inside the enclave. |

## Gotchas that already cost time

- **`DEPLOYER_PRIVATE_KEY` must carry the `0x` prefix.** `cast` accepts it without; `vm.envUint` fails with "missing hex prefix" and the whole deploy reverts before broadcasting.
- **Hedera's portal shows two private keys.** Take the raw 64-hex one, not the longer DER-encoded one. Verify with `cast wallet address --private-key` — the derived EVM address must match the mirror node's `evm_address` for the account.
- **An unbalanced quote anywhere breaks the entire file**, and bash reports the error at the *last* line rather than the offending one, because the parser only gives up at EOF. To find the real culprit:
  `awk '{n=gsub(/"/,"\""); if (n%2==1) print NR": "$0}' .env`
- **No credential is needed for Blocky402 on testnet** — it is an open facilitator. Confirm before depending on it (MOV-220).

## Not credentials, but required

- `turnstile.eth` on Sepolia — owned by the deployer, expiry 2027-09. See `scripts/register-turnstile-eth.sh`.
- Free-mint MockUSDC `0xd3322b29a7bdee707d1684676f149bf41aa3422f` pays ENS registration; `mint()` is permissionless.
