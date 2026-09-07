// The mandate: what the organization authorized, and the two places it is
// enforced.
//
// `mandate.ts` is the object, `enforce.ts` is the agent-side refusal, and
// `policy.ts` is the same limit expressed as a Privy policy that Privy's own
// enclave enforces. Read them in that order.

export { MandateLedger, demoMandate, isAllowlistedSeller, verifiedOperatorGate } from './mandate.ts';
export type { Mandate, RailId, Refusal, RefusalCode } from './mandate.ts';

export { MandateRefused, decide, mandateSpendingLimits, paidFetchForMandate } from './enforce.ts';

export {
  APPROVE_ABI,
  DEPOSIT_FOR_ABI,
  createMandatePolicy,
  getMandatePolicy,
  mandatePolicyName,
  mandatePolicyRules,
  policySpendCapUsd,
  raiseSpendCap,
  usdToUsdcAtomic,
} from './policy.ts';
export type { Policy, PolicyRule } from './policy.ts';
