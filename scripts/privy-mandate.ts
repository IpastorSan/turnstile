// The mandate, end to end: an agent refused, and the quorum that answers it.
//
//   node scripts/privy-mandate.ts              # the whole transcript
//   node scripts/privy-mandate.ts --no-raise   # stop before raising the cap
//
// Five beats, and every one of them is a live call to Privy rather than a
// rehearsal:
//
//   1. the mandate, and the two places it is enforced
//   2. the **agent** refuses a premium offer over its per-query ceiling — our
//      code, before a signature exists
//   3. the **org wallet** funds the agent within the cap — one operator, one
//      signature, a real signed Arc transaction
//   4. the same wallet is refused a deposit over the cap — Privy's enclave, not
//      our code, and it would refuse the same request from an attacker holding
//      our app secret
//   5. Alice alone cannot raise the cap. Alice **and** Bob can.
//
// Beat 5 is the B2B workflow: a treasury change that one person cannot make.
// Beats 3 and 4 are the financial flow, on `eth_signTransaction`, which is
// generally available rather than a preview feature.
//
// Nothing is broadcast here — `scripts/arc-setup.ts` does that. This script
// proves who may authorize what, which is the part that needs a second person in
// the room.

import { encodeFunctionData, getAddress } from 'viem';

import { PrivyClient, PrivyError, credentialsFromEnv, getOrgWallet, signTransaction } from '../buyer/org/index.ts';
import { loadOrgFromEnv } from '../buyer/org/env.ts';
import { DEPOSIT_FOR_ABI, decide, demoMandate, getMandatePolicy, policySpendCapUsd, raiseSpendCap, usdToUsdcAtomic } from '../buyer/mandate/index.ts';
import type { Mandate } from '../buyer/mandate/index.ts';
import { CHAIN_ID, GATEWAY_WALLET, USDC_ASSET, arcscanAddressUrl } from '../rails/arc-usdc/config.ts';
import type { PaymentRequirement } from '../rails/PaymentRail.ts';
import type { RailSigner } from '../buyer/watchdog/pay.ts';

const args = process.argv.slice(2);
const skipRaise = args.includes('--no-raise');

const rule = (title: string) => console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);

const privy = new PrivyClient(credentialsFromEnv());
const org = loadOrgFromEnv();
const [alice, bob] = org.operators;
if (!alice || !bob) throw new Error('the demo needs two operators — rerun `npm run privy:setup`');

const agentAddress = getAddress(process.env['ARC_AGENT_ADDRESS'] ?? '0x0633a193017939Bb1eB242982397224c66948e2F');
const sellerPayout = process.env['ARC_SELLER_PAYOUT'] ?? '0x0Adca6e14bA956201D221feC767e4f24194bf5F2';

// ---------------------------------------------------------------------------
// 1. The mandate
// ---------------------------------------------------------------------------

const policy = await getMandatePolicy(privy, org.policyId);
const wallet = await getOrgWallet(privy, org.walletId);

// The **policy** is the authority on the cap, not a literal in this file. Once a
// quorum has raised it, a script still quoting `demoMandate()` would be
// describing a mandate that no longer exists — and a demo that lies on its
// second run is worse than one that cannot be run twice.
const liveCapUsd = policySpendCapUsd(policy);
if (liveCapUsd === null) throw new Error(`policy ${policy.id} has no depositFor cap — is it one of ours?`);

let mandate: Mandate = demoMandate({ spendCapUsd: liveCapUsd, sellerAllowlist: [sellerPayout, '0.0.10403961'] });

