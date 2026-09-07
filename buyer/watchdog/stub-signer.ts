// The buyer-side counterpart to `rails/stub-rail.ts`.
//
// Produces the `{ signature, payer }` payload that a stub rail's `verify()`
// accepts, so the whole 402 -> pay -> 200 loop can be exercised end to end with
// no testnet and no funded key. MOV-220 and MOV-225 each replace this with a
// real signer next to their rail; nothing in `pay.ts` changes when they do.
//
// It signs nothing. The name is honest about that.

import type { PaymentRequirement } from '../../rails/PaymentRail.ts';
import type { RailSigner } from './pay.ts';

export interface StubSignerConfig {
  railId: string;
  scheme: string;
  network: string;
  decimals?: number;
  usdPerUnit?: number;
  /** The buyer's account, echoed back in the receipt. */
  payer?: string;
}

export function createStubSigner(config: StubSignerConfig): RailSigner {
  return {
    railId: config.railId,
    scheme: config.scheme,
    network: config.network,
    decimals: config.decimals ?? 6,
    usdPerUnit: config.usdPerUnit ?? 1,
    async sign(requirement: PaymentRequirement) {
      return {
        // A real signer signs over the requirement. This one only proves it
        // saw one, which is all the stub rail checks.
        signature: `stub-signature:${requirement.scheme}:${requirement.network}:${requirement.amount}`,
        payer: config.payer ?? 'stub-buyer',
      };
    },
  };
}
