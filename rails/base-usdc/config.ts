// Values for the Base rail, each one read off the live network rather than
// remembered. Re-run the command in each comment before trusting it.
//
// ## Why this rail exists
//
// The Bazantic gateway pays a provider over x402 `exact` in **USDC on Base** —
// that is the only rail its client (`baz curl`) will sign for on a production
// gateway (see `@bazantic/cli`, `src/gateway/networks.js`: Base is the default,
// Base Sepolia the testnet, Tempo the alternative). The seller advertised
// `hedera:testnet` HBAR and `eip155:5042002` (Arc) USDC, so a gateway client
// found nothing it could pay and the Recipe could not run. This rail is that
// missing `accepts[]` entry.
//
// ## Testnet, on purpose, and said plainly
//
// The public facilitator settles `exact` on **eip155:84532 (Base Sepolia)** and
// does not list Base mainnet. A mainnet rail would therefore be a quote nobody
// can settle without a second facilitator or our own relayer holding mainnet
// gas — so this one is testnet-live, settles real testnet USDC, and proves on
// sepolia.basescan.org. Mainnet is a config swap (`network`, `asset`,
// `facilitatorUrl`) once something that settles it exists; nothing else here
// assumes Sepolia.

/**
 * CAIP-2 network id — what goes on the x402 wire, and the id `baz curl
 * --network base-sepolia` compares against.
 *
 * Verified 2026-09-11: `cast chain-id --rpc-url https://sepolia.base.org`
 * returns 84532, and `GET https://x402.org/facilitator/supported` lists
 * `{x402Version: 2, scheme: "exact", network: "eip155:84532"}`.
 */
export const NETWORK = 'eip155:84532';

/** The EVM chain id inside {@link NETWORK}. Needed for the EIP-712 domain. */
export const CHAIN_ID = 84532;

/**
 * USDC on Base Sepolia — Circle's testnet FiatToken, not a mock.
 *
 * Verified 2026-09-11 against the chain: `symbol()` and `name()` both return
 * `"USDC"` and `version()` returns `"2"`. That third call is the one that
 * matters: the facilitator checks the EIP-712 domain it is handed against the
 * token's own and refuses the payment with
 * `invalid_exact_evm_token_version_mismatch` if they differ, so
 * {@link EIP712_VERSION} is a live fact rather than a convention.
 */
export const USDC_ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

/** USDC has six decimals everywhere. */
export const USDC_DECIMALS = 6;

/** EIP-712 domain name, from the token's own `name()`. */
export const EIP712_NAME = 'USDC';

/** EIP-712 domain version, from the token's own `version()`. See {@link USDC_ASSET}. */
export const EIP712_VERSION = '2';

/**
 * The public x402 facilitator, run by the x402 Foundation.
 *
 * **No API key, no signup, no Authorization header — verified 2026-09-11.**
 * It is a *different* facilitator from Blocky402 (Hedera) and Circle Gateway
 * (Arc), which is the point of the seam: three rails, three settlement stacks,
 * one `PaymentRail` interface.
 */
export const FACILITATOR_URL = 'https://x402.org/facilitator';

/** Base Sepolia's public RPC. Free, no key — verified 2026-09-11. */
export const RPC_URL = 'https://sepolia.base.org';

/** Basescan's testnet explorer. This is where a judge checks the payment. */
export const EXPLORER_URL = 'https://sepolia.basescan.org';

/**
 * keccak256("Transfer(address,address,uint256)") — topic 0 of every ERC-20
 * transfer, identical on every chain and every token. Hardcoded rather than
 * computed because it is a protocol constant, not our value: no keccak
 * implementation is needed to read a log.
 */
export const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * The seller's payout address, used when `BASE_PAYOUT_ADDRESS` is unset.
 *
 * The same address the Arc rail pays (`ENS_PAYOUT_ADDRESS` there), which is the
 * ENS `addr(60)` record on `liquidity.turnstile.eth`. Named again here rather
 * than imported across rails: two rails agreeing on an address is a fact about
 * this deployment, not a dependency between implementations.
 */
