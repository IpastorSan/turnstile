// World Selfie Check: proof of personhood as an abuse control, not a login.
//
// Import from here. The split between `limits.ts` (the rule), `world.ts` (the
// protocol) and `store.ts` (the table) is for reading, not for consuming.

export { LISTINGS_PER_HUMAN, listingAllowance } from './limits.ts';
export type { ListingAllowance, ListingRefusalCode } from './limits.ts';

export { OPERATOR_ACTION, nullifierFrom, signRpContext, verifyProof, worldConfigFromEnv, worldIsConfigured } from './world.ts';
export type { RpContext, VerifiedProof, VerifyOutcome, WorldConfig } from './world.ts';

export { mayClaim, recordVerification, standingFor, verificationFor } from './store.ts';
export type { HumanStanding, VerificationRow } from './store.ts';
