// What the premium tier claims about an on-chain verdict, and what it refuses
// to claim.
//
// Every test here is about honesty rather than about mechanism. The mechanism
// is a contract read; the thing that can go wrong is reporting a record as
// attested when it is not, and the whole tier is worthless the first time it
// does that.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Address, PublicClient } from 'viem';
import { answerPremium, fetchAttestation, PREMIUM_TIER, SEPOLIA_CRE_FORWARDER } from './premium.ts';

const FIXTURE = join(import.meta.dirname, '..', 'cre', 'fixtures', 'usdc-weth-500.json');
const POOL = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640' as const;
const HASH = '0x60caa3841046ee545a5a91881ba92e5ce201a49048f3d3ec08ad5369c2bd02c2' as const;
const CONSUMER = '0xEE72d3d0E4b090eBB8Db6abc26547bcd1fc9C5F2' as Address;

interface FakeState {
  forwarder: string;
  gated: boolean;
  has: boolean;
  rating?: number;
  confidenceBp?: number;
  failMask?: number;
  warnMask?: number;
  assessedAt?: bigint;
  evidenceHash?: string;
  settledAt?: bigint;
}

/** A `PublicClient` that answers only the four calls premium.ts makes. */
function fakeClient(state: FakeState): PublicClient {
  return {
    getChainId: async () => 11155111,
    readContract: async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case 'forwarder':
          return state.forwarder;
        case 'verdictsAreGated':
          return state.gated;
        case 'hasVerdict':
          return state.has;
        case 'verdictOf':
          return {
            rating: state.rating ?? 1,
            confidenceBp: state.confidenceBp ?? 7500,
            failMask: state.failMask ?? 0,
            warnMask: state.warnMask ?? 0b0001100,
            assessedAt: state.assessedAt ?? 1_788_789_738n,
            evidenceHash: state.evidenceHash ?? HASH,
            settledAt: state.settledAt ?? 1_788_800_000n,
          };
        default:
          throw new Error(`unexpected call ${functionName}`);
      }
    },
  } as unknown as PublicClient;
}

// --- how much a record is worth --------------------------------------------

test('a report from the CRE Forwarder into a pinned workflow is attested', async () => {
  const a = await fetchAttestation(
    fakeClient({ forwarder: SEPOLIA_CRE_FORWARDER, gated: true, has: true }),
    CONSUMER,
    POOL,
    HASH,
    'CAUTION',
  );
  assert.equal(a.strength, 'attested');
  assert.match(a.note, /attested AWS Nitro enclave/);
});

test('the CRE Forwarder without a pinned workflow is weaker, and says so', async () => {
  // The window between deploying the consumer and registering the workflow is
  // real, and reporting it as fully attested would be a lie of omission.
  const a = await fetchAttestation(
    fakeClient({ forwarder: SEPOLIA_CRE_FORWARDER, gated: false, has: true }),
    CONSUMER,
    POOL,
    HASH,
    'CAUTION',
  );
  assert.equal(a.strength, 'forwarded-ungated');
  assert.match(a.note, /does not pin a workflow id/);
});

test('a consumer whose forwarder is not the CRE Forwarder is never attested', async () => {
  // The rehearsal consumer. Everything it holds was delivered by hand, and this
  // is the check that stops that reading as an enclave result.
  const a = await fetchAttestation(
    fakeClient({ forwarder: '0x0Adca6e14bA956201D221feC767e4f24194bf5F2', gated: true, has: true }),
    CONSUMER,
    POOL,
    HASH,
    'CAUTION',
  );
  assert.equal(a.strength, 'self-delivered');
  assert.match(a.note, /delivered by hand/);
  assert.match(a.note, /proves nothing about attestation/);
});

test('an empty consumer answers "we looked and found nothing", not null', async () => {
  const a = await fetchAttestation(
    fakeClient({ forwarder: SEPOLIA_CRE_FORWARDER, gated: true, has: false }),
    CONSUMER,
    POOL,
    HASH,
    'CAUTION',
  );
  assert.equal(a.strength, 'none');
  assert.equal(a.commitsToEvidence, false);
  // Not ACCEPTABLE. A pool nobody judged must never read as a pool that passed.
  assert.equal(a.rating, 'INSUFFICIENT_DATA');
});

// --- the buyer's check, run for them ---------------------------------------

