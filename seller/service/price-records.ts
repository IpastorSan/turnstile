// Where the price records live: the seller's ENSv2 name, on Sepolia (TUR-3).
//
// The composition half of pricing, in the same position as `server.ts` and
// `premium-cli.ts`: it names the chain once and hands `pricing.ts` a
// `PriceReader` with no chain vocabulary in it. `no-chain-code.test.ts` exempts
// this file by name for that reason and scans `pricing.ts` and `tiers.ts` like
// everything else on the payment path.
//
// The reads are `graph/sink/ens.ts` — the same client and resolver ABI that
// hydrate discovery and render the seller page — and the seller's identity is
// the deployment manifest, as everywhere else (MOV-218: no name is hard-coded).
// One resolver client, one pricing function (`priceTiers`), so the seller and
// discovery cannot read the same record two ways.

import { readFileSync } from 'node:fs';

import { makePublicClient, readPriceRecords } from '../../graph/sink/ens.ts';
import { sellersFromManifest } from '../../graph/sink/sellers.ts';
import type { SellerConfig } from '../../graph/sink/sellers.ts';
import { PriceBook } from './pricing.ts';
import type { PriceBookOptions, PriceReader } from './pricing.ts';

const MANIFEST = new URL('../../contracts/addresses.turnstile.sepolia.json', import.meta.url);

/** The seller this service prices itself as, from the manifest. */
export function manifestSeller(): SellerConfig {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, unknown>;
  const [seller] = sellersFromManifest(manifest);
  if (!seller) throw new Error('the deployment manifest names no seller');
  return seller;
}

/**
 * Read `turnstile:price` and `turnstile:price-ceiling` off the seller's resolver.
 *
 * An unreachable RPC rejects; an unset record arrives as `undefined` and is
 * rejected by `priceTiers()`. Either way nothing is charged from it, and the
 * reason says which.
 */
export function ensPriceReader(rpcUrl: string | undefined, seller: SellerConfig = manifestSeller()): PriceReader {
  if (!rpcUrl) {
    return async () => { throw new Error('SEPOLIA_RPC_URL is not set, so the price records cannot be read'); };
  }
  const client = makePublicClient(rpcUrl);
  return async () => {
    const read = await readPriceRecords(client, { ensName: seller.ensName, resolver: seller.resolver });
    return {
      price: read.price,
      ceiling: read.priceCeiling,
      provenance: `${seller.ensName} at Sepolia block ${read.readAtBlock}`,
    };
  };
}

/** The seller's live price book: what `npm run serve` and the paid demos charge. */
export function livePricing(options: Omit<PriceBookOptions, 'read'> = {}): PriceBook {
  return new PriceBook({ read: ensPriceReader(process.env['SEPOLIA_RPC_URL']), ...options });
}
