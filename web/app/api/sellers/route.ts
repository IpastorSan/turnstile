// GET /api/sellers — the discovery query, over HTTP.
//
// This is the same call the MCP tool `find_sellers` makes, so a buyer's agent
// and this page are reading one directory through one engine rather than two
// that can disagree.

import { querySellers } from '../../../lib/discovery.ts';
import type { FindSellersQuery } from '../../../lib/discovery.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_LIMIT = 200;

function numberParam(v: string | null): number | undefined {
  if (v === null || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function listParam(v: string | null): string[] | undefined {
  if (!v) return undefined;
  const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

export function parseQuery(sp: URLSearchParams): FindSellersQuery {
  const limit = numberParam(sp.get('limit'));
  return {
    capabilities: listParam(sp.get('capability')),
    maxPriceUsd: numberParam(sp.get('maxPrice')),
    chains: listParam(sp.get('chain')),
    requireX402: sp.get('x402') === 'true' ? true : undefined,
    turnstileOnly: sp.get('turnstileOnly') === 'true' ? true : undefined,
    // The default is deliberately inverted from the CLI's. A directory that
    // hides the 196 agents with no readable price would be showing a market
    // that does not exist; the missing price is the finding, not a blank row.
    includeUnknownPrice: sp.get('includeUnknownPrice') !== 'false',
    limit: limit === undefined ? MAX_LIMIT : Math.min(Math.max(1, limit), MAX_LIMIT),
    offset: numberParam(sp.get('offset')),
  };
}

export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  const response = querySellers(parseQuery(sp));
  if (!response.ok) {
    return Response.json({ error: response.reason }, { status: 503 });
  }
  return Response.json(response, {
    headers: { 'cache-control': 'no-store' },
  });
}
