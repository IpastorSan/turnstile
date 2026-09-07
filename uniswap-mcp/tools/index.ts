// MCP tool registrations.
//
// Five tools, in the order an agent that knows nothing would need them:
// resolve a token, find its pools, quote one size, walk the ladder, then ask
// the indexed history. Each returns a prose summary followed by the full JSON,
// because the caller is a model that acts on this and the caveats have to be
// unavoidable rather than merely present.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { resolveChain } from '../src/chains.ts';
import { getClient } from '../src/client.ts';
import type { ClientOptions } from '../src/client.ts';
import { readToken } from '../src/tokens.ts';
import { findPools, V3_FEE_TIERS } from '../src/pools.ts';
import { quoteV3, quoteV4 } from '../src/quotes.ts';
import { profileDepth } from '../src/depth.ts';
import { CANNED_QUERIES, querySubgraph } from '../src/subgraph.ts';
import {
  summarizeDepth,
  summarizePools,
  summarizeQuote,
  summarizeSubgraph,
  summarizeToken,
} from '../src/format.ts';

export interface ToolOptions {
  rpcUrl?: string;
  subgraphUrl?: string;
  clientOptions?: ClientOptions;
}

const chainArg = z
  .union([z.string(), z.number()])
  .optional()
  .describe('Chain name ("mainnet", "base", "arbitrum", "optimism", "polygon") or chain id. Default mainnet.');

function text(...parts: string[]) {
  return { content: parts.map((t) => ({ type: 'text' as const, text: t })) };
}

function failure(error: unknown) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

export function registerAll(server: McpServer, options: ToolOptions = {}): void {
  registerToken(server, options);
  registerFindPools(server, options);
  registerQuote(server, options);
  registerPoolDepth(server, options);
  registerAmmQuery(server, options);
}

// ---------------------------------------------------------------------------

export function registerToken(server: McpServer, options: ToolOptions = {}): void {
  server.registerTool(
    'uniswap_token',
    {
      title: 'Read ERC-20 metadata',
      description:
        'Read symbol, name and decimals for a token, from the token contract itself.\n\n'
        + 'Call this before any tool that takes an amount. `decimals` cannot be guessed: assuming '
        + '18 for a 6-decimal token understates an amount by a factor of a trillion, and the '
        + 'result is still a plausible-looking number, so the mistake propagates silently.\n\n'
        + 'The result also flags a token whose symbol collides with a well-known token at a '
        + 'different address. Symbols are not unique and are not identity — some of the '
        + 'highest-TVL-looking pools on mainnet are impersonators exploiting exactly that.',
      inputSchema: {
        address: z.string().describe('Token contract address.'),
        chain: chainArg,
      },
    },
    async (args) => {
      try {
        const config = resolveChain(args.chain);
        const { client } = await getClient(config, { ...options.clientOptions, rpcUrl: options.rpcUrl });
        const token = await readToken(client, config, args.address);
        return text(summarizeToken(token, config.name), JSON.stringify(token, null, 2));
      } catch (error) {
        return failure(error);
      }
    },
  );
}

// ---------------------------------------------------------------------------

export function registerFindPools(server: McpServer, options: ToolOptions = {}): void {
  server.registerTool(
    'uniswap_find_pools',
    {
      title: 'Find v3 pools for a token pair',
      description:
        'For a token pair, ask the Uniswap v3 factory which fee tiers actually have a pool, and '
        + 'report each one\'s address, in-range liquidity and current tick.\n\n'
        + 'The factory is authoritative and current; a hardcoded pool list is neither, and a '
        + 'subgraph is behind the chain. Use this before quoting, because a pool can exist with '
        + 'zero liquidity — it quotes as a revert rather than as a zero, and QuoterV2 reports that '
        + 'revert with the same opaque string it uses for "no pool here at all".',
      inputSchema: {
        tokenA: z.string().describe('First token address. Order does not matter.'),
        tokenB: z.string().describe('Second token address.'),
        chain: chainArg,
        feeTiers: z
          .array(z.number().int().positive())
          .optional()
          .describe(`Fee tiers in hundredths of a bip. Default ${V3_FEE_TIERS.join(', ')}.`),
      },
    },
    async (args) => {
      try {
        const config = resolveChain(args.chain);
        const { client } = await getClient(config, { ...options.clientOptions, rpcUrl: options.rpcUrl });
        const [tokenA, tokenB] = await Promise.all([
          readToken(client, config, args.tokenA),
          readToken(client, config, args.tokenB),
        ]);
        const result = await findPools(client, config, tokenA, tokenB, args.feeTiers ?? V3_FEE_TIERS);
        return text(summarizePools(result), JSON.stringify(result, null, 2));
      } catch (error) {
        return failure(error);
      }
    },
  );
}

