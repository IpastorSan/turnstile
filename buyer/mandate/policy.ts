// The mandate, projected onto a Privy policy — the half of enforcement that
// does not run on our machine.
//
// `enforce.ts` stops the *agent* from overspending. This file stops **anyone
// holding our Privy app secret** from over-funding the agent, which is a
// different and stronger claim. Privy's enclave evaluates these rules before a
// signature exists; a server that has been fully compromised still cannot
// deposit a dollar more than the mandate says, and still cannot raise the
// mandate without two operators' authorization keys that the server never held.
//
// That is `CLAUDE.md`'s invariant with the last piece filled in:
//
// > **the key that spends can never raise its own limit** — and now neither can
// > the key that *funds* it.
//
// ## What the cap is actually on
//
// The org's only spending action is funding the agent: `approve()` on USDC, then
// `depositFor(token, agent, value)` on Circle's GatewayWallet. So capping
// `depositFor.value` caps the entire mandate at its source — the agent's Gateway
// balance is the only money it can reach, and this is the only tap that fills
// it. See `docs/arc-nanopayments.md` for why the deposit is what funds a wallet
// that never transacts.
//
// The `depositor` argument is pinned to the agent's address in the same rule, so
// the org wallet cannot fund a *different* agent inside its cap either.
//
// ## Two things Privy's policy engine does that the docs do not spell out
//
// Both verified live on 2026-09-07, both cost real time:
//
//  1. **A catch-all `{ method: '*', action: 'DENY' }` rule denies everything**,
//     including requests an earlier `ALLOW` rule matched. DENY is not "the last
//     word in an ordered list", it is a veto. Privy is already deny-by-default —
//     a policy with **zero** rules refuses every request — so the catch-all is
//     both unnecessary and actively harmful. There is deliberately none below.
//  2. **Address comparisons are case-sensitive.** Privy stores a condition's
//     address value EIP-55 checksummed, and compares it against the transaction's
//     `to` verbatim. A lowercase `to` against a checksummed rule silently fails
//     the match and lands in the deny-by-default path, which surfaces as
//     `policy_violation` with no hint that the addresses were the same address.
//     Everything below goes through viem's `getAddress()`.

import { getAddress } from 'viem';

import type { AuthorizationKey } from '../org/authorization-key.ts';
import type { PrivyClient } from '../org/privy.ts';
import { GATEWAY_WALLET, USDC_ASSET, USDC_DECIMALS } from '../../rails/arc-usdc/config.ts';
import type { Mandate } from './mandate.ts';