export const ENS_PAYOUT_ADDRESS = '0x0Adca6e14bA956201D221feC767e4f24194bf5F2';

// ---------------------------------------------------------------------------
// Base MAINNET — the same rail, the other chain
//
// Added 2026-09-11 for the Bazantic gateway. The reason is not symmetry: a
// gateway registered on `bazantic.com` is a *production* one, and it charges
// its client in USDC on Base mainnet (`network: base`, 0.01 USDC, read off the
// live challenge). The Testnet rail above cannot be paid by that client, and
// `*.bazantic.dev` previews — which would settle on Sepolia — are the
// vendor's own deployments behind Vercel SSO, not something a hackathon
// account can create.
//
// Everything below was read off Base mainnet on 2026-09-11 with `cast`; the
// commands are in the commit message. The EIP-712 domain is the part that
// differs from Sepolia in a way nobody would guess: Circle's mainnet token is
// named **"USD Coin"** while the testnet one is named "USDC", and the
// facilitator refuses a payment signed against the wrong name
// (`invalid_exact_evm_token_name_mismatch`).
// ---------------------------------------------------------------------------

/** CAIP-2 network id for Base mainnet. `cast chain-id --rpc-url https://mainnet.base.org` → 8453. */
export const MAINNET_NETWORK = 'eip155:8453';

/** The EVM chain id inside {@link MAINNET_NETWORK}. */
export const MAINNET_CHAIN_ID = 8453;

/** USDC on Base mainnet — Circle's real token, `0x833589…2913`. */
export const MAINNET_USDC_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/** Mainnet USDC's EIP-712 domain name. **Not** the same string as testnet's. */
export const MAINNET_EIP712_NAME = 'USD Coin';

/**
 * The facilitator that settles this rail.
 *
 * The x402 Foundation's facilitator (`x402.org`) lists Base Sepolia only, so
 * mainnet needs a different operator. **Verified 2026-09-11: no API key.**
 * `GET https://facilitator.payai.network/supported` advertises
 * `{scheme: exact, network: eip155:8453}` and `POST /verify` answers
 * `invalid_exact_evm_signature` for a malformed authorization — i.e. the
 * request reaches the verifier rather than a gate.
 *
 * **Not verified, and worth knowing before mainnet revenue depends on it:**
 * this facilitator's fee model. The other candidate, `facilitator.xpay.sh`,
 * also settles mainnet with no key; swapping to it is one option or one env
 * var (`X402_FACILITATOR_URL`).
 */
export const MAINNET_FACILITATOR_URL = 'https://facilitator.payai.network';

/** Base mainnet's public RPC. Free, no key — verified 2026-09-11. */
export const MAINNET_RPC_URL = 'https://mainnet.base.org';

/** Block explorer per network. A mainnet payment must not link to a testnet explorer. */
const EXPLORER_BY_NETWORK: Record<string, string> = {
  [NETWORK]: EXPLORER_URL,
  [MAINNET_NETWORK]: 'https://basescan.org',
};

/** The right explorer URL for a settlement on a given network. */
export function explorerTransactionUrl(network: string, hash: string): string {
  return `${EXPLORER_BY_NETWORK[network] ?? EXPLORER_URL}/tx/${hash}`;
}


export function basescanTransactionUrl(hash: string): string {
  return `${EXPLORER_URL}/tx/${hash}`;
}

export function basescanAddressUrl(address: string): string {
  return `${EXPLORER_URL}/address/${address}`;
}

/**
 * Is this a settlement transaction hash, rather than something else we hand
 * around?
 *
 * `receipt()` is given one string and has to decide whether the RPC can answer
 * for it. A 32-byte EVM hash is the only shape it can.
 */
export function isTransactionHash(id: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(id);
}
