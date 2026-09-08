// MCP tool: get_offer.
//
// The step between "this agent exists" and "I am about to pay it". A buyer's
// agent hands over whatever identifier it happens to hold — an ENS name off a
// website, an `agentUid` from `find_sellers`, or a bare URL — and gets back one
// record saying what the thing costs, where to buy it, and whether it can be
// bought at all right now.
//
// The last of those is the field that matters. A published price and a payable
// quote are different objects, and an agent that conflates them will confidently
// try to pay an endpoint that does not exist.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { openStore } from '../store.ts';
import { getOffer } from '../offer.ts';
import type { OfferRecord } from '../offer.ts';

export const GET_OFFER_INPUT = {
  agent: z
    .string()
    .describe(
      'Who to price. One of: an ENS name ("liquidity.turnstile.eth"), an agentUid as returned by ' +
      'find_sellers ("eip155:11155111:0x8004…/10127"), or an http(s) URL of an endpoint to quote ' +
      'directly. A URL skips the directory entirely.',
    ),
  resource: z
    .string()
    .optional()
    .describe(
      'Buy from this URL instead of the one the agent published. Use it when a seller runs somewhere ' +
      'other than the address in its registration — including on localhost.',
    ),
  probe: z
    .boolean()
    .optional()
    .describe(
      'Ask the endpoint for a live 402. Default true. This is an unsolicited request to a third ' +
      "party's paid endpoint, so set it false to stay offline — but then nothing is purchasable, " +
      'because only a live quote can be paid.',
    ),
  live: z
    .boolean()
    .optional()
    .describe('Read ENS records from the chain rather than from the store. Needs an RPC endpoint.'),
  resolver: z
    .string()
    .optional()
    .describe(
      'Resolver address for a live read of a name the store does not hold. Required for such names: ' +
      'ENSv2 has no universal resolver to walk from a name alone on this deployment, and guessing ' +
      'one would produce a confident wrong answer.',
    ),
  rpcUrl: z.string().optional().describe('RPC endpoint for a live ENS read. Defaults to SEPOLIA_RPC_URL.'),
  chainId: z.number().int().optional().describe('Chain the resolver lives on. Defaults to the store, then Sepolia.'),
  timeoutMs: z.number().int().min(500).max(60_000).optional(),
};

export const GET_OFFER_DESCRIPTION =
  'Resolve one agent into an offer: what it charges, where to buy it, and whether it can be bought ' +
  'right now.\n\n' +
  'Accepts an ENS name, an agentUid from find_sellers, or a bare endpoint URL — nothing about the ' +
  'resolution is specific to any seller.\n\n' +
  'A price can come from an ENSv2 turnstile:price record (exact, published in advance), a live HTTP ' +
  '402 (what the seller will actually take, right now), a cached 402 (a price that WAS true), or a ' +
  'non-standard price object in the registration document. `offer.source` always says which.\n\n' +
  'Read `purchasable` before paying. It is true only when the endpoint answered 402 with a payable ' +
  'quote. A published price is not a quote: an agent can publish an exact price on chain and name an ' +
  'endpoint that does not resolve, and this tool will report the price and refuse to call it buyable.';

export function summarizeOffer(record: OfferRecord): string {
  const lines: string[] = [];
  const name = record.agent?.name ?? record.ens?.ensName ?? record.ref;
  lines.push(`${name} — resolved from ${record.refKind.replace('_', ' ')}.`);

  if (record.published) {
    lines.push(
      `Published price $${record.published.priceUsd ?? '?'} (${record.published.priceRaw}` +
      `${record.published.currency ? ` ${record.published.currency}` : ''}), from ${record.published.source}` +
      (record.published.ceilingUsd !== null ? `, under a cold-key ceiling of $${record.published.ceilingUsd}` : '') +
      '. A published price is what the seller intends to charge, not a quote.',
    );
  }

  const o = record.offer;
  if (o.source === 'x402_live') {
    lines.push(
      `Live quote: ${o.priceRaw} ${o.asset ?? ''} on ${o.network ?? '?'} to ${o.payTo ?? '?'}` +
      (o.priceUsd !== null ? ` — about $${o.priceUsd}` : ' — no dollar figure available') + '.',
    );
    lines.push(
      o.comparable
        ? 'That dollar figure is comparable to a budget: it is a recognised dollar stablecoin unit.'
        : "That dollar figure is the SELLER's own arithmetic and is NOT safe to check a budget against. " +
          "`purchase` re-prices the same offer with the buyer's own rate before the mandate sees it.",
    );
  } else if (o.priceUsd === null && o.source === 'ask_x402') {
    lines.push('No price published. The agent advertises x402 support, which means "ask the endpoint" — not "free".');
  } else if (!record.published) {
    lines.push('No price, and no published way to get one.');
  }

  lines.push(`Resource: ${o.resource ?? '(none published)'}`);
  lines.push(`Purchasable: ${record.purchasable.ok ? 'YES' : 'NO'} — ${record.purchasable.reason}`);

  if (record.ens) {
    lines.push(
      `ENS records read ${record.ens.readFrom === 'live' ? 'live from the chain' : 'from the store'}; ` +
      `resolver ${record.ens.resolverVerified ? 'verified against ENS VerifiableFactory' : 'NOT verified'}` +
      (record.ens.rails.length > 0 ? `; rails ${record.ens.rails.join(', ')}` : '') + '.',
    );
  }
  if (o.note) lines.push(`Note: ${o.note}`);
  for (const warning of record.warnings) lines.push(`WARNING: ${warning}`);
  return lines.join('\n');
}

export interface GetOfferToolOptions {
  dbPath: string;
}

export function registerGetOffer(server: McpServer, options: GetOfferToolOptions): void {
  server.registerTool(
    'get_offer',
    { title: 'Price one agent', description: GET_OFFER_DESCRIPTION, inputSchema: GET_OFFER_INPUT },
    async (args) => {
      // Opened per call: the sink writes to the same file, and a long-lived
      // reader in WAL mode pins the snapshot it started with.
      const db = openStore(options.dbPath);
      let record: OfferRecord;
      try {
        record = await getOffer(db, args.agent, {
          probe: args.probe,
          resource: args.resource,
          live: args.live,
          resolver: args.resolver,
          rpcUrl: args.rpcUrl,
          chainId: args.chainId,
          timeoutMs: args.timeoutMs,
        });
      } finally {
        db.close();
      }
      return {
        content: [
          { type: 'text' as const, text: summarizeOffer(record) },
          { type: 'text' as const, text: JSON.stringify(record, null, 2) },
        ],
      };
    },
  );
}
