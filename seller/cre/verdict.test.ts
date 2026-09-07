// The codec is the one thing on both sides of the enclave boundary AND both
// sides of the chain boundary: the workflow encodes with it inside the TEE,
// VerdictConsumer.sol decodes the result, and premium.ts reads it back. A drift
// here does not fail loudly — it silently reports the wrong signals as having
// failed. So these tests pin the bit order and the round trip rather than the
// pretty-printing.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { keccak256, toHex } from 'viem';
import { assess, type Calibration } from '../analyst/scoring.ts';
import type { AnalystInput, Signal, Verdict } from '../analyst/types.ts';
import {
  compact,
  decodeVerdictReport,
  describeCompact,
  encodeVerdictReport,
  RATING_CODES,
  signalsInMask,
  SIGNAL_BITS,
} from './verdict.ts';

const HASH = '0x60caa3841046ee545a5a91881ba92e5ce201a49048f3d3ec08ad5369c2bd02c2' as const;

function signal(id: string, verdict: Signal['verdict']): Signal {
  return { id, label: id, verdict, structural: false, headline: '', evidence: {}, reasoning: '' };
}

function verdictWith(signals: Signal[], overrides: Partial<Verdict> = {}): Verdict {
  return {
    pool: 'Test pool',
    poolAddress: '0x88E6A0C2DDD26FEEB64F039A2C41296FCB3F5640',
    rating: 'CAUTION',
    confidence: 0.75,
    summary: '',
    signals,
    provenance: {
      subgraph: '',
      subgraphTransport: 'http',
      subgraphBlock: 0,
      subgraphLagSeconds: 0,
      depthProvider: null,
      depthBlock: null,
      assessedAt: 0,
    },
    caveats: [],
    ...overrides,
  };
}

test('the bit order is frozen — it is part of the on-chain encoding', () => {
  // Reordering these is a breaking change that no type checker catches: the
  // masks still encode, they just mean something else on chain.
  assert.deepEqual(SIGNAL_BITS, [
    'inventory-balance',
    'executable-depth',
    'depth-vs-tvl',
    'slippage-curve',
    'fee-return',
    'activity-continuity',
    'lp-concentration',
  ]);
});

test('INSUFFICIENT_DATA sorts above AVOID, so a missing measurement cannot pass for a mild one', () => {
  assert.ok(RATING_CODES.INSUFFICIENT_DATA > RATING_CODES.AVOID);
  assert.ok(RATING_CODES.AVOID > RATING_CODES.CAUTION);
  assert.ok(RATING_CODES.CAUTION > RATING_CODES.ACCEPTABLE);
});

test('fail and warn land in separate masks', () => {
  const v = verdictWith([
    signal('inventory-balance', 'fail'),
    signal('executable-depth', 'pass'),
    signal('depth-vs-tvl', 'warn'),
    signal('slippage-curve', 'warn'),
    signal('fee-return', 'unknown'),
    signal('activity-continuity', 'pass'),
    signal('lp-concentration', 'fail'),
  ]);
  const c = compact(v, HASH, 1_757_260_000);

  assert.equal(c.failMask, 0b1000001);
  assert.equal(c.warnMask, 0b0001100);
  assert.deepEqual(signalsInMask(c.failMask), ['inventory-balance', 'lp-concentration']);
  assert.deepEqual(signalsInMask(c.warnMask), ['depth-vs-tvl', 'slippage-curve']);
});

test("an 'unknown' signal sets no bit — absence of evidence is not evidence of failure", () => {
  const c = compact(verdictWith([signal('executable-depth', 'unknown')]), HASH, 1);
  assert.equal(c.failMask, 0);
  assert.equal(c.warnMask, 0);
});

test('a signal with no bit throws rather than encoding a mask that understates the failures', () => {
  assert.throws(
    () => compact(verdictWith([signal('some-new-signal', 'fail')]), HASH, 1),
    /has no bit in SIGNAL_BITS/,
  );
});

test('the report round-trips through its own codec', () => {
  const c = compact(
    verdictWith([signal('depth-vs-tvl', 'warn'), signal('slippage-curve', 'warn')], {
      rating: 'CAUTION',
      confidence: 0.75,
    }),
    HASH,
    1_757_260_000,
  );
  assert.deepEqual(decodeVerdictReport(encodeVerdictReport(c)), c);
});

