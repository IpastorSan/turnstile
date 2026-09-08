# Evidence

One row per claim, one link per row. Everything here is on a public chain or a
public endpoint, and every link was checked on 2026-09-08.

Where something is **not** proven, this page says so in the same table rather
than in a footnote. Two rows do exactly that, and they are the two worth reading
first if you are looking for the seam.

**Verify the whole repo in one command:**

```bash
npm run verify      # 315 node tests + 90 Forge tests, including 13 fork tests against live Sepolia
```

**Run the product end to end in one command:**

```bash
npm run demo        # discover a seller, read its price from Sepolia, pay on both rails, get the answer
```

---

## Settlement: the money actually moves

| Claim | Evidence | Where |
|---|---|---|
| A real paid request settled on Hedera through Blocky402 | `0.0.7162784@1788791855.758948636`, 0.84367844 HBAR ($0.07) from `0.0.10408012` to `0.0.10403961`, buyer gas zero | [HashScan](https://hashscan.io/testnet/transaction/0.0.7162784@1788791855.758948636) |
| The same query settles over the *other* rail | Arc authorization `fa4ca648-863c-4f61-9a1e-2953eb789f7f` and Hedera `0.0.7162784@1788800327.098234984`, same verdict both times, one run, one URL | [HashScan](https://hashscan.io/testnet/transaction/0.0.7162784@1788800327.098234984) |
| Rail-agnosticism is enforced, not asserted | `seller/service/no-chain-code.test.ts` fails the build if any file on the payment path names a chain | [`seller/service/no-chain-code.test.ts`](../seller/service/no-chain-code.test.ts) |
| Sub-cent payments batch into one transaction | Six $0.000500 queries plus one $0.07 query settled together, block 60940635, 0.133111 USDC total across 22 payments including other Gateway users' | [ArcScan](https://testnet.arcscan.app/tx/0xd6e77a59ad4740e5f89c9c601a05e7cf7859c9253fb1b3c31a8eae97e859a0c1) |
| A second batch, so the first was not a fluke | Four more settled, block 60942503. Eleven settled payments across two transactions | [ArcScan](https://testnet.arcscan.app/tx/0xe50b8be63a2fe102c70de3b62a43251fbfcac1d8ca93f9f1760dd3c7a7985c39) |
| The spending agent pays **zero** gas | Agent `0x0633a193…8e2F`, **nonce still 0** after eleven payments. It signs EIP-3009 authorizations offchain and never submits a transaction | [ArcScan](https://testnet.arcscan.app/address/0x0633a193017939Bb1eB242982397224c66948e2F) |
| Receipts are auditable by anyone, with no key | HCS topic `0.0.10408013`, read back through the public mirror node and checked against the ledger | [HashScan](https://hashscan.io/testnet/topic/0.0.10408013) |

## Authority: the key split is enforced by the chain

| Claim | Evidence | Where |
|---|---|---|
| The hot key **cannot** move the payout address | `setAddr` from `0x16244874…6367` reverts with `EACUnauthorizedAccountRoles`, live on Sepolia, with a Forge fork test behind it | [`testFork_hotKeyCannotChangeThePayoutOnChain`](../contracts/test/fork/SepoliaOffer.t.sol) |
| The hot key **can** still do its job | Same key repricing successfully, so the restriction is scoped rather than a dead key | [`testFork_hotKeyCanStillReprice`](../contracts/test/fork/SepoliaOffer.t.sol) |
| Its scope is exactly two records | Roles cover `agent-endpoint[mcp]` and `turnstile:price`, nothing else | [`testFork_hotKeyIsStillScopedToTwoRecords`](../contracts/test/fork/SepoliaOffer.t.sol) |
| The operator key holds the root roles | `0x0Adca6e1…f5F2` on `liquidity.turnstile.eth` | [`addresses.turnstile.sepolia.json`](../contracts/addresses.turnstile.sepolia.json) |
| **Custody is not cold.** Stated here so it is not inferred | That operator key is the same address as the deployer, and its key is `DEPLOYER_PRIVATE_KEY` in `.env`. The *authority* split is real; the custody is not. See [`CORRECTIONS.md`](../CORRECTIONS.md) | this row |

## Discovery: the offer lives in the name

| Claim | Evidence | Where |
|---|---|---|
| The resolver record **is** the offer | `liquidity.turnstile.eth` resolves price, rails and endpoint from Sepolia on every request, no cache, no hard-coded values | [Resolver on Etherscan](https://sepolia.etherscan.io/address/0xb1B4Da2C49814c8CbF975E7a48fbB014EA0b075B) |
| Standard ENSIP keys, not a bespoke schema | `agent-context`, `agent-endpoint[mcp]`, `agent-registration[…]` per ENSIP-25/26 | [`docs/ens-offer-records.md`](./ens-offer-records.md) |
| Our registry and registrar are ours and deployed | Registry `0x10969a72…2d24`, Registrar `0x8e428Cc0…656a` | [`addresses.turnstile.sepolia.json`](../contracts/addresses.turnstile.sepolia.json) |
| The name is linked into the real ENSv2 hierarchy | `linkedIntoHierarchy: true`, verified against the live `eth` registry rather than a local deployment | [`testFork_nameIsDerivedFromTheLiveHierarchy`](../contracts/test/fork/SepoliaEnsV2.t.sol) |
| The market reads real registrations, not fixtures | 197 ERC-8004 registrations across Base, mainnet and Sepolia | `npm run discover` |
| **Exactly one of those 197 publishes a readable price, and it is ours** | This is the measured claim the whole project rests on. EIP-8004 registration-v1 has no price field | [`docs/architecture.md`](./architecture.md) |

## The Graph

| Claim | Evidence | Where |
|---|---|---|
| A Messari-conformant subgraph, live on Studio | DEX AMM Extended v4.0.1 schema, adopted rather than invented | [Studio endpoint](https://api.studio.thegraph.com/query/1758854/turnstile-uniswap-v-3-messari/v0.1.0) |
| An authored Substreams module for an emerging standard | ERC-8004 agent-registry normalization, Rust, one pipeline across four networks | [`graph/substreams/erc8004-agent-registry-v0.1.0.spkg`](../graph/substreams/) |
| Reusable infrastructure, not a one-off app | `mcp-turnstile` (4 tools + `SKILL.md`) and a standalone `uniswap-mcp` package | [`mcp-turnstile/SKILL.md`](../mcp-turnstile/SKILL.md) |

## Chainlink CRE: read this one carefully

| Claim | Evidence | Where |
|---|---|---|
| A confidential workflow runs in a TEE and produces a verdict | `cre workflow simulate` output, with the enclave constraint and the secret reaching the API | [`docs/cre-confidential-workflow.md`](./cre-confidential-workflow.md) |
| The encoding, the contract and the evidence commitment work against real chain | A verdict settled on Sepolia: CAUTION, confidence 7500bp, evidence hash `0x60caa384…02c2` over 9218 bytes, block 11654749 | [Etherscan](https://sepolia.etherscan.io/tx/0x8ee33bb38563ed88836eaf6e2b7011c1350ef64390f7307691da24bd45e909b8) |
| It is **byte-identical** to what the enclave produced | Same evidence hash, rating, confidence and masks as the simulator. The determinism claim is exercised, not asserted | [`addresses.verdict-rehearsal.sepolia.json`](../contracts/addresses.verdict-rehearsal.sepolia.json) |
| **That settled verdict is NOT DON-attested.** Do not cite it as such | Its forwarder is the seller's own key, so we delivered it. `cre workflow deploy` needs deployment access this org does not have (verified 2026-09-07) | this row |
| The production consumer exists and **would reject** that write | `0xfE95CD0f…C5F2`, gated on the real CRE Forwarder `0xF8344CFd…4482`. Nothing has settled into it | [Etherscan](https://sepolia.etherscan.io/address/0xfE95CD0f710DDC5ceED0e93c4e25412Dc3d8eEeA) |

## Privy: the warm tier

| Claim | Evidence | Where |
|---|---|---|
| An org wallet governed by two key quorums signed on chain | Server wallet `0x3De96375…bE84`, 1-of-2 ops quorum owns it, separate 2-of-2 board quorum owns the mandate policy | [ArcScan](https://testnet.arcscan.app/address/0x3De96375140717193f52c220Df5Ec460971cbE84) |
| A treasury operation, executed | `approve` + `depositFor` funding the agent | [tx 1](https://testnet.arcscan.app/tx/0x3c526daf25216ac831ba21f828458e4bdd7562227b012b399b3e05f0869320de) · [tx 2](https://testnet.arcscan.app/tx/0x681ba1cdbe5b46c6dcd6a7f906265b678099c501e425d62b114793d65c297ec3) |
| An approval workflow that actually refuses | Raising the mandate cap returns `401` with one operator signature and succeeds with two | `npm run privy:mandate` |

## What is not live

Stated plainly, because a demo surface deserves the same honesty as a retracted claim.

| Not live | Why | Consequence |
|---|---|---|
| The hosted seller endpoint | `agent-endpoint[mcp]` names an address with no DNS record. The service is real and runs from the repo; the deploy is scheduled for Sept 14 | A judge reading only the ENS record finds nothing to pay. Run it locally with `npm run serve` |
| A DON-attested verdict | `cre workflow deploy` is gated on access we do not have | The enclave and the settlement both work; the link between them is signed by us, not the DON |
| World Selfie Check | Sandbox access, the Selfie Check Beta flag and the Sandbox mobile app are all pending approvals | `/onboard` is a labelled placeholder. `world_verification` is empty, so every agent reports `unknown`, never `unverified` |
| The `/mandate` web page | The mandate itself is live and runs from the CLI | Use `npm run privy:mandate`, not the browser |

## The Arc payout address reads 0 USDC, and always will

Worth knowing before you open a block explorer and conclude nothing settled.
Circle Gateway credits a **Gateway balance**, not the wallet. The payout address
will show zero on ArcScan forever. Check it with:

```bash
npm run arc:setup -- --status
```
