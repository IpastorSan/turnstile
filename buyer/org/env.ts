// Reassembling the organization from `.env`.
//
// `scripts/privy-org-setup.ts` creates the operators, the two quorums, the
// mandate policy and the org wallet once; everything afterwards — funding the
// agent, raising the cap, the tests — needs to find them again. This is that
// lookup, in one place, with error messages that name the script to run rather
// than the variable that was undefined.
//
// The **only secrets** here are the operator authorization keys. They are in
// `.env` because this is a hackathon and `.env` is gitignored; in production
// each one belongs on its operator's own device, and the fact that this file
// reads them from a shared environment is the single largest gap between this
// demo and a real treasury. Said plainly rather than left for a reviewer to
// notice.

import { loadAuthorizationKey, type AuthorizationKey } from './authorization-key.ts';

/** One operator as `.env` knows them: a handle, a role, and a key. */
export interface EnvOperator {
  handle: string;
  role: string;
  key: AuthorizationKey;
  /** Present only if setup recorded it. Not needed to approve anything. */
  userId?: string;
  walletAddress?: string;
}

export interface OrgFromEnv {
  operators: EnvOperator[];
  opsQuorumId: string;
  boardQuorumId: string;
  policyId: string;
  walletId: string;
  walletAddress: string;
}

/** The two operators the demo onboards. Order is fixed so `approvals[0]` is always the proposer. */
export const DEMO_OPERATORS = [
  { handle: 'alice', role: 'CFO', email: 'alice@turnstile.example' },
  { handle: 'bob', role: 'Head of Research', email: 'bob@turnstile.example' },
] as const;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set — run \`npm run privy:setup\` and paste its .env block`);
  return value;
}

/** Read one operator's key, or say which variable is missing and where it comes from. */
export function operatorFromEnv(handle: string, role: string, env: NodeJS.ProcessEnv = process.env): EnvOperator {
  const upper = handle.toUpperCase();
  const operator: EnvOperator = { handle, role, key: loadAuthorizationKey(required(env, `PRIVY_OPERATOR_${upper}_KEY`)) };
  const userId = env[`PRIVY_OPERATOR_${upper}_USER_ID`];
  const walletAddress = env[`PRIVY_OPERATOR_${upper}_WALLET`];
  if (userId) operator.userId = userId;
  if (walletAddress) operator.walletAddress = walletAddress;
  return operator;
}

/**
 * Load the whole organization, or fail with the one command that fixes it.
 *
 * Deliberately all-or-nothing: a half-configured org — a wallet id with no
 * operator keys, say — can fund the agent but can never raise the cap, and
 * discovering that during a demo is worse than discovering it here.
 */
export function loadOrgFromEnv(env: NodeJS.ProcessEnv = process.env): OrgFromEnv {
  return {
    operators: DEMO_OPERATORS.map(o => operatorFromEnv(o.handle, o.role, env)),
    opsQuorumId: required(env, 'PRIVY_OPS_QUORUM_ID'),
    boardQuorumId: required(env, 'PRIVY_BOARD_QUORUM_ID'),
    policyId: required(env, 'PRIVY_MANDATE_POLICY_ID'),
    walletId: required(env, 'PRIVY_ORG_WALLET_ID'),
    walletAddress: required(env, 'PRIVY_ORG_WALLET_ADDRESS'),
  };
}

/** Is the org configured at all? For scripts that should degrade rather than throw. */
export function orgIsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    loadOrgFromEnv(env);
    return true;
  } catch {
    return false;
  }
}