test('the pool address is lowercased, because it is a mapping key on both sides', () => {
  const c = compact(verdictWith([]), HASH, 1);
  assert.equal(c.poolAddress, '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640');
});

test('confidence is clamped into basis points rather than overflowing uint16', () => {
  assert.equal(compact(verdictWith([], { confidence: 1 }), HASH, 1).confidenceBp, 10_000);
  assert.equal(compact(verdictWith([], { confidence: 0 }), HASH, 1).confidenceBp, 0);
  // Not reachable from assess(), but the encoder must not be the thing that
  // discovers it: 1.5 * 10000 would silently wrap in a uint16.
  assert.equal(compact(verdictWith([], { confidence: 1.5 }), HASH, 1).confidenceBp, 10_000);
  assert.equal(compact(verdictWith([], { confidence: -0.2 }), HASH, 1).confidenceBp, 0);
});

test('describeCompact says nothing the on-chain record does not already say', () => {
  const c = compact(
    verdictWith([signal('inventory-balance', 'fail'), signal('fee-return', 'warn')], { rating: 'AVOID', confidence: 0.14 }),
    HASH,
    1,
  );
  assert.equal(
    describeCompact(c),
    'AVOID at 14% confidence; failing inventory-balance; warning on fee-return',
  );
});

// --- the property the whole attestation argument rests on -------------------

const FIXTURE = join(import.meta.dirname, 'fixtures', 'usdc-weth-500.json');
const CALIBRATION: Partial<Calibration> = {
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

test('the enclave verdict reproduces exactly outside the enclave', () => {
  // This is the claim an attested verdict makes, and it is only worth anything
  // if it is true: same bytes in, same verdict out, on any machine. The values
  // below are what `cre workflow simulate` printed from inside the TEE on
  // 2026-09-07 — copied from that terminal output, not from a run of this code.
  const body = readFileSync(FIXTURE, 'utf8');
  const input = JSON.parse(body) as AnalystInput;

  assert.equal(keccak256(toHex(body)), HASH);

  const c = compact(assess(input, CALIBRATION), HASH, input.now);
  assert.equal(c.rating, 'CAUTION');
  assert.equal(c.confidenceBp, 7500);
  assert.equal(c.failMask, 0);
  assert.equal(c.warnMask, 0b0001100);
  assert.deepEqual(signalsInMask(c.warnMask), ['depth-vs-tvl', 'slippage-curve']);
});

test('the sealed calibration is what makes the premium verdict different', () => {
  // If these agreed, the Vault secret would be decoration. The public scorer
  // calls this pool ACCEPTABLE; the seller's calibration calls it CAUTION, and
  // that gap is the thing being sold.
  const input = JSON.parse(readFileSync(FIXTURE, 'utf8')) as AnalystInput;
  assert.equal(assess(input).rating, 'ACCEPTABLE');
  assert.equal(assess(input, CALIBRATION).rating, 'CAUTION');
});

test('a null calibration is the public one, so a Vault outage degrades rather than lies', () => {
  const input = JSON.parse(readFileSync(FIXTURE, 'utf8')) as AnalystInput;
  assert.deepEqual(assess(input, null), assess(input));
  assert.deepEqual(assess(input, {}), assess(input));
});

test('the commitment is to bytes, and formatting is a byte difference', () => {
  // The chain commits to bytes, not to a data structure. `AnalystInput` happens
  // to round-trip byte-identically through JSON — MOV-216 measured that, and it
  // still holds here — which is *why* passing the bundle through the enclave
  // boundary is lossless. But that is a property of this data, not a guarantee,
  // and any reformatting is a different commitment. So both halves are pinned:
  // the round trip is stable, and a pretty-print is not the same bundle.
  const body = readFileSync(FIXTURE, 'utf8');
  const parsed = JSON.parse(body) as AnalystInput;

  assert.equal(keccak256(toHex(JSON.stringify(parsed))), keccak256(toHex(body)));
  assert.notEqual(keccak256(toHex(JSON.stringify(parsed, null, 2))), keccak256(toHex(body)));
});
