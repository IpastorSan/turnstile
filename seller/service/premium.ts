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
//      a Chainlink CRE confidential workflow: rating, confidence, two signal
//      masks, and keccak256 over the evidence.
//
// The second is what makes the first worth buying from a stranger. An analyst
// you have never met asserting AVOID is a claim; an attested Nitro enclave
// asserting AVOID over evidence you can hash yourself is a fact. So this module
// does the buyer's verification *for* them and reports the result honestly,
// including — especially including — when the answer is "this is not attested
// yet, and here is exactly why".
//
// ── The seam MOV-219 plugs into ────────────────────────────────────────────
//
// `rails/PaymentRail.ts` does not exist on `dev` at the time of writing, so
// nothing here imports it. The join is deliberately one function:
//
//   answerPremium(options) -> PremiumAnswer
//
// A rail calls it *after* it has verified payment and passes the result into
// its own receipt. Nothing in here checks payment, quotes a price, or knows what
// a rail is — which is what makes it usable from x402 on Hedera and from Arc
// USDC without either of them learning about the other. See `PREMIUM_TIER`
// below for the tier name to match on.

import { readFile } from 'node:fs/promises';
import { createPublicClient, http, keccak256, toHex, type Address, type PublicClient } from 'viem';
import { sepolia } from 'viem/chains';
import { analyzePool, gatherInput, renderVerdict, type AnalyzeOptions } from '../analyst/analyst.ts';
import { assess, type Calibration } from '../analyst/scoring.ts';
import type { AnalystInput, Verdict } from '../analyst/types.ts';
import { RATING_NAMES, signalsInMask, type SignalId } from '../cre/verdict.ts';

/** The tier name. Exported so a rail matches on a constant rather than a string literal. */
export const PREMIUM_TIER = 'premium' as const;

/**
 * The CRE Forwarder on Sepolia.
 *
 * A verdict is only attested if the consumer holding it will accept reports
 * from *this* address and nothing else. A consumer whose forwarder is anything
 * else is holding data somebody delivered by hand, which may be perfectly
 * correct and is not the same claim at all.
 */
export const SEPOLIA_CRE_FORWARDER = '0xF8344CFd5c43616a4366C34E3EEE75af79a74482' as const;

