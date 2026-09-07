// Reading a Turnstile seller's offer off its ENSv2 resolver.
//
// This is the leg of discovery the registry cannot supply. EIP-8004
// registration-v1 has no price field and a survey of 1,200 live registrations
// found zero carrying one, so "what does this agent cost" is not a question the
// ERC-8004 registry can answer for anybody. For our own sellers it is answered
// by ENSIP-25/26 records on a name whose write permissions are split between a
// cold and a hot key (see docs/ens-offer-records.md).
//
// The registry tells you who exists; Turnstile tells you what they cost.

import { createPublicClient, http, namehash, parseAbi } from 'viem';
import type { Address, PublicClient } from 'viem';

/** ENSIP-26 keys are standard; an agent that has never heard of us reads these. */
export const ENSIP26_KEYS = ['agent-context', 'agent-endpoint[mcp]'] as const;
/** Turnstile-specific keys, layered on top rather than replacing the standard ones. */
export const TURNSTILE_KEYS = [
  'turnstile:price',
  'turnstile:price-ceiling',
  'turnstile:rails',
  'turnstile:operator-proof',
] as const;

const RESOLVER_ABI = parseAbi([
  'function text(bytes32 node, string key) view returns (string)',
  'function addr(bytes32 node) view returns (address)',
]);

const VERIFIABLE_FACTORY_ABI = parseAbi([
  'function verifyContract(address proxy) view returns (address)',
]);

export interface SellerOffer {
  ensName: string;
  node: `0x${string}`;
  resolver: Address;
  chainId: number;
  agentContext?: string;
  mcpEndpoint?: string;
  price?: string;
  priceCeiling?: string;
  rails?: string;
  operatorProof?: string;
  payoutAddr?: string;
  /** The ENSIP-25 record was found and confirms the link to this agent. */
  agentRegistrationConfirmed: boolean;
  agentRegistrationKey?: string;
  /** `VerifiableFactory.verifyContract` returned the expected implementation. */
  resolverVerified: boolean;
  resolverImplementation?: string;
  readAtBlock: number;
}

/**
 * ERC-7930 interoperable address, as ENSIP-25 embeds it in the record key.
 *
 * Layout: version(2) ‖ chainType(2) ‖ len(chainRef) ‖ chainRef ‖ len(addr) ‖ addr,
 * with `chainRef` the chain id big-endian and minimally encoded. Sepolia's
 * 11155111 is 0xaa36a7, three bytes — which is why the length prefix exists and
 * why a fixed 32-byte encoding would be wrong.
 */
export function encodeErc7930(chainId: number, address: string): `0x${string}` {
  let hex = chainId.toString(16);
  if (hex.length % 2 === 1) hex = '0' + hex;
  const chainRefBytes = hex.length / 2;
  const addr = address.toLowerCase().replace(/^0x/, '');
  return `0x0001` +
    `0000` +
    chainRefBytes.toString(16).padStart(2, '0') +
    hex +
    (addr.length / 2).toString(16).padStart(2, '0') +
    addr as `0x${string}`;
}

/**
 * The ENSIP-25 record key binding an ENS name to an on-chain agent registration.
 *
 * `contracts/test/OfferRecords.t.sol` reproduces the specification's own worked
 * example byte for byte against the Solidity encoder; this is the TypeScript
 * side of the same thing. A malformed key still stores and still reads back —
 * it is just invisible to every ENSIP-25 client — so the two encoders agreeing
 * with the spec, rather than merely with each other, is what matters.
 */
export function agentRegistrationKey(chainId: number, registry: string, agentId: string | number): string {
  return `agent-registration[${encodeErc7930(chainId, registry)}][${agentId}]`;
}

export function makePublicClient(rpcUrl: string): PublicClient {
  return createPublicClient({ transport: http(rpcUrl) }) as PublicClient;
}

const emptyToUndefined = (v: string): string | undefined => (v === '' ? undefined : v);

/**
 * Read one seller's whole offer.
 *
 * Every call is independent and a missing record is a normal outcome, so each
 * read is caught individually: one unset text key must not take down the read
 * of the six that are set.
 */
