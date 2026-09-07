// One place that builds a viem client, so every tool gets the same timeout and
// the same "which RPC actually answered" provenance.
//
// The client is intentionally chain-agnostic (no `chain:` field). Passing a
// viem chain object would let viem apply chain-specific formatters and, more
// importantly, would make it possible for the configured chain and the RPC's
// real chain to disagree without anyone noticing. Instead `assertChainId`
// checks the RPC's own `eth_chainId` against the config once per client and
// refuses the mismatch — the class of bug where a mainnet RPC quietly answers a
// Base question is worth one extra round trip to rule out.

import { createPublicClient, http } from 'viem';
import type { PublicClient } from 'viem';

import type { ChainConfig } from './chains.ts';
import { rpcUrlFor } from './chains.ts';

export interface ClientOptions {
  rpcUrl?: string;
  /** Injected by tests; skips construction and the chain-id check. */
  client?: PublicClient;
  timeoutMs?: number;
}

export class ChainIdMismatch extends Error {
  constructor(expected: number, actual: number, rpcUrl: string, chainName: string) {
    super(
      `RPC ${new URL(rpcUrl).host} reports chain id ${actual}, but "${chainName}" is chain id `
      + `${expected}. Refusing to answer, because a quote taken from the wrong chain is not a `
      + 'wrong-looking answer — it is a plausible one. Set the right endpoint in '
      + `${chainName.toUpperCase()}_RPC_URL, or pass rpcUrl explicitly.`,
    );
    this.name = 'ChainIdMismatch';
  }
}

export interface ResolvedClient {
  client: PublicClient;
  rpcUrl: string;
  rpcHost: string;
}

const checked = new WeakSet<object>();

export async function getClient(
  config: ChainConfig,
  options: ClientOptions = {},
): Promise<ResolvedClient> {
  const rpcUrl = rpcUrlFor(config, options.rpcUrl);
  if (options.client) {
    return { client: options.client, rpcUrl, rpcHost: safeHost(rpcUrl) };
  }
  const client = createPublicClient({
    transport: http(rpcUrl, { timeout: options.timeoutMs ?? 20_000 }),
  }) as PublicClient;

  // Once per client object, not once per call.
  if (!checked.has(client)) {
    const actual = await client.getChainId();
    if (actual !== config.id) throw new ChainIdMismatch(config.id, actual, rpcUrl, config.name);
    checked.add(client);
  }
  return { client, rpcUrl, rpcHost: safeHost(rpcUrl) };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
