#!/usr/bin/env node
// Commit a dated copy of the discovery store so a deployment has real data.
//
//   node web/scripts/export-snapshot.ts
//
// graph/sink/data/ is gitignored on purpose: it is a working store, rebuilt
// from chain, and it changes every time the sink runs. A deployed web app still
// needs something real to serve, so this writes a VACUUMed copy to web/data/
// together with a provenance record of when it was captured and what is in it.
//
// The copy is the same schema queried by the same engine, so nothing about the
// data is transformed or summarised on the way out. It is a photograph of the
// store, dated, not a derived fixture.

import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, '..', '..', 'graph', 'sink', 'data', 'discovery.db');
const OUT_DIR = join(HERE, '..', 'data');
const OUT_DB = join(OUT_DIR, 'discovery.db');
const OUT_PROVENANCE = join(OUT_DIR, 'provenance.json');

if (!existsSync(SOURCE)) {
  console.error(`no working store at ${SOURCE}`);
  console.error('build one first: node graph/sink/sink.ts && node graph/sink/resolve-cards.ts && node graph/sink/hydrate-sellers.ts');
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
if (existsSync(OUT_DB)) rmSync(OUT_DB);

const db = new DatabaseSync(SOURCE, { readOnly: true });
db.exec(`VACUUM INTO '${OUT_DB.replace(/'/g, "''")}'`);

const chains = db
  .prepare('select network, chain_id as chainId, count(*) as agents from agent_current group by network, chain_id order by agents desc')
  .all() as { network: string; chainId: number; agents: number }[];
const total = (db.prepare('select count(*) as n from agent_current').get() as { n: number }).n;
const documentStates = db
  .prepare('select document_state as state, count(*) as n from agent_current group by document_state order by state')
  .all() as { state: string; n: number }[];
const blocks = db
  .prepare('select network, min(block_number) as fromBlock, max(block_number) as toBlock from agent_current group by network order by network')
  .all() as { network: string; fromBlock: number; toBlock: number }[];
const turnstileSellers = (db.prepare('select count(*) as n from turnstile_seller').get() as { n: number }).n;
db.close();

const provenance = {
  capturedAt: new Date().toISOString(),
  source: 'graph/sink/data/discovery.db',
  how: 'ERC-8004 Identity Registry events streamed via Substreams (graph/sink/sink.ts), registration documents resolved off-module (resolve-cards.ts), Turnstile sellers hydrated from their ENSv2 resolver (hydrate-sellers.ts).',
  registries: {
    mainnet: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
    base: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
    sepolia: '0x8004a818bfb912233c491871b3d84c89a494bd9e',
  },
  totalAgents: total,
  chains,
  blockRanges: blocks,
  documentStates: Object.fromEntries(documentStates.map((d) => [d.state, d.n])),
  turnstileSellers,
  note: 'Prices are not frozen here in any meaningful sense: only one agent in the whole store has a readable price, and the seller page reads that price live from Sepolia rather than from this file.',
};

writeFileSync(OUT_PROVENANCE, JSON.stringify(provenance, null, 2) + '\n');

const kb = Math.round(statSync(OUT_DB).size / 1024);
console.log(`snapshot written: ${OUT_DB} (${kb} KB)`);
console.log(`${total} agents across ${chains.length} chains — ${chains.map((c) => `${c.network} ${c.agents}`).join(', ')}`);
console.log(`document states: ${JSON.stringify(provenance.documentStates)}`);
console.log(`captured at ${provenance.capturedAt}`);
