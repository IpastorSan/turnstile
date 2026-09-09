// The /mandate page's reader, and the two things it must never do: quote a cap
// from a literal, and fail with a stack trace.
//
// The cap in particular is the reason this module is not a static description of
// the warm tier. A quorum can raise it — MOV-228 did, live — so a page quoting
// `demoMandate()`'s 0.25 would be quietly wrong the moment the demo's own story
// happens. Every test below that asserts a cap therefore uses a policy whose cap
// is *not* the literal, so a regression to the literal fails rather than passing
// by coincidence.
//
// Privy is never called. `PrivyClient` takes its `fetch` from `globalThis` when
// its credentials do not carry one, and `mandate.ts` builds it from the
// environment, so a stub installed here runs the real client, the real error
// type and the real policy parser.

import assert from 'node:assert/strict';
import test from 'node:test';

import { readMandate } from './mandate.ts';
import { generateAuthorizationKey } from '../../buyer/org/authorization-key.ts';
import { demoMandate, mandatePolicyRules } from '../../buyer/mandate/index.ts';

const AGENT = '0x0633a193017939Bb1eB242982397224c66948e2F';
const WALLET_ADDRESS = '0x3De96375140717193f52c220Df5Ec460971cbE84';

/** Everything `loadOrgFromEnv` and `credentialsFromEnv` insist on, all at once. */
function configuredEnv(): Record<string, string> {
  return {
    PRIVY_APP_ID: 'app-under-test',
    PRIVY_APP_SECRET: 'secret-under-test',
    PRIVY_OPERATOR_ALICE_KEY: generateAuthorizationKey().privateKey,
    PRIVY_OPERATOR_ALICE_USER_ID: 'did:privy:alice',
    PRIVY_OPERATOR_BOB_KEY: generateAuthorizationKey().privateKey,
    PRIVY_OPS_QUORUM_ID: 'ops-quorum',
    PRIVY_BOARD_QUORUM_ID: 'board-quorum',
    PRIVY_MANDATE_POLICY_ID: 'policy-from-env',
    PRIVY_ORG_WALLET_ID: 'wallet-from-env',
    PRIVY_ORG_WALLET_ADDRESS: WALLET_ADDRESS,
  };
}

/** Every PRIVY_ variable this module can read, so a test can clear them all. */
const PRIVY_KEYS = [
  ...Object.keys(configuredEnv()),
  'PRIVY_OPERATOR_ALICE_WALLET',
  'PRIVY_OPERATOR_BOB_USER_ID',
  'PRIVY_OPERATOR_BOB_WALLET',
];

const wallet = (over: Record<string, unknown> = {}) => ({
  id: 'wallet-from-argument',
  address: WALLET_ADDRESS,
  chain_type: 'ethereum',
  policy_ids: ['policy-from-wallet'],
  owner_id: 'ops-quorum-of-this-org',
  ...over,
});

/** A policy Privy would return, built by the repo's own rule builder. */
const policy = (spendCapUsd: number, over: Record<string, unknown> = {}) => ({
  id: 'policy-from-wallet',
  name: `Turnstile mandate — $${spendCapUsd} cap`,
  chain_type: 'ethereum',
  rules: mandatePolicyRules(demoMandate({ spendCapUsd }), AGENT).map((r, i) => ({ ...r, id: `rule-${i}` })),
  owner_id: 'board-quorum-of-this-org',
  ...over,
});

interface Privy {
  wallets?: Record<string, unknown>;
  policies?: Record<string, unknown>;
  /** Answer this status for everything, as a wrong id or a revoked key does. */
  status?: number;
}

function stubPrivy(api: Privy): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (api.status) return new Response(JSON.stringify({ error: 'no' }), { status: api.status });

    const walletMatch = /\/v1\/wallets\/([^/?]+)/.exec(url);
    if (walletMatch) {
      const found = api.wallets?.[walletMatch[1]!];
      if (!found) return new Response(JSON.stringify({ error: 'wallet not found' }), { status: 404 });
      return new Response(JSON.stringify(found), { status: 200 });
    }
    const policyMatch = /\/v1\/policies\/([^/?]+)/.exec(url);
    if (policyMatch) {
      const found = api.policies?.[policyMatch[1]!];
      if (!found) return new Response(JSON.stringify({ error: 'policy not found' }), { status: 404 });
      return new Response(JSON.stringify(found), { status: 200 });
    }
    throw new Error(`unstubbed Privy request to ${url} — this test must not reach the network`);
  }) as typeof globalThis.fetch;
}