rule('1. THE MANDATE');
console.log(`spend cap           $${mandate.spendCapUsd}   (read back off the live policy — Privy caps this on chain)`);
console.log(`per-query ceiling   $${mandate.maxPerQueryUsd}`);
console.log(`rails               ${mandate.railPreference.join(' > ')}`);
console.log(`seller allowlist    ${mandate.sellerAllowlist.join(', ')}`);
console.log(`verified operator   ${mandate.verifiedOperatorOnly} (MOV-223 seam — blocked on World Sandbox approval)`);
console.log(`\norg wallet          ${wallet.address}`);
console.log(`                    ${arcscanAddressUrl(wallet.address)}`);
console.log(`  owner             ${wallet.owner_id}  operations quorum, 1 of ${org.operators.length}`);
console.log(`policy              ${policy.name}`);
console.log(`  owner             ${policy.owner_id}  board quorum — raising the cap needs its threshold`);
console.log(`operators           ${org.operators.map(o => `${o.handle} (${o.role})`).join(', ')}`);

// ---------------------------------------------------------------------------
// 2. The agent refuses, before a signature exists
// ---------------------------------------------------------------------------

/**
 * The seller's real numbers, from `docs/arc-nanopayments.md`: $0.07 standard,
 * $0.35 premium. Hard-coded rather than fetched so the refusal is legible
 * without a running seller, and so this beat cannot fail for a reason unrelated
 * to the mandate.
 */
const offer = (amountAtomic: string, payTo = sellerPayout): PaymentRequirement => ({
  scheme: 'exact',
  network: `eip155:${CHAIN_ID}`,
  asset: USDC_ASSET,
  amount: amountAtomic,
  payTo,
  maxTimeoutSeconds: 300,
  extra: {},
});

// Only the fields `enforceMandate` reads. The real signer is built in
// `scripts/arc-paid-request.ts`; constructing one here would need the agent key
// for a decision that never signs anything.
const arcSigner = {
  railId: 'arc-usdc',
  scheme: 'exact',
  network: `eip155:${CHAIN_ID}`,
  decimals: 6,
  usdPerUnit: 1,
  sign: () => Promise.reject(new Error('this script never signs a payment')),
} satisfies RailSigner;

rule('2. THE AGENT IS REFUSED — OUR CODE, BEFORE A SIGNATURE EXISTS');
for (const [label, requirement] of [
  ['standard tier, $0.07', offer('70000')],
  ['premium tier,  $0.35', offer('350000')],
  ['a seller not on the allowlist, $0.07', offer('70000', '0x000000000000000000000000000000000000dEaD')],
] as const) {
  const decision = decide([requirement], mandate, [arcSigner]);
  if (decision.chosen) console.log(`${label.padEnd(38)} PAY`);
  else console.log(`${label.padEnd(38)} REFUSED — ${decision.rejected[0]?.reason}`);
}
console.log('\nThe agent stops. It does not downgrade to a cheaper tier and it does not');
console.log('improvise: no rail can settle below the authorized amount (MOV-225, verified');
console.log('against live Gateway), so the tier is decided before quoting or not at all.');

// ---------------------------------------------------------------------------
// 3 & 4. The treasury operation, and the cap
// ---------------------------------------------------------------------------

const usdc = getAddress(USDC_ASSET);
const gateway = getAddress(GATEWAY_WALLET);

function depositTransaction(amountUsd: number) {
  return {
    to: gateway,
    data: encodeFunctionData({
      abi: DEPOSIT_FOR_ABI,
      functionName: 'depositFor',
      args: [usdc, agentAddress, usdToUsdcAtomic(amountUsd)],
    }),
    value: 0,
    chain_id: CHAIN_ID,
    nonce: 0,
    gas_limit: 120000,
    max_fee_per_gas: 1_000_000_000,
    max_priority_fee_per_gas: 1_000_000,
    type: 2 as const,
  };
}

/** Comfortably over whatever the live cap is. */
const overCap = Number((mandate.spendCapUsd * 4).toFixed(6));

