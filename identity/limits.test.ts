import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LISTINGS_PER_HUMAN, listingAllowance } from './limits.ts';

test('a verified human may publish up to the limit', () => {
  for (let used = 0; used < LISTINGS_PER_HUMAN; used += 1) {
    const allowance = listingAllowance(used);
    assert.equal(allowance.allowed, true, `listing ${used + 1} should be allowed`);
    assert.equal(allowance.remaining, LISTINGS_PER_HUMAN - used);
  }
});

test('the fourth listing is refused, and says which limit it hit', () => {
  const allowance = listingAllowance(LISTINGS_PER_HUMAN);
  assert.equal(allowance.allowed, false);
  assert.equal(allowance.code, 'listing_limit_reached');
  assert.equal(allowance.remaining, 0);
  assert.match(allowance.detail ?? '', /3 of 3/);
});

test('an unverified operator is refused rather than waved through', () => {
  // The failure mode this pins: treating "no proof on file" as "zero listings
  // used" and therefore allowing it. That inverts the control — an operator
  // with no proof would get an unlimited allowance by never verifying.
  const allowance = listingAllowance(0, { verified: false });
  assert.equal(allowance.allowed, false);
  assert.equal(allowance.code, 'operator_not_verified');
});

test('being over the limit stays refused rather than going negative', () => {
  const allowance = listingAllowance(9);
  assert.equal(allowance.allowed, false);
  assert.equal(allowance.remaining, 0);
});

test('a custom limit is honoured, and a nonsensical one is refused loudly', () => {
  assert.equal(listingAllowance(1, { limit: 1 }).allowed, false);
  assert.equal(listingAllowance(0, { limit: 1 }).allowed, true);
  assert.throws(() => listingAllowance(0, { limit: 0 }), /positive integer/);
  assert.throws(() => listingAllowance(-1), /non-negative/);
});
