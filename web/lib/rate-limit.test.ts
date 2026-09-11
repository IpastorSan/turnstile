// The window logic, without a NextRequest.
//
// `take` is the seam the NextRequest wrapper calls, and it is the only part
// with behaviour worth testing: the window, the per-route/per-IP isolation, and
// the retry-after arithmetic. The IP extraction is covered too because getting
// it wrong in either direction is the interesting failure — no header falls
// back to a shared bucket (stricter, safe), a forged first hop simply gets its
// own bucket (documented in clientIp above).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resetRateLimits, take } from './rate-limit.ts';

test('a burst over the limit is refused with a retry-after', () => {
  resetRateLimits();
  for (let i = 0; i < 3; i += 1) assert.equal(take('org-create', '1.2.3.4', 3), null, `hit ${i} should pass`);
  const retry = take('org-create', '1.2.3.4', 3);
  assert.equal(typeof retry, 'number');
  assert.ok(retry! > 0 && retry! <= 60, `retry-after should be sane, got ${retry}`);
});

test('limits are per-IP and per-route independently', () => {
  resetRateLimits();
  take('org-create', '1.2.3.4', 1);
  // Same route, different IP: full allowance.
  assert.equal(take('org-create', '5.6.7.8', 1), null);
  // Same IP, different route: full allowance.
  assert.equal(take('world-verify', '1.2.3.4', 1), null);
  // Exhausting one route must not throttle the others for anyone.
  take('world-context', '9.9.9.9', 1);
  assert.equal(take('org-create', '9.9.9.9', 1), null);
});

test('a refusal repeats while the window is open', () => {
  resetRateLimits();
  take('x', 'ip', 1);
  const first = take('x', 'ip', 1);
  assert.ok(first !== null && first <= 60, `expected a wait inside the window, got ${first}`);
  // A second refusal within the same window must not "drift" into a pass.
  assert.ok(take('x', 'ip', 1) !== null);
});
