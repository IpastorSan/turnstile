// The mandate, offline.
//
// Two halves, tested separately because they fail in different places:
//
//   - the **agent-side** refusals, which are pure functions and can be exhausted
//     here;
//   - the **Privy policy** the mandate projects into, where the only thing this
//     file can check is that we build the right request. The behaviour of that
//     request was verified against the live API on 2026-09-07 and is recorded in
//     `docs/privy-mandate.md`, including the two rules Privy's docs do not state.

import test from 'node:test';
import assert from 'node:assert/strict';

import type { PaymentRequirement } from '../../rails/PaymentRail.ts';
import type { RailSigner } from '../watchdog/pay.ts';
import { GATEWAY_WALLET, USDC_ASSET } from '../../rails/arc-usdc/config.ts';
import { MandateLedger, demoMandate, isAllowlistedSeller, verifiedOperatorGate } from './mandate.ts';
import { MandateRefused, decide, mandateSpendingLimits } from './enforce.ts';
import { mandatePolicyRules, policySpendCapUsd, raiseSpendCap, usdToUsdcAtomic } from './policy.ts';
import { PrivyClient } from '../org/privy.ts';
import { generateAuthorizationKey } from '../org/authorization-key.ts';

const SELLER = '0x0Adca6e14bA956201D221feC767e4f24194bf5F2';
const AGENT = '0x0633a193017939Bb1eB242982397224c66948e2F';
const ARC = 'eip155:5042002';

const arcSigner: RailSigner = {
  railId: 'arc-usdc',
  scheme: 'exact',
  network: ARC,
  decimals: 6,
  usdPerUnit: 1,
  sign: () => Promise.reject(new Error('no signing in these tests')),
};

const offer = (amount: string, payTo = SELLER): PaymentRequirement => ({
  scheme: 'exact', network: ARC, asset: USDC_ASSET, amount, payTo, maxTimeoutSeconds: 300, extra: {},
});

// --- the object --------------------------------------------------------------

test('the ledger tracks what is left, and never goes negative', () => {
  const ledger = new MandateLedger(demoMandate({ spendCapUsd: 0.25 }));
  assert.equal(ledger.remainingUsd, 0.25);
  ledger.record(0.07);
  assert.equal(Number(ledger.remainingUsd.toFixed(6)), 0.18);
  ledger.record(1);
  assert.equal(ledger.remainingUsd, 0, 'an overspend clamps rather than reporting a negative allowance');
});

test('an empty seller allowlist allows nobody — a blank field must not widen a mandate', () => {
  assert.equal(isAllowlistedSeller(demoMandate({ sellerAllowlist: [] }), SELLER), false);
  assert.equal(isAllowlistedSeller(demoMandate({ sellerAllowlist: [SELLER] }), SELLER), true);
});

test('the seller allowlist ignores address case — checksummed and lowercase are one seller', () => {
  const mandate = demoMandate({ sellerAllowlist: [SELLER.toLowerCase()] });
  assert.equal(isAllowlistedSeller(mandate, SELLER), true);
});

test('verified_operator_only refuses while it is wired to nothing', () => {
  // MOV-223 replaces this. Until it can, a gate that returns "allowed" would read
  // as a control in the demo and not be one.
  assert.equal(verifiedOperatorGate(demoMandate({ verifiedOperatorOnly: false })), null);
  assert.equal(verifiedOperatorGate(demoMandate({ verifiedOperatorOnly: true }))?.code, 'operator_not_verified');
  assert.equal(verifiedOperatorGate(demoMandate({ verifiedOperatorOnly: true }), true), null);
});

// --- the agent-side refusals -------------------------------------------------

test('an offer within the mandate is chosen', () => {
  const decision = decide([offer('70000')], demoMandate(), [arcSigner]);
  assert.equal(decision.chosen?.amount, '70000');
});

test('an offer over the per-query ceiling is refused, and says which limit bit', () => {
  const decision = decide([offer('350000')], demoMandate({ maxPerQueryUsd: 0.1 }), [arcSigner]);
  assert.equal(decision.chosen, null);
  assert.match(decision.rejected[0]!.reason, /exceeds the mandate cap of \$0\.1000/);
});