async function withEnv<T>(env: Record<string, string>, api: Privy, run: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  const saved = new Map(PRIVY_KEYS.map(k => [k, process.env[k]]));
  for (const key of PRIVY_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  globalThis.fetch = stubPrivy(api);
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const key of Object.keys(env)) if (!saved.has(key)) delete process.env[key];
  }
}

// --- the deployment has no organization ---------------------------------------

test('an unconfigured deployment names the command that fixes it', async () => {
  // The branch a fresh clone hits, and the one most likely to be seen by someone
  // who is not us. "PRIVY_ORG_WALLET_ID is not set" would be an accurate message
  // and a useless one; the reader has to be told which script creates all of it.
  const read = await withEnv({}, {}, () => readMandate());
  assert.equal(read.ok, false);
  assert.match(read.ok === false ? read.reason : '', /npm run privy:setup/);
  assert.match(read.ok === false ? read.reason : '', /no Privy organization configured/);
});

test('the unconfigured branch is checked before any network call', async () => {
  // No stub is installed by the caller here; the one `withEnv` provides throws
  // on any request. Reaching Privy with no app id would surface as a 401, which
  // reads as "our credentials are wrong" rather than "this deployment has none".
  const read = await withEnv({}, {}, () => readMandate());
  assert.equal(read.ok, false);
  assert.doesNotMatch(read.ok === false ? read.reason : '', /401|unstubbed/);
});

test('a partly configured org is unconfigured, not half-working', async () => {
  // `loadOrgFromEnv` is deliberately all-or-nothing: a wallet id with no
  // operator keys can fund the agent but can never raise the cap, and finding
  // that out mid-demo is worse than finding it out here.
  const env = configuredEnv();
  delete env['PRIVY_OPERATOR_BOB_KEY'];
  const read = await withEnv(env, {}, () => readMandate());
  assert.equal(read.ok, false);
  assert.match(read.ok === false ? read.reason : '', /npm run privy:setup/);
});

// --- reading the demo org out of .env -----------------------------------------

test('the configured org reports the cap the policy carries, not the literal', async () => {
  const read = await withEnv(
    configuredEnv(),
    {
      wallets: { 'wallet-from-env': wallet({ id: 'wallet-from-env' }) },
      policies: { 'policy-from-env': policy(1.5, { id: 'policy-from-env' }) },
    },
    () => readMandate(),
  );

  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.notEqual(read.state.spendCapUsd, demoMandate().spendCapUsd, 'the cap came from demoMandate() rather than the policy');
  assert.equal(read.state.spendCapUsd, 1.5);
  // The quorum ids come from .env for the demo org, and the two are different
  // on purpose: the quorum that owns the wallet is not the one that may raise
  // the cap. Collapsing them would erase the property the page exists to show.
  assert.equal(read.state.opsQuorumId, 'ops-quorum');
  assert.equal(read.state.boardQuorumId, 'board-quorum');
  assert.notEqual(read.state.opsQuorumId, read.state.boardQuorumId);
  assert.deepEqual(read.state.operators.map(o => o.handle), ['alice', 'bob']);
  assert.equal(read.state.operators[0]?.userId, 'did:privy:alice');
  assert.equal(read.state.rules.length, 2);
});

test('a Privy error is a reason on the page, not a crash', async () => {
  // Server-rendered: an uncaught throw here is a 500 where the mandate should
  // be, which during judging is indistinguishable from the feature not existing.
  const read = await withEnv(configuredEnv(), { status: 500 }, () => readMandate());
  assert.equal(read.ok, false);
  assert.match(read.ok === false ? read.reason : '', /500/);
});