export async function readSellerOffer(
  client: PublicClient,
  params: {
    ensName: string;
    resolver: Address;
    chainId: number;
    /** ERC-8004 Identity Registry the ENSIP-25 record should point at. */
    identityRegistry?: string;
    agentId?: string | number;
    /** Checked with `verifyContract`, proving the resolver is a stock ENS one. */
    verifiableFactory?: Address;
    permissionedResolverImpl?: string;
  },
): Promise<SellerOffer> {
  const node = namehash(params.ensName);

  const readText = async (key: string): Promise<string | undefined> => {
    try {
      const value = await client.readContract({
        address: params.resolver,
        abi: RESOLVER_ABI,
        functionName: 'text',
        args: [node, key],
      });
      return emptyToUndefined(value);
    } catch {
      return undefined;
    }
  };

  const [agentContext, mcpEndpoint, price, priceCeiling, rails, operatorProof] = await Promise.all([
    readText('agent-context'),
    readText('agent-endpoint[mcp]'),
    readText('turnstile:price'),
    readText('turnstile:price-ceiling'),
    readText('turnstile:rails'),
    readText('turnstile:operator-proof'),
  ]);

  let payoutAddr: string | undefined;
  try {
    const value = await client.readContract({
      address: params.resolver, abi: RESOLVER_ABI, functionName: 'addr', args: [node],
    });
    payoutAddr = value === '0x0000000000000000000000000000000000000000' ? undefined : value;
  } catch {
    payoutAddr = undefined;
  }

  // The two-way link. The ENS name asserting an agent id is only half of it;
  // hydrate-sellers checks the registry's tokenURI points back.
  let agentRegistrationConfirmed = false;
  let key: string | undefined;
  if (params.identityRegistry && params.agentId !== undefined) {
    key = agentRegistrationKey(params.chainId, params.identityRegistry, params.agentId);
    agentRegistrationConfirmed = (await readText(key)) !== undefined;
  }

  // A resolver that answers `text()` honestly for a while and then lies is the
  // attack this defends against: `verifyContract` proves the proxy came out of
  // ENS's own VerifiableFactory with a known implementation behind it, which is
  // why a buyer's agent can act on a price read here.
  let resolverVerified = false;
  let resolverImplementation: string | undefined;
  if (params.verifiableFactory) {
    try {
      resolverImplementation = await client.readContract({
        address: params.verifiableFactory,
        abi: VERIFIABLE_FACTORY_ABI,
        functionName: 'verifyContract',
        args: [params.resolver],
      });
      resolverVerified = params.permissionedResolverImpl
        ? resolverImplementation.toLowerCase() === params.permissionedResolverImpl.toLowerCase()
        : resolverImplementation !== '0x0000000000000000000000000000000000000000';
    } catch {
      resolverVerified = false;
    }
  }

  const readAtBlock = Number(await client.getBlockNumber());

  return {
    ensName: params.ensName,
    node,
    resolver: params.resolver,
    chainId: params.chainId,
    agentContext, mcpEndpoint, price, priceCeiling, rails, operatorProof, payoutAddr,
    agentRegistrationConfirmed,
    agentRegistrationKey: key,
    resolverVerified,
    resolverImplementation,
    readAtBlock,
  };
}

const IDENTITY_REGISTRY_ABI = parseAbi([
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)',
]);

/**
 * The other half of the two-way link: does the ERC-8004 registration point back
 * at the name? A name can claim any agent id; only the registry can corroborate.
 */
export async function readAgentBacklink(
  client: PublicClient,
  identityRegistry: Address,
  agentId: string | number,
): Promise<{ tokenUri?: string; owner?: string }> {
  const out: { tokenUri?: string; owner?: string } = {};
  try {
    out.tokenUri = await client.readContract({
      address: identityRegistry, abi: IDENTITY_REGISTRY_ABI, functionName: 'tokenURI', args: [BigInt(agentId)],
    });
  } catch { /* an agent id that does not exist is a finding, not an error */ }
  try {
    out.owner = await client.readContract({
      address: identityRegistry, abi: IDENTITY_REGISTRY_ABI, functionName: 'ownerOf', args: [BigInt(agentId)],
    });
  } catch { /* same */ }
  return out;
}
