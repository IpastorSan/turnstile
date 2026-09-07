// Stand up the buyer organization on Privy: two human operators, two quorums,
// the mandate policy, and the org wallet that replaces the plain key.
//
//   node scripts/privy-org-setup.ts            # create everything, print the .env block
//   node scripts/privy-org-setup.ts --status   # read what .env already points at
//
// ## What this creates, and what each piece is for
//
//   alice (CFO), bob (Head of Research)  — Privy users with **embedded wallets**,
//                                          pre-generated server-side. Each holds a
//                                          P-256 authorization key.
//   operations quorum (1 of 2)           — owns the org wallet. Any one operator
//                                          can run a routine treasury operation.
//   board quorum (2 of 2)                — owns the mandate policy. Raising the
//                                          agent's spend cap needs both.
//   mandate policy                       — "fund this agent, up to $X, and nothing
//                                          else", enforced by Privy's enclave.
//   org wallet                           — the warm tier. Replaces
//                                          `ARC_ORG_PRIVATE_KEY`.
//
// ## Run it once
//
// Every call creates **new** objects; Privy has no upsert here. Rerunning leaves
// the old wallet holding whatever USDC you sent it, and orphans the old quorums.
// So the script refuses to run when `.env` already names an org, unless you pass
// `--force` and mean it.

import { PrivyClient, createKeyQuorum, createOrgWallet, credentialsFromEnv, generateAuthorizationKey, getOrgWallet, onboardOperator } from '../buyer/org/index.ts';
import type { Operator } from '../buyer/org/index.ts';
import { DEMO_OPERATORS, loadOrgFromEnv, orgIsConfigured } from '../buyer/org/env.ts';
import { createMandatePolicy, demoMandate, getMandatePolicy, mandatePolicyRules } from '../buyer/mandate/index.ts';

const args = process.argv.slice(2);
const statusOnly = args.includes('--status');
const force = args.includes('--force');

const rule = (title: string) => console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);

const privy = new PrivyClient(credentialsFromEnv());
const mandate = demoMandate();

const agentAddress = process.env['ARC_AGENT_ADDRESS'] ?? '0x0633a193017939Bb1eB242982397224c66948e2F';

if (statusOnly) {
  const org = loadOrgFromEnv();
  const [wallet, policy] = await Promise.all([getOrgWallet(privy, org.walletId), getMandatePolicy(privy, org.policyId)]);
  rule('THE BUYER ORGANIZATION, AS PRIVY HAS IT');
  console.log(`org wallet    ${wallet.address}`);
  console.log(`  privy id    ${wallet.id}`);
  console.log(`  owner       ${wallet.owner_id}   (operations quorum, 1 of ${org.operators.length})`);
  console.log(`  policy      ${wallet.policy_ids.join(', ')}`);
  console.log(`mandate policy ${policy.name}`);
  console.log(`  owner       ${policy.owner_id}   (board quorum — raising the cap needs its threshold)`);
  for (const r of policy.rules) console.log(`  rule        ${r.action.padEnd(5)} ${r.name}`);
  console.log(`operators     ${org.operators.map(o => `${o.handle} (${o.role})`).join(', ')}`);
  process.exit(0);
}

if (orgIsConfigured() && !force) {
  console.error('.env already names a Privy org. Rerunning would create a second one and orphan the first.');
  console.error('Use --status to inspect it, or --force if you really want a fresh org.');
  process.exit(1);
}

rule('1. ONBOARD THE HUMAN OPERATORS');
const operators: Operator[] = [];
for (const spec of DEMO_OPERATORS) {
  // Reuse a key already in `.env` when there is one: the quorums are built from
  // public keys, so a regenerated key locks the org out of its own mandate.
  const existing = process.env[`PRIVY_OPERATOR_${spec.handle.toUpperCase()}_KEY`];
  const operator = await onboardOperator(privy, {
    handle: spec.handle,
    role: spec.role,
    email: spec.email,
    ...(existing ? { existingKey: existing } : { existingKey: generateAuthorizationKey() }),
  });
  operators.push(operator);
  console.log(`${operator.handle.padEnd(6)} ${operator.role.padEnd(18)} ${operator.userId}`);
  console.log(`       embedded wallet ${operator.walletAddress}`);
}

rule('2. THE TWO QUORUMS');
const ops = await createKeyQuorum(privy, { displayName: 'Turnstile operations', members: operators, threshold: 1 });
const board = await createKeyQuorum(privy, { displayName: 'Turnstile board', members: operators, threshold: 2 });
console.log(`operations  ${ops.id}   ${ops.authorization_threshold} of ${operators.length}  — owns the org wallet`);
console.log(`board       ${board.id}   ${board.authorization_threshold} of ${operators.length}  — owns the mandate policy`);
console.log('\nThat asymmetry is the control: funding the agent takes one operator, widening');
console.log('what it may spend takes two. See buyer/org/operators.ts.');

rule('3. THE MANDATE, AS A PRIVY POLICY');
const policy = await createMandatePolicy(privy, { mandate, agentAddress, ownerQuorumId: board.id });
console.log(`policy      ${policy.id}   ${policy.name}`);
for (const r of mandatePolicyRules(mandate, agentAddress)) console.log(`  ALLOW     ${r.name}`);
console.log('  (everything else is refused by Privy\'s deny-by-default — see buyer/mandate/policy.ts)');

rule('4. THE ORG WALLET — THE WARM TIER');
const wallet = await createOrgWallet(privy, { ownerQuorumId: ops.id, policyId: policy.id, displayName: 'Turnstile buyer org' });
console.log(`wallet      ${wallet.id}`);
console.log(`address     ${wallet.address}`);
console.log('\nThis address replaces ARC_ORG_PRIVATE_KEY as the depositFor() depositor.');
console.log('There is no private key for it on this machine, or anywhere outside Privy\'s enclave.');

rule('PASTE THIS INTO .env — IT CONTAINS SECRETS, DO NOT COMMIT IT');
const lines = [
  ...operators.flatMap(o => [
    `export PRIVY_OPERATOR_${o.handle.toUpperCase()}_KEY="${o.key.privateKey}"`,
    `export PRIVY_OPERATOR_${o.handle.toUpperCase()}_USER_ID="${o.userId}"`,
    `export PRIVY_OPERATOR_${o.handle.toUpperCase()}_WALLET="${o.walletAddress}"`,
  ]),
  `export PRIVY_OPS_QUORUM_ID="${ops.id}"`,
  `export PRIVY_BOARD_QUORUM_ID="${board.id}"`,
  `export PRIVY_MANDATE_POLICY_ID="${policy.id}"`,
  `export PRIVY_ORG_WALLET_ID="${wallet.id}"`,
  `export PRIVY_ORG_WALLET_ADDRESS="${wallet.address}"`,
];
console.log(lines.join('\n'));

console.log(`\nThen fund ${wallet.address} with Arc testnet USDC and run:`);
console.log('  node scripts/arc-setup.ts        # depositFor(), signed by the org wallet under the mandate');
console.log('  node scripts/privy-mandate.ts    # the refusal, and the quorum that answers it');