const CONSUMER_ABI = [
  {
    type: 'function',
    name: 'verdictOf',
    stateMutability: 'view',
    inputs: [{ name: 'pool', type: 'address' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'rating', type: 'uint8' },
          { name: 'confidenceBp', type: 'uint16' },
          { name: 'failMask', type: 'uint8' },
          { name: 'warnMask', type: 'uint8' },
          { name: 'assessedAt', type: 'uint64' },
          { name: 'evidenceHash', type: 'bytes32' },
          { name: 'settledAt', type: 'uint64' },
        ],
      },
    ],
  },
  { type: 'function', name: 'hasVerdict', stateMutability: 'view', inputs: [{ name: 'pool', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'forwarder', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'verdictsAreGated', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
] as const;

/** How much the on-chain record can be trusted, and why. Never a bare boolean. */
export type AttestationStrength =
  /** Delivered by the CRE Forwarder from a pinned workflow. The full claim. */
  | 'attested'
  /** Delivered by the CRE Forwarder, but the consumer accepts any workflow. */
  | 'forwarded-ungated'
  /** The consumer's forwarder is not the CRE Forwarder. Somebody delivered this by hand. */
  | 'self-delivered'
  /** Nothing has settled for this pool. */
  | 'none';

export interface PremiumAttestation {
  chainId: number;
  consumer: Address;
  explorer: string;
  strength: AttestationStrength;
  /** One sentence a buyer can act on, stating what this is and is not. */
  note: string;
  rating: (typeof RATING_NAMES)[number];
  confidenceBp: number;
  failed: SignalId[];
  warned: SignalId[];
  /** Unix seconds the evidence describes. */
  assessedAt: number;
  /** Unix seconds the report landed on chain. Later than `assessedAt`, by however long the DON took. */
  settledAt: number;
  evidenceHash: `0x${string}`;
  /**
   * Does the chain commit to the evidence bundle in this response?
   *
   * This is the buyer's check, run on their behalf. `false` means the seller
   * handed over a different bundle from the one that was scored, which is the
   * one form of cheating the on-chain record exists to catch.
   */
  commitsToEvidence: boolean;
  /** Does the settled rating match the verdict in this response? */
  agreesWithAnswer: boolean;
}

export interface PremiumAnswer {
  tier: typeof PREMIUM_TIER;
  pool: `0x${string}`;
  poolName: string;
  /** The product. Everything the buyer paid for. */
  verdict: Verdict;
  /** The same thing, rendered for a human. */
  rendered: string;
  evidence: {
    /** The exact bytes the enclave scored, as served. */
    bytes: number;
    hash: `0x${string}`;
    /** The bundle itself, so the buyer can hash it and check the chain unaided. */
    input: AnalystInput;
  };
  /** `null` when no consumer was configured — not when nothing settled. */
  attestation: PremiumAttestation | null;
  /** Anything the buyer needs to know that the fields above do not say. */
  caveats: string[];
}

export interface PremiumOptions {
  /** The pool to judge. */
  pool: string;
  /**
   * Score this exact bundle instead of gathering a fresh one.
   *
   * The premium path prefers a *pinned* bundle, because the on-chain verdict
   * commits to specific bytes — re-gathering would produce a different hash and
   * the buyer's check would fail through no fault of anyone's.
   */
  evidenceFile?: string;
  /** Overrides onto the public thresholds. In production this only exists inside the enclave. */
  calibration?: Partial<Calibration> | null;
  /** Where the attested verdict settles. Omit to skip the on-chain half entirely. */
  consumer?: Address;
  rpcUrl?: string;
  /** Injectable for tests. */
  client?: PublicClient;
  /** Passed through to `gatherInput` when no `evidenceFile` is given. */
  analyze?: Omit<AnalyzeOptions, 'pool'>;
}

function noteFor(strength: AttestationStrength, consumer: Address): string {
  switch (strength) {
    case 'attested':
      return (
        'Delivered by the Chainlink CRE Forwarder from a pinned workflow id, so this rating was '
        + 'produced inside an attested AWS Nitro enclave over the evidence hashed above.'
      );
    case 'forwarded-ungated':
      return (
        'Delivered by the Chainlink CRE Forwarder, so it came from a workflow the DON signed for — '
        + `but ${consumer} does not pin a workflow id yet, so it would accept a report from any `
        + 'workflow this owner deploys. Weaker than attested, stronger than a signature.'
      );
    case 'self-delivered':
      return (
        `${consumer} does not accept reports from the CRE Forwarder, so this record was delivered `
        + 'by hand. It demonstrates the encoding and the evidence commitment and it proves nothing '
        + 'about attestation. Do not treat it as an enclave result.'
      );
    case 'none':
      return 'No verdict has settled on chain for this pool. The answer above is unattested.';
  }
}

/**
 * Read the settled verdict for a pool, and say plainly how much it is worth.
 *
 * Returns `null` only when there is no consumer to ask. A consumer that holds
 * nothing returns a `strength: 'none'` attestation rather than `null`, because
 * "we looked and there is nothing" and "we did not look" are different answers
 * and a buyer needs to tell them apart.
 */
export async function fetchAttestation(
  client: PublicClient,
  consumer: Address,
  pool: `0x${string}`,
  evidenceHash: `0x${string}`,
  answerRating: string,
): Promise<PremiumAttestation> {
  const [forwarder, gated, has] = await Promise.all([
    client.readContract({ address: consumer, abi: CONSUMER_ABI, functionName: 'forwarder' }),
    client.readContract({ address: consumer, abi: CONSUMER_ABI, functionName: 'verdictsAreGated' }),
    client.readContract({ address: consumer, abi: CONSUMER_ABI, functionName: 'hasVerdict', args: [pool] }),
  ]);

  const isForwarder = forwarder.toLowerCase() === (SEPOLIA_CRE_FORWARDER as string).toLowerCase();
  const chainId = await client.getChainId();
  const explorer = `https://sepolia.etherscan.io/address/${consumer}`;

  if (!has) {
    return {
      chainId,
      consumer,
      explorer,
      strength: 'none',
      note: noteFor('none', consumer),
      rating: 'INSUFFICIENT_DATA',
      confidenceBp: 0,
      failed: [],
      warned: [],
      assessedAt: 0,
      settledAt: 0,
      evidenceHash: `0x${'0'.repeat(64)}`,
      commitsToEvidence: false,
      agreesWithAnswer: false,
    };
  }

  const stored = await client.readContract({
    address: consumer,
    abi: CONSUMER_ABI,
    functionName: 'verdictOf',
    args: [pool],
  });

  const strength: AttestationStrength = !isForwarder
    ? 'self-delivered'
    : gated
      ? 'attested'
      : 'forwarded-ungated';

  const rating = RATING_NAMES[stored.rating] ?? 'INSUFFICIENT_DATA';

  return {
    chainId,
    consumer,
    explorer,
    strength,
    note: noteFor(strength, consumer),
    rating,
    confidenceBp: stored.confidenceBp,
    failed: signalsInMask(stored.failMask),
    warned: signalsInMask(stored.warnMask),
    assessedAt: Number(stored.assessedAt),
    settledAt: Number(stored.settledAt),
    evidenceHash: stored.evidenceHash,
    commitsToEvidence: stored.evidenceHash === evidenceHash,
    agreesWithAnswer: rating === answerRating,
  };
}

/**
 * The premium answer.
 *
 * Call this only after payment is settled — it does not check, and it is not
 * this module's job to. See the seam note at the top of the file.
 */
export async function answerPremium(options: PremiumOptions): Promise<PremiumAnswer> {
  const caveats: string[] = [];

  let input: AnalystInput;
  let evidenceBytes: number;
  let evidenceHash: `0x${string}`;

  if (options.evidenceFile) {
    // Read as bytes and hash *those*, never a re-serialization. The on-chain
    // record commits to the exact bytes the enclave received, and JSON
    // round-tripping reorders nothing today and something tomorrow.
    const raw = await readFile(options.evidenceFile);
    const body = raw.toString('utf8');
    input = JSON.parse(body) as AnalystInput;
    evidenceBytes = raw.length;
    evidenceHash = keccak256(toHex(body));
  } else {
    input = await gatherInput({ pool: options.pool, ...options.analyze });
    const body = JSON.stringify(input);
    evidenceBytes = Buffer.byteLength(body, 'utf8');
    evidenceHash = keccak256(toHex(body));
    caveats.push(
      'Evidence was gathered fresh for this request rather than read from a pinned bundle, so its '
      + 'hash will not match a verdict settled from an earlier bundle. That is a mismatch of '
      + 'inputs, not a failed verification.',
    );
  }

  const verdict = assess(input, options.calibration);
  const pool = verdict.poolAddress.toLowerCase() as `0x${string}`;

  let attestation: PremiumAttestation | null = null;
  if (options.consumer) {
    const client =
      options.client
      ?? createPublicClient({
        chain: sepolia,
        transport: http(options.rpcUrl ?? process.env.SEPOLIA_RPC_URL),
      });
    attestation = await fetchAttestation(client, options.consumer, pool, evidenceHash, verdict.rating);

    if (attestation.strength === 'none') {
      caveats.push('Nothing has settled on chain for this pool, so the answer above stands on the seller\'s word alone.');
    } else if (!attestation.commitsToEvidence) {
      caveats.push(
        'The settled verdict commits to different evidence than the bundle in this response. Either '
        + 'they are different assessments, or the bundle was substituted — check `assessedAt` on both '
        + 'before trusting either.',
      );
    }
    if (attestation.strength !== 'none' && !attestation.agreesWithAnswer) {
      caveats.push(
        `The settled verdict says ${attestation.rating} and this answer says ${verdict.rating}. That `
        + 'happens when the two were scored with different calibrations; the on-chain one is the one '
        + 'produced inside the enclave.',
      );
    }
  } else {
    caveats.push('No VerdictConsumer configured, so this answer carries no on-chain pointer.');
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

/** Re-exported so a caller can get an unattested verdict without a second import. */
export { analyzePool };
