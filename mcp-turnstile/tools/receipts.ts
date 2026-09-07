// MCP tool: receipts.
//
// What a seller has actually been paid, read off a public consensus topic with
// no key — and, with `verify`, cross-checked against the ledger so that a claim
// becomes evidence.
//
// This is the tool that makes a ranking worth reading. `find_sellers` orders by
// registration recency and labels itself a placeholder precisely because settled
// volume did not exist to rank on; these are the rows that change that, and a
// buyer can compute the same number by the same route without asking us.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { readReceipts } from '../receipts.ts';
import type { ReceiptsResult } from '../receipts.ts';

export const RECEIPTS_INPUT = {
  topic: z
    .string()
    .optional()
    .describe(
      'Hedera Consensus Service topic id ("0.0.10408013"). Defaults to HEDERA_RECEIPT_TOPIC_ID. ' +
      'Nothing on chain binds a seller to a topic yet, so this has to be supplied by whoever knows it.',
    ),
  transaction: z.string().optional().describe('Only the receipt for this settlement transaction id.'),
  payTo: z.string().optional().describe('Only receipts paying this account.'),
  resource: z.string().optional().describe('Only receipts whose bought resource URL contains this string.'),
  verify: z
    .boolean()
    .optional()
    .describe(
      'Cross-check every receipt against the ledger: does the transaction exist, did it succeed, and ' +
      'did it credit the claimed payee with the claimed amount? Costs one mirror-node request each. ' +
      'Set this whenever the topic has no submit key.',
    ),
  limit: z.number().int().min(1).max(100).optional().describe('Messages to read. Default 100.'),
  mirrorNodeUrl: z.string().optional().describe('Mirror node base URL. Defaults to the public Hedera testnet one.'),
};

export const RECEIPTS_DESCRIPTION =
  'Read a seller\'s settlement receipts off a Hedera Consensus Service topic, through the public ' +
  'mirror node, with no API key and no wallet.\n\n' +
  'Each receipt names the settlement transaction, the rail, the amount, the payer, the payee and the ' +
  'resource that was bought. It never carries the answer that was sold: the topic is public, and ' +
  'writing the verdict into it would give away permanently what the buyer just paid for.\n\n' +
  'Two caveats travel with every result. First, no on-chain record binds a seller to a receipt topic, ' +
  'so the topic id has to come from somewhere trusted. Second, a topic with no submit key can be ' +
  'appended to by anyone — so a receipt is a CLAIM until `verify` checks it against the ledger, and ' +
  '`submitKey: null` in the result means exactly that.';

export function summarizeReceipts(result: ReceiptsResult): string {
  const lines: string[] = [];
  if (!result.topic) {
    lines.push('No topic to read.');
  } else {
    lines.push(
      `${result.totals.receipts} receipt(s) on topic ${result.topic}, ` +
      `$${result.totals.settledUsd} settled in total, via ${Object.entries(result.totals.byRail).map(([r, n]) => `${r}×${n}`).join(', ') || 'no rail'}.`,
    );
    if (result.window) lines.push(`Consensus window ${result.window.firstConsensus} … ${result.window.lastConsensus}.`);
    for (const payee of result.totals.byPayee) {
      lines.push(`  ${payee.payTo}: ${payee.count} payment(s), $${payee.usd}`);
    }
    if (result.totals.verified) {
      lines.push(
        'Ledger check: ' + Object.entries(result.totals.verified).map(([status, n]) => `${n} ${status}`).join(', ') + '.',
      );
    }
  }
  for (const note of result.notes) lines.push(note);
  return lines.join('\n');
}

export function registerReceipts(server: McpServer): void {
  server.registerTool(
    'receipts',
    { title: 'Read the settlement audit trail', description: RECEIPTS_DESCRIPTION, inputSchema: RECEIPTS_INPUT },
    async (args) => {
      const result = await readReceipts({
        topic: args.topic,
        transaction: args.transaction,
        payTo: args.payTo,
        resource: args.resource,
        verify: args.verify,
        limit: args.limit,
        mirrorNodeUrl: args.mirrorNodeUrl,
      });
      return {
        content: [
          { type: 'text' as const, text: summarizeReceipts(result) },
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );
}
