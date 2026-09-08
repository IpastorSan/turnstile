// What is allowed to leave the enclave.
//
// `assess()` produces a `Verdict`: four ratings, a confidence, seven signals,
// each with a headline, a reasoning paragraph and a block of labelled evidence.
// That whole object is the thing the buyer pays for, and it is emphatically
// *not* what goes on chain — an LP-safety report published in the clear is a
// report nobody needs to buy.
//
// So this file defines the narrow waist. A `CompactVerdict` is seven fields —
// 224 bytes ABI-encoded, 65 bytes of actual information — carrying exactly four
// things:
//
//   - which pool was judged, so the verdict is addressable;
//   - the rating and confidence, so a contract can act on it;
//   - two 7-bit masks saying *which* signals failed and which warned, so the
//     verdict is falsifiable rather than an opaque number;
//   - a keccak256 over the evidence bytes the enclave actually scored.
//
// That last field is the keystone. The buyer receives the full 9kB
// `AnalystInput` off-chain when they pay, hashes it, and compares. If it
// matches, the report they hold is provably the one an attested enclave
// scored — same bytes, same calibration, same verdict. If it does not, the
// seller substituted the evidence after the fact and the buyer can prove it.
// Someone who has not paid learns nothing from the hash at all.
//
// Everything here is pure and dependency-light on purpose: it is imported by
// the CRE workflow (compiled to WASM, running inside the TEE) and by
// `seller/service/premium.ts` (running on the seller's box), and both sides
// have to agree byte-for-byte or the comparison above is worthless.

import { decodeAbiParameters, encodeAbiParameters, parseAbiParameters } from 'viem';
import type { Rating, Signal, Verdict } from '../analyst/types.ts';

/**
 * Bit positions in `failMask` / `warnMask`, by signal id.
 *
 * The order is frozen: it is part of the on-chain encoding, so appending is
 * fine and reordering is a breaking change. Seven signals fit in a `uint8`
 * with one bit spare.
 */
export const SIGNAL_BITS = [
  'inventory-balance',
  'executable-depth',
  'depth-vs-tvl',
  'slippage-curve',
  'fee-return',
  'activity-continuity',
  'lp-concentration',
] as const;

export type SignalId = (typeof SIGNAL_BITS)[number];

/**
 * Rating as a `uint8`, ordered by severity so a contract can write
 * `require(v.rating <= uint8(Rating.CAUTION))` and mean it.
 *
 * `INSUFFICIENT_DATA` sits at the far end deliberately. It is not "worse than
 * AVOID"; it is "do not act on this", and putting it above AVOID stops a
 * threshold comparison quietly treating a missing measurement as a mild one.
 */
export const RATING_CODES: Record<Rating, number> = {
  ACCEPTABLE: 0,
  CAUTION: 1,
  AVOID: 2,
  INSUFFICIENT_DATA: 3,
};

export const RATING_NAMES: Rating[] = ['ACCEPTABLE', 'CAUTION', 'AVOID', 'INSUFFICIENT_DATA'];

/** The verdict, reduced to what a contract can hold and a buyer can verify. */
export interface CompactVerdict {
  /** The pool judged. Lowercased 0x-address; the on-chain mapping key. */
  poolAddress: `0x${string}`;
  rating: Rating;
  /** `RATING_CODES[rating]`. Carried so the encoder never has to look it up twice. */
  ratingCode: number;
  /** Confidence in basis points, 0..10000. */
  confidenceBp: number;
  /** Bit i set when `SIGNAL_BITS[i]` returned `fail`. */
  failMask: number;
  /** Bit i set when `SIGNAL_BITS[i]` returned `warn`. */
  warnMask: number;
  /** `input.now` — the instant the evidence describes, not the instant of the write. */
  assessedAt: number;
  /** keccak256 over the exact evidence bytes the enclave received. */
  evidenceHash: `0x${string}`;
}

/** The ABI shape. One string, so the encoder and the Solidity side cannot drift. */
export const VERDICT_ABI_PARAMS =
  'address pool, uint8 rating, uint16 confidenceBp, uint8 failMask, uint8 warnMask, uint64 assessedAt, bytes32 evidenceHash';

function maskOf(signals: Signal[], want: 'fail' | 'warn'): number {
  let mask = 0;
  for (const signal of signals) {
    const bit = SIGNAL_BITS.indexOf(signal.id as SignalId);
    // An unknown id means someone added a signal without adding a bit. Skipping
    // it silently would ship a verdict whose mask understates the failures, so
    // this is deliberately loud.
    if (bit === -1) throw new Error(`signal '${signal.id}' has no bit in SIGNAL_BITS`);
    if (signal.verdict === want) mask |= 1 << bit;
  }
  return mask;
}

/**
 * Reduce a full verdict to the part that may cross the boundary.
 *
 * Note what is dropped: every `headline`, every `reasoning`, every `evidence`
 * map, the summary paragraph, the caveats, the provenance. Those are the
 * answer the buyer paid for. What survives is a claim plus a commitment to the
 * evidence behind it.
 */
export function compact(verdict: Verdict, evidenceHash: `0x${string}`, assessedAt: number): CompactVerdict {
  const confidenceBp = Math.max(0, Math.min(10_000, Math.round(verdict.confidence * 10_000)));
  return {
    poolAddress: verdict.poolAddress.toLowerCase() as `0x${string}`,
    rating: verdict.rating,
    ratingCode: RATING_CODES[verdict.rating],
    confidenceBp,
    failMask: maskOf(verdict.signals, 'fail'),
    warnMask: maskOf(verdict.signals, 'warn'),
    assessedAt,
    evidenceHash,
  };
}

/** ABI-encode for `writeReport`. The bytes the DON signs. */
export function encodeVerdictReport(v: CompactVerdict): `0x${string}` {
  return encodeAbiParameters(parseAbiParameters(VERDICT_ABI_PARAMS), [
    v.poolAddress,
    v.ratingCode,
    v.confidenceBp,
    v.failMask,
    v.warnMask,
    BigInt(v.assessedAt),
    v.evidenceHash,
  ]);
}

/** The inverse, for tests and for reading a settled verdict back off chain. */
export function decodeVerdictReport(encoded: `0x${string}`): CompactVerdict {
  const [pool, ratingCode, confidenceBp, failMask, warnMask, assessedAt, evidenceHash] =
    decodeAbiParameters(parseAbiParameters(VERDICT_ABI_PARAMS), encoded);
  const rating = RATING_NAMES[ratingCode];
  if (rating === undefined) throw new Error(`rating code ${ratingCode} is not a rating`);
  return {
    poolAddress: pool.toLowerCase() as `0x${string}`,
    rating,
    ratingCode,
    confidenceBp,
    failMask,
    warnMask,
    assessedAt: Number(assessedAt),
    evidenceHash,
  };
}

/** Signal ids set in a mask. The human-readable half of a settled verdict. */
export function signalsInMask(mask: number): SignalId[] {
  return SIGNAL_BITS.filter((_, bit) => (mask & (1 << bit)) !== 0);
}

/**
 * One line describing a compact verdict, for logs and for the premium
 * response. Says nothing the on-chain record does not already say.
 */
export function describeCompact(v: CompactVerdict): string {
  const fails = signalsInMask(v.failMask);
  const warns = signalsInMask(v.warnMask);
  const parts = [`${v.rating} at ${(v.confidenceBp / 100).toFixed(0)}% confidence`];
  if (fails.length > 0) parts.push(`failing ${fails.join(', ')}`);
  if (warns.length > 0) parts.push(`warning on ${warns.join(', ')}`);
  return parts.join('; ');
}
