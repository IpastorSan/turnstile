// Fund the buyer agent's mandate on Arc, without the agent ever sending a
// transaction.
//
//   node scripts/arc-setup.ts               # deposit the default allowance
//   node scripts/arc-setup.ts --amount 0.5  # a different allowance, in USDC
//   node scripts/arc-setup.ts --status      # read the two wallets and stop
//   node scripts/arc-setup.ts --seed 2      # one-time: move USDC from the legacy key
//
// ## Why there are two wallets and not one
//
// Circle Gateway pays gaslessly out of a **Gateway balance**, and creating one
// means depositing USDC into the GatewayWallet contract — which is a
// transaction, which costs gas. If the agent deposited for itself, the agent
// would have paid gas, and the zero-gas claim would be false in the first thirty
// seconds of the demo.
//
// `depositFor(token, depositor, value)` is the way out, and it is not a trick:
// the caller pays the gas and the resulting balance belongs to the *named*
// address. So the warm tier funds the mandate and eats the cost, and the hot
// tier (`ARC_AGENT_*`) receives spending power without ever touching the chain.
// That is `CLAUDE.md`'s cold/warm/hot hierarchy expressed in one contract call —
// and the hot key cannot reverse it, because depositing, withdrawing and
// transferring are all transactions and it has no gas for any of them.
//
// ## Correction (2026-09-07, MOV-228): the warm tier is no longer a plain key
//
// This script used to read `ARC_ORG_PRIVATE_KEY` — a raw secp256k1 key at
// `0xdFe3088aC34e7329006407C246C9F6D7534B2aC5` — and call Circle's
// `GatewayClient.depositFor()` with it. **The mechanism above is unchanged.**
// What changed is the key holder: the depositor is now a **Privy server
// wallet**, owned by a 1-of-N operations quorum of human operators and governed
// by a mandate policy that Privy's enclave enforces before it will produce a
// signature.
//
// Three things follow, and they are the reason for the change:
//
//   1. There is no org private key on this machine. Reading `.env` no longer
//      yields the ability to spend.
//   2. An over-cap deposit is refused by Privy, not by us. It would refuse the
//      same request from someone holding our app secret.
//   3. Raising the cap needs **two** operators — `npm run privy:mandate`.
//
// `ARC_ORG_PRIVATE_KEY` is still read for exactly one thing: `--seed`, the
// one-time transfer that moves testnet USDC from the legacy key to the new org
// wallet, because Circle's faucet is reCAPTCHA-gated and cannot fund a new
// address unattended. It is not on the deposit path and does not need to exist
// for a normal run.
//
// ## The number to watch
//
// The agent's **nonce**. It must be `0` before this script and `0` after it, and
// `0` after every payment for the rest of the demo. A wallet that has never
// submitted a transaction has never paid gas, and unlike a balance that is not
// something we can fake.

import { createWalletClient, erc20Abi, getAddress, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet } from 'viem/chains';

import { PrivyClient, credentialsFromEnv, getOrgWallet } from '../buyer/org/index.ts';
import { loadOrgFromEnv } from '../buyer/org/env.ts';
import { fundAgentMandate } from '../buyer/org/fund-agent.ts';
import { RPC_URL, USDC_ASSET, arcscanAddressUrl, arcscanTransactionUrl } from '../rails/arc-usdc/config.ts';
import { arcClient, formatUsdc, gatewayBalance, readArcWallet, sameBalance } from '../rails/arc-usdc/wallet.ts';
import { usdToUsdcAtomic } from '../buyer/mandate/index.ts';

const args = process.argv.slice(2);
const statusOnly = args.includes('--status');
const seedIndex = args.indexOf('--seed');
const seedAmount = seedIndex === -1 ? null : args[seedIndex + 1] ?? '2';
const amount = args.includes('--amount') ? args[args.indexOf('--amount') + 1]! : (process.env['ARC_MANDATE_ALLOWANCE'] ?? '0.25');

const rule = (title: string) => console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);

const agentKey = process.env['ARC_AGENT_PRIVATE_KEY'];
if (!agentKey) throw new Error('set ARC_AGENT_PRIVATE_KEY (the hot tier — it must never send a transaction)');
const agent = privateKeyToAccount(agentKey as Hex).address;

const privy = new PrivyClient(credentialsFromEnv());
const org = loadOrgFromEnv();
const orgWallet = await getOrgWallet(privy, org.walletId);
const orgAddress = getAddress(orgWallet.address);
const [approver] = org.operators;
if (!approver) throw new Error('no operator keys in .env — run `npm run privy:setup`');

