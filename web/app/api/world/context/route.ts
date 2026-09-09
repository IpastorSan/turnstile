// Sign a request context so the widget can ask for a proof as us.
//
// This exists because the signing key must never reach a browser: a context the
// client could mint itself is a context anyone could mint, and the signature is
// the only thing telling World the request came from this app.

import { OPERATOR_ACTION, signRpContext, worldConfigFromEnv, worldIsConfigured } from '../../../../../identity/index.ts';

export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
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
