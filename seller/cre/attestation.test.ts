// What a settled verdict is worth, and what it is not.
//
// Every test here is about honesty rather than about mechanism. The mechanism
// is three contract reads; the thing that can go wrong is reporting a record as
// attested when it is not, and the premium tier is worthless the first time it
// does that.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PublicClient } from 'viem';
import { readAttestation, SEPOLIA_CRE_FORWARDER } from './attestation.ts';

const POOL = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640' as const;
const HASH = '0x60caa3841046ee545a5a91881ba92e5ce201a49048f3d3ec08ad5369c2bd02c2' as const;
const CONSUMER = '0xEE72d3d0E4b090eBB8Db6abc26547bcd1fc9C5F2' as const;
const OUR_KEY = '0x0Adca6e14bA956201D221feC767e4f24194bf5F2' as const;

interface FakeState {
  forwarder: string;
  gated: boolean;
  has: boolean;
  rating?: number;
  failMask?: number;
  warnMask?: number;
  evidenceHash?: string;
}

/** A `PublicClient` that answers only the four calls `readAttestation` makes. */
function fakeClient(state: FakeState): PublicClient {
  return {
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
            confidenceBp: 7500,
            failMask: state.failMask ?? 0,
            warnMask: state.warnMask ?? 0b0001100,
            assessedAt: 1_788_789_738n,
            evidenceHash: state.evidenceHash ?? HASH,
            settledAt: 1_788_800_000n,
          };
        default:
          throw new Error(`unexpected call ${functionName}`);
      }
    },
  } as unknown as PublicClient;
}

const read = (state: FakeState) => readAttestation(fakeClient(state), CONSUMER, POOL, HASH, 'CAUTION');

test('the CRE Forwarder plus a pinned workflow is the full claim', async () => {
  const a = await read({ forwarder: SEPOLIA_CRE_FORWARDER, gated: true, has: true });
  assert.equal(a.strength, 'attested');
  assert.match(a.note, /attested AWS Nitro enclave/);
});

test('the CRE Forwarder without a pinned workflow is weaker, and says so', async () => {
  // The window between deploying the consumer and registering the workflow is
  // real — the workflow id does not exist until then — and reporting it as
  // fully attested would be a lie of omission.
  const a = await read({ forwarder: SEPOLIA_CRE_FORWARDER, gated: false, has: true });
  assert.equal(a.strength, 'forwarded-ungated');
  assert.match(a.note, /does not pin a workflow id/);
});

test('a consumer whose forwarder is not the CRE Forwarder is never attested', async () => {
  // The rehearsal consumer. Everything it holds was delivered by hand, and this
  // is the check that stops that reading as an enclave result.
  const a = await read({ forwarder: OUR_KEY, gated: true, has: true });
  assert.equal(a.strength, 'self-delivered');
  assert.match(a.note, /delivered by hand/);
  assert.match(a.note, /proves nothing about attestation/);
});

test('an empty consumer answers "we looked and found nothing"', async () => {
  const a = await read({ forwarder: SEPOLIA_CRE_FORWARDER, gated: true, has: false });
  assert.equal(a.strength, 'none');
  assert.equal(a.commitsToEvidence, false);
  // Not ACCEPTABLE. A pool nobody judged must never read as a pool that passed.
  assert.equal(a.rating, 'INSUFFICIENT_DATA');
});

test('the evidence commitment is checked against the bundle actually handed over', async () => {
  const match = await read({ forwarder: SEPOLIA_CRE_FORWARDER, gated: true, has: true });
  assert.equal(match.commitsToEvidence, true);

  const substituted = await read({
    forwarder: SEPOLIA_CRE_FORWARDER,
    gated: true,
    has: true,
    evidenceHash: `0x${'ab'.repeat(32)}`,
  });
  assert.equal(substituted.commitsToEvidence, false);
});

test('a settled rating that disagrees with the answer is reported, not smoothed over', async () => {
  const a = await read({ forwarder: SEPOLIA_CRE_FORWARDER, gated: true, has: true, rating: 2 });
  assert.equal(a.rating, 'AVOID');
  assert.equal(a.agreesWithAnswer, false);
});

test('the settled masks decode back into signal names', async () => {
  const a = await read({
    forwarder: SEPOLIA_CRE_FORWARDER,
    gated: true,
    has: true,
    failMask: 0b1000001,
    warnMask: 0b0001100,
  });
  assert.deepEqual(a.failed, ['inventory-balance', 'lp-concentration']);
  assert.deepEqual(a.warned, ['depth-vs-tvl', 'slippage-curve']);
});

test('the forwarder comparison is case-insensitive', async () => {
  // `forwarder()` comes back checksummed and the constant is checksummed too,
  // but a consumer deployed from a lowercased literal would otherwise read as
  // self-delivered — a false negative that quietly downgrades a real verdict.
  const a = await read({ forwarder: SEPOLIA_CRE_FORWARDER.toLowerCase(), gated: true, has: true });
  assert.equal(a.strength, 'attested');
});