async function attemptDeposit(label: string, amountUsd: number, approvals = [alice!.key]): Promise<void> {
  try {
    const signed = await signTransaction(privy, { walletId: org.walletId, transaction: depositTransaction(amountUsd), approvals });
    console.log(`${label.padEnd(46)} SIGNED  ${signed.slice(0, 26)}…`);
  } catch (error) {
    const err = error as PrivyError;
    const code = typeof err.body === 'object' && err.body !== null ? (err.body as { code?: string }).code ?? '' : '';
    console.log(`${label.padEnd(46)} REFUSED ${err.status} ${code || (err.body as { error?: string })?.error?.slice(0, 60)}`);
  }
}

rule('3 & 4. THE ORG WALLET FUNDS THE AGENT — PRIVY DECIDES, NOT US');
console.log(`depositFor(USDC, ${agentAddress}, …) on the GatewayWallet\n`);
await attemptDeposit(`fund $${mandate.spendCapUsd} — at the cap, alice approves`, mandate.spendCapUsd);
await attemptDeposit(`fund $${overCap} — over the cap, alice approves`, overCap);
await attemptDeposit(`fund $${mandate.spendCapUsd} — nobody approves`, mandate.spendCapUsd, []);
console.log('\nThe over-cap refusal is `policy_violation` from Privy, and it would refuse the');
console.log('same request from anyone holding this app secret. The unapproved one is a 401:');
console.log('a different failure, deliberately not collapsed into the first.');

// ---------------------------------------------------------------------------
// 5. Raising the cap needs two
// ---------------------------------------------------------------------------

if (skipRaise) {
  console.log('\n--no-raise: stopping before the quorum beat.');
  process.exit(0);
}

// Four times whatever it is now, so the beat works on a second run too.
const raisedTo = Number(process.env['PRIVY_RAISED_CAP_USD'] ?? (mandate.spendCapUsd * 4).toFixed(6));

rule('5. RAISING THE CAP NEEDS A QUORUM');
console.log(`${alice.handle} (${alice.role}) proposes raising the cap $${mandate.spendCapUsd} → $${raisedTo}\n`);

try {
  await raiseSpendCap(privy, { policyId: org.policyId, mandate, newSpendCapUsd: raisedTo, agentAddress, approvals: [alice.key] });
  console.log('alice alone                                    RAISED — this should not happen');
  process.exitCode = 1;
} catch (error) {
  const err = error as PrivyError;
  console.log(`alice alone                                    REFUSED ${err.status} ${(err.body as { error?: string })?.error}`);
}

console.log(`\n${bob.handle} (${bob.role}) approves.\n`);
const raised = await raiseSpendCap(privy, {
  policyId: org.policyId,
  mandate,
  newSpendCapUsd: raisedTo,
  agentAddress,
  approvals: [alice.key, bob.key],
});
mandate = raised.mandate;
console.log(`alice + bob                                    RAISED → ${raised.policy.name}`);
for (const r of raised.policy.rules) console.log(`  ALLOW  ${r.name}`);

console.log('');
await attemptDeposit(`fund $${overCap} — the same request as beat 4`, overCap);

rule('WHAT JUST HAPPENED');
console.log('An agent hit a limit it cannot raise. A human proposed raising it and could');
console.log('not, alone. A second human approved and the limit moved. Every one of those');
console.log('checks ran inside Privy, against registered public keys — our app secret was');
console.log('never enough on its own. That is CLAUDE.md\'s invariant with the last gap');
console.log('closed: the key that spends cannot raise its own limit, and neither can the');
console.log('key that funds it.');
console.log('');
console.log('One honest caveat: in this demo BOTH operator private keys sit in .env, so');
console.log('this machine could in fact produce both signatures. That is a property of');
console.log('the demo, not of the design — in production each key lives on its operator\'s');
console.log('own device and the server holding the app secret never sees one. Nothing in');
console.log('buyer/org/ assumes otherwise; see buyer/org/env.ts.');
console.log(`\nTo reset the cap for another run: set PRIVY_RAISED_CAP_USD, or rerun`);
console.log('`npm run privy:setup -- --force` for a fresh org.');
