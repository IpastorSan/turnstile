// Create a buyer organization: two quorums, a mandate policy, and an org wallet.
//
// This is `npm run privy:setup` with one difference that is the entire point:
// the setup script generates the operator keypairs itself, which is correct on
// an operator's own machine and wrong here. This route never sees a private
// key. The browser generates them (web/lib/browser-key.ts) and posts only the
// public halves, which is all a Privy key quorum has ever consumed.
//
// **What we do hold.** The org is created under our Privy app, so our app
// secret can address these wallets. It cannot move their money: every mutation
// also needs `privy-authorization-signature` from the quorum's registered keys,
// and those live in the creator's browser and nowhere else. We are the
// registrar, not the custodian. Anyone who would rather not take that on runs
// `npm run privy:setup` against their own Privy app and self-hosts; the page
// hands them the .env block for exactly that.

import { NextRequest } from 'next/server';

import { ORG_CREATE, rateLimit } from '../../../../lib/rate-limit.ts';
import {
  PrivyClient,
  createKeyQuorum,
  createOrgWallet,
  credentialsFromEnv,
  registerOperator,
} from '../../../../../buyer/org/index.ts';
import { createMandatePolicy, demoMandate } from '../../../../../buyer/mandate/index.ts';

export const dynamic = 'force-dynamic';

/** Enough for a real board, small enough that this endpoint is not a free Privy account farm. */
const MAX_OPERATORS = 5;
const MAX_CAP_USD = 100;

interface OperatorInput {
  handle?: unknown;
  role?: unknown;
  email?: unknown;
  publicKey?: unknown;
}

function badRequest(reason: string): Response {
  return Response.json({ ok: false, reason }, { status: 400 });
}

export async function POST(request: NextRequest): Promise<Response> {
  // Before any parsing or Privy call: a throttled request must cost zero. This
  // endpoint creates users, quorums, a policy and a wallet under OUR Privy app,
  // so unlimited access to it is an account farm with our credentials.
  const limited = rateLimit(request, ORG_CREATE.name, ORG_CREATE.limit);
  if (limited) return limited;

  let body: { orgName?: unknown; operators?: unknown; capUsd?: unknown; agentAddress?: unknown };
  try {
    body = await request.json();
  } catch {
    return badRequest('the request body was not JSON');
  }

  const orgName = typeof body.orgName === 'string' && body.orgName.trim() ? body.orgName.trim().slice(0, 40) : 'Turnstile buyer org';

  if (!Array.isArray(body.operators)) return badRequest('operators must be an array');
  if (body.operators.length < 2) {
    return badRequest('a mandate needs at least two operators — the whole control is that raising the cap takes more than one person');
  }
  if (body.operators.length > MAX_OPERATORS) return badRequest(`at most ${MAX_OPERATORS} operators`);

  const operators: { handle: string; role: string; email: string; publicKey: string }[] = [];
  for (const [index, raw] of (body.operators as OperatorInput[]).entries()) {
    const { handle, role, email, publicKey } = raw;
    if (typeof handle !== 'string' || !handle.trim()) return badRequest(`operator ${index} has no handle`);
    if (typeof email !== 'string' || !email.includes('@')) return badRequest(`operator ${index} has no usable email`);
    if (typeof publicKey !== 'string' || publicKey.length < 40) {
      return badRequest(`operator ${index} has no public key — it is generated in your browser, so this usually means key generation failed`);
    }
    // A private key must never arrive here. If one does, refuse the whole
    // request rather than quietly ignore it: it means the client is not the one
    // we shipped, and the user's assumption about custody is wrong.
    if ('privateKey' in (raw as object)) {
      return badRequest('a private key was sent. This endpoint must never receive one, so the request was refused rather than processed.');
    }
    operators.push({
      handle: handle.trim().slice(0, 24),
      role: typeof role === 'string' && role.trim() ? role.trim().slice(0, 40) : 'operator',
      email: email.trim().slice(0, 120),
      publicKey,
    });
  }

  const capUsd = typeof body.capUsd === 'number' && Number.isFinite(body.capUsd) ? body.capUsd : 1;
  if (capUsd <= 0 || capUsd > MAX_CAP_USD) return badRequest(`the cap must be between 0 and ${MAX_CAP_USD} USD`);

  const agentAddress =
    typeof body.agentAddress === 'string' && /^0x[0-9a-fA-F]{40}$/.test(body.agentAddress)
      ? body.agentAddress
      : (process.env['ARC_AGENT_ADDRESS'] ?? '0x0633a193017939Bb1eB242982397224c66948e2F');

  try {
    const privy = new PrivyClient(credentialsFromEnv());

    // 1. The humans. Sequential rather than parallel: Privy assigns each an
    //    embedded wallet, and a partial failure is easier to read in order.
    const registered = [];
    for (const operator of operators) registered.push(await registerOperator(privy, operator));

    const publicKeys = registered.map(operator => operator.publicKey);

    // 2. Two quorums over the same people, with different thresholds. That
    //    asymmetry is the control: spending takes one, widening takes two.
    const [ops, board] = await Promise.all([
      createKeyQuorum(privy, { displayName: `${orgName} operations`, publicKeys, threshold: 1 }),
      createKeyQuorum(privy, { displayName: `${orgName} board`, publicKeys, threshold: 2 }),
    ]);

    // 3. The mandate, as a policy the BOARD owns.
    const mandate = demoMandate({ spendCapUsd: capUsd });
    const policy = await createMandatePolicy(privy, { mandate, agentAddress, ownerQuorumId: board.id });

    // 4. The wallet, owned by operations and governed by that policy. Both set
    //    at creation, never patched afterwards.
    const wallet = await createOrgWallet(privy, { ownerQuorumId: ops.id, policyId: policy.id, displayName: orgName });

    return Response.json({
      ok: true,
      orgName,
      walletId: wallet.id,
      walletAddress: wallet.address,
      opsQuorumId: ops.id,
      boardQuorumId: board.id,
      policyId: policy.id,
      policyName: policy.name,
      capUsd,
      agentAddress,
      operators: registered.map(operator => ({
        handle: operator.handle,
        role: operator.role,
        userId: operator.userId,
        walletAddress: operator.walletAddress,
      })),
    });
  } catch (error) {
    return Response.json({ ok: false, reason: (error as Error).message }, { status: 502 });
  }
}
