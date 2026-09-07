// What Turnstile sells, and for how much.
//
// Two tiers, and the difference between them is not a rate limit. It is **how
// much of the analyst's reasoning the buyer gets to check for themselves.**
//
//   standard — the verdict. Answered from the subgraph alone, so it costs one
//              indexed query and no RPC. This is the tier the price on chain
//              refers to.
//
//   premium  — the verdict, plus a live depth ladder quoted against the pool at
//              the current block, plus the complete `AnalystInput` that produced
//              the verdict. The input is the interesting half: `scoring.ts` is a
//              pure function of it, so a buyer holding the input can re-derive
//              the verdict independently and get the same bytes. MOV-227 turns
//              that from "you could check this" into "a Chainlink TEE has
//              already checked it", and needs no new tier to do it — the payload
//              is already exactly the enclave's argument.
//
// ## Prices are not invented here
//
// `0.07` is the value of the `turnstile:price` text record on
// `liquidity.turnstile.eth`, read live off Sepolia on 2026-09-07. Discovery
// reads that record and reports `priceSource: 'turnstile'` meaning "exact", so a
// service charging something else would make the discovery layer a liar.
//
// `0.35` is under the `turnstile:price-ceiling` of `0.50` on the same name. The
// ceiling is cold-key-only by design: the hot key that sets `turnstile:price`
// cannot raise the ceiling above itself, which is the `CLAUDE.md` invariant that
// the key which spends can never raise its own limit, applied to the seller
// side. `assertWithinCeiling` enforces it here too, so a bad edit to this file
// fails a test rather than quietly charging over the published maximum.

/** Verified on Sepolia 2026-09-07 against the `turnstile:price` text record. */
export const ENS_PRICE_USD = 0.07;
/** Verified on Sepolia 2026-09-07 against `turnstile:price-ceiling`. */
export const ENS_PRICE_CEILING_USD = 0.5;

export type TierId = 'standard' | 'premium';

export interface Tier {
  id: TierId;
  priceUsd: number;
  description: string;
  /**
   * Whether to quote the pool live. The standard tier answers from the subgraph
   * alone; skipping the quote is most of why it is cheaper, and the verdict says
   * out loud that it is flying blind rather than pretending otherwise.
   */
  liveDepth: boolean;
  /**
   * Whether to return the `AnalystInput` alongside the verdict. This is the
   * premium tier's actual deliverable and the MOV-227 seam: about 9KB of plain
   * JSON that round-trips losslessly through `assess()`.
   */
  includeAnalystInput: boolean;
}

export const TIERS: Record<TierId, Tier> = {
  standard: {
    id: 'standard',
    priceUsd: ENS_PRICE_USD,
    description: 'Liquidity Analyst verdict — is this pool safe to LP? Answered from the subgraph.',
    liveDepth: false,
    includeAnalystInput: false,
  },
  premium: {
    id: 'premium',
    priceUsd: 0.35,
    description: 'Liquidity Analyst verdict with a live depth ladder, plus the full scorer input so the verdict can be re-derived.',
    liveDepth: true,
    includeAnalystInput: true,
  },
};

/**
 * Throws when a tier is priced above the published ceiling.
 *
 * Called at service construction, not at request time: a seller that would
 * overcharge should refuse to start rather than discover it on the first sale.
 */
export function assertWithinCeiling(tiers: readonly Tier[] = Object.values(TIERS), ceiling = ENS_PRICE_CEILING_USD): void {
  for (const tier of tiers) {
    if (tier.priceUsd > ceiling) {
      throw new RangeError(
        `tier '${tier.id}' is priced at $${tier.priceUsd}, above the turnstile:price-ceiling of $${ceiling} ` +
        'published on liquidity.turnstile.eth. Raising the ceiling is a cold-key operation.',
      );
    }
  }
}
