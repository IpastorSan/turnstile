# Evidence

One row per claim, one link per row. Everything here is on a public chain or a
public endpoint, and every link was checked on 2026-09-09.

Where something is **not** proven, this page says so in the same table rather
than in a footnote. Two rows do exactly that, and they are the two worth reading
first if you are looking for the seam.

**Verify the whole repo in one command:**

```bash
npm run verify      # 426 node tests + 90 Forge tests, including 13 fork tests against live Sepolia
```

**Read it rather than run it:** [`walkthrough/index.html`](../walkthrough/index.html)
is six pages covering the same ground, each figure below shown as the screen it
came from. There is a [48-second recording](./walkthrough.mp4) too.

## The screens these claims describe

Every image is the live stack, captured 2026-09-11 from the public deployment, waiting on real data rather
than a timer — a shot taken on page load would show a structurally complete page
with none of the thing it exists to show.

| Screen | Shows | Image |
|---|---|---|
| Market | 197 registrations; one readable price | [`market.png`](./screenshots/market.png) |
| Seller | `liquidity.turnstile.eth` resolved live from Sepolia, block number moving on reload | [`seller.png`](./screenshots/seller.png) |
| Mandate | both key quorums, the policy, and 25 settled payments across two rails | [`mandate.png`](./screenshots/mandate.png) |
| Create a mandate | operator keys generated in the browser, never sent to the server | [`mandate-new.png`](./screenshots/mandate-new.png) |
| Onboard | Selfie Check as an abuse control, not a login; the listing picker (registered agent or reservation) | [`onboard.png`](./screenshots/onboard.png) |

**Update (2026-09-11, MOV-279):** `onboard.png` was re-captured from the public
deployment after MOV-277 replaced the hard-coded listing with a picker. The other
four images are unchanged from MOV-276.

**Update (2026-09-11, MOV-273):** `seller.png` predates two changes, and shows the
old state of both: `turnstile:operator-proof` reading `ledger-key-ring` (rewritten
on chain 2026-09-11), and a "Where to ask" section saying the published host does
not answer yet (the host is live since 2026-09-11; the published *path* still
404s). What it claims in the table above — a live, uncached read from Sepolia — is
unaffected. It was not re-captured in this change.

