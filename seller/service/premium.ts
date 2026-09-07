// The premium tier: the answer, plus a pointer to the attested verdict.
//
// The free tier of a Turnstile seller is discovery — you can find the analyst,
// read its price and see what it claims to do. The premium tier is the thing
// itself, and it is two artefacts rather than one:
//
//   1. the full `Verdict` — seven signals, each with its headline, its
//      reasoning and its numbers, plus the summary and the caveats. This is
//      what the buyer is paying for and it never goes on chain.
//
//   2. a pointer to the on-chain record of the *same* verdict, produced inside
//      a Chainlink CRE confidential workflow.
//
// The second is what makes the first worth buying from a stranger. An analyst
// you have never met asserting AVOID is a claim; an attested enclave asserting
// AVOID over evidence you can hash yourself is a fact. So this module runs the
// buyer's verification *for* them and reports the result honestly — especially
// when the answer is "this is not attested, and here is exactly why".
//
// ── Why the chain is not in this file ──────────────────────────────────────
//
// `no-chain-code.test.ts` asserts that nothing on the payment path names a
// chain, a vendor, an asset or a chain library, and it is right to: the service
// composes rails, and the moment it knows what one of them is made of, the
// abstraction that lets two rails share it is gone.
//
// The same argument applies to the attestation. Everything that knows about
// `VerdictConsumer`, the CRE Forwarder and an RPC endpoint lives in
// `seller/cre/attestation.ts`; this file takes an `AttestationReader`, gets back
// an `Attestation`, and reports its `strength` verbatim without interpreting it.
// A caller who wants no on-chain half passes no reader.
//
// ── The seam ───────────────────────────────────────────────────────────────
//
// The join to `rails/PaymentRail.ts` is one function:
//
//   answerPremium(options) -> PremiumAnswer
//
// A rail calls it *after* it has verified payment and puts the result in its own
// receipt. Nothing here checks payment, quotes a price, or knows what a rail is.
// `PREMIUM_TIER` is exported so a rail matches on a constant.

import { gatherInput, renderVerdict, type AnalyzeOptions } from '../analyst/analyst.ts';
import { assess, type Calibration } from '../analyst/scoring.ts';
import type { AnalystInput, Verdict } from '../analyst/types.ts';
import type { Attestation, AttestationReader } from '../cre/attestation.ts';
import { hashEvidence, readEvidenceFile } from '../cre/evidence-server.ts';

/** The tier name. Exported so a rail matches on a constant rather than a string literal. */
export const PREMIUM_TIER = 'premium' as const;

export type { Attestation, AttestationReader };

export interface PremiumAnswer {
  tier: typeof PREMIUM_TIER;
  pool: string;
  poolName: string;
  /** The product. Everything the buyer paid for. */
  verdict: Verdict;
  /** The same thing, rendered for a human. */
  rendered: string;
  evidence: {
    /** The exact bytes the enclave scored, as served. */
    bytes: number;
    hash: string;
    /** The bundle itself, so the buyer can hash it and check the record unaided. */
    input: AnalystInput;
  };
  /** `null` when no reader was supplied — not when nothing had settled. */
  attestation: Attestation | null;
  /** Anything the buyer needs to know that the fields above do not say. */
  caveats: string[];
}

export interface PremiumOptions {
  /** The pool to judge. Ignored when `evidenceFile` is given — the bundle names its own. */
  pool: string;
  /**
   * Score this exact bundle instead of gathering a fresh one.
   *
   * The premium path prefers a *pinned* bundle, because the settled verdict
   * commits to specific bytes — re-gathering produces a different hash and the
   * buyer's check fails through nobody's fault.
   */
  evidenceFile?: string;
  /** Overrides onto the public thresholds. In production this only exists inside the enclave. */
  calibration?: Partial<Calibration> | null;
  /** Omit to skip the attested half entirely. */
  attestations?: AttestationReader;
  /** Passed through to `gatherInput` when no `evidenceFile` is given. */
  analyze?: Omit<AnalyzeOptions, 'pool'>;
}

/**
 * The premium answer.
 *
 * Call this only after payment is settled — it does not check, and it is not
 * this module's job to.
 */
export async function answerPremium(options: PremiumOptions): Promise<PremiumAnswer> {
  const caveats: string[] = [];

  let input: AnalystInput;
  let evidenceBytes: number;
  let evidenceHash: string;

  if (options.evidenceFile) {
    const bundle = await readEvidenceFile(options.evidenceFile);
    input = bundle.input;
    evidenceBytes = bundle.bytes.length;
    evidenceHash = bundle.hash;
  } else {
    input = await gatherInput({ pool: options.pool, ...options.analyze });
    const body = JSON.stringify(input);
    evidenceBytes = Buffer.byteLength(body, 'utf8');
    evidenceHash = hashEvidence(body);
    caveats.push(
      'Evidence was gathered fresh for this request rather than read from a pinned bundle, so its '
      + 'hash will not match a verdict settled from an earlier bundle. That is a mismatch of '
      + 'inputs, not a failed verification.',
    );
  }

  const verdict = assess(input, options.calibration);
  const pool = verdict.poolAddress.toLowerCase();

  let attestation: Attestation | null = null;
  if (options.attestations) {
    attestation = await options.attestations(pool, evidenceHash, verdict.rating);

    if (attestation.strength === 'none') {
      caveats.push("Nothing has settled on chain for this pool, so the answer above stands on the seller's word alone.");
    } else if (!attestation.commitsToEvidence) {
      caveats.push(
        'The settled verdict commits to different evidence than the bundle in this response. Either '
        + 'they are different assessments, or the bundle was substituted — compare `assessedAt` on '
        + 'both before trusting either.',
      );
    }
    if (attestation.strength !== 'none' && !attestation.agreesWithAnswer) {
      caveats.push(
        `The settled verdict says ${attestation.rating} and this answer says ${verdict.rating}. That `
        + 'happens when the two were scored with different calibrations; the settled one is the one '
        + 'produced inside the enclave.',
      );
    }
  } else {
    caveats.push('No attestation source configured, so this answer carries no on-chain pointer.');
  }

  return {
    tier: PREMIUM_TIER,
    pool,
    poolName: verdict.pool,
    verdict,
    rendered: renderVerdict(verdict),
    evidence: { bytes: evidenceBytes, hash: evidenceHash, input },
    attestation,
    caveats,
  };
}