test('an offer over what is LEFT of the spend cap is refused, and points at the quorum', () => {
  const mandate = demoMandate({ spendCapUsd: 0.25, maxPerQueryUsd: 1 });
  const ledger = new MandateLedger(mandate, 0.2);
  const decision = decide([offer('70000')], mandate, [arcSigner], { ledger });
  assert.equal(decision.chosen, null);
  assert.match(decision.rejected[0]!.reason, /left of the mandate's spend cap — raising it needs a quorum/);
});

test('a seller off the allowlist is refused before the price is even considered', () => {
  const decision = decide([offer('1', '0x000000000000000000000000000000000000dEaD')], demoMandate(), [arcSigner]);
  assert.equal(decision.chosen, null);
  assert.match(decision.rejected[0]!.reason, /not on the mandate's seller allowlist/);
});

test('a rail outside the mandate is refused even when the price is fine', () => {
  const decision = decide([offer('1000')], demoMandate({ railPreference: ['hedera-x402'] }), [arcSigner]);
  assert.equal(decision.chosen, null);
  assert.match(decision.rejected[0]!.reason, /is not in the mandate/);
});

test('projecting a verified-operator mandate throws rather than quietly dropping the flag', () => {
  assert.throws(() => mandateSpendingLimits(demoMandate({ verifiedOperatorOnly: true })), MandateRefused);
});

test('the projection never leaves the allowlist undefined', () => {
  // `undefined` means "no allowlist, any payee"; a mandate must never produce it.
  assert.ok(Array.isArray(mandateSpendingLimits(demoMandate()).sellerAllowlist));
});

// --- the Privy policy --------------------------------------------------------

test('dollars round DOWN to atomic units — a cap must never round up', () => {
  assert.equal(usdToUsdcAtomic(0.25), 250000n);
  assert.equal(usdToUsdcAtomic(0.0000019), 1n);
  assert.throws(() => usdToUsdcAtomic(-1), /not a dollar amount/);
});

test('the policy caps depositFor, pins the depositor, and checksums every address', () => {
  const rules = mandatePolicyRules(demoMandate({ spendCapUsd: 0.25 }), AGENT.toLowerCase());
  const deposit = rules.find(r => r.name.startsWith('Fund'))!;
  const conditions = deposit.conditions as { field: string; operator: string; value: string }[];

  // `GATEWAY_WALLET` is stored lowercase in config.ts; the rule must carry the
  // EIP-55 form, because Privy compares address values verbatim.
  assert.equal(conditions.find(c => c.field === 'to')!.value, '0x0077777d7EBA4688BDeF3E311b846F25870A19B9');
  assert.equal(conditions.find(c => c.field === 'to')!.value.toLowerCase(), GATEWAY_WALLET);
  assert.equal(conditions.find(c => c.field === 'depositFor.depositor')!.value, AGENT, 'the depositor is pinned, checksummed');
  assert.equal(conditions.find(c => c.field === 'depositFor.value')!.value, '0x3d090');
  assert.equal(conditions.find(c => c.field === 'depositFor.value')!.operator, 'lte');
});

test('the policy has no catch-all DENY — on Privy, a DENY is a veto that would deny everything', () => {
  // Verified live 2026-09-07: adding { method: '*', action: 'DENY' } denied
  // requests an earlier ALLOW rule matched. Privy is deny-by-default already.
  const rules = mandatePolicyRules(demoMandate(), AGENT);
  assert.equal(rules.some(r => r.action === 'DENY'), false);
  assert.equal(rules.every(r => r.method === 'eth_signTransaction'), true);
});

test('the cap can be read back out of a policy — the policy is the authority, not a literal', () => {
  const rules = mandatePolicyRules(demoMandate({ spendCapUsd: 1.5 }), AGENT);
  assert.equal(policySpendCapUsd({ rules: rules as never }), 1.5);
  assert.equal(policySpendCapUsd({ rules: [] }), null);
});

test('raiseSpendCap refuses to lower a cap through the raise path', async () => {
  const client = new PrivyClient({ appId: 'a', appSecret: 's', fetch: (() => { throw new Error('should not reach the network'); }) as never });
  await assert.rejects(
    () => raiseSpendCap(client, { policyId: 'p', mandate: demoMandate({ spendCapUsd: 1 }), newSpendCapUsd: 0.5, agentAddress: AGENT, approvals: [] }),
    /lowering a cap is a different operation/,
  );
});

test('raiseSpendCap sends one signature per approver and the new rules', async () => {
  const calls: { headers: Record<string, string>; body: string }[] = [];
  const client = new PrivyClient({
    appId: 'a', appSecret: 's',
    fetch: (async (_url: string | URL, init?: RequestInit) => {
      calls.push({ headers: init!.headers as Record<string, string>, body: init!.body as string });
      return new Response(JSON.stringify({ id: 'p', name: 'x', chain_type: 'ethereum', rules: [], owner_id: 'q' }), { status: 200 });
    }) as unknown as typeof globalThis.fetch,
  });

  const raised = await raiseSpendCap(client, {
    policyId: 'p',
    mandate: demoMandate({ spendCapUsd: 0.25 }),
    newSpendCapUsd: 1,
    agentAddress: AGENT,
    approvals: [generateAuthorizationKey(), generateAuthorizationKey()],
  });

  assert.equal(raised.mandate.spendCapUsd, 1);
  assert.equal(calls[0]!.headers['privy-authorization-signature']!.split(',').length, 2);
  const body = JSON.parse(calls[0]!.body) as { rules: { conditions: { field: string; value: string }[] }[] };
  assert.equal(body.rules[0]!.conditions.find(c => c.field === 'depositFor.value')!.value, '0xf4240');
});