test('the evidence commitment is checked against the bundle actually handed over', async () => {
  const match = await fetchAttestation(
    fakeClient({ forwarder: SEPOLIA_CRE_FORWARDER, gated: true, has: true }),
    CONSUMER,
    POOL,
    HASH,
    'CAUTION',
  );
  assert.equal(match.commitsToEvidence, true);

  const substituted = await fetchAttestation(
    fakeClient({ forwarder: SEPOLIA_CRE_FORWARDER, gated: true, has: true, evidenceHash: `0x${'ab'.repeat(32)}` }),
    CONSUMER,
    POOL,
    HASH,
    'CAUTION',
  );
  assert.equal(substituted.commitsToEvidence, false);
});

test('the settled masks decode back into signal names', async () => {
  const a = await fetchAttestation(
    fakeClient({ forwarder: SEPOLIA_CRE_FORWARDER, gated: true, has: true, failMask: 0b1000001, warnMask: 0b0001100 }),
    CONSUMER,
    POOL,
    HASH,
    'CAUTION',
  );
  assert.deepEqual(a.failed, ['inventory-balance', 'lp-concentration']);
  assert.deepEqual(a.warned, ['depth-vs-tvl', 'slippage-curve']);
});

// --- the whole answer -------------------------------------------------------

test('a pinned bundle produces the verdict that is on chain, and says the two agree', async () => {
  const answer = await answerPremium({
    pool: POOL,
    evidenceFile: FIXTURE,
    calibration: {
      usableDepthSlippageCeiling: 0.005,
      retailSlippageWarn: 0.005,
      depthToTvlWarnShare: 0.02,
      slippageCliffMultiple: 12,
      feeApyWarnLow: 0.02,
      activeHourWarnShare: 0.6,
      activeHourFailShare: 0.25,
      lpCountWarn: 8,
      lagWarnSeconds: 10_800,
    },
    consumer: CONSUMER,
    client: fakeClient({ forwarder: SEPOLIA_CRE_FORWARDER, gated: true, has: true }),
  });

  assert.equal(answer.tier, PREMIUM_TIER);
  assert.equal(answer.pool, POOL);
  assert.equal(answer.verdict.rating, 'CAUTION');
  assert.equal(answer.evidence.bytes, 9218);
  assert.equal(answer.evidence.hash, HASH);
  assert.equal(answer.attestation?.strength, 'attested');
  assert.equal(answer.attestation?.commitsToEvidence, true);
  assert.equal(answer.attestation?.agreesWithAnswer, true);
  assert.deepEqual(answer.caveats, []);

  // The product is the whole verdict, not the compact one — that is what the
  // buyer is paying for and what never goes on chain.
  assert.equal(answer.verdict.signals.length, 7);
  assert.ok(answer.rendered.includes('VERDICT'));
  assert.ok(answer.verdict.signals.every((s) => s.reasoning.length > 0));
});

test('a disagreement between the answer and the chain is surfaced, not smoothed over', async () => {
  const answer = await answerPremium({
    pool: POOL,
    evidenceFile: FIXTURE,
    // Scored with the public thresholds: ACCEPTABLE. The chain says CAUTION.
    calibration: null,
    consumer: CONSUMER,
    client: fakeClient({ forwarder: SEPOLIA_CRE_FORWARDER, gated: true, has: true }),
  });

  assert.equal(answer.verdict.rating, 'ACCEPTABLE');
  assert.equal(answer.attestation?.agreesWithAnswer, false);
  assert.ok(answer.caveats.some((c) => c.includes('settled verdict says CAUTION')));
});

test('an empty consumer leaves the answer standing on the seller\'s word, and says that', async () => {
  const answer = await answerPremium({
    pool: POOL,
    evidenceFile: FIXTURE,
    consumer: CONSUMER,
    client: fakeClient({ forwarder: SEPOLIA_CRE_FORWARDER, gated: true, has: false }),
  });
  assert.ok(answer.caveats.some((c) => c.includes("seller's word alone")));
});

test('no consumer at all is a caveat rather than a silent omission', async () => {
  const answer = await answerPremium({ pool: POOL, evidenceFile: FIXTURE });
  assert.equal(answer.attestation, null);
  assert.ok(answer.caveats.some((c) => c.includes('No VerdictConsumer configured')));
});
