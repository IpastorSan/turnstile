// The worked example: an agent discovers a seller it has never seen, pays it,
// and reasons over the answer — with no API key anywhere in the flow.
//
//   set -a; source .env; set +a          # the buyer's wallet key, and nothing else
//   node mcp-turnstile/examples/discover-pay-reason.ts
//   node mcp-turnstile/examples/discover-pay-reason.ts --dry-run   # no wallet needed
//
// ## What is real here
//
// The directory is real: 197 ERC-8004 registrations across mainnet, Base and
// Sepolia, indexed from chain events. The price is real: a `turnstile:price`
// text record on an ENSv2 name, written by a hot key under a cold-key ceiling.
// The payment is real: HBAR moving on Hedera testnet through the public
// Blocky402 facilitator, with a HashScan link at the end. The receipts are real:
// messages on a public consensus topic, read back with no key and checked
// against the ledger.
//
// ## What is local, and why
//
// Both sellers run on this machine. That is not a shortcut — it is the finding.
// `liquidity.turnstile.eth` publishes `agent-endpoint[mcp]` pointing at
// `https://mcp-eu.turnstile.xyz/…`, and that host does not resolve. Act 1 shows
// the MCP server reporting exactly that, refusing to call the offer purchasable,
// and only then buying from the address the seller actually serves at. A demo
// that skipped straight to the working URL would have hidden the one thing a
// buyer most needs this infrastructure to tell it.
//
// ## The credential story
//
// The buyer holds one secret: a Hedera key that signs one transfer inside a
// mandate it cannot widen. Not an API key, not an account with either seller, no
// signup. Discovery, pricing and receipt-reading use no credential at all — run
// with `--dry-run` and the whole flow works with an empty environment.
//
// The seller's upstream credentials never appear: that is the product. It sells
// the answer and keeps the method.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { createHederaRail } from '../../rails/hedera-x402/index.ts';
import { createArcRail } from '../../rails/arc-usdc/index.ts';
import { RailRegistry } from '../../rails/registry.ts';
import { createApp } from '../../seller/service/app.ts';
import { liveAnalyst } from '../../seller/service/analyst-port.ts';
import { fakeAnalyst } from '../../seller/service/testing.ts';
import { runBuyer } from './buyer-agent.ts';
import type { BuyerOutcome } from './buyer-agent.ts';
import { STRANGER_PRICE_USD, startStrangerSeller } from './stranger-seller.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'server.ts');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const live = argv.includes('--live');
const pool = argv[argv.indexOf('--pool') + 1]?.startsWith('0x')
  ? argv[argv.indexOf('--pool') + 1]!
  : '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640';

const rule = (title: string): void => console.log(`\n${'='.repeat(76)}\n${title}\n${'='.repeat(76)}`);
const step = (n: string, title: string): void => console.log(`\n--- ${n}  ${title}`);

function report(outcome: BuyerOutcome): void {
  for (const s of outcome.steps) {
    console.log(`\n[${s.step}]`);
    console.log(s.summary.split('\n').map((l) => `  ${l}`).join('\n'));
  }
  console.log(`\n[the agent's conclusion]`);
  for (const line of outcome.conclusion) console.log(`  ${line}`);
  if (outcome.settlement) console.log(`\n[settlement] ${JSON.stringify(outcome.settlement)}`);
}

/** Start the seller's own HTTP service, as `npm run serve` does. */
async function startTurnstileSeller(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const registry = new RailRegistry([createHederaRail(), createArcRail()]);
  const app = createApp({ registry, analyst: live ? liveAnalyst() : fakeAnalyst() });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve(); }); }),
  };
}

const hasWallet = Boolean(process.env['HEDERA_BUYER_ID'] && process.env['HEDERA_BUYER_KEY']);

rule('SETUP');
console.log(`buyer wallet     ${hasWallet ? `hedera ${process.env['HEDERA_BUYER_ID']}` : 'NONE — discovery and quoting still work; nothing will be paid'}`);
console.log(`API keys in use  none. Not for discovery, not for pricing, not for payment, not for receipts.`);
console.log(`analyst          ${live ? 'live subgraph' : 'fixture (pass --live for the real one)'}`);
console.log(`mode             ${dryRun ? 'DRY RUN — the mandate is applied and nothing is signed' : 'live payment'}`);