async function report(label: string): Promise<void> {
  const [orgState, agentState, orgGateway, agentGateway] = await Promise.all([
    readArcWallet(orgAddress),
    readArcWallet(agent as Address),
    gatewayBalance(orgAddress),
    gatewayBalance(agent as Address),
  ]);

  rule(label);
  console.log(`warm / org    ${orgState.address}   (Privy wallet ${orgWallet.id})`);
  console.log(`  owner       ${orgWallet.owner_id}   operations quorum — ${approver!.handle} can approve alone`);
  console.log(`  policy      ${orgWallet.policy_ids.join(', ')}   raising its cap needs the board quorum`);
  console.log(`  nonce       ${orgState.nonce}   (it transacts; this is expected to move)`);
  console.log(`  on chain    ${formatUsdc(orgState.usdc)} USDC   [native ${orgState.native} wei, same balance at 18 dp: ${sameBalance(orgState)}]`);
  console.log(`  gateway     ${orgGateway ? `${orgGateway.available} USDC available` : '(no Gateway balance)'}`);
  console.log(`  ${arcscanAddressUrl(orgState.address)}`);
  console.log(`hot / agent   ${agentState.address}`);
  console.log(`  nonce       ${agentState.nonce}   <-- MUST STAY 0. This is the zero-gas proof.`);
  console.log(`  on chain    ${formatUsdc(agentState.usdc)} USDC   [native ${agentState.native} wei]`);
  console.log(`  gateway     ${agentGateway ? `${agentGateway.available} USDC available` : '(no Gateway balance yet)'}`);
  console.log(`  ${arcscanAddressUrl(agentState.address)}`);

  if (agentState.nonce !== 0) {
    console.warn('\n  WARNING: the agent has submitted a transaction. The zero-gas demonstration is void');
    console.warn('  for this wallet — generate a fresh ARC_AGENT_PRIVATE_KEY rather than explaining it away.');
  }
}

await report('BEFORE');

if (statusOnly) process.exit(0);

// --- one-time migration ------------------------------------------------------
//
// The Privy org wallet starts empty and Circle's faucet needs a human, so the
// legacy key hands over its testnet USDC once. This is the *only* thing
// ARC_ORG_PRIVATE_KEY is still used for, and it is not on the deposit path.
if (seedAmount !== null) {
  const legacyKey = process.env['ARC_ORG_PRIVATE_KEY'];
  if (!legacyKey) throw new Error('--seed needs ARC_ORG_PRIVATE_KEY, the legacy warm key it moves USDC out of');
  const legacy = privateKeyToAccount(legacyKey as Hex);

  rule(`SEED ${seedAmount} USDC: LEGACY KEY -> PRIVY ORG WALLET`);
  console.log(`${legacy.address}  ->  ${orgAddress}`);
  console.log('one-time. Circle\'s faucet is reCAPTCHA-gated, so a fresh address cannot fund itself.\n');

  const wallet = createWalletClient({ account: legacy, chain: arcTestnet, transport: http(process.env['ARC_RPC_URL'] ?? RPC_URL) });
  const hash = await wallet.writeContract({
    address: getAddress(USDC_ASSET),
    abi: erc20Abi,
    functionName: 'transfer',
    args: [orgAddress, usdToUsdcAtomic(Number(seedAmount))],
  });
  console.log(`transfer  ${hash}  ${arcscanTransactionUrl(hash)}`);
  // Wait for it. Reporting before the receipt shows a zero balance and reads as
  // a failed transfer, which cost one confused run.
  await arcClient().waitForTransactionReceipt({ hash });
  await report('AFTER SEEDING');
}

// --- the deposit -------------------------------------------------------------

const onChain = await readArcWallet(orgAddress);
if (onChain.usdc === 0n) {
  console.error(`\nThe org wallet holds no USDC. Either:`);
  console.error(`  node scripts/arc-setup.ts --seed 2        # move some from the legacy key`);
  console.error(`  or fund ${orgAddress} at https://faucet.circle.com (chain: Arc Testnet)`);
  console.error('The faucet is reCAPTCHA-gated, so that second path needs a human.');
  process.exit(1);
}

rule(`DEPOSIT ${amount} USDC INTO THE AGENT'S GATEWAY BALANCE`);
console.log(`depositFor(USDC, ${agent}, ${usdToUsdcAtomic(Number(amount))})`);
console.log(`signed by the Privy org wallet, approved by ${approver.handle} (${approver.role}), within the mandate policy`);
console.log('the org pays this transaction; the agent receives the balance and signs nothing\n');

const result = await fundAgentMandate({
  privy,
  walletId: org.walletId,
  walletAddress: orgAddress,
  agentAddress: agent as Address,
  amountUsd: Number(amount),
  approvals: [approver.key],
  onStep: message => console.log(`  ${message}`),
});
console.log(`\ndepositor ${result.depositor} (the agent, not the caller)`);

// Gateway credits a deposit after a short confirmation delay.
await new Promise(r => setTimeout(r, 8000));
await report('AFTER');

console.log('\nNext: node scripts/arc-paid-request.ts');
