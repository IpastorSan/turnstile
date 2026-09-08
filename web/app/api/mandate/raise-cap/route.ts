// "Attempt a cap raise with one signature." It is supposed to fail.
//
// This is the only write path the web app has, and it exists because a refusal
// is the safest thing to demonstrate live: it proves the board quorum is real
// without this server ever holding enough keys to satisfy it.
//
// The route signs with **alice only**, hard-coded. The second operator's key is
// never read here, so there is no argument order or request parameter that
// could turn this into a real raise — the threshold is 2 and one signature can
// never meet it. `npm run privy:mandate` is where the two-signature path lives,
// on an operator's own machine, which is where it belongs.
//
// If Privy ever ACCEPTS this, that is a finding and not a success, so the route
// reports it as an error rather than reporting a raise.

import { PrivyClient, PrivyError, credentialsFromEnv, loadOrgFromEnv, operatorFromEnv } from '../../../../../buyer/org/index.ts';
import { demoMandate, getMandatePolicy, policySpendCapUsd, raiseSpendCap } from '../../../../../buyer/mandate/index.ts';

export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  const agentAddress = process.env['ARC_AGENT_ADDRESS'] ?? '0x0633a193017939Bb1eB242982397224c66948e2F';

  try {
    const org = loadOrgFromEnv();
    const privy = new PrivyClient(credentialsFromEnv());
    const alice = operatorFromEnv('alice', 'CFO');

    // The live cap, off the policy. A quorum may have raised it since the last
    // deploy, and proposing a number below the current cap fails for the wrong
    // reason — which would look like the quorum working when it was not.
    const policy = await getMandatePolicy(privy, org.policyId);
    const liveCapUsd = policySpendCapUsd(policy);
    if (liveCapUsd === null) {
      return Response.json({ ok: false, reason: `policy ${policy.id} has no depositFor cap` }, { status: 500 });
    }

    const mandate = demoMandate({ spendCapUsd: liveCapUsd });
    const proposedUsd = Number((liveCapUsd * 4).toFixed(6));

    await raiseSpendCap(privy, {
      policyId: org.policyId,
      mandate,
      newSpendCapUsd: proposedUsd,
      agentAddress,
      approvals: [alice.key], // one. never two.
    });

    // Unreachable if the quorum is configured as intended.
    return Response.json(
      {
        ok: false,
        unexpected: true,
        reason:
          'Privy ACCEPTED a cap raise carrying one signature where the board quorum requires two. That is a real finding, not a working demo — the quorum threshold is not doing what this page claims.',
        proposedUsd,
        fromUsd: liveCapUsd,
      },
      { status: 500 },
    );
  } catch (error) {
    const err = error as PrivyError;
    if (typeof err.status === 'number') {
      return Response.json(
        {
          ok: true,
          refused: true,
          status: err.status,
          detail: (err.body as { error?: string } | undefined)?.error ?? 'refused',
        },
        { status: 200 },
      );
    }
    return Response.json({ ok: false, reason: (error as Error).message }, { status: 500 });
  }
}