const turnstile = await startTurnstileSeller();
const stranger = await startStrangerSeller();
console.log(`turnstile seller ${turnstile.baseUrl}  (the service behind liquidity.turnstile.eth)`);
console.log(`stranger seller  ${stranger.baseUrl}  (strangergas.example — shares no seller code with it)`);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  // The child needs the wallet key and the RPC endpoint. Passed explicitly
  // rather than inherited so it is obvious what the MCP server is given.
  env: {
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? '',
    ...(process.env['HEDERA_BUYER_ID'] ? { HEDERA_BUYER_ID: process.env['HEDERA_BUYER_ID'] } : {}),
    ...(process.env['HEDERA_BUYER_KEY'] ? { HEDERA_BUYER_KEY: process.env['HEDERA_BUYER_KEY'] } : {}),
    ...(process.env['HEDERA_RECEIPT_TOPIC_ID'] ? { HEDERA_RECEIPT_TOPIC_ID: process.env['HEDERA_RECEIPT_TOPIC_ID'] } : {}),
    ...(process.env['SEPOLIA_RPC_URL'] ? { SEPOLIA_RPC_URL: process.env['SEPOLIA_RPC_URL'] } : {}),
  },
  stderr: 'pipe',
});

const mcp = new Client({ name: 'buyer-agent', version: '1.0.0' });
let failed = false;

try {
  await mcp.connect(transport);
  const tools = await mcp.listTools();
  console.log(`mcp server       ${tools.tools.map((t) => t.name).join(', ')}`);

  // ---------------------------------------------------------------- act one
  rule('ACT 1 — a seller the buyer has never heard of');
  console.log(
    'The buyer asks for a capability, not for a name. Everything it learns below —\n' +
    'the seller, its ENS name, its price, its payout account — arrives from the\n' +
    'directory and from the seller\'s own 402.',
  );

  step('1.1', 'discovery, then pricing at the address published ON CHAIN');
  const published = await runBuyer(mcp, {
    capability: ['liquidity'],
    chains: ['sepolia'],
    budgetUsd: 0.5,
    dryRun,
  });
  report(published);
  console.log(
    '\n  ^ This is the finding, not a failure. The seller publishes an exact price on\n' +
    '    an ENSv2 name and the endpoint that name points at does not resolve. The\n' +
    '    tool reports the price AND refuses to call it buyable. An agent that treated\n' +
    '    a published price as a quote would now be trying to pay a dead host.',
  );

  step('1.2', 'the same seller, at the address it actually serves');
  const act1 = await runBuyer(mcp, {
    capability: ['liquidity'],
    chains: ['sepolia'],
    budgetUsd: 0.5,
    resourceOverride: `${turnstile.baseUrl}/analyze/${pool}`,
    dryRun,
  });
  report(act1);

  // ---------------------------------------------------------------- act two
  rule('ACT 2 — the same buyer, a seller with nothing in common');
  console.log(
    `strangergas.example sells an hourly gas-fee window for $${STRANGER_PRICE_USD}, on a URL shape\n` +
    'Turnstile does not use, from a hand-rolled x402 handler that imports none of\n' +
    "Turnstile's seller code. The buyer function below is byte-identical to act 1's.",
  );

  step('2.1', 'quote and buy, from a URL alone');
  const act2 = await runBuyer(mcp, {
    capability: [],
    budgetUsd: 0.5,
    resource: `${stranger.baseUrl}/v1/gas-window/base`,
    dryRun,
  });
  report(act2);

  // --------------------------------------------------------------- receipts
  rule('THE AUDIT TRAIL — read with no key, checked against the ledger');
  const audit = await mcp.callTool({ name: 'receipts', arguments: { verify: true, limit: 100 } });
  const text = (audit as { content: { type: string; text?: string }[] }).content
    .filter((c) => c.type === 'text').map((c) => c.text ?? '');
  console.log(text[0]);

  rule('WHAT THIS PROVED');
  console.log(
    `  discovery      ${published.steps[0]?.summary.split('\n')[0] ?? ''}\n` +
    `  act 1 bought   ${act1.bought ? 'yes' : 'no'}   ${act1.settlement ? JSON.stringify(act1.settlement) : ''}\n` +
    `  act 2 bought   ${act2.bought ? 'yes' : 'no'}   ${act2.settlement ? JSON.stringify(act2.settlement) : ''}\n` +
    '\n' +
    '  The same buyer, unchanged, bought from two unrelated services. It knew\n' +
    "  neither seller's name, price, payout account or response schema before it ran.\n" +
    '  No API key was used at any point by either the buyer or the MCP server.',
  );
  // A dry run buys nothing by design, so it cannot be judged on `bought`.
  if (!dryRun && (!act1.bought || !act2.bought)) failed = true;
} catch (cause) {
  failed = true;
  console.error('\nFAILED:', cause instanceof Error ? cause.stack : cause);
} finally {
  await mcp.close().catch(() => {});
  await turnstile.close();
  await stranger.close();
}

process.exit(failed ? 1 : 0);
