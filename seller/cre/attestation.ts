// Reading a settled verdict, and saying honestly how much it is worth.
//
// This lives in `seller/cre/` rather than in `seller/service/` for a reason
// worth stating, because the obvious place for it is next to its only caller.
// MOV-219's `seller/service/no-chain-code.test.ts` asserts that nothing on the
// payment path names a chain, a vendor, an asset or a chain library — and it is
// right to. The service composes rails; the moment it knows what Sepolia is,
// the abstraction that lets x402 and Arc share it is gone.
//
// So the split is: everything here knows about `VerdictConsumer`, the CRE
// Forwarder and a JSON-RPC endpoint, and `seller/service/premium.ts` knows only
// that it was handed an `AttestationReader` and got back an `Attestation` whose
// `strength` it reports verbatim. That is not a workaround for a lint rule. It
// is the same boundary the rule exists to defend, applied to a second kind of
// chain dependency the rule's author had not met yet.
//
// ── Why strength is four values ────────────────────────────────────────────
//
// A verdict on chain is only the claim "an attested enclave said this" when the
// consumer holding it will accept reports from the CRE Forwarder and from a
// pinned workflow. Every weaker configuration is a *different* claim, and
// collapsing them into `verified: true` is the one bug that would make the
// premium tier worthless — three of the four are not the claim being sold.

import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { sepolia } from 'viem/chains';
import { RATING_NAMES, signalsInMask, type SignalId } from './verdict.ts';

/**
 * The CRE Forwarder on Sepolia, from `~/.cre/context.yaml` (chain selector
 * 16015286601757825753) on 2026-09-07.
 *
 * A consumer whose `forwarder()` is anything else is holding data somebody
 * delivered by hand. That may be perfectly correct and it is not the same claim.
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
  /** Delivered by the CRE Forwarder, but the consumer accepts any of this owner's workflows. */
  | 'forwarded-ungated'
  /** The consumer's forwarder is not the CRE Forwarder. Somebody delivered this by hand. */
  | 'self-delivered'
  /** Nothing has settled for this pool. */
  | 'none';

export interface Attestation {
  strength: AttestationStrength;
  /** One sentence a buyer can act on, stating what this is and is not. */
  note: string;
  /** Where to go and look. */
  explorer: string;
  rating: (typeof RATING_NAMES)[number];
  confidenceBp: number;
  failed: SignalId[];
  warned: SignalId[];
  /** Unix seconds the evidence describes. */
  assessedAt: number;
  /** Unix seconds the report landed. Later than `assessedAt` by however long the DON took. */
  settledAt: number;
  evidenceHash: `0x${string}`;
  /**
   * Does the settled verdict commit to the evidence bundle the buyer was given?
   *
   * This is the buyer's own check. `false` means the seller handed over a
   * different bundle from the one that was scored — the one form of cheating
   * the on-chain record exists to catch.
   */
  commitsToEvidence: boolean;
  /** Does the settled rating match the verdict in the same response? */
  agreesWithAnswer: boolean;
}

/**
 * The whole interface `seller/service/` is allowed to know about.
 *
 * No addresses, no endpoints, no chain. A rail hands one of these to
 * `answerPremium()` and gets back something it reports rather than interprets.
 */
export type AttestationReader = (
  pool: string,
  evidenceHash: string,
  answerRating: string,
) => Promise<Attestation>;

function noteFor(strength: AttestationStrength, consumer: string): string {
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
 * Read the settled verdict for a pool.
 *
 * Always returns an `Attestation`. A consumer holding nothing answers
 * `strength: 'none'` rather than throwing or returning null, because "we looked
 * and there is nothing" and "we did not look" are different answers and a buyer
 * needs to be able to tell them apart.
 */
export async function readAttestation(
  client: PublicClient,
  consumer: Address,
  pool: string,
  evidenceHash: string,
  answerRating: string,
): Promise<Attestation> {
  const poolAddress = pool.toLowerCase() as Address;
  const [forwarder, gated, has] = await Promise.all([
    client.readContract({ address: consumer, abi: CONSUMER_ABI, functionName: 'forwarder' }),
    client.readContract({ address: consumer, abi: CONSUMER_ABI, functionName: 'verdictsAreGated' }),
    client.readContract({ address: consumer, abi: CONSUMER_ABI, functionName: 'hasVerdict', args: [poolAddress] }),
  ]);

  const explorer = `https://sepolia.etherscan.io/address/${consumer}`;

  if (!has) {
    return {
      strength: 'none',
      note: noteFor('none', consumer),
      explorer,
      // Not ACCEPTABLE. A pool nobody judged must never read as a pool that passed.
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
    args: [poolAddress],
  });

  const isForwarder = forwarder.toLowerCase() === (SEPOLIA_CRE_FORWARDER as string).toLowerCase();
  const strength: AttestationStrength = !isForwarder
    ? 'self-delivered'
    : gated
      ? 'attested'
      : 'forwarded-ungated';

  const rating = RATING_NAMES[stored.rating] ?? 'INSUFFICIENT_DATA';

  return {
    strength,
    note: noteFor(strength, consumer),
    explorer,
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

export interface ReaderOptions {
  consumer: Address;
  rpcUrl?: string;
  /** Injectable, for tests and for a caller that already has a client. */
  client?: PublicClient;
}

/** Bind a consumer and an endpoint into the chain-free interface the service takes. */
export function onChainAttestations(options: ReaderOptions): AttestationReader {
  const client =
    options.client
    ?? createPublicClient({
      chain: sepolia,
      transport: http(options.rpcUrl ?? process.env.SEPOLIA_RPC_URL),
    });
  return (pool, evidenceHash, answerRating) =>
    readAttestation(client, options.consumer, pool, evidenceHash, answerRating);
}
