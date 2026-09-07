// The buyer's half of the Arc rail: a `RailSigner` for `exact` on
// `eip155:5042002`.
//
// Small, like the Hedera signer, and for the same reason: the authorization is
// built by **Circle's own client scheme** (`BatchEvmScheme`) rather than by us.
// Re-deriving an EIP-712 domain from a spec when the counterparty ships the
// encoder is how a signature ends up valid-looking and unverifiable.
// `buyer/watchdog/pay.ts` still owns the two decisions that are ours — which
// offer to pay and whether to pay at all.
//
// ## What signing does, and what it deliberately does not do
//
// `BatchEvmScheme` reads `extra.name`, `extra.version` and
// `extra.verifyingContract` out of the seller's requirement, builds an EIP-3009
// `TransferWithAuthorization` for exactly `requirement.amount`, and signs it as
// typed data. That is the whole operation. It:
//
//   - **sends no transaction**, so this key pays no gas and its nonce never
//     moves. That is the zero-gas property, and `scripts/arc-paid-request.ts`
//     checks it on chain rather than taking this comment's word for it;
//   - **spends a Gateway balance**, not a token allowance — the authorization's
//     verifying contract is the GatewayWallet. So this key can only spend what
//     the warm tier already deposited **for** it via `depositFor`, and it cannot
//     top itself up: a deposit is a transaction, and a transaction needs gas
//     this wallet does not have.
//
// That last sentence is the `CLAUDE.md` invariant — the key that spends can
// never raise its own limit — enforced by the chain rather than by our code.
//
// ## Why `usdPerUnit` is 1, and why that is still our number and not the seller's
//
// The Hedera signer reads an exchange rate itself, because taking the seller's
// `extra.usdPerUnit` would let a seller quote 12 HBAR as "seven cents" and pass
// a cap computed from its own arithmetic. USDC needs no rate — but the principle
// is unchanged, so the `1` here is a constant this file owns and the seller's
// `extra.usdPerUnit` is still ignored. A seller that quoted `usdPerUnit: 0.01`
// on a USDC rail would be trying the same trick with different numbers.

import { BatchEvmScheme } from '@circle-fin/x402-batching/client';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';

import type { PaymentRequirement } from '../../rails/PaymentRail.ts';
import { NETWORK, USDC_DECIMALS } from '../../rails/arc-usdc/config.ts';
import type { RailSigner } from './pay.ts';

export interface ArcSignerOptions {
  /** The buyer agent's raw 32-byte hex key. Defaults to `ARC_AGENT_PRIVATE_KEY`. */
  privateKey?: string;
  network?: string;
  decimals?: number;
  /** Overrides the dollar assumption. Present for a non-dollar Gateway asset. */
  usdPerUnit?: number;
}

export interface ArcRailSigner extends RailSigner {
  address: Address;
  /** No-op. Present so callers can treat this like a resource with a lifetime. */
  close(): void;
}

/**
 * A `RailSigner` for the Arc rail.
 *
 * Async only to match {@link createHederaSigner}'s shape, so
 * `scripts/arc-paid-request.ts` can build both the same way. There is nothing to
 * await — which is itself the point worth noticing about a dollar-denominated
 * rail.
 */
export async function createArcSigner(options: ArcSignerOptions = {}): Promise<ArcRailSigner> {
  const rawKey = options.privateKey ?? process.env['ARC_AGENT_PRIVATE_KEY'] ?? '';
  if (!rawKey) throw new Error('no buyer Arc key: set ARC_AGENT_PRIVATE_KEY or pass privateKey');

  const account = privateKeyToAccount((rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as Hex);
  const scheme = new BatchEvmScheme(account);
  const network = options.network ?? NETWORK;

  return {
    railId: 'arc-usdc',
    scheme: 'exact',
    network,
    decimals: options.decimals ?? USDC_DECIMALS,
    usdPerUnit: options.usdPerUnit ?? 1,
    address: account.address,
    async sign(requirement: PaymentRequirement): Promise<Record<string, unknown>> {
      // `createPaymentPayload` returns `{ x402Version, payload }`; the rail seam
      // wants only the rail-private half, because `pay.ts` puts the version back
      // on. It throws when the requirement carries no Gateway batching metadata,
      // which is the correct failure: without `verifyingContract` there is no
      // domain to sign against and a guessed one produces a signature that
      // verifies as garbage.
      const { payload } = await scheme.createPaymentPayload(2, requirement as never);
      return payload as unknown as Record<string, unknown>;
    },
    close() {
      // Nothing to release: signing is local and opens no connection.
    },
  };
}
