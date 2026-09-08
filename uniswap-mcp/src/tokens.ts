// ERC-20 metadata, read from the token itself.
//
// This exists because every other tool needs `decimals` and cannot guess it.
// The guess is the bug: assuming 18 turns a 6-decimal USDC amount into a number
// a trillion times too small, and the result still looks like a number, so it
// propagates. `decimals` is therefore always read, never defaulted, and a token
// that will not answer `decimals()` is an error rather than an assumption.
//
// `symbol` is treated as decoration and never as identity. Two of the most
// misleading pools on mainnet are impersonators that return the string "USDT"
// from an 18-decimal contract that is not USDT; a caller who matches on symbol
// will find them. Addresses are the identity here, and `symbol` is carried
// alongside so a human can read the output — flagged, in `warnings`, when it
// collides with a well-known token at a different address.

import { getAddress, parseAbi } from 'viem';
import type { PublicClient } from 'viem';

import type { ChainConfig } from './chains.ts';

const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function name() view returns (string)',
]);

// Some older tokens (MKR, and a long tail of pre-standard ERC-20s) return a
// bytes32 rather than a string from symbol()/name(). Decoding those as string
// throws, so the bytes32 shape is tried second rather than the call being
// treated as a failure.
const ERC20_BYTES32_ABI = parseAbi([
  'function symbol() view returns (bytes32)',
  'function name() view returns (bytes32)',
]);

export interface TokenInfo {
  address: `0x${string}`;
  symbol: string;
  name: string | null;
  decimals: number;
  warnings: string[];
}

export class TokenReadFailed extends Error {
  constructor(address: string, cause: string) {
    super(
      `could not read ERC-20 metadata from ${address}: ${cause}. `
      + 'Nothing downstream can proceed without decimals — an amount scaled by the wrong number '
      + 'of decimals is silently wrong rather than visibly wrong — so this is fatal rather than '
      + 'defaulted to 18.',
    );
    this.name = 'TokenReadFailed';
  }
}

/** Well-known symbols, so an impersonator using one can be flagged. */
function knownSymbolAddresses(config: ChainConfig): Map<string, string> {
  return new Map([
    [config.usdStable.symbol.toUpperCase(), config.usdStable.address.toLowerCase()],
    [config.wrappedNative.symbol.toUpperCase(), config.wrappedNative.address.toLowerCase()],
  ]);
}

function bytes32ToString(value: `0x${string}`): string {
  const hex = value.slice(2).replace(/(00)+$/, '');
  let out = '';
  for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return out.trim();
}

const cache = new Map<string, TokenInfo>();

export async function readToken(
  client: PublicClient,
  config: ChainConfig,
  rawAddress: string,
): Promise<TokenInfo> {
  let address: `0x${string}`;
  try {
    address = getAddress(rawAddress.trim());
  } catch {
    throw new TokenReadFailed(rawAddress, 'not a valid EVM address');
  }

  const cacheKey = `${config.id}:${address.toLowerCase()}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  let decimals: number;
  try {
    decimals = Number(
      await client.readContract({ address, abi: ERC20_ABI, functionName: 'decimals' }),
    );
  } catch (error) {
    throw new TokenReadFailed(address, reasonOf(error));
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new TokenReadFailed(address, `decimals() returned ${decimals}, which is not usable`);
  }

  const symbol = await readStringish(client, address, 'symbol') ?? '???';
  const name = await readStringish(client, address, 'name');

  const warnings: string[] = [];
  const known = knownSymbolAddresses(config).get(symbol.toUpperCase());
  if (known && known !== address.toLowerCase()) {
    warnings.push(
      `This contract reports the symbol "${symbol}", but the well-known ${symbol} on `
      + `${config.name} is ${getAddress(known as `0x${string}`)}. Symbols are not unique and are `
      + 'not identity; impersonator tokens deliberately reuse them. Treat the address as the '
      + 'only identifier.',
    );
  }
  if (decimals !== 18 && decimals !== 6 && decimals !== 8) {
    warnings.push(`Unusual decimals (${decimals}). Check any amount you compute against this token.`);
  }

  const info: TokenInfo = { address, symbol, name, decimals, warnings };
  cache.set(cacheKey, info);
  return info;
}

async function readStringish(
  client: PublicClient,
  address: `0x${string}`,
  fn: 'symbol' | 'name',
): Promise<string | null> {
  try {
    return String(await client.readContract({ address, abi: ERC20_ABI, functionName: fn }));
  } catch {
    try {
      const raw = await client.readContract({ address, abi: ERC20_BYTES32_ABI, functionName: fn });
      return bytes32ToString(raw as `0x${string}`);
    } catch {
      // A token with no readable symbol is unusual but not fatal — unlike
      // decimals, nothing arithmetic depends on it.
      return null;
    }
  }
}

export function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // viem stacks a readable summary above a long call trace. The first line is
  // the part a caller wants.
  return message.split('\n')[0]!.trim().slice(0, 220);
}

/** Exposed for tests, which must not inherit a previous test's cache. */
export function clearTokenCache(): void {
  cache.clear();
}
