// The values MOV-219 shipped as deliberate placeholders, replaced with verified
// ones. Every constant below was read off a live endpoint on 2026-09-07; the
// commands are in `docs/arc-nanopayments.md` so the next reader can re-run them
// rather than trust this file.
//
// **Correction (2026-09-07, MOV-225):** `rails/arc-usdc/index.ts` previously
// declared `NETWORK = 'eip155:0-PLACEHOLDER-arc'`, `ASSET = 'PLACEHOLDER-arc-usdc'`
// and a facilitator at `https://facilitator.arc.circle.com`. All three are now
// real, and the facilitator host was a guess that does not resolve — the product
// is **Circle Gateway Nanopayments**, served from
// `https://gateway-api-testnet.circle.com`.
//
// ## Two identifiers for one chain, and mixing them up is the failure mode
//
// This bit the Hedera rail once already (see `../hedera-x402/config.ts`), in the
// opposite direction. Arc has **two** names and both are correct in their own
// place:
//
// | | Value | Used by |
// |---|---|---|
// | CAIP-2 | `eip155:5042002` | the x402 wire — `PaymentRequirements.network`, Gateway's `/supported` |
// | Circle chain name | `arcTestnet` | the Circle SDK — `GatewayClient({ chain })`, `CHAIN_CONFIGS` |
//
// They are not interchangeable in either direction. `GatewayClient({ chain:
// 'eip155:5042002' })` throws on an unknown chain, and a challenge quoting
// `arcTestnet` as its `network` is rejected by Gateway because no supported kind
// matches it. {@link GATEWAY_CHAIN_NAME} exists so the one place that needs the
// second form does not reach for the first.

/**
 * CAIP-2 network id — what goes on the x402 wire.
 *
 * Verified 2026-09-07 two independent ways: `eth_chainId` on
 * {@link RPC_URL} returns `0x4cef52` (= 5042002), and
 * `GET https://gateway-api-testnet.circle.com/v1/x402/supported` advertises a
 * kind on `eip155:5042002`.
 */
export const NETWORK = 'eip155:5042002';

/** The EVM chain id inside {@link NETWORK}. Needed for the EIP-712 domain. */
export const CHAIN_ID = 5042002;

/**
 * Circle's own name for this chain — `SupportedChainName` in
 * `@circle-fin/x402-batching/client`. **Not** a CAIP-2 id. See the header.
 */
export const GATEWAY_CHAIN_NAME = 'arcTestnet';

/** Circle Gateway's cross-chain domain number for Arc. From `GATEWAY_DOMAINS`. */
export const GATEWAY_DOMAIN = 26;

/**
 * USDC on Arc testnet.
 *
 * The address is a system precompile rather than a deployed ERC-20, which is the
 * first visible sign of the thing that matters most about this chain: **USDC is
 * Arc's native gas token.** See {@link NATIVE_DECIMALS}.
 *
 * Verified 2026-09-07 against Gateway's `/supported` for `eip155:5042002`.
 */
export const USDC_ASSET = '0x3600000000000000000000000000000000000000';

/** USDC's ERC-20 view has six decimals, like USDC everywhere. */
export const USDC_DECIMALS = 6;

/**
 * The *native* view of the same balance has eighteen.
 *
 * This is not a second asset. `eth_getBalance(a)` and `USDC.balanceOf(a)` are
 * two views of one balance at two precisions, and the ERC-20 view truncates.
 * Measured 2026-09-07 against a live Arc address:
 *
 * ```
 * eth_getBalance   285144556003000000   (18 dp) = 0.285144556003 USDC
 * USDC.balanceOf              285144   ( 6 dp) = 0.285144       USDC
 * ```
 *
 * Recorded here because a document in this repo drew the wrong conclusion from
 * it — see the correction in `CLAUDE.md`'s key-tiers table.
 */
export const NATIVE_DECIMALS = 18;

/**
 * The GatewayWallet contract, and the EIP-712 `verifyingContract` a payer signs
 * against.
 *
 * Note that this is **not** the USDC contract. Circle Gateway's batched `exact`
 * scheme has the payer sign an EIP-3009 `TransferWithAuthorization` whose
 * verifying contract is the GatewayWallet, which is what lets Circle's batcher
 * redeem many authorizations in one transaction.
 *
 * Do not hardcode a challenge against this constant: `challenge()` reads it from
 * the facilitator's `/supported` every time, and this value exists only so a
 * test has something to assert against. Verified 2026-09-07.
 */
export const GATEWAY_WALLET = '0x0077777d7eba4688bdef3e311b846f25870a19b9';

/**
 * Circle Gateway's testnet facilitator.
 *
 * **No API key, no signup, no Authorization header — verified 2026-09-07.**
 * `GET /v1/x402/supported` and `GET /v1/x402/transfers` both answer an
 * unauthenticated request. (Our `CIRCLE_API_KEY` is a Circle Mint sandbox key
 * and is not used by this rail at all; it answers 403 on the faucet API.)
 *
 * Mainnet is `https://gateway-api.circle.com`, which is the SDK's default — so
 * a rail that forgets to pass this URL quietly points at mainnet.
 */
export const FACILITATOR_URL = 'https://gateway-api-testnet.circle.com';

/** Arc testnet's public RPC. Free, no key — verified 2026-09-07. */
export const RPC_URL = 'https://rpc.testnet.arc.network';

/** ArcScan, the explorer judges will check. A tx page returned 200 to curl on 2026-09-07. */
export const EXPLORER_URL = 'https://testnet.arcscan.app';

export function arcscanTransactionUrl(hash: string): string {
  return `${EXPLORER_URL}/tx/${hash}`;
}

export function arcscanAddressUrl(address: string): string {
  return `${EXPLORER_URL}/address/${address}`;
}

/**
 * Is this a settled batch transaction hash, rather than an authorization id?
 *
 * The two identifiers this rail hands around are deliberately distinguishable by
 * shape, because `receipt()` is given one string and has to know which endpoint
 * can answer for it. A batch hash is a 32-byte EVM transaction hash; an
 * authorization id is a Gateway UUID.
 */
export function isBatchTransactionHash(id: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(id);
}

/** Is this a Gateway authorization (transfer) id? See {@link isBatchTransactionHash}. */
export function isAuthorizationId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
