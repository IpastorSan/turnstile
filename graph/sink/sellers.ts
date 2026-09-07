// Seller identity, as pure functions over a deployment manifest.
//
// These live apart from hydrate-sellers.ts because that file is a CLI: it reads
// a path chosen at runtime, and any bundler that follows an import into it has
// to assume the whole repository might be read. The web app imports seller
// identity on its server-rendered demo path, so the helpers it needs are here,
// where importing them pulls in nothing but this file.
//
// hydrate-sellers.ts re-exports all three, so existing callers are unaffected.

import type { Address } from 'viem';

/**
 * Behind the seller's PermissionedResolver proxy; from
 * contracts/addresses.sepolia.json. `VerifiableFactory.verifyContract` must
 * return this for the resolver's records to count as more than a claim.
 */
export const PERMISSIONED_RESOLVER_IMPL = '0x7E4B2d59938930168024201752EE5503df402303';

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
