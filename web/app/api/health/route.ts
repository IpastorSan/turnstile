// GET /api/health — what this deployment can actually reach.
//
// Both dependencies are external and either can be absent in a given
// environment, so the page says which, rather than degrading into blank panels.

import { resolveStore } from '../../../lib/discovery.ts';
import { knownSellers } from '../../../lib/ens.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const store = resolveStore();
  let sellers: string[] = [];
  let manifestError: string | null = null;
  try {
    sellers = knownSellers().map((s) => s.ensName);
  } catch (err) {
    manifestError = err instanceof Error ? err.message : String(err);
  }
  return Response.json(
    {
      discoveryStore: store ? { available: true, provenance: store.provenance } : { available: false },
      sepoliaRpc: { configured: Boolean(process.env.SEPOLIA_RPC_URL) },
      manifestSellers: sellers,
      manifestError,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
