// Hedera testnet, settled through the Blocky402 facilitator.
//
// **This is a placeholder (MOV-219). MOV-220 replaces the body and keeps the
// shape.** It advertises the right scheme, network and asset so the 402 is
// honestly two-rail from day one, and it settles nothing — `info.live` is false
// and every challenge says `extra.turnstileSettlement: 'stub'`.
//
// ## What MOV-220 has to change, and what it must not
//
// Replace `createStubRail(...)` with a real implementation of `PaymentRail`.
// Nothing in `seller/service/` should need to change; if it does, say so loudly,
// because that means the seam is wrong rather than that the rail is unusual.
//
// The one genuinely non-standard thing about this rail is that **Hedera settles
// through a partially-signed transaction co-signed by the facilitator**, not
// through a bare EIP-3009 style authorization. That does not need a new
// interface method. It lives in two opaque bags:
//
//   - the transaction body the payer must sign goes in `challenge()`'s
//     `extra` — the service copies it onto the wire without reading it;
//   - the payer's partially-signed transaction comes back in
//     `PaymentPayload.payload` — the service hands it straight to `settle()`.
//
// `settle()` then posts to Blocky402's `/settle`, which adds the second
// signature and submits. `receipt()` reads the settlement back — from HCS if
// MOV-220 lands the receipt topic, which is also what unblocks the
// `settledVolume` ranking that `seller/service/discovery.ts` currently reports
// as a placeholder.
//
// ## Values that are NOT verified
//
// Both of these are placeholders, and MOV-220 must confirm them before the rail
// can settle. They are written as obvious placeholders rather than as
// plausible-looking real values on purpose — a wrong-but-believable asset
// address is far more expensive to discover than an obviously fake one.
//
//   - `NETWORK` is Hedera testnet's EVM chain id as `eip155:296`. Hedera also
//     has a CAIP-2 namespace of its own (`hedera:testnet`), and which of the two
//     Blocky402 expects is **unverified as of 2026-09-07**. Read its
//     `/supported` endpoint and use whatever it advertises.
//   - `ASSET` is a placeholder string, not an address. Replace it with the real
//     testnet USDC id in the form `/supported` names.
//
// `docs/accounts.md` records that Blocky402 needs no credential on testnet, and
// that too is marked "confirm before depending on it".

import type { PaymentRail } from '../PaymentRail.ts';
import { createStubRail } from '../stub-rail.ts';

/** UNVERIFIED (2026-09-07) — see the note above. */
export const NETWORK = 'eip155:296';
/** UNVERIFIED (2026-09-07) — a placeholder, deliberately not an address. */
export const ASSET = 'PLACEHOLDER-hedera-testnet-usdc';

export interface HederaRailOptions {
  /** The seller's payout account. Defaults to `HEDERA_PAYOUT_ACCOUNT`. */
  payTo?: string;
  /** Blocky402 base URL. Defaults to `BLOCKY402_URL`. Unused while stubbed. */
  facilitatorUrl?: string;
  network?: string;
}

export function createHederaRail(options: HederaRailOptions = {}): PaymentRail {
  const payTo = options.payTo ?? process.env['HEDERA_PAYOUT_ACCOUNT'] ?? '0.0.10403961';
  return createStubRail({
    id: 'hedera-x402',
    label: 'Hedera testnet USDC, settled through Blocky402',
    scheme: 'exact',
    network: options.network ?? NETWORK,
    asset: { id: ASSET, symbol: 'USDC', decimals: 6 },
    // The on-chain `turnstile:rails` record reads `x402,usdc-arc`; this rail is
    // the `x402` token in it. See RailInfo.ensRailToken.
    ensRailToken: 'x402',
    payTo,
    usdPerUnit: 1,
    extra: {
      facilitator: options.facilitatorUrl ?? process.env['BLOCKY402_URL'] ?? 'https://facilitator.blocky402.dev',
      // MOV-220 replaces this with the real transaction body for the payer to
      // co-sign. The service never reads it.
      settlementModel: 'facilitator-cosigned-transaction',
    },
  });
}
