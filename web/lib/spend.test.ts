// The containment between the two rails, which is the only interesting thing
// this module does.
//
// `readSpend` reads two independent networks and merges them into one page. The
// property worth pinning is the one from the file's own header: **a rail that
// could not be read must not blank the other, and must not report zero.** A zero
// and a failure look identical once summed, so "we could not reach Circle" would
// render as "this agent has never paid on Arc" — the strongest claim on the page
// turned into a quiet lie by an outage.
//
// Nothing here touches the network. Both rails go through `globalThis.fetch`
// (the mirror node directly, Circle Gateway through `CircleGateway`), so a stub
// installed here exercises the real HTTP clients, the real parsers and the real
// error types — not a mock of them.

import assert from 'node:assert/strict';
import test from 'node:test';

import { readSpend } from './spend.ts';

// readReceipts falls back to this when no topic is passed, and spend.ts passes
// none. Set before the first import-time read so every test sees a topic.
process.env['HEDERA_RECEIPT_TOPIC_ID'] = '0.0.1';

const AGENT = '0x0633a193017939Bb1eB242982397224c66948e2F';

type Receipt = { message: string; sequence_number: number; consensus_timestamp: string };

const settlement = (over: Record<string, unknown> = {}) => ({
  v: 1,
  kind: 'turnstile.settlement',
  railId: 'hedera-x402',
  network: 'hedera:testnet',
  transaction: '0.0.7162784@1788791871.396045089',
  payer: '0.0.10408012',
  payTo: '0.0.10403961',
  amount: '84367844',
  asset: '0.0.0',
  priceUsd: 0.07,
  resource: 'http://seller.example/analyze/0xpool',
  settledAt: 1_788_791_876_671,
  ...over,
});

const receipt = (over: Record<string, unknown> = {}, sequence = 1, consensus = '1788791871.396045089'): Receipt => ({
  message: Buffer.from(JSON.stringify(settlement(over)), 'utf8').toString('base64'),
  sequence_number: sequence,
  consensus_timestamp: consensus,
});

const transfer = (id: string, amount: string, createdAt: string) => ({
  id,
  status: 'COMPLETE',
  amount,
  txHash: `0x${id.repeat(64).slice(0, 64)}`,
  createdAt,
});

/** Either rail can be told to fail, which is the whole point of this file. */
interface Rails {
  receipts?: Receipt[];
  submitKey?: { key: string } | null;
  /** `'down'` throws at the socket; a number answers that HTTP status. */
  mirror?: 'down' | number;
  transfers?: ReturnType<typeof transfer>[];
  gateway?: 'down' | number;
}

function stubFetch(rails: Rails): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes('/api/v1/topics/')) {
      if (rails.mirror === 'down') throw new Error('ECONNREFUSED mirror');
      if (typeof rails.mirror === 'number') return new Response('{}', { status: rails.mirror });
      if (url.includes('/messages')) {
        return new Response(JSON.stringify({ messages: rails.receipts ?? [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ submit_key: rails.submitKey ?? null }), { status: 200 });
    }

    if (url.includes('/v1/x402/transfers')) {
      if (rails.gateway === 'down') throw new Error('ECONNREFUSED gateway');
      if (typeof rails.gateway === 'number') return new Response('upstream said no', { status: rails.gateway });
      return new Response(JSON.stringify({ transfers: rails.transfers ?? [] }), { status: 200 });
    }

    // Loud rather than silent: an unstubbed route means readSpend grew a
    // dependency this file does not know about, and a 404 would look like an
    // ordinary empty answer.
    throw new Error(`unstubbed request to ${url} — this test must not reach the network`);
  }) as typeof globalThis.fetch;
}

async function spendWith(rails: Rails): ReturnType<typeof readSpend> {
  const real = globalThis.fetch;
  globalThis.fetch = stubFetch(rails);
  try {
    return await readSpend(AGENT);
  } finally {
    globalThis.fetch = real;
  }
}

