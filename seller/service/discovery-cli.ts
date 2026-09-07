#!/usr/bin/env node
// Human-readable front end for findSellers(). The MCP tool is the real
// interface; this exists so the join can be inspected from a terminal.
//
//   node seller/service/discovery-cli.ts --capability liquidity --max-price 0.10
//   node seller/service/discovery-cli.ts --chains base,mainnet --limit 5 --json

import { fileURLToPath } from 'node:url';

import { DEFAULT_DB_PATH, openDb } from '../../graph/sink/db.ts';
import { findSellers } from './discovery.ts';
import type { FindSellersQuery } from './discovery.ts';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const chains = get('--chains');
  const maxPrice = get('--max-price');
  const query: FindSellersQuery = {
    capabilities: get('--capability')?.split(',').map((s) => s.trim()).filter(Boolean),
    maxPriceUsd: maxPrice === undefined ? undefined : Number(maxPrice),
    chains: chains
      ? chains.split(',').map((c) => (/^\d+$/.test(c.trim()) ? Number(c.trim()) : c.trim()))
      : undefined,
    requireX402: argv.includes('--x402'),
    turnstileOnly: argv.includes('--turnstile-only'),
    includeUnknownPrice: argv.includes('--include-unknown-price'),
    matchText: !argv.includes('--no-text-match'),
    limit: Number(get('--limit') ?? 20),
  };

  const db = openDb(get('--db') ?? DEFAULT_DB_PATH);
  const result = findSellers(db, query);
  db.close();

  if (argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const c = result.coverage;
    console.log(
      `\n${c.totalAgents} agents in the store across ${c.chains.length} chains: ` +
      c.chains.map((x) => `${x.network} (${x.chainId}) ${x.agents}`).join(', '),
    );
    console.log(`documents: ${JSON.stringify(c.documentStates)}`);
    console.log(`price sources among matches: ${JSON.stringify(result.priceSources)}`);
    if (c.droppedForPriceCeiling > 0 || c.droppedForUnknownPrice > 0) {
      console.log(
        `filtered out: ${c.droppedForPriceCeiling} over the ceiling, ` +
        `${c.droppedForUnknownPrice} with no knowable price`,
      );
    }
    console.log(`\nranking: ${result.ranking.basis}${result.ranking.placeholder ? '  [PLACEHOLDER]' : ''}`);
    console.log(`  ${result.ranking.note}\n`);

    for (const s of result.sellers) {
      const price = s.price
        ? `${s.price.usd !== null ? `$${s.price.usd}` : s.price.raw} (${s.price.source}${s.price.comparable ? '' : ', not comparable'})`
        : '(no price)';
      console.log(`${s.network.padEnd(9)} #${s.agentId.padEnd(7)} ${price}`);
      console.log(`  ${s.name ?? '(unnamed)'}${s.turnstile ? `  <- ${s.turnstile.ensName}` : ''}`);
      if (s.description) console.log(`  ${s.description.slice(0, 110)}`);
      console.log(
        `  uid ${s.agentUid}\n` +
        `  payTo ${s.payTo}  x402 ${s.x402Support}  doc ${s.documentState}${s.fetchStatus && s.documentState === 'failed' ? ` (${s.fetchStatus})` : ''}`,
      );
      if (s.capabilities.length > 0) console.log(`  capabilities ${s.capabilities.slice(0, 8).join(', ')}`);
      if (s.matchedOn.length > 0) console.log(`  matched on ${s.matchedOn.join(', ')}`);
      if (s.turnstile) {
        console.log(
          `  turnstile rails ${s.turnstile.rails.join(', ')}  ceiling ${s.turnstile.priceCeiling}  ` +
          `resolver ${s.turnstile.resolverVerified ? 'verified' : 'UNVERIFIED'}`,
        );
      }
      console.log('');
    }
    console.log(`${result.sellers.length} shown of ${c.matchedBeforePriceFilter} matched.\n`);
  }
}
