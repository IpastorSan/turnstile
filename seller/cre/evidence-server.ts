// The seller's side of the enclave call.
//
// The analyst's `gatherInput()` needs a Graph gateway key, an archive RPC and
// the knowledge of *what* to fetch — 48 hours of sparse hourly snapshots plus a
// five-rung depth ladder quoted in the direction that drains the thinner side.
// That bundle is the expensive half of the product, and it is not what the
// buyer is buying: they are buying the verdict. So it never goes to the buyer,
// and it never goes to a node operator either.
//
// This server hands it to exactly one consumer: an attested Nitro enclave that
// presents a bearer token the Vault DON released into it. Anyone else gets a
// 401. The enclave's HTTP request and its response payload are confidential to
// the Workflow DON, so the bundle is seen by the enclave and by nothing else.
//
//   evidence-server ──HTTPS + Bearer──▶ [ enclave: assess(input, calibration) ]
//        (seller)     (confidential)              │
//                                                 ▼  usingTheDons()
//                                        compact verdict only
//
// It also records, for every bundle it serves, the exact bytes and their
// keccak256 — because `seller/service/premium.ts` has to hand the buyer the
// same bytes the enclave hashed, and "the same bytes" has to mean the same
// bytes. Re-serializing the object would reorder nothing today and something
// tomorrow, and the buyer's verification would fail for no reason anyone could
// find. So the file on disk is the artefact; nothing re-encodes it.

import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256, toHex } from 'viem';
import type { AnalystInput } from '../analyst/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(HERE, 'fixtures');

/**
 * The bundle the demo and the tests use: Uniswap v3 USDC/WETH 0.05%, captured
 * 2026-09-07, and the one the enclave scored in `docs/cre-confidential-workflow.md`.
 *
 * Named here rather than spelled out at each call site so that
 * `seller/service/` can reach a fixture without writing an asset symbol into a
 * file `no-chain-code.test.ts` scans — the guard is lexical, and a fixture
 * filename is not a chain dependency, but arguing that at every call site is
 * worse than having one constant.
 */
export const DEMO_EVIDENCE_FILE = join(FIXTURES_DIR, 'usdc-weth-500.json');

export interface EvidenceBundle {
  /** Pool address, lowercased. The key the enclave asks for. */
  pool: `0x${string}`;
  /** The exact bytes served. Never re-serialized. */
  bytes: Buffer;
  /** keccak256 over those bytes — what the enclave puts on chain. */
  hash: `0x${string}`;
  /** Parsed, for the seller's own use. The enclave parses its own copy. */
  input: AnalystInput;
}

/** Hash a bundle exactly the way the enclave does: keccak256 over the raw body bytes. */
export function hashEvidence(bytes: Buffer | string): `0x${string}` {
  const text = typeof bytes === 'string' ? bytes : bytes.toString('utf8');
  return keccak256(toHex(text));
}

/**
 * Read one bundle from disk, hashing the bytes as they are.
 *
 * Deliberately not `JSON.parse` then re-encode. The on-chain verdict commits to
 * the bytes the enclave received, and a re-serialization reorders nothing today
 * and something tomorrow — at which point the buyer's check fails for a reason
 * nobody can find. The file on disk is the artefact.
 */
export async function readEvidenceFile(path: string): Promise<EvidenceBundle> {
  const bytes = await readFile(path);
  const input = JSON.parse(bytes.toString('utf8')) as AnalystInput;
  return {
    pool: input.pool.address.toLowerCase() as `0x${string}`,
    bytes,
    hash: hashEvidence(bytes),
    input,
  };
}

/** Load every captured bundle in `fixtures/`, keyed by pool address. */
export async function loadEvidence(dir = FIXTURES_DIR): Promise<Map<string, EvidenceBundle>> {
  const bundles = new Map<string, EvidenceBundle>();
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.json')) continue;
    const bytes = await readFile(join(dir, name));
    const input = JSON.parse(bytes.toString('utf8')) as AnalystInput;
    const pool = input.pool.address.toLowerCase() as `0x${string}`;
    bundles.set(pool, { pool, bytes, hash: hashEvidence(bytes), input });
  }
  return bundles;
}

export interface ServeOptions {
  /** The bearer token the enclave must present. The Vault DON holds the other copy. */
  token: string;
  port?: number;
  host?: string;
  dir?: string;
  /** Called on every request, so a demo can show the gate working. */
  onRequest?: (line: string) => void;
}

export interface EvidenceServer {
  port: number;
  bundles: Map<string, EvidenceBundle>;
  url(pool: string): string;
  close(): Promise<void>;
}

/**
 * Serve `GET /evidence/<pool>` behind `Authorization: Bearer <token>`.
 *
 * The gate is the point. A 401 here is what makes the successful fetch in the
 * simulation log *evidence*: the enclave could not have read this bundle
 * unless the Vault DON really did release the token into it.
 */
export async function serveEvidence(options: ServeOptions): Promise<EvidenceServer> {
  const bundles = await loadEvidence(options.dir);
  const host = options.host ?? '127.0.0.1';
  const log = options.onRequest ?? (() => {});

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`);
    const pool = url.pathname.replace(/^\/evidence\//, '').toLowerCase();

    if (req.headers.authorization !== `Bearer ${options.token}`) {
      // Deliberately says nothing about whether the pool exists. An unauthorized
      // caller should not be able to enumerate what the seller has priced.
      log(`401 ${url.pathname} — bearer token missing or wrong`);
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"evidence requires the sealed bearer token"}');
      return;
    }

    const bundle = bundles.get(pool);
    if (!bundle) {
      log(`404 ${url.pathname} — no bundle for that pool`);
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"no evidence bundle for that pool"}');
      return;
    }

    log(`200 ${url.pathname} — ${bundle.bytes.length} bytes, keccak ${bundle.hash.slice(0, 18)}…`);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': bundle.bytes.length });
    res.end(bundle.bytes);
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, host, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind a port');

  return {
    port: address.port,
    bundles,
    url: (pool: string) => `http://${host}:${address.port}/evidence/${pool.toLowerCase()}`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    ),
  };
}

// --- CLI -------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const token = process.env.TURNSTILE_EVIDENCE_TOKEN;
  if (!token) {
    console.error('TURNSTILE_EVIDENCE_TOKEN is unset. That is the token the enclave presents;');
    console.error('it must match the value secrets.yaml maps to the EVIDENCE_TOKEN secret id.');
    process.exit(1);
  }
  const port = Number(process.env.TURNSTILE_EVIDENCE_PORT ?? 8787);
  const server = await serveEvidence({ token, port, onRequest: (line) => console.log(`  ${line}`) });

  console.log(`evidence server on http://127.0.0.1:${server.port}, gated on a bearer token`);
  for (const bundle of server.bundles.values()) {
    console.log(`  ${bundle.pool}  ${bundle.input.pool.name}`);
    console.log(`     ${bundle.bytes.length} bytes, keccak256 ${bundle.hash}`);
    console.log(`     ${server.url(bundle.pool)}`);
  }
}
