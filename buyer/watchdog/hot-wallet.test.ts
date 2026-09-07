// The claim this whole design rests on, as a test rather than a paragraph.
//
// > The hot wallet signs an EIP-3009 authorization **offchain and never submits
// > a transaction**, so it pays exactly zero gas.
//
// The evidence is its **nonce**. `eth_getTransactionCount` staying `0` across
// every settled payment is unforgeable and on chain — unlike a balance, it
// cannot be topped up to look right. MOV-225 established it across eleven
// settled payments; MOV-228 changed who funds the agent, and this file exists so
// that change cannot quietly break it.
//
// ## Two tests, and why the second one is the load-bearing one
//
// The live check needs `.env` and a network, and CI has neither — it skips
// there, loudly, rather than passing vacuously. So there is a second, **pure**
// test asserting the property that makes the first one true: nothing on the
// funding path constructs a wallet client for the agent. A signature is a
// transaction is gas, and the way this claim dies is a later edit adding a
// convenience `walletClient` for the agent key, not a deliberate transfer.
//
// `buyer/org/org.test.ts` holds the matching assertion from the other side: the
// deposit is signed by the *org* wallet id and names the agent only as
// `depositFor`'s depositor.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';

import { readArcWallet } from '../../rails/arc-usdc/wallet.ts';

const agentKey = process.env['ARC_AGENT_PRIVATE_KEY'];

test('the hot wallet has still never submitted a transaction', { skip: agentKey ? false : 'ARC_AGENT_PRIVATE_KEY is not set — source .env to run this against live Arc' }, async t => {
  const agent = privateKeyToAccount((agentKey!.startsWith('0x') ? agentKey! : `0x${agentKey!}`) as Hex).address as Address;

  let state: Awaited<ReturnType<typeof readArcWallet>>;
  try {
    state = await readArcWallet(agent);
  } catch (error) {
    // A silent pass would be worse than a skip: this test's whole value is that
    // it fails when the number changes.
    t.skip(`Arc RPC unreachable (${(error as Error).message.split('\n')[0]}) — not asserting a claim we could not read`);
    return;
  }

  assert.equal(state.nonce, 0, `${agent} has submitted ${state.nonce} transaction(s). The zero-gas demonstration is void for this wallet — generate a fresh ARC_AGENT_PRIVATE_KEY rather than explaining it away`);
  assert.equal(state.native, 0n, `${agent} holds native token. On Arc that is the same balance as its USDC, so a non-zero value means it was funded on chain rather than through the warm tier's depositFor()`);
  assert.equal(state.usdc, 0n, `${agent} holds USDC on chain. Its spending power must live in its Gateway balance, not in its wallet`);
});

test('the agent\'s key reaches the signer and nothing else, and the signer cannot transact', async () => {
  // The pure guard. MOV-228 moved the deposit from a plain key to a Privy
  // wallet, and the tempting next edit is "just give the agent a walletClient so
  // it can top itself up" — one line, and the claim is over.
  //
  // Two different rules, because the agent key is not forbidden everywhere. It
  // *belongs* in `arc-signer.ts`: signing an EIP-3009 authorization is a local
  // operation that opens no connection and sends nothing. What must never appear
  // there is a way to broadcast.
  const source = async (relative: string): Promise<string> => {
    const text = await readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
    // Strip comments — this file, and the ones it reads, discuss these names.
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  };

  for (const relative of ['../org/fund-agent.ts', '../org/org-wallet.ts', '../org/privy.ts', '../mandate/policy.ts']) {
    assert.equal(/ARC_AGENT_PRIVATE_KEY/.test(await source(relative)), false, `${relative} reads the agent's key. Only the signer and the scripts may`);
  }

  const signer = await source('./arc-signer.ts');
  for (const forbidden of ['createWalletClient', 'sendTransaction', 'writeContract', 'sendRawTransaction']) {
    assert.equal(signer.includes(forbidden), false, `arc-signer.ts contains ${forbidden}. The agent holds a key precisely because it can only sign offchain`);
  }
});