const railById = (state: Awaited<ReturnType<typeof readSpend>>, id: string) => {
  const found = state.rails.find(r => r.railId === id);
  assert.ok(found, `no ${id} row was produced at all`);
  return found;
};

test('both rails readable: each reports its own count and the totals add up', async () => {
  const state = await spendWith({
    receipts: [receipt({ priceUsd: 0.07 }, 1, '1788791871.396045089')],
    transfers: [transfer('a', '500', '2026-09-07T17:00:00.000Z'), transfer('b', '500', '2026-09-07T18:00:00.000Z')],
  });

  assert.equal(railById(state, 'hedera-x402').count, 1);
  assert.equal(railById(state, 'hedera-x402').usd, 0.07);
  assert.equal(railById(state, 'arc-usdc').count, 2);
  // 500 atomic USDC is 0.000500 dollars. Getting the decimals wrong here would
  // put a thousand-fold error on the page's headline number.
  assert.equal(railById(state, 'arc-usdc').usd, 0.001);
  assert.equal(state.totalCount, 3);
  assert.equal(Number(state.totalUsd.toFixed(6)), 0.071);
  assert.equal(state.payments.length, 3);
  // Newest first, across both rails — the merged list is the point of merging.
  assert.deepEqual(
    state.payments.map(p => p.at),
    ['2026-09-07T18:00:00.000Z', '2026-09-07T17:00:00.000Z', new Date(1_788_791_871_000).toISOString()],
  );
  for (const rail of state.rails) assert.equal(rail.error, undefined, `${rail.railId} reported an error it should not have`);
});

test('Arc unreachable does not blank Hedera, and reports null rather than zero', async () => {
  // The assertion this whole file exists for. One rail down must cost exactly
  // that rail's numbers and nothing else.
  const state = await spendWith({
    receipts: [receipt({ priceUsd: 0.07 }, 1), receipt({ priceUsd: 0.02, transaction: '0.0.1@2.3' }, 2, '1788791999.000000000')],
    gateway: 'down',
  });

  const hedera = railById(state, 'hedera-x402');
  assert.equal(hedera.count, 2, 'the readable rail lost its count because the other one failed');
  assert.equal(hedera.usd, 0.09);
  assert.equal(hedera.error, undefined);

  const arc = railById(state, 'arc-usdc');
  // The negative control. `0` here is the bug: it reads as "this agent has
  // never paid on Arc", which is a claim we cannot make from a failed read.
  assert.notEqual(arc.usd, 0, 'a failed Arc read reported 0 dollars, which is indistinguishable from never having paid');
  assert.equal(arc.usd, null);
  assert.match(arc.error ?? '', /unreachable|ECONNREFUSED/);

  // The total is the readable rails only, and the error row travels with it so
  // the page can say the number is partial rather than presenting it as final.
  assert.equal(state.totalUsd, 0.09);
  assert.equal(state.payments.length, 2, 'the surviving rail lost its individual payments');
});

test('a Gateway HTTP error is contained the same way a socket failure is', async () => {
  // Two different failure shapes reach the same branch: `getJson` throws a
  // GatewayError for a non-2xx as well as for an unreachable host. A test that
  // only covered the socket case would miss a 500, which is the likelier one.
  const state = await spendWith({ receipts: [receipt()], gateway: 500 });
  const arc = railById(state, 'arc-usdc');
  assert.equal(arc.usd, null);
  assert.equal(arc.count, 0);
  assert.match(arc.error ?? '', /500/);
  assert.equal(railById(state, 'hedera-x402').usd, 0.07, 'Hedera was blanked by an Arc HTTP error');
});