/** `depositFor(token, depositor, value)` on Circle's GatewayWallet. Privy decodes calldata with this. */
export const DEPOSIT_FOR_ABI = [
  {
    name: 'depositFor',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'depositor', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

/**
 * `approve(spender, value)`.
 *
 * The parameter names are ours to pick — Privy decodes positionally off the
 * four-byte selector, which comes from `approve(address,uint256)` and not from
 * what we called the arguments. They are named to match the policy `field`
 * strings below, which is the only thing that has to agree.
 */
export const APPROVE_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

/**
 * Dollars to USDC atomic units, rounding **down**.
 *
 * Down rather than nearest because this number is a ceiling: rounding a cap up,
 * even by one atomic unit, authorizes more than the operators approved.
 */
export function usdToUsdcAtomic(usd: number): bigint {
  if (!Number.isFinite(usd) || usd < 0) throw new Error(`not a dollar amount: ${usd}`);
  return BigInt(Math.floor(usd * 10 ** USDC_DECIMALS));
}

export interface PolicyRule {
  name: string;
  method: string;
  conditions: unknown[];
  action: 'ALLOW' | 'DENY';
}

export interface Policy {
  id: string;
  name: string;
  chain_type: string;
  rules: (PolicyRule & { id: string })[];
  owner_id: string | null;
}

/**
 * The mandate as Privy rules: fund this agent, up to this much, and nothing
 * else.
 *
 * Two rules and no third. Anything the org wallet might want to do that is not
 * one of these two calls is refused by Privy's deny-by-default, which is both
 * stricter than a catch-all DENY and — per the header — the only thing that
 * actually works.
 */
export function mandatePolicyRules(mandate: Mandate, agentAddress: string): PolicyRule[] {
  const cap = `0x${usdToUsdcAtomic(mandate.spendCapUsd).toString(16)}`;
  const agent = getAddress(agentAddress);
  const usdc = getAddress(USDC_ASSET);
  const gateway = getAddress(GATEWAY_WALLET);

  return [
    {
      name: 'Fund the agent, within the mandate',
      method: 'eth_signTransaction',
      conditions: [
        { field_source: 'ethereum_transaction', field: 'to', operator: 'eq', value: gateway },
        { field_source: 'ethereum_calldata', field: 'depositFor.depositor', abi: DEPOSIT_FOR_ABI, operator: 'eq', value: agent },
        { field_source: 'ethereum_calldata', field: 'depositFor.value', abi: DEPOSIT_FOR_ABI, operator: 'lte', value: cap },
      ],
      action: 'ALLOW',
    },
    {
      name: 'Approve the GatewayWallet, within the mandate',
      method: 'eth_signTransaction',
      conditions: [
        { field_source: 'ethereum_transaction', field: 'to', operator: 'eq', value: usdc },
        { field_source: 'ethereum_calldata', field: 'approve.spender', abi: APPROVE_ABI, operator: 'eq', value: gateway },
        { field_source: 'ethereum_calldata', field: 'approve.value', abi: APPROVE_ABI, operator: 'lte', value: cap },
      ],
      action: 'ALLOW',
    },
  ];
}

/** A stable, human-readable policy name. Privy caps it at 50 characters. */
export function mandatePolicyName(mandate: Mandate): string {
  return `Turnstile mandate — $${mandate.spendCapUsd} cap`.slice(0, 50);
}

/**
 * Create the mandate policy, owned by the **board** quorum.
 *
 * The owner is the whole point: from this moment the policy can only be changed
 * by a request carrying enough operator signatures, and our app secret is not
 * one of them.
 */
export async function createMandatePolicy(
  privy: PrivyClient,
  options: { mandate: Mandate; agentAddress: string; ownerQuorumId: string },
): Promise<Policy> {
  return privy.post<Policy>('/v1/policies', {
    version: '1.0',
    name: mandatePolicyName(options.mandate),
    chain_type: 'ethereum',
    rules: mandatePolicyRules(options.mandate, options.agentAddress),
    owner_id: options.ownerQuorumId,
  });
}

export async function getMandatePolicy(privy: PrivyClient, policyId: string): Promise<Policy> {
  return privy.get<Policy>(`/v1/policies/${policyId}`);
}

/**
 * Raise the mandate's spend cap. **This is the quorum-gated operation.**
 *
 * Privy counts the signatures in `privy-authorization-signature` and compares
 * them against the policy owner's `authorization_threshold`. One short and the
 * request comes back `401` with
 * `"Number of signatures … does not match the wallet's authorization threshold"`
 * — captured verbatim on 2026-09-07, and reproduced by
 * `npm run privy:mandate -- --raise` with a single approver.
 *
 * Note what is *not* here: no code path that raises the cap without approvals,
 * no "force" flag, no admin override. There cannot be one — the check runs on
 * Privy's side, so an override here would simply be a 401 with extra steps.
 */
export async function raiseSpendCap(
  privy: PrivyClient,
  options: {
    policyId: string;
    mandate: Mandate;
    newSpendCapUsd: number;
    agentAddress: string;
    /** One per approving operator. Must satisfy the board quorum's threshold. */
    approvals: readonly AuthorizationKey[];
  },
): Promise<{ policy: Policy; mandate: Mandate }> {
  if (options.newSpendCapUsd <= options.mandate.spendCapUsd) {
    throw new Error(
      `refusing to "raise" the cap from $${options.mandate.spendCapUsd} to $${options.newSpendCapUsd} — ` +
        'lowering a cap is a different operation with different risk, and should not be smuggled through this one',
    );
  }
  const raised: Mandate = { ...options.mandate, spendCapUsd: options.newSpendCapUsd };
  const policy = await privy.patch<Policy>(
    `/v1/policies/${options.policyId}`,
    { name: mandatePolicyName(raised), rules: mandatePolicyRules(raised, options.agentAddress) },
    { approvals: options.approvals },
  );
  return { policy, mandate: raised };
}

/**
 * Read the spend cap back out of a live policy.
 *
 * The policy is the authority, not the {@link Mandate} literal in a script: once
 * a quorum has raised the cap, a script still quoting `demoMandate()` is
 * describing a mandate that no longer exists. Reading it back means the demo can
 * be run twice without lying the second time.
 *
 * Returns `null` when no rule caps `depositFor.value` — which means the policy
 * is not one of ours, and a caller should say so rather than assume a number.
 */
export function policySpendCapUsd(policy: Pick<Policy, 'rules'>): number | null {
  for (const rule of policy.rules) {
    for (const condition of rule.conditions as { field?: string; operator?: string; value?: string }[]) {
      if (condition.field === 'depositFor.value' && condition.operator === 'lte' && typeof condition.value === 'string') {
        return Number(BigInt(condition.value)) / 10 ** USDC_DECIMALS;
      }
    }
  }
  return null;
}
