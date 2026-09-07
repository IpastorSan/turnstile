#!/usr/bin/env node
// Sink the ERC-8004 Substreams feed into the discovery store.
//
//   node graph/sink/sink.ts --network base --start 41700000 --stop 41706000
//   node graph/sink/sink.ts --network sepolia --from-file capture/sepolia.jsonl
//
// Consumes `map_agent_registrations`, not `map_agent_directory`. The directory
// module reads `store_agent_wallets`, and a store must be backfilled from its
// initialBlock before it can answer — 37,000 blocks of Base just to read one
// window. `map_agent_registrations` is a pure function of the block, so it
// streams the requested range and nothing else; the wallet join it gives up is
// recovered by folding `wallet_updates` in SQL at the end of the run
// (`foldWallets`). Same answer, none of the backfill.

import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { DatabaseSync } from 'node:sqlite';

import {
  DEFAULT_DB_PATH,
  foldWallets,
  openDb,
  recordWalletUpdate,
  replaceEndpoints,
  stripEnumPrefix,
  updateCursor,
  upsertAgent,
} from './db.ts';
import type { AgentEndpoint, AgentRow, UriScheme } from './db.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SPKG = join(HERE, '..', 'substreams', 'erc8004-agent-registry-v0.1.0.spkg');

/** Networks the packaged .spkg declares. Params live in its substreams.yaml. */
const NETWORKS = ['mainnet', 'base', 'sepolia', 'base-sepolia'] as const;

interface SinkOptions {
  network: string;
  start?: number;
  stop?: number;
  dbPath: string;
  spkg: string;
  fromFile?: string;
  quiet: boolean;
}

interface SinkResult {
  network: string;
  chainId: number;
  registry: string;
  blocks: number;
  registrations: number;
  walletUpdates: number;
  firstBlock: number;
  lastBlock: number;
  walletsFolded: number;
}

// --- the wire format --------------------------------------------------------

// `substreams run -o jsonl` emits one JSON object per block. Proto3 JSON omits
// default values, so absent means zero: no `registrations` key is an empty
// block, no `x402Support` is false, no `logIndex` is 0. Every read below
// defaults rather than assuming presence.
interface JsonlLine {
  '@module'?: string;
  '@block'?: number;
  '@data'?: {
    chain?: string;
    chainId?: string;
    network?: string;
    blockNumber?: string;
    blockTimestamp?: string;
    registrations?: RawRegistration[];
    walletUpdates?: RawWalletUpdate[];
  };
}

interface RawRegistration {
  agentUid: string;
  namespace?: string;
  chainId?: string;
  network?: string;
  registry?: string;
  agentId?: string;
  owner?: string;
  operator?: string;
  operatorSource?: string;
  agentUri?: string;
  uriScheme?: string;
  registrationResolved?: boolean;
  name?: string;
  description?: string;
  image?: string;
  endpoints?: RawEndpoint[];
  x402Support?: boolean;
  active?: boolean;
  supportedTrust?: string[];
  price?: { amount?: string; currency?: string; asset?: string; network?: string; scheme?: string };
  event?: string;
  blockNumber?: string;
  blockTimestamp?: string;
  transactionHash?: string;
  logIndex?: number;
}

interface RawEndpoint {
  name?: string;
  uri?: string;
  version?: string;
  skills?: string[];
  domains?: string[];
}

interface RawWalletUpdate {
  agentUid: string;
  wallet?: string;
  blockNumber?: string;
  blockTimestamp?: string;
  transactionHash?: string;
  logIndex?: number;
}

// --- translation ------------------------------------------------------------

const num = (v: string | number | undefined): number => (v === undefined ? 0 : Number(v));

export function toAgentRow(raw: RawRegistration): AgentRow {
  return {
    agentUid: raw.agentUid,
    namespace: raw.namespace ?? 'eip155',
    chainId: num(raw.chainId),
    network: raw.network ?? '',
    registry: raw.registry ?? '',
    agentId: raw.agentId ?? '',
    owner: raw.owner ?? '',
    // EIP-8004 initialises agentWallet to the owner, and the module already
    // applies that default, so an absent operator really is the owner.
    operator: raw.operator ?? raw.owner ?? '',
    operatorSource: stripEnumPrefix(raw.operatorSource, 'OPERATOR_SOURCE_'),
    agentUri: raw.agentUri ?? '',
    uriScheme: stripEnumPrefix(raw.uriScheme, 'URI_SCHEME_') as UriScheme,
    inModuleResolved: raw.registrationResolved === true,
    name: raw.name,
    description: raw.description,
    image: raw.image,
    x402Support: raw.x402Support === true,
    active: raw.active === true,
    supportedTrust: raw.supportedTrust,
    endpoints: raw.endpoints as AgentEndpoint[] | undefined,
    price: raw.price,
    lastEvent: stripEnumPrefix(raw.event, 'REGISTRATION_EVENT_'),
    blockNumber: num(raw.blockNumber),
    blockTimestamp: num(raw.blockTimestamp),
    transactionHash: raw.transactionHash ?? '',
    logIndex: raw.logIndex ?? 0,
  };
}

// --- ingest -----------------------------------------------------------------

/**
 * Read a jsonl stream into the store. Writes in one transaction per 500 blocks:
 * small enough that a killed run loses little, large enough that a 6,000-block
 * range is not 6,000 fsyncs.
 */
