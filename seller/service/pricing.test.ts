// The seller's price comes from its records, and these are the ways that goes
// wrong (TUR-3). No network: the reader is a function the test controls, and the
// clock is a number.

import test from 'node:test';
import assert from 'node:assert/strict';

import { PriceBook } from './pricing.ts';
import type { PriceReader, PriceState } from './pricing.ts';
import { PREMIUM_MULTIPLE, PriceRecordError, parsePriceRecord, priceTiers, publishedPrice } from './tiers.ts';
import type { PriceRecords } from './tiers.ts';
import { RECORDED_PRICE_RECORDS } from './testing.ts';

/** A reader over mutable records that can be made to fail, and counts its calls. */
function fakeRecords(initial: PriceRecords | Error) {
  const state = { now: 0, reads: 0, next: initial };
  const read: PriceReader = async () => {
    state.reads += 1;
    if (state.next instanceof Error) throw state.next;
    return { ...state.next };
  };
  const book = new PriceBook({ read, ttlMs: 60_000, retryMs: 5_000, now: () => state.now });
  return { state, book };
}

function charged(state: PriceState): number {
  assert.ok(state.ok, `expected a price, got: ${state.ok ? '' : state.reason}`);
  return state.tiers.standard.priceUsd;
}

test('the record is read and applied: standard is the record, premium five times it', () => {
  const tiers = priceTiers(RECORDED_PRICE_RECORDS);
  assert.equal(tiers.standard.priceUsd, 0.07);
  assert.equal(tiers.premium.priceUsd, 0.35, 'micro-dollar rounding, not 0.35000000000000003');
  assert.equal(PREMIUM_MULTIPLE, 5);
  assert.equal(tiers.ceilingUsd, 0.5);
  assert.deepEqual(tiers.records, { price: '0.07', ceiling: '0.50' });
});

test('premium is capped at the ceiling, never above it', () => {
  // 5 x 0.12 = 0.60; the ceiling is 0.50.
  const tiers = priceTiers({ price: '0.12', ceiling: '0.50' });
  assert.equal(tiers.standard.priceUsd, 0.12);
  assert.equal(tiers.premium.priceUsd, 0.5);
});

test('a price above the ceiling is rejected, not clamped', () => {
  assert.throws(() => priceTiers({ price: '0.51', ceiling: '0.50' }), PriceRecordError);
  assert.throws(() => priceTiers({ price: '0.51', ceiling: '0.50' }), /above the turnstile:price-ceiling of \$0.5/);
  // At the ceiling exactly is allowed.
  assert.equal(priceTiers({ price: '0.50', ceiling: '0.50' }).standard.priceUsd, 0.5);
});

test('records that are unset or not a price are rejected with a reason', () => {
  assert.throws(() => priceTiers({ ceiling: '0.50' }), /turnstile:price is not set/);
  assert.throws(() => priceTiers({ price: '0.07' }), /turnstile:price-ceiling is not set/);
  for (const bad of ['', 'free', '0x10', '1e3', ' 0.07', '0.07 USD', '-1', '0', '0.00', 'Infinity', '.5', '5.']) {
    assert.equal(parsePriceRecord(bad), null, JSON.stringify(bad));
    assert.throws(() => priceTiers({ price: bad, ceiling: '0.50' }), PriceRecordError, JSON.stringify(bad));
  }
  assert.throws(() => priceTiers({ price: '0.07', ceiling: 'lots' }), /turnstile:price-ceiling is "lots"/);
});

test('a read is cached for the TTL, and a reprice is picked up when it expires', async () => {
  const { state, book } = fakeRecords({ price: '0.07', ceiling: '0.50' });
  assert.equal(charged(await book.current()), 0.07);
  assert.equal(state.reads, 1);

  state.next = { price: '0.09', ceiling: '0.50' };
  state.now = 59_999;
  assert.equal(charged(await book.current()), 0.07, 'inside the TTL, no new read');
  assert.equal(state.reads, 1);

  state.now = 60_000;
  const after = await book.current();
  assert.equal(charged(after), 0.09);
  assert.ok(after.ok && after.tiers.premium.priceUsd === 0.45);
  assert.equal(state.reads, 2);
});