test('the mirror node being down does not blank Arc, and does not report zero either', async () => {
  // The mirror-node direction of the same property, and the one that used to be
  // wrong: `readReceipts` answers an unreachable node with an empty result and a
  // note rather than a throw, so `Promise.allSettled` sees a *fulfilled* read of
  // zero receipts. That rendered as "0 payments, $0.00 on Hedera" with no error
  // — exactly the confusion this module's header says it avoids. `unreadable`
  // is what tells the two apart now.
  const state = await spendWith({ mirror: 'down', transfers: [transfer('a', '70000', '2026-09-07T17:00:00.000Z')] });

  const hedera = railById(state, 'hedera-x402');
  assert.notEqual(hedera.usd, 0, 'an unreadable mirror node reported $0 settled, which is a claim the read cannot support');
  assert.equal(hedera.usd, null);
  assert.match(hedera.error ?? '', /could not be reached/);

  const arc = railById(state, 'arc-usdc');
  assert.equal(arc.count, 1);
  assert.equal(arc.usd, 0.07);
  assert.equal(arc.error, undefined);
  assert.equal(state.totalUsd, 0.07);
});

test('a mirror node answering an HTTP error is a failed read, not an empty topic', async () => {
  const state = await spendWith({ mirror: 503, transfers: [] });
  const hedera = railById(state, 'hedera-x402');
  assert.equal(hedera.usd, null);
  assert.match(hedera.error ?? '', /503/);
});

test('a topic that is genuinely empty reports zero, which is a different answer', async () => {
  // The other half of the distinction. If every unread rail reported null, the
  // error field would be noise. A topic that answered and held no receipts is a
  // real zero and must say so.
  const state = await spendWith({ receipts: [], transfers: [] });
  const hedera = railById(state, 'hedera-x402');
  assert.equal(hedera.usd, 0);
  assert.equal(hedera.count, 0);
  assert.equal(hedera.error, undefined, 'an empty-but-readable topic was reported as a failure');
  assert.equal(state.totalUsd, 0);
});

test('an unkeyed topic is flagged, because a receipt on one is a claim', async () => {
  const open = await spendWith({ receipts: [receipt()], submitKey: null, transfers: [] });
  assert.equal(open.topicIsOpen, true);
  assert.equal(open.topic, '0.0.1');

  const keyed = await spendWith({ receipts: [receipt()], submitKey: { key: '02abc' }, transfers: [] });
  assert.equal(keyed.topicIsOpen, false, 'a topic with a submit key was still described as open to anyone');
});

test('an unreadable topic is not described as open, because we never learned', async () => {
  // `submitKey: null` on a failed read means "unknown", not "no submit key".
  // Reporting it as open would be inventing a security property from an outage.
  const state = await spendWith({ mirror: 'down', transfers: [] });
  assert.equal(state.topicIsOpen, false);
});

test('individual payments carry a link and a reference per rail', async () => {
  const state = await spendWith({
    receipts: [receipt()],
    transfers: [transfer('c', '500', '2026-09-07T17:00:00.000Z')],
  });
  const arc = state.payments.find(p => p.railId === 'arc-usdc');
  const hedera = state.payments.find(p => p.railId === 'hedera-x402');
  assert.match(arc?.href ?? '', /^https:\/\/testnet\.arcscan\.app\/tx\/0x/);
  assert.equal(arc?.amount, '0.000500 USDC');
  assert.match(hedera?.href ?? '', /^https:\/\/hashscan\.io\/testnet\/transaction\/0\.0\.7162784@/);
  assert.equal(hedera?.reference, '0.0.7162784@1788791871.396045089');
});

test('a transfer with no txHash still gets a reference, and no dead link', async () => {
  // Gateway hands back an authorization id immediately and the batch hash only
  // once the batch settles, so this is an ordinary state, not an error.
  const pending = { id: 'auth-1', status: 'PENDING', amount: '500', createdAt: '2026-09-07T17:00:00.000Z' };
  const state = await spendWith({ receipts: [], transfers: [pending as ReturnType<typeof transfer>] });
  const arc = state.payments.find(p => p.railId === 'arc-usdc');
  assert.equal(arc?.href, null);
  assert.equal(arc?.reference, 'auth-1');
});