export async function ingest(
  db: DatabaseSync,
  lines: Readable,
  opts: { network: string; quiet?: boolean },
): Promise<SinkResult> {
  const result: SinkResult = {
    network: opts.network,
    chainId: 0,
    registry: '',
    blocks: 0,
    registrations: 0,
    walletUpdates: 0,
    firstBlock: 0,
    lastBlock: 0,
    walletsFolded: 0,
  };

  let open = false;
  const begin = () => { if (!open) { db.exec('BEGIN'); open = true; } };
  const commit = () => { if (open) { db.exec('COMMIT'); open = false; } };

  const rl = createInterface({ input: lines, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      let parsed: JsonlLine;
      try {
        parsed = JSON.parse(line) as JsonlLine;
      } catch {
        // The CLI interleaves the odd progress line into stdout on some
        // terminals. A line that is not JSON is not a block; skip it rather
        // than killing a long run.
        continue;
      }
      const data = parsed['@data'];
      if (!data) continue;

      begin();
      result.blocks += 1;
      const blockNumber = num(data.blockNumber);
      if (result.firstBlock === 0) result.firstBlock = blockNumber;
      result.lastBlock = blockNumber;
      if (result.chainId === 0) result.chainId = num(data.chainId);

      for (const raw of data.registrations ?? []) {
        const row = toAgentRow(raw);
        if (result.registry === '') result.registry = row.registry;
        upsertAgent(db, row);
        // Endpoints are only replaced when this document actually carried one.
        // An unresolved URI_UPDATED must not wipe endpoints we already have.
        if (row.inModuleResolved) {
          replaceEndpoints(db, row.agentUid, 'in_module', row.endpoints, row.supportedTrust);
        }
        result.registrations += 1;
      }

      for (const u of data.walletUpdates ?? []) {
        if (!u.wallet) continue;
        recordWalletUpdate(db, {
          agentUid: u.agentUid,
          wallet: u.wallet,
          blockNumber: num(u.blockNumber),
          blockTimestamp: num(u.blockTimestamp),
          transactionHash: u.transactionHash ?? '',
          logIndex: u.logIndex ?? 0,
        });
        result.walletUpdates += 1;
      }

      if (result.blocks % 500 === 0) {
        commit();
        if (!opts.quiet) {
          process.stderr.write(
            `  ${opts.network} block ${blockNumber} — ${result.registrations} registrations\n`,
          );
        }
      }
    }
  } finally {
    commit();
  }

  result.walletsFolded = foldWallets(db);
  if (result.blocks > 0) {
    updateCursor(
      db, opts.network, result.chainId, result.registry,
      result.firstBlock, result.lastBlock, result.blocks, result.registrations,
    );
  }
  return result;
}

// --- driving the CLI --------------------------------------------------------

/**
 * Run `substreams run` and hand its stdout to the ingester.
 *
 * The Graph Market plan caps concurrent streams at 2 (`ResourceExhausted:
 * Concurrent stream limit exceeded (active sessions: 2/2)`), which is why the
 * multi-chain entry point below runs networks one at a time rather than
 * fanning out. Three parallel chains fails; two is the ceiling.
 */
async function runSubstreams(opts: SinkOptions, db: DatabaseSync): Promise<SinkResult> {
  if (!process.env.SUBSTREAMS_API_TOKEN) {
    throw new Error('SUBSTREAMS_API_TOKEN is not set — source .env first');
  }
  const args = [
    'run', opts.spkg, 'map_agent_registrations',
    '--network', opts.network,
    '-o', 'jsonl',
  ];
  if (opts.start !== undefined) args.push('-s', String(opts.start));
  if (opts.stop !== undefined) args.push('-t', String(opts.stop));

  const child = spawn('substreams', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
  });

  const exited = new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 0));
  });

  const result = await ingest(db, child.stdout, { network: opts.network, quiet: opts.quiet });
  const code = await exited;
  if (code !== 0) {
    throw new Error(`substreams exited ${code}\n${stderr.trim().split('\n').slice(-6).join('\n')}`);
  }
  return result;
}

async function runFromFile(opts: SinkOptions, db: DatabaseSync): Promise<SinkResult> {
  return ingest(db, createReadStream(opts.fromFile!), { network: opts.network, quiet: opts.quiet });
}

export async function sink(opts: SinkOptions): Promise<SinkResult> {
  mkdirSync(dirname(opts.dbPath), { recursive: true });
  const db = openDb(opts.dbPath);
  try {
    return opts.fromFile ? await runFromFile(opts, db) : await runSubstreams(opts, db);
  } finally {
    db.close();
  }
}

// --- entry point ------------------------------------------------------------

function parseArgs(argv: string[]): SinkOptions {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const network = get('--network');
  if (!network) throw new Error(`--network is required, one of: ${NETWORKS.join(', ')}`);

  const start = get('--start');
  const stop = get('--stop');
  return {
    network,
    start: start === undefined ? undefined : Number(start),
    stop: stop === undefined ? undefined : Number(stop),
    dbPath: get('--db') ?? DEFAULT_DB_PATH,
    spkg: get('--spkg') ?? DEFAULT_SPKG,
    fromFile: get('--from-file'),
    quiet: argv.includes('--quiet'),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const result = await sink(opts);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  process.stderr.write(
    `\n${result.network} (chain ${result.chainId}): ` +
    `${result.registrations} registrations, ${result.walletUpdates} wallet updates ` +
    `over ${result.blocks} blocks ${result.firstBlock}..${result.lastBlock} in ${seconds}s ` +
    `(${result.walletsFolded} operators folded)\n`,
  );
}
