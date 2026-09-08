// Reading a seller's offer off its ENSv2 resolver, live, on every request.
//
// Two rules from MOV-218 carry into the web app and are the reason this file
// exists rather than a JSON fixture:
//
//   1. No ENS name is hard-coded anywhere on the demo path. Seller identity is
//      read from the deployment manifest, the same source hydrate-sellers.ts
//      uses, so renaming the seller changes one file and the site follows.
//   2. The price shown is the price on chain at the moment of the read. Caching
//      it into the snapshot would turn a verifiable record into a claim, which
//      is the exact failure the ENS leg exists to fix.
//
// The reads themselves are graph/sink/ens.ts, unmodified — the ENSIP-25 key
// encoder there is tested against the specification's own worked example, and a
// second copy in the web app could drift from it without failing that test.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Address } from 'viem';

import { makePublicClient, readAgentBacklink, readSellerOffer } from '../../graph/sink/ens.ts';
import type { SellerOffer } from '../../graph/sink/ens.ts';
import {
  PERMISSIONED_RESOLVER_IMPL,
  agentUid,
  sellersFromManifest,
} from '../../graph/sink/sellers.ts';
import type { SellerConfig } from '../../graph/sink/sellers.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(HERE, '..', '..', 'contracts', 'addresses.turnstile.sepolia.json');

export interface KnownSeller extends SellerConfig {
  uid: string;
}

/** Every seller this deployment knows how to read, from the manifest. Never a literal. */
export function knownSellers(): KnownSeller[] {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, unknown>;
  return sellersFromManifest(manifest).map((s) => ({
    ...s,
    permissionedResolverImpl: PERMISSIONED_RESOLVER_IMPL,
    uid: agentUid(s.chainId, s.identityRegistry, s.agentId),
  }));
}

export function findSeller(ensName: string): KnownSeller | null {
  const wanted = ensName.trim().toLowerCase();
  return knownSellers().find((s) => s.ensName.toLowerCase() === wanted) ?? null;
}

/** One resolver record, as read. `value: null` means the key is unset on chain. */
export interface OfferRecord {
  key: string;
  label: string;
  value: string | null;
  /** ensip25/ensip26 are standard keys any client reads; turnstile keys are ours. */
  family: 'ensip26' | 'ensip25' | 'turnstile' | 'addr';
  note?: string;
}

export interface LiveOffer {
  ok: true;
  ensName: string;
  chainId: number;
  resolver: string;
  node: string;
  readAtBlock: number;
  readAt: string;
  records: OfferRecord[];
  offer: SellerOffer;
  /** The ERC-8004 side of the two-way link. */
  backlink: { tokenUri?: string; owner?: string };
  /** Both directions agree: the name names the agent and the registry names the name back. */
  linked: boolean;
  agentUid: string;
  identityRegistry: string;
  agentId: string;
}

export interface OfferUnavailable {
  ok: false;
  ensName: string | null;
  reason: string;
}

export type LiveOfferResult = LiveOffer | OfferUnavailable;

function rpcUrl(): string | null {
  return process.env.SEPOLIA_RPC_URL ?? process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? null;
}

/** Read one seller's records off chain. Never falls back to cached values. */
export async function readOffer(ensName: string): Promise<LiveOfferResult> {
  const seller = findSeller(ensName);
  if (!seller) {
    return { ok: false, ensName: null, reason: `No seller named ${ensName} is in the deployment manifest.` };
  }
  const url = rpcUrl();
  if (!url) {
    return {
      ok: false,
      ensName: seller.ensName,
      reason:
        'SEPOLIA_RPC_URL is not set on this deployment, so the resolver cannot be read. The records are not shown rather than served from cache — a price that is not read live is not a price this page can vouch for.',
    };
  }

  const client = makePublicClient(url);
  let offer: SellerOffer;
  try {
    offer = await readSellerOffer(client, {
      ensName: seller.ensName,
      resolver: seller.resolver,
      chainId: seller.chainId,
      identityRegistry: seller.identityRegistry,
      agentId: seller.agentId,
      verifiableFactory: seller.verifiableFactory,
      permissionedResolverImpl: seller.permissionedResolverImpl,
    });
  } catch (err) {
    return {
      ok: false,
      ensName: seller.ensName,
      reason: `Sepolia read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const backlink = await readAgentBacklink(
    client,
    seller.identityRegistry as Address,
    seller.agentId,
  ).catch(() => ({}) as { tokenUri?: string; owner?: string });

  const linked =
    offer.agentRegistrationConfirmed &&
    (backlink.tokenUri ?? '').toLowerCase() === seller.ensName.toLowerCase();

  const records: OfferRecord[] = [
    {
      key: 'agent-context',
      label: 'What it sells',
      value: offer.agentContext ?? null,
      family: 'ensip26',
      note: 'ENSIP-26. An agent that has never heard of Turnstile reads this key.',
    },
    {
      key: 'agent-endpoint[mcp]',
      label: 'Where to ask',
      value: offer.mcpEndpoint ?? null,
      family: 'ensip26',
      note: 'ENSIP-26. The MCP endpoint a buyer connects to after paying.',
    },
    {
      key: 'turnstile:price',
      label: 'Price per query',
      value: offer.price ?? null,
      family: 'turnstile',
      note: 'Decimal dollars, written by the hot key within the ceiling below.',
    },
    {
      key: 'turnstile:price-ceiling',
      label: 'Price ceiling',
      value: offer.priceCeiling ?? null,
      family: 'turnstile',
      note: 'Written by the cold key. The hot key that sets the price cannot raise this.',
    },
    {
      key: 'turnstile:rails',
      label: 'Payment rails',
      value: offer.rails ?? null,
      family: 'turnstile',
      note: 'Which rails this seller settles on.',
    },
    {
      key: 'turnstile:operator-proof',
      label: 'Operator proof',
      value: offer.operatorProof ?? null,
      family: 'turnstile',
      note: 'How the operator identity is held.',
    },
    {
      key: offer.agentRegistrationKey ?? 'agent-registration[…]',
      label: 'ERC-8004 registration',
      value: offer.agentRegistrationConfirmed ? seller.ensName : null,
      family: 'ensip25',
      note: 'ENSIP-25. The key embeds an ERC-7930 interoperable address of the registry, so it names one agent on one chain unambiguously.',
    },
    {
      key: 'addr',
      label: 'Payout address',
      value: offer.payoutAddr ?? null,
      family: 'addr',
      note: 'Where payment for an answer lands.',
    },
  ];

  return {
    ok: true,
    ensName: offer.ensName,
    chainId: offer.chainId,
    resolver: offer.resolver,
    node: offer.node,
    readAtBlock: offer.readAtBlock,
    readAt: new Date().toISOString(),
    records,
    offer,
    backlink,
    linked,
    agentUid: seller.uid,
    identityRegistry: String(seller.identityRegistry),
    agentId: String(seller.agentId),
  };
}
