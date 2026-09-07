// GET /api/offer/:name — one seller's ENSv2 records, read from Sepolia now.
//
// No cache header is a deliberate choice, not an oversight: the point of
// publishing an offer as a resolver record is that a buyer can read the current
// value themselves. A cached price is a claim about the past.

import { readOffer } from '../../../../lib/ens.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const result = await readOffer(decodeURIComponent(name));
  return Response.json(result, {
    status: result.ok ? 200 : 404,
    headers: { 'cache-control': 'no-store' },
  });
}
