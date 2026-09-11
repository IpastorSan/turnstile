// Sign a request context so the widget can ask for a proof as us.
//
// This exists because the signing key must never reach a browser: a context the
// client could mint itself is a context anyone could mint, and the signature is
// the only thing telling World the request came from this app.

import { NextRequest } from 'next/server';

import { OPERATOR_ACTION, signRpContext, worldConfigFromEnv, worldIsConfigured } from '../../../../../identity/index.ts';
import { WORLD_CONTEXT, rateLimit } from '../../../../lib/rate-limit.ts';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<Response> {
  // Signing is cheap locally, but the route exists to feed a widget an attacker
  // could drive; the paired /verify route is the one that calls World, so this
  // keeps their per-context window honest with ours.
  const limited = rateLimit(request, WORLD_CONTEXT.name, WORLD_CONTEXT.limit);
  if (limited) return limited;

  if (!worldIsConfigured()) {
    return Response.json(
      {
        ok: false,
        reason:
          'This deployment has no World credentials. Set WORLD_APP_ID, WORLD_RP_ID and WORLD_RP_SIGNING_KEY from the Developer Portal.',
      },
      { status: 503 },
    );
  }
  try {
    const config = worldConfigFromEnv();
    return Response.json({
      ok: true,
      app_id: config.appId,
      action: OPERATOR_ACTION,
      // The signature, nonce and window. The key itself stays here.
      rp_context: signRpContext(config, OPERATOR_ACTION),
    });
  } catch (error) {
    return Response.json({ ok: false, reason: (error as Error).message }, { status: 500 });
  }
}
