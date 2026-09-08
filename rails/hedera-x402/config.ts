// The values MOV-219 shipped as deliberate placeholders, replaced with verified
// ones. Every constant below was read off a live endpoint on 2026-09-07; the
// commands are in `docs/payment-flow.md` so the next reader can re-run them
// rather than trust this file.
//
// **Correction (2026-09-07, MOV-220):** `rails/hedera-x402/index.ts` previously
// declared `NETWORK = 'eip155:296'` (Hedera testnet's EVM chain id) and marked
// it UNVERIFIED. That is wrong. Blocky402's `/supported` advertises
// `hedera:testnet` — Hedera's own CAIP-2 namespace — and `@x402/hedera`'s
// `assertSupportedHederaNetwork()` accepts only `hedera:mainnet` and
// `hedera:testnet`. A challenge on `eip155:296` is rejected by the facilitator
// with `network_mismatch` before anything is signed.

/**
 * CAIP-2 network id. Verified 2026-09-07 against
 * `GET https://api.testnet.blocky402.com/supported`, which returns
 * `{"x402Version":2,"scheme":"exact","network":"hedera:testnet",
 *   "extra":{"feePayer":"0.0.7162784"}}`.
 */
export const NETWORK = 'hedera:testnet';

/** Blocky402's hosted testnet facilitator. No API key, no signup — verified 2026-09-07. */
export const FACILITATOR_URL = 'https://api.testnet.blocky402.com';

/** Hedera's public testnet mirror node. Free, no key. */
export const MIRROR_NODE_URL = 'https://testnet.mirrornode.hedera.com';

/**
 * The asset id x402 uses for native HBAR, per `@x402/hedera`'s `HBAR_ASSET_ID`.
 *
 * ## Why HBAR and not USDC
 *
 * The placeholder advertised `USDC`, and testnet USDC does exist on Hedera
 * (`0.0.429274`, 6 decimals — `HEDERA_TESTNET_USDC` in `@x402/hedera`). We
 * settle in HBAR anyway, and the reason is the acceptance criterion: an HTS
 * transfer requires **both** the payer and the payee to be associated with the
 * token, and the payer to hold a balance of it. That is two more transactions,
 * a faucet we do not control, and two more ways for the one payment that has to
 * work on camera to fail with `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`. Native HBAR
 * needs none of it and the operator is funded with 1000 HBAR.
 *
 * The rail is not HBAR-specific: pass `asset`/`decimals`/`usdPerUnit` to
 * {@link createHederaRail} and the same code path settles USDC. Only the
 * default changed.
 */
export const HBAR_ASSET = '0.0.0';

/** Tinybars per HBAR is 1e8. Not 1e6 — HBAR has eight decimals, USDC has six. */
export const HBAR_DECIMALS = 8;

/**
 * Fallback HBAR/USD, used only when the mirror node's exchange rate is
 * unreachable. Read 2026-09-07 from
 * `GET https://testnet.mirrornode.hedera.com/api/v1/network/exchangerate`
 * (`cent_equivalent: 248910 / hbar_equivalent: 30000` = 8.297¢).
 *
 * A stale rate here only changes the size of the payment, never its validity —
 * the payer signs whatever the challenge quotes — but it goes stale, so the live
 * rate is preferred and the one actually used is reported in `extra.rateSource`.
 */
export const HBAR_USD_FALLBACK = 0.08297;

/**
 * HashScan, the explorer judges will check.
 *
 * The `@` is left unescaped: that is the form Hedera's own documentation and
 * HashScan's routes use, and percent-encoding it produces a link that reads
 * wrong even where it resolves.
 *
 * **Not verified from a terminal (2026-09-07).** `hashscan.io` answers 404 to
 * curl for *every* path including its own root, so a status code says nothing
 * about whether a route exists — it is a single-page app behind bot filtering.
 * The link that *is* verified is the mirror node one below: it returned the
 * settled transaction with `result: SUCCESS`. Check HashScan in a browser
 * before putting it in front of a judge.
 */
export function hashscanTransactionUrl(transactionId: string, network = 'testnet'): string {
  return `https://hashscan.io/${network}/transaction/${transactionId}`;
}

export function hashscanTopicUrl(topicId: string, network = 'testnet'): string {
  return `https://hashscan.io/${network}/topic/${topicId}`;
}

/** The mirror node REST record for a transaction. Verified to resolve; no key needed. */
export function mirrorNodeTransactionUrl(transactionId: string, mirrorNodeUrl = MIRROR_NODE_URL): string {
  return `${mirrorNodeUrl}/api/v1/transactions/${toMirrorNodeTransactionId(transactionId)}`;
}

/**
 * Hedera writes a transaction id two ways and they are not interchangeable.
 *
 * The SDK and HashScan use `0.0.7162784@1788789662.378811934`; the mirror node
 * REST API wants `0.0.7162784-1788789662-378811934` in a path segment. Getting
 * this wrong produces a 404 that looks exactly like "the transaction does not
 * exist", which is the expensive way to find out.
 */
export function toMirrorNodeTransactionId(transactionId: string): string {
  return transactionId.replace('@', '-').replace(/\.(\d+)$/, '-$1');
}
