// MCP tool: find_sellers.
//
// The buyer's agent asks this before it opens its wallet. The contract it
// enforces is that the answer never overstates what it knows:
//
//   - every result carries `priceSource`, so an agent cannot mistake "we have
//     not asked yet" for "this is free";
//   - `ranking.placeholder` is true while settled volume does not exist, and
//     the note says why;
//   - agents whose document could not be fetched are marked `failed`, not
//     dropped, so the caller sees the shape of what discovery could not reach.
//
// An agent that acts on this output is about to spend money. Anything it cannot
// verify has to arrive labelled.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { DEFAULT_DB_PATH, openDb } from '../../graph/sink/db.ts';
import { findSellers } from '../../seller/service/discovery.ts';
import type { FindSellersQuery, FindSellersResult } from '../../seller/service/discovery.ts';

export const FIND_SELLERS_INPUT = {
  capability: z
    .array(z.string())
    .optional()
    .describe(
      'Capability tokens, e.g. ["liquidity", "analytics"]. An agent matching ANY token qualifies. ' +
      'Matched first against skills and domains the agent declared, then against its name and ' +
      'description; each result reports which in `matchedOn`.',
    ),
  maxPriceUsd: z
    .number()
    .positive()
    .optional()
    .describe(
      'Price ceiling in USD. Only applied to agents whose price is actually knowable — a Turnstile ' +
      'seller with a turnstile:price record, or an agent with a fetched 402 quote. Agents whose ' +
      'price cannot be established are excluded unless includeUnknownPrice is set, and the count is ' +
      'reported in coverage.droppedForUnknownPrice.',
    ),
  chains: z
    .array(z.union([z.string(), z.number()]))
    .optional()
    .describe('Networks ("base", "mainnet", "sepolia") or numeric chain ids. Omit for every chain.'),
  requireX402: z
    .boolean()
    .optional()
    .describe('Only agents advertising x402Support — the registry signal meaning "this agent can be paid".'),
  turnstileOnly: z
    .boolean()
    .optional()
    .describe('Only Turnstile sellers, i.e. the agents whose price is published on an ENSv2 name.'),
  includeUnknownPrice: z
    .boolean()
    .optional()
    .describe('Keep agents with no knowable price even when maxPriceUsd is set. They arrive with price: null.'),
  limit: z.number().int().min(1).max(100).optional().describe('Results to return. Default 20.'),
  offset: z.number().int().min(0).optional(),
};

export const FIND_SELLERS_DESCRIPTION =
  'Find agents that can sell a service, across every chain that hosts an ERC-8004 Identity Registry, ' +
  'and rank them.\n\n' +
  'Discovery is a three-way join. The ERC-8004 registry says who exists — it has no price field, so ' +
  'it can never say what anything costs. Turnstile sellers publish an exact price in an ENSv2 ' +
  'turnstile:price record. Everyone else only reveals a price in a live HTTP 402 response. Each ' +
  'result therefore carries priceSource: turnstile | x402 | document | ask_x402 | none. ' +
  '"ask_x402" means the agent takes payment but has not been quoted yet — it is not a free service.\n\n' +
  'Ranking is by settled volume where settlement receipts exist. They do not yet (MOV-220), so ' +
  'results come back ordered by registration recency with ranking.placeholder = true. Do not read ' +
  'that order as reputation.';

/** Shaped for an agent reading the result, not for a human reading a table. */
export function summarize(result: FindSellersResult): string {
  const c = result.coverage;
  const lines = [
    `${result.sellers.length} of ${c.matchedBeforePriceFilter} matching agents, ` +
    `from ${c.totalAgents} in the store across ${c.chains.length} chains ` +
    `(${c.chains.map((x) => `${x.network}:${x.agents}`).join(', ')}).`,
    `Ranking: ${result.ranking.basis}${result.ranking.placeholder ? ' — PLACEHOLDER, not a reputation signal' : ''}.`,
  ];
  if (c.droppedForUnknownPrice > 0) {
    lines.push(
      `${c.droppedForUnknownPrice} agents were excluded because their price is not knowable from ` +
      `on-chain data. Set includeUnknownPrice to see them, or probe their x402 endpoints for a quote.`,
    );
  }
  if (c.droppedForPriceCeiling > 0) {
    lines.push(`${c.droppedForPriceCeiling} agents were over the price ceiling.`);
  }
  const failed = c.documentStates.failed ?? 0;
  if (failed > 0) {
    lines.push(
      `${failed} agents in the store have a registration document that could not be fetched ` +
      `(404, timeout or unreachable gateway). They are listed with documentState "failed": their ` +
      `capabilities are unknown, not absent.`,
    );
  }
  return lines.join('\n');
}

export interface FindSellersToolOptions {
  dbPath?: string;
}

export function registerFindSellers(server: McpServer, options: FindSellersToolOptions = {}): void {
  const dbPath = options.dbPath ?? DEFAULT_DB_PATH;

  server.registerTool(
    'find_sellers',
    {
      title: 'Find and rank agent sellers',
      description: FIND_SELLERS_DESCRIPTION,
      inputSchema: FIND_SELLERS_INPUT,
    },
    async (args) => {
      const query: FindSellersQuery = {
        capabilities: args.capability,
        maxPriceUsd: args.maxPriceUsd,
        chains: args.chains,
        requireX402: args.requireX402,
        turnstileOnly: args.turnstileOnly,
        includeUnknownPrice: args.includeUnknownPrice,
        limit: args.limit,
        offset: args.offset,
      };

      // Opened per call rather than held: the sink writes to the same file, and
      // a long-lived reader in WAL mode pins the snapshot it started with, so a
      // server that stayed connected would keep serving a directory that had
      // stopped being current.
      const db = openDb(dbPath);
      let result: FindSellersResult;
      try {
        result = findSellers(db, query);
      } finally {
        db.close();
      }

      return {
        content: [
          { type: 'text' as const, text: summarize(result) },
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );
}
