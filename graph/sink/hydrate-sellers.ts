#!/usr/bin/env node
// Hydrate Turnstile sellers from their ENSv2 resolver records.
//
//   node graph/sink/hydrate-sellers.ts --db graph/sink/data/discovery.db
//
// Seller identity comes from the deployment manifest rather than a constant:
// MOV-218 established that no name is hard-coded anywhere, and this honours the
// same rule. Point `--sellers` at a JSON array to hydrate more than one.
//
// The `agent_uid` link is only written when BOTH directions check out — the ENS
// name carries the ENSIP-25 record naming the agent, AND the registry's
// tokenURI names the ENS name back. A name can claim any agent id it likes;
// unilateral claims stay unlinked and are reported, not quietly trusted.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Address } from 'viem';

import { DEFAULT_DB_PATH, openDb } from './db.ts';
import { makePublicClient, readAgentBacklink, readSellerOffer } from './ens.ts';
import type { SellerOffer } from './ens.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST = join(HERE, '..', '..', 'contracts', 'addresses.turnstile.sepolia.json');
/** Behind the seller's PermissionedResolver proxy; from contracts/addresses.sepolia.json. */
const PERMISSIONED_RESOLVER_IMPL = '0x7E4B2d59938930168024201752EE5503df402303';

export interface SellerConfig {
  ensName: string;
  resolver: Address;
  chainId: number;
  identityRegistry: Address;
  agentId: string | number;
  verifiableFactory?: Address;
  permissionedResolverImpl?: string;
  rpcUrl?: string;
}

/** Read seller config out of a MOV-217/218 deployment manifest. */
export function sellersFromManifest(manifest: Record<string, unknown>): SellerConfig[] {
  const ensName = manifest.sellerName as string | undefined;
  const resolver = manifest.resolver as Address | undefined;
  const chainId = manifest.chainId as number | undefined;
  if (!ensName || !resolver || !chainId) {
    throw new Error('manifest is missing sellerName, resolver or chainId');
  }
  return [{
    ensName,
    resolver,
    chainId,
    identityRegistry: manifest.erc8004IdentityRegistry as Address,
    agentId: manifest.erc8004AgentId as number,
    verifiableFactory: manifest.ensVerifiableFactory as Address | undefined,
    permissionedResolverImpl: PERMISSIONED_RESOLVER_IMPL,
  }];
}

/** The join key the Substreams module emits. Both sides must spell it the same. */
export function agentUid(chainId: number, registry: string, agentId: string | number): string {
  return `eip155:${chainId}:${registry.toLowerCase()}/${agentId}`;
}

export interface HydrateResult {
  offer: SellerOffer;
  uid: string;
  linked: boolean;
  backlinkTokenUri?: string;
  /** Present when the seller is linked but that agent is not in the store yet. */
  warning?: string;
}

export async function hydrateSeller(
  db: ReturnType<typeof openDb>,
  seller: SellerConfig,
  rpcUrl: string,
): Promise<HydrateResult> {
  const client = makePublicClient(rpcUrl);
  const offer = await readSellerOffer(client, {
    ensName: seller.ensName,
    resolver: seller.resolver,
    chainId: seller.chainId,
    identityRegistry: seller.identityRegistry,
    agentId: seller.agentId,
    verifiableFactory: seller.verifiableFactory,
    permissionedResolverImpl: seller.permissionedResolverImpl,
  });

  const backlink = await readAgentBacklink(client, seller.identityRegistry, seller.agentId);
  const backlinkOk = backlink.tokenUri?.toLowerCase() === seller.ensName.toLowerCase();
  const linked = offer.agentRegistrationConfirmed && backlinkOk;
  const uid = agentUid(seller.chainId, seller.identityRegistry, seller.agentId);

  let warning: string | undefined;
  if (!linked) {
    warning = offer.agentRegistrationConfirmed
      ? `registry tokenURI is ${backlink.tokenUri ?? '(unset)'}, not ${seller.ensName} — link not written`
      : 'ENSIP-25 agent-registration record not found on the name — link not written';
  } else {
    const known = db.prepare('SELECT 1 FROM agent WHERE agent_uid = ?').get(uid);
    if (!known) {
      warning = `linked to ${uid}, but that agent is not in the store — sink the block range that contains it`;
    }
  }

  db.prepare(`
    INSERT INTO turnstile_seller (
      ens_name, node, resolver, chain_id, agent_uid, agent_context, mcp_endpoint,
      price, price_ceiling, rails, operator_proof, payout_addr, resolver_verified,
      read_at, read_at_block
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), ?)
    ON CONFLICT(ens_name) DO UPDATE SET
      node              = excluded.node,
      resolver          = excluded.resolver,
      chain_id          = excluded.chain_id,
      agent_uid         = excluded.agent_uid,
      agent_context     = excluded.agent_context,
      mcp_endpoint      = excluded.mcp_endpoint,
      price             = excluded.price,
      price_ceiling     = excluded.price_ceiling,
      rails             = excluded.rails,
      operator_proof    = excluded.operator_proof,
      payout_addr       = excluded.payout_addr,
      resolver_verified = excluded.resolver_verified,
      read_at           = unixepoch(),
      read_at_block     = excluded.read_at_block
  `).run(
    offer.ensName, offer.node, offer.resolver, offer.chainId,
    linked ? uid : null,
    offer.agentContext ?? null, offer.mcpEndpoint ?? null,
    offer.price ?? null, offer.priceCeiling ?? null, offer.rails ?? null,
    offer.operatorProof ?? null, offer.payoutAddr ?? null,
    offer.resolverVerified ? 1 : 0, offer.readAtBlock,
  );

  return { offer, uid, linked, backlinkTokenUri: backlink.tokenUri, warning };
}

// --- entry point ------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const rpcUrl = get('--rpc') ?? process.env.SEPOLIA_RPC_URL;
  if (!rpcUrl) throw new Error('SEPOLIA_RPC_URL is not set and --rpc was not given');

  const sellersPath = get('--sellers');
  const sellers: SellerConfig[] = sellersPath
    ? (JSON.parse(readFileSync(sellersPath, 'utf8')) as SellerConfig[])
    : sellersFromManifest(JSON.parse(readFileSync(get('--manifest') ?? DEFAULT_MANIFEST, 'utf8')));

  const db = openDb(get('--db') ?? DEFAULT_DB_PATH);
  for (const seller of sellers) {
    const result = await hydrateSeller(db, seller, seller.rpcUrl ?? rpcUrl);
    const o = result.offer;
    process.stdout.write(
      `${o.ensName}\n` +
      `  price          ${o.price ?? '(unset)'}  ceiling ${o.priceCeiling ?? '(unset)'}  rails ${o.rails ?? '(unset)'}\n` +
      `  mcp            ${o.mcpEndpoint ?? '(unset)'}\n` +
      `  payout         ${o.payoutAddr ?? '(unset)'}\n` +
      `  resolver       ${o.resolverVerified ? 'verified' : 'UNVERIFIED'} (impl ${o.resolverImplementation ?? '?'})\n` +
      `  agent link     ${result.linked ? result.uid : 'NOT LINKED'}\n` +
      `  read at block  ${o.readAtBlock}\n`,
    );
    if (result.warning) process.stderr.write(`  warning: ${result.warning}\n`);
  }
  db.close();
}
