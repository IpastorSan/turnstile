// The live mandate, read for the page at /mandate.
//
// This is the warm tier as it actually exists right now, not a description of
// it: the Privy organization wallet, the two key quorums that govern it, and
// the policy that caps what the agent may spend. Every value below is fetched
// per request from Privy, and the spend cap in particular is read off the
// **policy** rather than from `demoMandate()`, because a quorum can raise it and
// a page quoting the literal would then be quietly wrong.
//
// Read-only, deliberately. Issuing a mandate and raising a cap need operator
// signatures, and holding both operators' keys server-side so a browser button
// could work would defeat the exact property this page exists to show. The one
// interactive control on the page attempts a raise with a SINGLE signature,
// which is supposed to fail — see app/api/mandate/raise-cap/route.ts.

import {
  PrivyClient,
  credentialsFromEnv,
  getOrgWallet,
  loadOrgFromEnv,
  orgIsConfigured,
} from '../../buyer/org/index.ts';
import { demoMandate, getMandatePolicy, policySpendCapUsd, type Policy } from '../../buyer/mandate/index.ts';

export interface MandateOperator {
  handle: string;
  role: string;
  userId?: string;
  walletAddress?: string;
}

export interface MandateState {
  walletId: string;
  walletAddress: string;
  /** The quorum that owns the wallet. Signing a transaction needs its threshold. */
  opsQuorumId: string;
  ownerId: string | null;
  /** The separate quorum that owns the policy. Raising the cap needs THIS one. */
  boardQuorumId: string;
  policyId: string;
  policyName: string;
  policyOwnerId: string | null;
  rules: { name: string }[];
  operators: MandateOperator[];
  /** Read off the live policy, not from a literal. Null if the policy is not ours. */
  spendCapUsd: number | null;
  maxPerQueryUsd: number;
  railPreference: readonly string[];
  sellerAllowlist: readonly string[];
  readAt: string;
}

export type MandateRead =
  | { ok: true; state: MandateState }
  | { ok: false; reason: string };

export async function readMandate(): Promise<MandateRead> {
  if (!orgIsConfigured()) {
    return {
      ok: false,
      reason:
        'This deployment has no Privy organization configured. `npm run privy:setup` creates the operators, both quorums, the policy and the org wallet, and prints the .env block to paste.',
    };
  }

  try {
    const org = loadOrgFromEnv();
    const privy = new PrivyClient(credentialsFromEnv());

    // Both reads are GETs, which Privy does not require an authorization
    // signature for — nothing here can mutate anything.
    const [wallet, policy] = await Promise.all([
      getOrgWallet(privy, org.walletId),
      getMandatePolicy(privy, org.policyId) as Promise<Policy>,
    ]);

    const shape = demoMandate();

    return {
      ok: true,
      state: {
        walletId: org.walletId,
        walletAddress: org.walletAddress,
        opsQuorumId: org.opsQuorumId,
        ownerId: wallet.owner_id,
        boardQuorumId: org.boardQuorumId,
        policyId: policy.id,
        policyName: policy.name,
        policyOwnerId: policy.owner_id,
        rules: policy.rules.map(rule => ({ name: rule.name })),
        operators: org.operators.map((op): MandateOperator => ({
          handle: op.handle,
          role: op.role,
          userId: op.userId,
          walletAddress: op.walletAddress,
        })),
        spendCapUsd: policySpendCapUsd(policy),
        maxPerQueryUsd: shape.maxPerQueryUsd,
        railPreference: shape.railPreference,
        sellerAllowlist: shape.sellerAllowlist,
        readAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}
