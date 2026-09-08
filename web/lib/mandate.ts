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

/**
 * Read a mandate.
 *
 * With no argument this is the organization named in `.env` — the demo one.
 * With a wallet id it is anybody's: the wallet record carries its `policy_ids`,
 * so one id resolves the whole shape without the reader needing `.env` at all.
 * That is what makes `/mandate/<walletId>` work for an org created through the
 * browser, whose operator keys we deliberately never received.
 */
export async function readMandate(walletId?: string): Promise<MandateRead> {
  if (walletId) return readMandateByWalletId(walletId);
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

async function readMandateByWalletId(walletId: string): Promise<MandateRead> {
  try {
    const privy = new PrivyClient(credentialsFromEnv());
    const wallet = await getOrgWallet(privy, walletId);

    const policyId = wallet.policy_ids[0];
    if (!policyId) {
      return {
        ok: false,
        reason: `Wallet ${walletId} exists but has no policy attached, so it has no mandate to show. A wallet without a policy is not governed by anything.`,
      };
    }

    const policy = await getMandatePolicy(privy, policyId);
    const shape = demoMandate();

    return {
      ok: true,
      state: {
        walletId: wallet.id,
        walletAddress: wallet.address,
        // Read from the wallet and the policy themselves. Anything from `.env`
        // would describe the demo org, not this one.
        opsQuorumId: wallet.owner_id ?? 'unset',
        ownerId: wallet.owner_id,
        boardQuorumId: policy.owner_id ?? 'unset',
        policyId: policy.id,
        policyName: policy.name,
        policyOwnerId: policy.owner_id,
        rules: policy.rules.map(rule => ({ name: rule.name })),
        // We hold no operator keys for an org created in a browser, and Privy
        // does not list a quorum's members back. An empty list is the honest
        // answer; the page renders the quorum ids instead.
        operators: [],
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
