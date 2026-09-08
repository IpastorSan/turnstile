// The buyer organization's warm tier: Privy, the operators, and the org wallet.
//
// Import from here rather than from the individual files — the split between
// `privy.ts` (transport), `authorization-key.ts` (crypto), `operators.ts`
// (people) and `org-wallet.ts` (the wallet itself) is for reading, not for
// consuming.

export { canonicalize, generateAuthorizationKey, loadAuthorizationKey, signAuthorizationPayload } from './authorization-key.ts';
export type { AuthorizationKey, AuthorizationPayload } from './authorization-key.ts';

export { PRIVY_API_BASE, PrivyClient, PrivyError, credentialsFromEnv } from './privy.ts';
export type { PrivyCredentials, RequestOptions } from './privy.ts';

export { createKeyQuorum, onboardOperator, registerOperator } from './operators.ts';
export type { KeyQuorum, OnboardOperatorOptions, Operator, RegisteredOperator } from './operators.ts';

export { createOrgWallet, getOrgWallet, signTransaction } from './org-wallet.ts';
export type { OrgWallet, PrivyTransactionRequest } from './org-wallet.ts';

export { DEMO_OPERATORS, loadOrgFromEnv, operatorFromEnv, orgIsConfigured } from './env.ts';
export type { EnvOperator, OrgFromEnv } from './env.ts';
