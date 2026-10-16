// What Turnstile sells, and how its price is derived.
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
// ## Prices are read, not written here
//
// The standard tier costs exactly what the `turnstile:price` record on the
// seller's name says, and every tier is held under `turnstile:price-ceiling` on
// the same name. This file holds no price at all: `priceTiers()` turns the two
// record strings into priced tiers, and `pricing.ts` decides when to read them.
//
// **Correction (2026-10-16, TUR-3):** this header previously said "`0.07` is the
// value of the `turnstile:price` text record … read live off Sepolia on
// 2026-09-07", and the file exported that value as `ENS_PRICE_USD` beside
// `ENS_PRICE_CEILING_USD = 0.5`. The values were right on the day, but they were
// copies, and nothing checked the copy against the record: a hot-key reprice
// changed what discovery advertised and not what the 402 charged. That is the
// failure the header itself warned about ("a service charging something else
// would make the discovery layer a liar"). The constants are gone; the recorded
// values survive only as a test fixture in `testing.ts`. **What is unchanged:**
// the tier shapes, the five-to-one premium relationship, and the cold-key
// ceiling invariant below.
//
// ## Discovery and the 402 agree by construction
//
// `discovery.ts` reports a Turnstile seller's price as exact
// (`priceSource: 'turnstile'`). It reads it with `publishedPrice()`, which is
// `priceTiers()` — the function the 402 is priced by — so the dollar figure
// discovery advertises and the `priceUsd` on the 402 are the same function of
// the same two records. Records the seller will not charge from (unset, not a
// number, above the ceiling) are reported by discovery as no price, not as a
// number.
//
// ## The ceiling, and the premium rule
//
// The ceiling is cold-key-only by design: the hot key that sets
// `turnstile:price` cannot raise the ceiling above itself, which is the
// `CLAUDE.md` invariant that the key which spends can never raise its own limit,
// applied to the seller side. A `turnstile:price` above the ceiling is therefore
// **rejected**, not clamped — it is either a mistake or a hot key trying to do a
// cold key's job, and charging it would be the second.
//
// Premium is `PREMIUM_MULTIPLE` (5) times the standard price, the relationship
// the tiers were launched with ($0.07 and $0.35), **capped at the ceiling**.
// Unlike the standard price, nobody published the premium price, so capping it
// overrides nothing anyone wrote: it is the honest reading of "every tier stays
// under the published maximum". Repricing standard to $0.12 therefore makes
// premium $0.50 (the ceiling), not $0.60. Changing the multiple is a code
// change, by design — the hot key moves one number, not the whole price list.

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

/** What a tier is, before the records say what it costs. */
export const TIER_SHAPES: Record<TierId, Omit<Tier, 'priceUsd'>> = {
  standard: {
    id: 'standard',
    description: 'Liquidity Analyst verdict — is this pool safe to LP? Answered from the subgraph.',
    liveDepth: false,
    includeAnalystInput: false,
  },
  premium: {
    id: 'premium',
    description: 'Liquidity Analyst verdict with a live depth ladder, plus the full scorer input so the verdict can be re-derived.',
    liveDepth: true,
    includeAnalystInput: true,
  },
};

/** Premium costs this many standard queries, up to the ceiling. See the header. */
export const PREMIUM_MULTIPLE = 5;

/** The record keys, named once. */
export const PRICE_RECORD = 'turnstile:price';
export const CEILING_RECORD = 'turnstile:price-ceiling';

/** The two records as read: `undefined` when unset. */
export interface PriceRecords {
  price?: string;
  ceiling?: string;
}

export interface PricedTiers {
  standard: Tier;
  premium: Tier;
  ceilingUsd: number;
  /** The record strings these prices were derived from, verbatim. */
  records: { price: string; ceiling: string };
}

/** Why a set of records cannot be charged from. The message is the reason. */
export class PriceRecordError extends Error {
  override name = 'PriceRecordError';
}

/**
 * A price record, as dollars — or `null` when it is not a price.
 *
 * Plain decimal only: `"0.07"`, `"1"`, `"0.50"`. `Number()` alone would accept
 * `"0x10"`, `"1e3"`, `" 7 "` and `""`, each of which is a hot key typo that would
 * otherwise become a charge. Zero and negatives are not prices either: a free
 * paid route is a misconfiguration, not an offer.
 */
export function parsePriceRecord(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string' || !/^\d+(\.\d+)?$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Dollars to the micro-dollar, so `5 * 0.07` is 0.35 and not 0.35000000000000003. */
const toMicroUsd = (usd: number): number => Math.round(usd * 1e6) / 1e6;

/**
 * Turn the two records into priced tiers, or say exactly why not.
 *
 * @throws PriceRecordError when either record is unset or not a price, or when
 *   the price is above the ceiling.
 */
export function priceTiers(records: PriceRecords): PricedTiers {
  if (records.price === undefined) throw new PriceRecordError(`${PRICE_RECORD} is not set`);
  if (records.ceiling === undefined) throw new PriceRecordError(`${CEILING_RECORD} is not set, so no price can be checked against it`);

  const price = parsePriceRecord(records.price);
  if (price === null) throw new PriceRecordError(`${PRICE_RECORD} is ${JSON.stringify(records.price)}, which is not a positive decimal price`);
  const ceiling = parsePriceRecord(records.ceiling);
  if (ceiling === null) throw new PriceRecordError(`${CEILING_RECORD} is ${JSON.stringify(records.ceiling)}, which is not a positive decimal price`);
  if (price > ceiling) {
    throw new PriceRecordError(
      `${PRICE_RECORD} is $${price}, above the ${CEILING_RECORD} of $${ceiling}. Raising the ceiling is a cold-key operation.`,
    );
  }

  return {
    standard: { ...TIER_SHAPES.standard, priceUsd: price },
    // Capped rather than rejected: see the header.
    premium: { ...TIER_SHAPES.premium, priceUsd: Math.min(toMicroUsd(price * PREMIUM_MULTIPLE), ceiling) },
    ceilingUsd: ceiling,
    records: { price: records.price, ceiling: records.ceiling },
  };
}

/**
 * The standard price as a buyer should read it off the records, for discovery.
 *
 * `priceTiers()` underneath, so discovery reports a dollar figure exactly when
 * the seller would charge it: a record above the ceiling, or with no ceiling,
 * is no price to either.
 */
export function publishedPrice(records: PriceRecords): { usd: number | null; ceilingUsd: number | null; note?: string } {
  try {
    const tiers = priceTiers(records);
    return { usd: tiers.standard.priceUsd, ceilingUsd: tiers.ceilingUsd };
  } catch (cause) {
    if (!(cause instanceof PriceRecordError)) throw cause;
    return {
      usd: null,
      ceilingUsd: parsePriceRecord(records.ceiling),
      note: `${cause.message}; the seller does not charge from these records`,
    };
  }
}
