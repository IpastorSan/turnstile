// The buyer's half of the Hedera rail: a `RailSigner` for `exact` on
// `hedera:testnet`.
//
// Small on purpose, and smaller than it first was. The transaction itself is
// built by **`@x402/hedera`'s own client signer** — the x402 Foundation's
// reference implementation of the Hedera `exact` scheme — rather than by us.
// That is worth the dependency: the facilitator validates the transaction's
// shape strictly (fee-payer identity, transfer sums, absence of non-transfer
// operations), and matching it from our own reading of the spec would be
// re-deriving something already written by the people who wrote the spec.
// `buyer/watchdog/pay.ts` still owns the two decisions that are ours — which
// offer to pay and whether to pay at all.
//
// ## What the reference signer does, in four lines
//
// It builds a `TransferTransaction` debiting the buyer and crediting `payTo`,
// then sets the transaction id to one generated for **`extra.feePayer`** — on
// Hedera the transaction id's account *is* the fee payer, so naming Blocky402's
// account there is what makes the facilitator pay the gas. It freezes, signs
// with the buyer's key only, and returns the bytes. The result is deliberately
// unsubmittable: valid in shape, missing the fee payer's signature. The buyer
// cannot broadcast it and the seller cannot alter it.
//
// ## Why the rate is read here and not taken from the seller
//
// `RailSigner.usdPerUnit` converts the seller's `amount` (tinybars) into the
// dollars the mandate is denominated in. The seller helpfully puts its own rate
// in `extra.usdPerUnit`, and using it would be a mistake: a seller that quotes
// 12 HBAR for "seven cents" and declares a rate making 12 HBAR look like seven
// cents would pass a cap computed from the seller's own arithmetic.
//
// From `CLAUDE.md`: **the key that spends can never raise its own limit.** A cap
// a counterparty can move is not a cap. So the rate comes from Hedera's network
// exchange rate, read by the buyer, and the seller's number is ignored — which
// is also why this is an async factory rather than a plain object literal.
//
// ## What the agent's key can and cannot do
//
// This is the hot tier. The key here signs one transfer, for one amount, to one
// account, and pays no gas. It cannot widen the mandate, rotate anything, or
// move a payout address; those live two tiers up.

import { PrivateKey, createClientHederaSigner } from '@x402/hedera';

import type { PaymentRequirement } from '../../rails/PaymentRail.ts';
import { HBAR_DECIMALS, NETWORK } from '../../rails/hedera-x402/config.ts';
import { HbarRate } from '../../rails/hedera-x402/rate.ts';
import type { RailSigner } from './pay.ts';

export interface HederaSignerOptions {
  /** The buyer agent's Hedera account. Defaults to `HEDERA_BUYER_ID`. */
  accountId?: string;
  /** Raw 64-hex ECDSA private key. Defaults to `HEDERA_BUYER_KEY`. */
  privateKey?: string;
  /** CAIP-2, and also what `@x402/hedera` uses to pick its node list. */
  network?: string;
  decimals?: number;
  /** Overrides the buyer's own rate lookup. Pass `1` for a dollar stablecoin. */
  usdPerUnit?: number;
}

export interface HederaRailSigner extends RailSigner {
  accountId: string;
  /** No-op. Present so callers can treat this like a resource with a lifetime. */
  close(): void;
}

/**
 * A `RailSigner` for the Hedera rail.
 *
 * Async because the mandate's dollar cap needs a rate the buyer trusts, and
 * because this is the natural place to fail if the agent has no key — before a
 * 402 is in flight rather than in the middle of answering one.
 */
export async function createHederaSigner(options: HederaSignerOptions = {}): Promise<HederaRailSigner> {
  const accountId = options.accountId ?? process.env['HEDERA_BUYER_ID'] ?? '';
  const rawKey = options.privateKey ?? process.env['HEDERA_BUYER_KEY'] ?? '';
  if (!accountId) throw new Error('no buyer Hedera account: set HEDERA_BUYER_ID or pass accountId');
  if (!rawKey) throw new Error('no buyer Hedera key: set HEDERA_BUYER_KEY or pass privateKey');

  const network = options.network ?? NETWORK;
  // `fromStringECDSA` wants the raw 64-hex form, which is the one
  // `docs/accounts.md` tells everyone to keep. It also accepts DER, so a key
  // pasted from the portal in the wrong form fails later rather than here.
  const inner = createClientHederaSigner(accountId, PrivateKey.fromStringECDSA(rawKey), { network });

  const decimals = options.decimals ?? HBAR_DECIMALS;
  const usdPerUnit = options.usdPerUnit ?? (await new HbarRate().get()).usdPerHbar;

  return {
    railId: 'hedera-x402',
    scheme: 'exact',
    network,
    decimals,
    usdPerUnit,
    accountId,
    async sign(requirement: PaymentRequirement): Promise<Record<string, unknown>> {
      // The reference signer takes the SDK's `PaymentRequirements`; ours is the
      // same object with a wider `network` type. The cast is the same one
      // `seller/service/x402.ts` makes, for the same reason.
      return { transaction: await inner.createPartiallySignedTransferTransaction(requirement as never) };
    },
    close() {
      // `@x402/hedera` opens and closes a client per signature, so there is
      // nothing to release. Kept so callers do not have to know that.
    },
  };
}