test('concurrent requests share one read', async () => {
  const { state, book } = fakeRecords({ price: '0.07', ceiling: '0.50' });
  await Promise.all([book.current(), book.current(), book.current()]);
  assert.equal(state.reads, 1);
});

test('unreadable with no last-known-good: fail closed, with the reason', async () => {
  const { state, book } = fakeRecords(new Error('rpc unreachable'));
  assert.deepEqual(await book.current(), { ok: false, reason: 'rpc unreachable' });

  // Retried after retryMs, not the full TTL, so a seller that started during an
  // outage recovers within seconds of it ending.
  state.next = { price: '0.07', ceiling: '0.50' };
  state.now = 4_999;
  assert.equal((await book.current()).ok, false);
  state.now = 5_000;
  assert.equal(charged(await book.current()), 0.07);
});

test('a price above the ceiling, with no last-known-good, is never charged', async () => {
  const { book } = fakeRecords({ price: '0.60', ceiling: '0.50' });
  const state = await book.current();
  assert.equal(state.ok, false);
  assert.match(state.ok ? '' : state.reason, /above the turnstile:price-ceiling/);
});

test('unreadable with a last-known-good: keep charging it, and say it is stale', async () => {
  for (const failure of [
    new Error('rpc unreachable'),
    { ceiling: '0.50' },                     // record unset
    { price: 'seven cents', ceiling: '0.50' }, // not a price
    { price: '0.60', ceiling: '0.50' },        // above the ceiling: a hot key cannot exceed the cold key's limit
  ] satisfies (Error | PriceRecords)[]) {
    const { state, book } = fakeRecords({ price: '0.07', ceiling: '0.50' });
    await book.current();

    state.next = failure;
    state.now = 60_000;
    const stale = await book.current();
    assert.ok(stale.ok && stale.stale, `expected stale for ${JSON.stringify(failure)}`);
    assert.equal(stale.tiers.standard.priceUsd, 0.07);
    assert.equal(stale.readAt, 0, 'readAt is when the price being charged was read');
    assert.ok(stale.reason);

    // And it recovers on the next good read.
    state.next = { price: '0.08', ceiling: '0.50' };
    state.now = 65_000;
    const fresh = await book.current();
    assert.ok(fresh.ok && !fresh.stale);
    assert.equal(fresh.tiers.standard.priceUsd, 0.08);
  }
});

test('a read that hangs is not waited on past the timeout when a price is known', async () => {
  let clock = 0;
  let hang = false;
  const book = new PriceBook({
    read: () => hang ? new Promise(() => {}) : Promise.resolve({ price: '0.07', ceiling: '0.50' }),
    ttlMs: 60_000, readTimeoutMs: 20, now: () => clock,
  });
  await book.current();
  hang = true;
  clock = 60_000;
  const state = await book.current();
  assert.ok(state.ok && !state.stale && state.tiers.standard.priceUsd === 0.07);
});

test('discovery reports a price exactly when the seller would charge it', () => {
  // publishedPrice() is what discovery.ts and mcp-turnstile/offer.ts call for
  // priceSource 'turnstile'; it is priceTiers() underneath, the function the 402
  // is priced by.
  assert.deepEqual(publishedPrice(RECORDED_PRICE_RECORDS), { usd: 0.07, ceilingUsd: 0.5 });
  assert.equal(publishedPrice(RECORDED_PRICE_RECORDS).usd, priceTiers(RECORDED_PRICE_RECORDS).standard.priceUsd);

  const over = publishedPrice({ price: '0.60', ceiling: '0.50' });
  assert.equal(over.usd, null, 'a price the seller refuses to charge is not advertised as exact');
  assert.equal(over.ceilingUsd, 0.5);
  assert.match(over.note ?? '', /above the turnstile:price-ceiling/);

  assert.equal(publishedPrice({ price: '0x10', ceiling: '0.50' }).usd, null);
  assert.equal(publishedPrice({ price: '0.07' }).usd, null);
});
