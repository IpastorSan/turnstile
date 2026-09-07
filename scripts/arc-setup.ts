// Fund the buyer agent's mandate on Arc, without the agent ever sending a
// transaction.
//
//   node scripts/arc-setup.ts               # deposit the default allowance
//   node scripts/arc-setup.ts --amount 0.5  # a different allowance, in USDC
//   node scripts/arc-setup.ts --status      # read the two wallets and stop
//
// ## Why there are two keys and not one
//
// Circle Gateway pays gaslessly out of a **Gateway balance**, and creating one
// means depositing USDC into the GatewayWallet contract — which is a
// transaction, which costs gas. If the agent deposited for itself, the agent
// would have paid gas, and the zero-gas claim would be false in the first thirty
// seconds of the demo.
//
// `depositFor(amount, depositor)` is the way out, and it is not a trick: the
// caller pays the gas and the resulting balance belongs to the *named* address.
// So the warm tier (`ARC_ORG_*`) funds the mandate and eats the cost, and the
// hot tier (`ARC_AGENT_*`) receives spending power without ever touching the
// chain. That is `CLAUDE.md`'s cold/warm/hot hierarchy expressed in one contract
// call — and the hot key cannot reverse it, because depositing, withdrawing and
// transferring are all transactions and it has no gas for any of them.
//
// ## The number to watch
//
// The agent's **nonce**. It must be `0` before this script and `0` after it, and
// `0` after every payment for the rest of the demo. A wallet that has never
// submitted a transaction has never paid gas, and unlike a balance that is not
// something we can fake.

import { GatewayClient } from '@circle-fin/x402-batching/client';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { GATEWAY_CHAIN_NAME, arcscanAddressUrl, arcscanTransactionUrl } from '../rails/arc-usdc/config.ts';
import { formatUsdc, readArcWallet, sameBalance } from '../rails/arc-usdc/wallet.ts';

const args = process.argv.slice(2);
const statusOnly = args.includes('--status');
const amount = args.includes('--amount') ? args[args.indexOf('--amount') + 1]! : (process.env['ARC_MANDATE_ALLOWANCE'] ?? '0.25');

const rule = (title: string) => console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);

const orgKey = process.env['ARC_ORG_PRIVATE_KEY'];
const agentKey = process.env['ARC_AGENT_PRIVATE_KEY'];
if (!orgKey) throw new Error('set ARC_ORG_PRIVATE_KEY (the warm tier — it pays the deposit gas)');
if (!agentKey) throw new Error('set ARC_AGENT_PRIVATE_KEY (the hot tier — it must never send a transaction)');

const agent = privateKeyToAccount(agentKey as Hex).address;

// One `GatewayClient` for the org: it is the only party that transacts. A
// GatewayClient for the agent is deliberately never constructed with intent to
// send — `arc-paid-request.ts` reads the agent's balance through the org's
// client instead, so there is no code path that could spend the agent's gas.
const org = new GatewayClient({ chain: GATEWAY_CHAIN_NAME, privateKey: orgKey as Hex });

async function report(label: string): Promise<void> {
  const [orgState, agentState, orgGateway, agentGateway] = await Promise.all([
    readArcWallet(org.address),
    readArcWallet(agent as Address),
    org.getBalances(org.address),
    org.getBalances(agent as Address).catch(() => null),
  ]);

  rule(label);
  console.log(`warm / org    ${orgState.address}`);
  console.log(`  nonce       ${orgState.nonce}   (it transacts; this is expected to move)`);
  console.log(`  on chain    ${formatUsdc(orgState.usdc)} USDC   [native ${orgState.native} wei, same balance at 18 dp: ${sameBalance(orgState)}]`);
  console.log(`  gateway     ${orgGateway.gateway.formattedAvailable} USDC available`);
  console.log(`  ${arcscanAddressUrl(orgState.address)}`);
  console.log(`hot / agent   ${agentState.address}`);
  console.log(`  nonce       ${agentState.nonce}   <-- MUST STAY 0. This is the zero-gas proof.`);
  console.log(`  on chain    ${formatUsdc(agentState.usdc)} USDC   [native ${agentState.native} wei]`);
  console.log(`  gateway     ${agentGateway ? `${agentGateway.gateway.formattedAvailable} USDC available` : '(no Gateway balance yet)'}`);
  console.log(`  ${arcscanAddressUrl(agentState.address)}`);

  if (agentState.nonce !== 0) {
    console.warn('\n  WARNING: the agent has submitted a transaction. The zero-gas demonstration is void');
    console.warn('  for this wallet — generate a fresh ARC_AGENT_PRIVATE_KEY rather than explaining it away.');
  }
}

await report('BEFORE');

if (statusOnly) process.exit(0);

const orgBalance = await org.getUsdcBalance();
if (orgBalance.balance === 0n) {
  console.error(`\nThe org wallet holds no USDC. Fund ${org.address} at https://faucet.circle.com (chain: Arc Testnet).`);
  console.error('The faucet is reCAPTCHA-gated, so this step needs a human; CIRCLE_API_KEY does not carry the faucet scope.');
  process.exit(1);
}

rule(`DEPOSIT ${amount} USDC INTO THE AGENT'S GATEWAY BALANCE`);
console.log(`depositFor(${amount}, ${agent})`);
console.log('the org pays this transaction; the agent receives the balance and signs nothing\n');

const result = await org.depositFor(amount, agent as Address);
if (result.approvalTxHash) console.log(`approve  ${result.approvalTxHash}  ${arcscanTransactionUrl(result.approvalTxHash)}`);
console.log(`deposit  ${result.depositTxHash}  ${arcscanTransactionUrl(result.depositTxHash)}`);
console.log(`depositor ${result.depositor} (the agent, not the caller)`);

// Gateway credits a deposit after a short confirmation delay.
await new Promise(r => setTimeout(r, 8000));
await report('AFTER');

console.log('\nNext: node scripts/arc-paid-request.ts');