// --- reading somebody else's org by wallet id ----------------------------------

test('a wallet with no policy is refused, and says why that matters', async () => {
  // The branch behind /mandate/<walletId> for an org created in the browser and
  // never given a policy. There is nothing to show and, more to the point,
  // nothing governing the wallet — so an empty mandate page would be a lie.
  const read = await withEnv(
    configuredEnv(),
    { wallets: { 'wallet-from-argument': wallet({ policy_ids: [] }) } },
    () => readMandate('wallet-from-argument'),
  );
  assert.equal(read.ok, false);
  assert.match(read.ok === false ? read.reason : '', /has no policy attached/);
  assert.match(read.ok === false ? read.reason : '', /not governed by anything/);
});

test('a wallet id resolves the whole shape without reading .env', async () => {
  // The claim in `readMandate`'s docstring: one id is enough. The env below
  // names a *different* wallet and policy, so anything leaking out of `.env`
  // shows up as the wrong id rather than passing quietly.
  const read = await withEnv(
    configuredEnv(),
    {
      wallets: { 'wallet-from-argument': wallet() },
      policies: { 'policy-from-wallet': policy(2.5) },
    },
    () => readMandate('wallet-from-argument'),
  );

  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.state.walletId, 'wallet-from-argument');
  assert.equal(read.state.policyId, 'policy-from-wallet');
  assert.equal(read.state.opsQuorumId, 'ops-quorum-of-this-org', "the demo org's quorum id leaked into somebody else's mandate");
  assert.equal(read.state.boardQuorumId, 'board-quorum-of-this-org');
  assert.equal(read.state.spendCapUsd, 2.5);
  // We hold no operator keys for an org created in a browser and Privy does not
  // list a quorum's members back, so an empty list is the honest answer. The
  // demo org's two operators appearing here would be an outright fabrication.
  assert.deepEqual(read.state.operators, []);
});

test('a wallet with no owner reports it as unset rather than borrowing one', async () => {
  const read = await withEnv(
    configuredEnv(),
    {
      wallets: { 'wallet-from-argument': wallet({ owner_id: null }) },
      policies: { 'policy-from-wallet': policy(2.5, { owner_id: null }) },
    },
    () => readMandate('wallet-from-argument'),
  );
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.state.opsQuorumId, 'unset');
  assert.equal(read.state.boardQuorumId, 'unset');
  assert.equal(read.state.ownerId, null);
  assert.equal(read.state.policyOwnerId, null);
});

test("a policy that is not one of ours reports a null cap rather than a number", async () => {
  // `policySpendCapUsd` returns null when no rule caps `depositFor.value`. A
  // wallet can be governed by any policy at all, and inventing a cap for one we
  // do not understand is the worst available answer.
  const read = await withEnv(
    configuredEnv(),
    {
      wallets: { 'wallet-from-argument': wallet() },
      policies: { 'policy-from-wallet': policy(2.5, { rules: [] }) },
    },
    () => readMandate('wallet-from-argument'),
  );
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.state.spendCapUsd, null);
  assert.equal(read.state.rules.length, 0);
});

test('a wallet id Privy has never seen is a reason, not a crash', async () => {
  const read = await withEnv(configuredEnv(), { wallets: {} }, () => readMandate('no-such-wallet'));
  assert.equal(read.ok, false);
  assert.match(read.ok === false ? read.reason : '', /404/);
});

test('a wallet id path is not blocked by an unconfigured org', async () => {
  // /mandate/<walletId> has to work on a deployment that has no org of its own —
  // only Privy app credentials. The `.env` org check must not gate it.
  const env = { PRIVY_APP_ID: 'app-under-test', PRIVY_APP_SECRET: 'secret-under-test' };
  const read = await withEnv(
    env,
    {
      wallets: { 'wallet-from-argument': wallet() },
      policies: { 'policy-from-wallet': policy(2.5) },
    },
    () => readMandate('wallet-from-argument'),
  );
  assert.equal(read.ok, true);
  assert.equal(read.ok === true && read.state.spendCapUsd, 2.5);
});