// ---------------------------------------------------------------------------

export function registerQuote(server: McpServer, options: ToolOptions = {}): void {
  server.registerTool(
    'uniswap_quote',
    {
      title: 'Quote one trade size on one pool',
      description:
        'Quote an exact-input swap against a single Uniswap pool, live at the current block, via '
        + 'QuoterV2 (v3) or V4Quoter (v4).\n\n'
        + 'This is a *per-pool* quote, not a routed one. It answers "what will this specific pool '
        + 'do with this size", which is the question behind LP decisions and pool comparisons. It '
        + 'is not the question a swap router answers — a router splits across pools to get the '
        + 'best execution, and its answer tells you nothing about any one pool.\n\n'
        + 'On v3 the response carries `initializedTicksCrossed`, which is the most informative '
        + 'number available anywhere here: it says how many discrete bands of liquidity the trade '
        + 'consumed. No routed quoting API returns an equivalent. V4Quoter does not return it '
        + 'either.\n\n'
        + 'Requires no API key — it is an `eth_call` against a public contract.',
      inputSchema: {
        tokenIn: z.string().describe('Input token address.'),
        tokenOut: z.string().describe('Output token address.'),
        amountIn: z.number().positive().describe('Amount of tokenIn, in whole tokens (1.5, not 1500000).'),
        feeTier: z
          .number()
          .int()
          .positive()
          .describe('Fee tier in hundredths of a bip: 100, 500, 3000 or 10000. Use find_pools first.'),
        chain: chainArg,
        version: z
          .enum(['v3', 'v4'])
          .optional()
          .describe('Default v3. v4 additionally needs tickSpacing and hooks.'),
        tickSpacing: z.number().int().optional().describe('v4 only. Part of the PoolKey.'),
        hooks: z.string().optional().describe('v4 only. Hook address; the zero address for none.'),
      },
    },
    async (args) => {
      try {
        const config = resolveChain(args.chain);
        const { client } = await getClient(config, { ...options.clientOptions, rpcUrl: options.rpcUrl });
        const [tokenIn, tokenOut] = await Promise.all([
          readToken(client, config, args.tokenIn),
          readToken(client, config, args.tokenOut),
        ]);

        if ((args.version ?? 'v3') === 'v4') {
          if (args.tickSpacing === undefined) {
            throw new Error('v4 needs tickSpacing: it is part of the PoolKey and the pool cannot be identified without it.');
          }
          // A v4 PoolKey orders its currencies by address, and `zeroForOne`
          // states the direction relative to that ordering rather than to the
          // caller's argument order. Deriving it here rather than asking for it
          // removes the most common way to quote the wrong direction.
          const inIsCurrency0 = tokenIn.address.toLowerCase() < tokenOut.address.toLowerCase();
          const currency0 = inIsCurrency0 ? tokenIn.address : tokenOut.address;
          const currency1 = inIsCurrency0 ? tokenOut.address : tokenIn.address;
          const quote = await quoteV4(client, config, {
            currency0,
            currency1,
            fee: args.feeTier,
            tickSpacing: args.tickSpacing,
            hooks: (args.hooks ?? '0x0000000000000000000000000000000000000000') as `0x${string}`,
            zeroForOne: inIsCurrency0,
            tokenIn,
            tokenOut,
            amountIn: args.amountIn,
          });
          return text(
            summarizeQuote(quote, tokenIn, tokenOut, config.name),
            JSON.stringify(quote, null, 2),
          );
        }

        const quote = await quoteV3(client, config, {
          tokenIn,
          tokenOut,
          feeTier: args.feeTier,
          amountIn: args.amountIn,
        });
        return text(
          summarizeQuote(quote, tokenIn, tokenOut, config.name),
          JSON.stringify(quote, null, 2),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
}

// ---------------------------------------------------------------------------

export function registerPoolDepth(server: McpServer, options: ToolOptions = {}): void {
  server.registerTool(
    'uniswap_pool_depth',
    {
      title: 'Walk a size ladder against one v3 pool',
      description:
        'Quote a ladder of increasing sizes against one v3 pool, every rung pinned to the same '
        + 'block, and report the resulting curve: price impact and `initializedTicksCrossed` at '
        + 'each size, the largest size that fills at all, and an estimate of what fits inside a '
        + 'slippage budget.\n\n'
        + 'This is the tool to reach for when the question is "is this pool actually deep" rather '
        + 'than "what is the price". TVL does not answer it: a pool can hold a large notional and '
        + 'still be unable to fill a modest trade, because concentrated liquidity can sit far from '
        + 'the current tick. The tick count across the ladder is the mechanical reading — it says '
        + 'how many discrete bands of liquidity each size consumed.\n\n'
        + 'A rung that reverts is recorded as "cannot fill" and the walk continues. That is the '
        + 'measurement, not an error: the size at which a pool stops filling is the number being '
        + 'looked for.',
      inputSchema: {
        tokenIn: z.string().describe('Input token address.'),
        tokenOut: z.string().describe('Output token address.'),
        feeTier: z.number().int().positive().describe('Fee tier in hundredths of a bip.'),
        chain: chainArg,
        baseAmountIn: z
          .number()
          .positive()
          .optional()
          .describe('Smallest rung, in whole tokenIn units. The ladder is this x1, x10, x100, x1e3, x1e4. Default 1.'),
        amountsIn: z
          .array(z.number().positive())
          .optional()
          .describe('Explicit ladder in whole tokenIn units. Overrides baseAmountIn.'),
        slippageBudget: z
          .number()
          .positive()
          .max(1)
          .optional()
          .describe('Fraction, e.g. 0.01 for 1%. Default 0.01.'),
      },
    },
    async (args) => {
      try {
        const config = resolveChain(args.chain);
        const { client } = await getClient(config, { ...options.clientOptions, rpcUrl: options.rpcUrl });
        const [tokenIn, tokenOut] = await Promise.all([
          readToken(client, config, args.tokenIn),
          readToken(client, config, args.tokenOut),
        ]);
        const profile = await profileDepth(client, config, {
          tokenIn,
          tokenOut,
          feeTier: args.feeTier,
          baseAmountIn: args.baseAmountIn,
          amountsIn: args.amountsIn,
          slippageBudget: args.slippageBudget,
        });
        return text(summarizeDepth(profile), JSON.stringify(profile, null, 2));
      } catch (error) {
        return failure(error);
      }
    },
  );
}

// ---------------------------------------------------------------------------

export function registerAmmQuery(server: McpServer, options: ToolOptions = {}): void {
  server.registerTool(
    'uniswap_amm_query',
    {
      title: 'Query a Messari DEX AMM subgraph',
      description:
        'Run a GraphQL document against a Messari DEX AMM (Extended) v4.x subgraph — indexed '
        + 'history, which the on-chain quoter cannot give you: volume, TVL over time, fee '
        + 'revenue, positions, ticks.\n\n'
        + 'The schema is a published standard rather than a Uniswap-specific one, so the same '
        + 'document answers against Uniswap v3, Sushiswap v2 and v3, and Curve, on several '
        + 'chains, with no per-protocol adapter. `cumulativeVolumeUSD` means the same thing in '
        + 'every response, so ranking across protocols is arithmetic rather than a research '
        + 'project. Point `url` at any conformant subgraph.\n\n'
        + 'Every response carries how far behind the chain the subgraph is, because a figure from '
        + 'an indexer is a historical claim, not a current one. Pass `canned` to run a known-good '
        + `document without writing GraphQL: ${Object.keys(CANNED_QUERIES).join(', ')}.`,
      inputSchema: {
        query: z.string().optional().describe('A GraphQL document. Omit when using `canned`.'),
        canned: z
          .enum(['protocol_vitals', 'concentrated_liquidity', 'pool_history'])
          .optional()
          .describe('Run a prewritten document instead of supplying one.'),
        variables: z.record(z.unknown()).optional().describe('GraphQL variables.'),
        url: z
          .string()
          .optional()
          .describe('Subgraph endpoint. Defaults to AMM_SUBGRAPH_URL, then to the Turnstile Uniswap v3 Messari subgraph.'),
      },
    },
    async (args) => {
      try {
        const canned = args.canned ? CANNED_QUERIES[args.canned] : undefined;
        const document = args.query ?? canned?.document;
        if (!document) {
          throw new Error(
            `pass either \`query\` or \`canned\` (one of ${Object.keys(CANNED_QUERIES).join(', ')}).`,
          );
        }
        const response = await querySubgraph(document, {
          url: args.url ?? options.subgraphUrl,
          variables: args.variables,
        });
        return text(
          summarizeSubgraph(response),
          JSON.stringify({ document, ...response }, null, 2),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
}
