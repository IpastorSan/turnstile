// MCP tool: purchase.
//
// The tool that spends money, and therefore the one whose description has to be
// hardest to misread. Three things are load-bearing:
//
//   1. `maxPriceUsd` is required. There is no default cap, because a default cap
//      is a number nobody chose being applied to somebody's wallet.
//   2. `dryRun` fetches the real 402 and applies the real mandate without
//      signing anything, and needs no key. An agent deciding *whether* to buy
//      should call that.
//   3. The result's `status` distinguishes "the seller was free", "the mandate
//      refused", "no signer", "settlement failed" and "bought". Collapsing those
//      into success/failure destroys the only information the caller can act on.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { openStore } from '../store.ts';
import { getOffer } from '../offer.ts';
import { purchase } from '../purchase.ts';
import type { PurchaseResult } from '../purchase.ts';
import { knownRails } from '../signers.ts';

export const PURCHASE_INPUT = {
  resource: z
    .string()
    .optional()
    .describe('URL to buy from. Either this or `agent` is required; this one wins if both are given.'),
  agent: z
    .string()
    .optional()
    .describe(
      'An ENS name, an agentUid or a URL, resolved the same way get_offer resolves it, to find the ' +
      'resource. Use `resource` directly when you already know where to buy.',
    ),
  maxPriceUsd: z
    .number()
    .positive()
    .describe(
      'Hard per-payment ceiling in decimal US dollars. REQUIRED — there is no default. The cap is ' +
      "applied to the buyer's own valuation of the asset, never to the seller's declared rate, " +
      'because a cap a counterparty can move is not a cap.',
    ),
  rails: z
    .array(z.string())
    .optional()
    .describe(
      `Rail preference, best first (known rails: ${knownRails().join(', ')}). Defaults to every rail ` +
      'this buyer holds a signer for. An offer on a rail not listed here is refused.',
    ),
  method: z.enum(['GET', 'POST']).optional().describe('Defaults to GET, or POST when a body is given.'),
  body: z.unknown().optional().describe('JSON request body. Sent on both the unpaid and the paid request.'),
  headers: z.record(z.string()).optional().describe('Extra request headers.'),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      'Fetch the 402, apply the mandate, and stop. Signs nothing and moves nothing. It still needs a ' +
      "signer, because the cap is applied to the buyer's own valuation of the asset; with no signer " +
      'the result is `no_signer` and still carries the real quote.',
    ),
  timeoutMs: z.number().int().min(1000).max(120_000).optional(),
};

export const PURCHASE_DESCRIPTION =
  'Buy an answer from an agent over x402, inside a mandate.\n\n' +
  'Fetches the resource, reads the 402 it returns, checks the price and rail against the mandate, ' +
  'pays, and returns what the seller sent back plus the settlement id. This is protocol, not product: ' +
  'it pays ANY x402 seller and has no branch for any particular one.\n\n' +
  'Statuses: `purchased` (paid and delivered), `would_purchase` (dryRun), `free` (the endpoint served ' +
  'without asking for money — common, not an error), `unpayable` (no x402 challenge came back), ' +
  '`refused` (the mandate authorizes none of the offers, with a reason for each), `no_signer` (a real ' +
  'quote and no wallet configured), `settlement_failed` (nothing was charged and nothing delivered).\n\n' +
  'The only credential this needs is the buyer agent\'s own wallet key. There is no API key, no ' +
  'account with the seller and no signup: the price and the payout address both arrive in the 402. ' +
  'Fetching that quote needs no credential at all — only signing the payment does.';

export function summarizePurchase(result: PurchaseResult): string {
  const lines = [`${result.status.toUpperCase()}: ${result.summary}`];
  if (result.accepts.length > 0) {
    lines.push(
      `Seller offered ${result.accepts.length} way(s) to pay (read from the ${result.challengeFrom}): ` +
      result.accepts.map((a) => `${a.scheme}/${a.network} ${a.amount} ${a.asset}`).join(' | '),
    );
  }
  if (result.decision && result.decision.rejected.length > 0) {
    lines.push(
      'Refused: ' + result.decision.rejected.map((r) => `${r.requirement.scheme}/${r.requirement.network} — ${r.reason}`).join('; '),
    );
  }
  if (result.settlement) {
    lines.push(
      `Settled ${result.settlement.amount} on ${result.settlement.network}, transaction ${result.settlement.transaction}` +
      (result.settlement.explorer ? `\n${result.settlement.explorer}` : ''),
    );
  }
  for (const gap of result.signerGaps) lines.push(`No signer for ${gap.railId}: ${gap.why} (set ${gap.needs.join(', ')}).`);
  for (const warning of result.warnings) lines.push(`WARNING: ${warning}`);
  return lines.join('\n');
}

export interface PurchaseToolOptions {
  dbPath: string;
}

export function registerPurchase(server: McpServer, options: PurchaseToolOptions): void {
  server.registerTool(
    'purchase',
    { title: 'Pay an agent and get the answer', description: PURCHASE_DESCRIPTION, inputSchema: PURCHASE_INPUT },
    async (args) => {
      let resource = args.resource;
      const notes: string[] = [];

      if (!resource) {
        if (!args.agent) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: 'purchase needs either `resource` (a URL) or `agent` (an ENS name, agentUid or URL).' }],
          };
        }
        const db = openStore(options.dbPath);
        try {
          // Resolved without probing: `purchase` is about to make the same
          // request itself, and a paid endpoint should not be asked twice for
          // the same quote just to fill in a field.
          const record = await getOffer(db, args.agent, { probe: false });
          resource = record.offer.resource ?? undefined;
          if (!resource) {
            return {
              isError: true,
              content: [{
                type: 'text' as const,
                text: `${args.agent} publishes no endpoint to buy from. ${record.warnings.join(' ')} Pass \`resource\` directly if you know one.`,
              }],
            };
          }
          notes.push(`resource ${resource} resolved from ${args.agent}`);
        } finally {
          db.close();
        }
      }

      const result = await purchase({
        resource,
        // True only when the caller named the URL. A resource resolved out of a
        // stranger's registration document must not reach a private address.
        allowPrivateHosts: args.resource !== undefined,
        maxPriceUsd: args.maxPriceUsd,
        rails: args.rails,
        method: args.method,
        body: args.body,
        headers: args.headers,
        dryRun: args.dryRun,
        timeoutMs: args.timeoutMs,
      });
      result.warnings.push(...notes);

      return {
        content: [
          { type: 'text' as const, text: summarizePurchase(result) },
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );
}
