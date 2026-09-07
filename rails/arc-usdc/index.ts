// Circle / Arc — USDC, Paymaster, nanopayments.
//
// **This is a placeholder (MOV-219). MOV-225 replaces the body and keeps the
// shape.** Same contract as `rails/hedera-x402`: `info.live` is false and every
// challenge carries `extra.turnstileSettlement: 'stub'`.
//
// ## Why this rail exists before it works
//
// The 402 has to advertise more than one way to pay from the first day, because
// the buyer's mandate choosing *between* rails is the interesting behaviour and
// a single-entry `accepts[]` never exercises it. `seller/service/` is written
// against a list of rails; it is not written against Hedera with an Arc branch
// bolted on later.
//
// ## What makes this rail different, and why it needs no new interface method
//
// Arc is a different facilitator stack from Blocky402, and the buyer's agent
// wallet here is the **hot tier** — the Circle / Arc Agent Stack wallet that
// spends within a mandate and holds zero native token, gas being sponsored by a
// Paymaster (`CLAUDE.md`, "The three key tiers"). None of that is visible to the
// seller's service:
//
//   - the Paymaster arrangement is between the buyer and Circle, and does not
//     appear in the challenge at all;
//   - the facilitator URL and the USDC contract go in `challenge()`'s `extra`;
//   - the payer's authorization comes back in `PaymentPayload.payload`.
//
// ## Values that are NOT verified
//
// Written as obvious placeholders rather than plausible-looking real values, for
// the same reason as the Hedera rail — a wrong-but-believable chain id costs far
// more to find than an obviously fake one.
//
//   - `NETWORK` is a placeholder. Arc's CAIP-2 identifier is **unverified as of
//     2026-09-07**; MOV-225 must read it off Circle's own documentation or the
//     facilitator's `/supported`, and `CHECKLIST.md` item 10 records that we are
//     still waiting on Circle to confirm whether the Launch track accepts a
//     testnet plus mainnet config at all.
//   - `ASSET` is a placeholder string, not an address.

import type { PaymentRail } from '../PaymentRail.ts';
import { createStubRail } from '../stub-rail.ts';

/** UNVERIFIED (2026-09-07) — deliberately not a real chain id. */
export const NETWORK = 'eip155:0-PLACEHOLDER-arc';
/** UNVERIFIED (2026-09-07) — deliberately not an address. */
export const ASSET = 'PLACEHOLDER-arc-usdc';

export interface ArcRailOptions {
  /** The seller's payout address. Defaults to `ARC_PAYOUT_ADDRESS`, then the ENS `addr()`. */
  payTo?: string;
  facilitatorUrl?: string;
  network?: string;
}

/**
 * The payout address published as `addr(60)` on `liquidity.turnstile.eth`,
 * read live off Sepolia on 2026-09-07. It is the cold tier's to change; a hot
 * key trying to move it reverts on-chain (`docs/ens-offer-records.md`).
 */
export const ENS_PAYOUT_ADDRESS = '0x0Adca6e14bA956201D221feC767e4f24194bf5F2';

export function createArcRail(options: ArcRailOptions = {}): PaymentRail {
  const payTo = options.payTo ?? process.env['ARC_PAYOUT_ADDRESS'] ?? ENS_PAYOUT_ADDRESS;
  return createStubRail({
    id: 'arc-usdc',
    label: 'Arc USDC, settled through the Circle Agent Stack facilitator',
    scheme: 'exact',
    network: options.network ?? NETWORK,
    asset: { id: ASSET, symbol: 'USDC', decimals: 6 },
    // The `usdc-arc` token of the on-chain `turnstile:rails` record.
    ensRailToken: 'usdc-arc',
    payTo,
    usdPerUnit: 1,
    extra: {
      facilitator: options.facilitatorUrl ?? process.env['ARC_FACILITATOR_URL'] ?? 'https://facilitator.arc.circle.com',
      settlementModel: 'facilitator-authorization',
    },
  });
}
