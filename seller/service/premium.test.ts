// The premium answer: what it returns, and what it says when the on-chain half
// does not back it up.
//
// Nothing here touches a chain. That is the point of the split — `premium.ts`
// takes an `AttestationReader` and reports what it gets, so a fake reader is a
// four-line function rather than a mock RPC client. The reader's own behaviour
// is tested in `seller/cre/attestation.test.ts`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Attestation, AttestationReader } from '../cre/attestation.ts';
import { DEMO_EVIDENCE_FILE as FIXTURE } from '../cre/evidence-server.ts';
import { answerPremium, PREMIUM_TIER } from './premium.ts';

const POOL = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640';
const HASH = '0x60caa3841046ee545a5a91881ba92e5ce201a49048f3d3ec08ad5369c2bd02c2';

/** The seller's tuned thresholds — the same nine the enclave applied. */
const CALIBRATION = {
  usableDepthSlippageCeiling: 0.005,
  retailSlippageWarn: 0.005,
  depthToTvlWarnShare: 0.02,
  slippageCliffMultiple: 12,
  feeApyWarnLow: 0.02,
  activeHourWarnShare: 0.6,
  activeHourFailShare: 0.25,
  lpCountWarn: 8,
  lagWarnSeconds: 10_800,
};

function reader(over: Partial<Attestation> = {}): AttestationReader {
  return async (pool, evidenceHash, answerRating) => ({
    strength: 'attested',
    note: 'test',
    explorer: 'https://example.invalid',
    rating: 'CAUTION',
    confidenceBp: 7500,
    failed: [],
    warned: ['depth-vs-tvl', 'slippage-curve'],
    assessedAt: 1_788_789_738,
    settledAt: 1_788_800_000,
    evidenceHash: evidenceHash as `0x${string}`,
    commitsToEvidence: true,
    agreesWithAnswer: answerRating === 'CAUTION',
    ...over,
    // Recorded so a test can assert the pool actually reached the reader.
    ...(pool === POOL ? {} : { note: `reader got the wrong pool: ${pool}` }),
  });
}

test('the product is the whole verdict, and the evidence it was scored on', async () => {
  const answer = await answerPremium({
    pool: POOL,
    evidenceFile: FIXTURE,
    calibration: CALIBRATION,
    attestations: reader(),
  });

  assert.equal(answer.tier, PREMIUM_TIER);
  assert.equal(answer.pool, POOL);
  assert.equal(answer.verdict.rating, 'CAUTION');
  assert.equal(answer.evidence.bytes, 9218);
  assert.equal(answer.evidence.hash, HASH);

  // Seven signals, each with its reasoning — this is what never goes on chain
  // and what the buyer is actually paying for.
  assert.equal(answer.verdict.signals.length, 7);
  assert.ok(answer.verdict.signals.every((s) => s.reasoning.length > 0));
  assert.ok(answer.rendered.includes('VERDICT'));

  assert.equal(answer.attestation?.strength, 'attested');
  assert.equal(answer.attestation?.note, 'test');
  assert.deepEqual(answer.caveats, []);
});

test('the sealed calibration is what makes this worth paying for', async () => {
  // Anyone can run the public scorer. The premium verdict differs, and that gap
  // is the product.
  const sealed = await answerPremium({ pool: POOL, evidenceFile: FIXTURE, calibration: CALIBRATION });
  const free = await answerPremium({ pool: POOL, evidenceFile: FIXTURE, calibration: null });
  assert.equal(sealed.verdict.rating, 'CAUTION');
  assert.equal(free.verdict.rating, 'ACCEPTABLE');
});

test('a disagreement with the settled verdict is surfaced, not smoothed over', async () => {
  const answer = await answerPremium({
    pool: POOL,
    evidenceFile: FIXTURE,
    // Public thresholds: ACCEPTABLE. The settled record says CAUTION.
    calibration: null,
    attestations: reader(),
  });

  assert.equal(answer.verdict.rating, 'ACCEPTABLE');
  assert.equal(answer.attestation?.agreesWithAnswer, false);
  assert.ok(answer.caveats.some((c) => c.includes('settled verdict says CAUTION')));
});

test('a substituted bundle is called out, because that is the cheating this catches', async () => {
  const answer = await answerPremium({
    pool: POOL,
    evidenceFile: FIXTURE,
    calibration: CALIBRATION,
    attestations: reader({ commitsToEvidence: false }),
  });
  assert.ok(answer.caveats.some((c) => c.includes('commits to different evidence')));
});

test('nothing settled leaves the answer standing on the seller\'s word, and says so', async () => {
  const answer = await answerPremium({
    pool: POOL,
    evidenceFile: FIXTURE,
    calibration: CALIBRATION,
    attestations: reader({ strength: 'none', commitsToEvidence: false, agreesWithAnswer: false }),
  });
  assert.ok(answer.caveats.some((c) => c.includes("seller's word alone")));
  // And not also the substitution caveat — one problem, one sentence.
  assert.ok(!answer.caveats.some((c) => c.includes('commits to different evidence')));
});

test('no reader at all is a caveat rather than a silent omission', async () => {
  const answer = await answerPremium({ pool: POOL, evidenceFile: FIXTURE });
  assert.equal(answer.attestation, null);
  assert.ok(answer.caveats.some((c) => c.includes('No attestation source configured')));
});

test('the pool the reader is asked about is the one the bundle describes', async () => {
  // `--pool` is ignored when a bundle is pinned, because the bundle names its
  // own pool and trusting the flag would let a caller ask for a verdict on one
  // pool and get another's.
  const answer = await answerPremium({
    pool: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    evidenceFile: FIXTURE,
    calibration: CALIBRATION,
    attestations: reader(),
  });
  assert.equal(answer.pool, POOL);
  assert.equal(answer.attestation?.note, 'test');
});
