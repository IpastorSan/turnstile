#!/usr/bin/env node
// Terminal front end for the analyst. The importable API in `analyst.ts` is the
// real interface; this exists so a verdict can be read and argued with by hand.
//
//   node seller/analyst/analyst-cli.ts --pool 0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640
//   node seller/analyst/analyst-cli.ts --top 5            # rank by TVL, then check the ranking
//   node seller/analyst/analyst-cli.ts --pool 0x... --json
//   node seller/analyst/analyst-cli.ts --pool 0x... --subgraph-id FQ6JY...   # over Subgraph MCP
//
// `--top` is worth running at least once. It prints the naive TVL ranking every
// dashboard shows, then puts a verdict next to each row.

import { fileURLToPath } from 'node:url';

import { flag, has, main, numberFlag } from '../../graph/sink/cli.ts';
import { analyzePool, renderVerdict } from './analyst.ts';
import { fetchTopPoolsByTvl, httpSource, mcpSource } from './subgraph.ts';
import type { SubgraphSource } from './subgraph.ts';
import type { DepthProvider } from './uniswap-quotes.ts';

function sourceFrom(argv: string[]): SubgraphSource {
  const subgraphId = flag(argv, '--subgraph-id');
  if (subgraphId) return mcpSource({ subgraphId });
  return httpSource({ url: flag(argv, '--endpoint') });
}

function usd(value: number): string {
  if (Math.abs(value) >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (Math.abs(value) >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (Math.abs(value) >= 1e3) return `$${(value / 1e3).toFixed(1)}k`;
  return `$${value.toFixed(2)}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);

  await main(async () => {
    const source = sourceFrom(argv);
    const shared = {
      source,
      hours: numberFlag(argv, '--hours', 48),
      skipDepth: has(argv, '--no-depth'),
      depthProvider: flag(argv, '--depth-provider') as DepthProvider | undefined,
      // A subgraph on another chain needs that chain's RPC, or the quoter is
      // asked about a pool address that does not exist where it is looking.
      quoter: { rpcUrl: flag(argv, '--rpc') },
      notionalsUSD: flag(argv, '--sizes')
        ?.split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0),
    };

    try {
      const topCount = flag(argv, '--top');
      if (topCount !== undefined) {
        const pools = await fetchTopPoolsByTvl(source, Number(topCount));
        console.log(`\nThe naive ranking — top ${pools.length} pools by TVL, as any dashboard shows them:\n`);
        for (const pool of pools) {
          console.log(
            `  ${usd(pool.totalValueLockedUSD).padStart(9)}  ` +
            `${pool.name.slice(0, 46).padEnd(46)}  vol ${usd(pool.cumulativeVolumeUSD)}`,
          );
        }
        console.log('\nNow the same pools, asked whether they are safe to LP.\n');

        const verdicts = [];
        for (const pool of pools) {
          const verdict = await analyzePool({ ...shared, pool: pool.address });
          verdicts.push(verdict);
          if (has(argv, '--json')) continue;
          console.log(renderVerdict(verdict));
          console.log('');
        }
        if (has(argv, '--json')) {
          console.log(JSON.stringify(verdicts, null, 2));
        } else {
          console.log('SUMMARY — TVL rank against LP verdict\n');
          for (const [index, verdict] of verdicts.entries()) {
            console.log(
              `  #${index + 1}  ${verdict.rating.padEnd(18)} ` +
              `${(verdict.confidence * 100).toFixed(0)}%  ${verdict.pool}`,
            );
          }
          console.log('');
        }
        return;
      }

      const pool = flag(argv, '--pool');
      if (!pool) throw new Error('pass --pool <address>, or --top <n>');
      const verdict = await analyzePool({ ...shared, pool });
      console.log(has(argv, '--json') ? JSON.stringify(verdict, null, 2) : renderVerdict(verdict));
    } finally {
      await source.close();
    }
  });
}