**Update (2026-09-11, MOV-276): re-captured.** All five screenshots were taken
again on 2026-09-11 from the **public deployment**, `https://turnstile.moveseventyeight.com`,
after the seller-page copy fix (MOV-275) went live. `seller.png` now shows
`turnstile:operator-proof` = `operator-key-role-scoped`, and a "Where to ask"
section saying the host answers while the published `/…/sse` path returns 404.
`mandate.png` shows both rails read from the deployed VM (12 on Hedera at
$0.840000, 13 on Arc at $0.215000). The note above was accurate for the images it
described; those images have been replaced.

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
| The operator key writes what only it may write | It rewrote `turnstile:operator-proof` from the stale `ledger-key-ring` to `operator-key-role-scoped`, signed by `0x0Adca6e1…f5F2`, block 11680454, status 1. Added and read back 2026-09-11 | [Etherscan](https://sepolia.etherscan.io/tx/0x261951055f300820830e66160c7a5d2437a489b15ee008aad39b4f47f2a3d4e1) |

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

## Uniswap

| Claim | Evidence | Where |
|---|---|---|
| We reported a defect in Uniswap's official agent-tooling repo | `v4-sdk-integration` mandated ethers v5 `callStatic` in a skill that installs no ethers and whose other snippets are all viem; both eval rubrics graded for it | [`uniswap-ai#148`](https://github.com/Uniswap/uniswap-ai/issues/148) |
| **Uniswap fixed and merged it, the same day** | Merged 2026-09-08T14:27:57Z, 7 files, +51 / −14, across the skill, its docs page, the plugin `CLAUDE.md` and both rubrics | [`uniswap-ai#149`](https://github.com/Uniswap/uniswap-ai/pull/149) |
| **The merged code is theirs, not ours.** Stated here so it is not inferred | A maintainer wrote it so the version bump and docs sync landed in one commit, and linked back to our issue: *"the shape is yours and the PR will link back here"* | [their comment](https://github.com/Uniswap/uniswap-ai/issues/148#issuecomment-5586501199) |

## Chainlink CRE: read this one carefully

| Claim | Evidence | Where |
|---|---|---|
| A confidential workflow runs in a TEE and produces a verdict | `cre workflow simulate` output, with the enclave constraint and the secret reaching the API | [`docs/cre-confidential-workflow.md`](./cre-confidential-workflow.md) |
| The encoding, the contract and the evidence commitment work against real chain | A verdict settled on Sepolia: CAUTION, confidence 7500bp, evidence hash `0x60caa384…02c2` over 9218 bytes, block 11654749 | [Etherscan](https://sepolia.etherscan.io/tx/0x8ee33bb38563ed88836eaf6e2b7011c1350ef64390f7307691da24bd45e909b8) |
| It is **byte-identical** to what the enclave produced | Same evidence hash, rating, confidence and masks as the simulator. The determinism claim is exercised, not asserted | [`addresses.verdict-rehearsal.sepolia.json`](../contracts/addresses.verdict-rehearsal.sepolia.json) |
| **That settled verdict is NOT DON-attested.** Do not cite it as such | Its forwarder is the seller's own key, so we delivered it. `cre workflow deploy` needs deployment access this org does not have (verified 2026-09-07) | this row |
| The production consumer exists and **would reject** that write | `0xfE95CD0f…eEeA`, gated on the real CRE Forwarder `0xF8344CFd…4482`. Nothing has settled into it | [Etherscan](https://sepolia.etherscan.io/address/0xfE95CD0f710DDC5ceED0e93c4e25412Dc3d8eEeA) |

## Privy: the warm tier

| Claim | Evidence | Where |
|---|---|---|
| An org wallet governed by two key quorums signed on chain | Server wallet `0x3De96375…bE84`, 1-of-2 ops quorum owns it, separate 2-of-2 board quorum owns the mandate policy | [ArcScan](https://testnet.arcscan.app/address/0x3De96375140717193f52c220Df5Ec460971cbE84) |
| A treasury operation, executed | `approve` + `depositFor` funding the agent | [tx 1](https://testnet.arcscan.app/tx/0x3c526daf25216ac831ba21f828458e4bdd7562227b012b399b3e05f0869320de) · [tx 2](https://testnet.arcscan.app/tx/0x681ba1cdbe5b46c6dcd6a7f906265b678099c501e425d62b114793d65c297ec3) |
| An approval workflow that actually refuses | Raising the mandate cap returns `401` with one operator signature and succeeds with two | `npm run privy:mandate` |

## Deployment: the host is live

Added 2026-09-11 (MOV-273). Both rows were checked that day from outside the box.

| Claim | Evidence | Where |
|---|---|---|
| The stack is served on the public internet | GCP Compute Engine VM `turnstile` (e2-medium, `europe-southwest1-a`, static IP `34.175.99.87`) running `deploy/compose.yaml` from `main` at `5feaec2`, behind Caddy with a Let's Encrypt certificate. Live since 2026-09-11 | [turnstile.moveseventyeight.com](https://turnstile.moveseventyeight.com) · [`docs/deploy.md`](./deploy.md) |
| The paid service answers, and will not answer unpaid | Over real TLS: `/analyze/0x88e6…5640` → `402 Payment Required`; `/`, `/api/health`, `/seller-health` → 200; http → https 308 | `curl -si https://turnstile.moveseventyeight.com/analyze/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640` |

The URL the ENS record publishes is **not** among these. It is the first row of
the next section.

## What is not live

Stated plainly, because a demo surface deserves the same honesty as a retracted claim.

| Not live | Why | Consequence |
|---|---|---|
| The MCP endpoint published on chain | `agent-endpoint[mcp]` publishes `https://turnstile.moveseventyeight.com/liquidity.turnstile.eth/sse`, and that exact URL returns **404** (verified 2026-09-11). `mcp-turnstile` is a stdio MCP server; nothing in the repo serves that path. The *host* is live — see [Deployment](#deployment-the-host-is-live) | A buyer's agent that follows the ENS record literally finds nothing to pay. The payable service is on the same host at `/analyze/:pool`, and the record does not say so. See [`docs/deploy.md`](./deploy.md), "Known gap" |
| A DON-attested verdict | `cre workflow deploy` is gated on access we do not have | The enclave and the settlement both work; the link between them is signed by us, not the DON |
| World Selfie Check | Sandbox access, the Selfie Check Beta flag and the Sandbox mobile app are all pending approvals | `/onboard` is a labelled placeholder. `world_verification` is empty, so every agent reports `unknown`, never `unverified` |

**Correction (2026-09-11, MOV-277): the World Selfie Check row above is no
longer true.** The approvals arrived on 2026-09-09, `/onboard` has run Selfie
Check since, and the first real Sandbox App proof was verified by World's
Developer Portal on 2026-09-11 at 09:06:02 UTC. It did **not** reach the
market: `/onboard` hard-coded one listing and posted its ENS name, the verify
route stored the proof under `liquidity.turnstile.eth`, and the market joins
`world_verification` on the ERC-8004 agent uid
(`eip155:11155111:0x8004a818…/10127`). Verified against the live store on
2026-09-11: one row, keyed by the name, and `/api/sellers` reporting the seller
as `unknown`. MOV-277 resolves the listing to its agent uid on the server,
turns `/onboard` into a picker (registered listings from the store, plus other
`turnstile.eth` subnames as labelled reservations so the cap can be shown), and
adds `scripts/world-rekey.ts` for the orphaned row. The market shows `verified`
for our seller only once that script has run on the host, or the listing is
verified again. What is unchanged: an agent with no proof reports `unknown`,
never `unverified`.

**Correction (2026-09-09, MOV-266): two rows above have been edited, and the
reason for each is below.** Both were found while building `walkthrough/`, which
reads this file as its source of truth and could not restate either.

1. **The `/mandate` web page row is deleted, because it is no longer true.** It
   said "the mandate itself is live and runs from the CLI … use
   `npm run privy:mandate`, not the browser". `/mandate` shipped on 2026-09-08
   and reads live from Privy: the org wallet, both quorums with their differing
   thresholds, the policy, the allowlist, and a per-rail ledger of what the
   agent actually spent. `/mandate/new` issues one, generating the operators'
   signing keys in the browser. `docs/screenshots/mandate.png` is that page.
   Everything else in this section is unchanged and still not live.

2. **The production CRE consumer was written `0xfE95CD0f…C5F2`. The suffix was
   wrong** — it is `0xfE95CD0f710DDC5ceED0e93c4e25412Dc3d8eEeA`, so the
   abbreviation is `0xfE95CD0f…eEeA`. `…C5F2` is the *rehearsal* consumer's
   suffix (`0xEE72d3d0E4b090eBB8Db6abc26547bcd1fc9C5F2`), copied across. The
   link in that row always pointed at the right address, and the claim it makes
   is unchanged: nothing has settled into the production consumer, and it would
   reject the rehearsal write.

**Addition (2026-09-09, MOV-266): the settlement counts above are a pinned
subset, not a total.** The Arc rows say "eleven settled payments across two
transactions", which is exactly right for 2026-09-07 and for the two batch
transactions they link — do not change them. As of **2026-09-09** the live
`/mandate` page reads **25 settled payments totalling $1.0550** across both
rails: 12 on `hedera-x402` ($0.840000) and 13 on `arc-usdc` ($0.215000), read
from the public mirror node and Circle Gateway's transfers API rather than from
any store of ours. The count grows every time the demo runs, which is why the
rows above pin transactions instead of a total.

**Update (2026-09-11, MOV-273): the first row of this section was rewritten.**
It previously read "The hosted seller endpoint | `agent-endpoint[mcp]` names an
address with no DNS record. The service is real and runs from the repo; the
deploy is scheduled for Sept 14 | … Run it locally with `npm run serve`". The
host went live on 2026-09-11, so that row now names only the part still not
live: the exact URL the record publishes, which returns 404. The host's own
evidence is in [Deployment](#deployment-the-host-is-live), and the operator
key's rewrite of `turnstile:operator-proof` was added to the Authority table.
The other two rows here are unchanged and still not live.

## The Arc payout address reads 0 USDC, and always will

Worth knowing before you open a block explorer and conclude nothing settled.
Circle Gateway credits a **Gateway balance**, not the wallet. The payout address
will show zero on ArcScan forever. Check it with:

```bash
npm run arc:setup -- --status
```
