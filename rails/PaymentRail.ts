// The shared seam. `rails/hedera-x402` (MOV-220) and `rails/arc-usdc` (MOV-225)
// both implement `PaymentRail`; `seller/service/` consumes it and must never
// learn which one answered.
//
// The rule that makes that true, and the only one worth memorising:
//
//   **The service speaks US dollars and opaque strings. The rail speaks chains.**
//
// A rail converts a USD price into its own asset's smallest unit, names its own
// payout account in its own address format, and puts everything a payer needs
// into `extra` — which the service copies onto the wire and never reads. Hedera
// settles through a partially-signed transaction co-signed by the Blocky402
// facilitator; Arc settles through a different facilitator stack entirely.
// Neither shape appears here, because both live inside `extra` and `payload`.
//
// If you find yourself wanting to add a field to `PaymentRequirement` so the
// service can branch on it, that is the abstraction failing. Put it in `extra`
// and give the rail a method instead.
//
// ---
//
// These types are deliberately *structurally* the x402 v2 wire shapes
// (`PaymentRequirements`, `PaymentPayload` from `@x402/core`), so the adapter in
// `rails/x402-adapter.ts` is a cast rather than a translation. They are declared
// here rather than imported so that a rail author reads one file, and so that an
// x402 SDK upgrade cannot silently change the seam two issues are building on.
// `rails/x402-adapter.test.ts` pins the two shapes together — if the SDK moves,
// that test fails rather than the wire format quietly drifting.

/**
 * A CAIP-2 chain identifier — `eip155:296`, `hedera:testnet`, `solana:mainnet`.
 *
 * Opaque to `seller/service/`. The service compares these for equality and
 * copies them onto the wire; it never parses one, and never branches on a
 * prefix. A `switch` on this value anywhere under `seller/service/` is the
 * abstraction leaking.
 */
export type NetworkId = string;

/**
 * What the seller wants paid for. The service's entire pricing vocabulary:
 * a dollar amount and a description. No asset, no chain, no address.
 */
export interface ChallengeRequest {
  /** Absolute URL of the resource being sold. Goes on the wire verbatim. */
  resource: string;
  /** Human-readable, shown to a payer deciding whether to pay. */
  description: string;
  /**
   * Decimal US dollars — `0.07`, not `"70000"`.
   *
   * The rail converts to its asset's smallest unit. That conversion is the
   * rail's business: a USDC rail multiplies by 1e6, an HBAR rail needs an FX
   * rate, and the service must not know which.
   */
  priceUsd: number;
  /** Seconds the payer has to produce a payment. Rails may clamp it. */
  maxTimeoutSeconds?: number;
}

/**
 * One way to pay, as it appears in the `accepts[]` array of a 402 challenge.
 * Structurally the x402 v2 `PaymentRequirements`.
 */
export interface PaymentRequirement {
  /** x402 payment scheme — `exact`, `upto`, ... Named by the rail. */
  scheme: string;
  network: NetworkId;
  /** Asset identifier in whatever form the network uses. Opaque to the service. */
  asset: string;
  /** Integer string in the asset's smallest unit. Never a float, never dollars. */
  amount: string;
  /** The seller's payout account, in the network's own address format. */
  payTo: string;
  maxTimeoutSeconds: number;
  /**
   * Everything chain-specific: token decimals, EIP-712 domains, a Hedera
   * transaction body to co-sign, a facilitator URL.
   *
   * **`seller/service/` never reads a key out of this object.** It is written by
   * the rail, copied onto the wire, and handed back to the rail. That is the
   * whole trick — it is why a Hedera partially-signed transaction and an Arc
   * USDC authorization can travel down the same code path.
   */
  extra: Record<string, unknown>;
}

/**
 * What a payer sends back in the `PAYMENT-SIGNATURE` header.
 * Structurally the x402 v2 `PaymentPayload`.
 */
export interface PaymentPayload {
  x402Version: number;
  /** The `accepts[]` entry the payer chose. Identifies the rail. */
  accepted: PaymentRequirement;
  /** The signature, authorization or partially-signed transaction. Rail-private. */
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

/**
 * Why a payment was rejected, as a stable machine-readable code.
 *
 * The buyer needs these to decide what to do next, and the three outcomes are
 * genuinely different: `insufficient_funds` means give up, `unsupported_rail`
 * means retry on the other rail in `accepts[]`, `expired` means re-fetch the
 * challenge. Collapsing them to `false` destroys that at the rail boundary,
 * where it cannot be recovered.
 *
 * Rails may return any string; these are the ones the buyer helper understands.
 */
export type VerifyFailureReason =
  | 'insufficient_funds'
  | 'invalid_signature'
  | 'wrong_amount'
  | 'wrong_recipient'
  | 'unsupported_rail'
  | 'expired'
  | 'already_settled'
  | 'facilitator_unavailable'
  | 'unknown';

/**
 * What the service knows about the request the payment arrived on.
 *
 * Optional, and a rail that ignores it still works. It exists so a rail *can*
 * bind its challenge to the resource it was issued for — the payer's chosen
 * entry travels back to us intact, so without something to compare it against, a
 * challenge minted for one URL could be replayed against another. The service
 * cannot make that check itself: the binding lives in the rail's own `extra`,
 * which the service must not read.
 */
export interface VerifyContext {
  /** Absolute URL of the resource being bought, right now. */
  resource: string;
  /** Every requirement currently on offer for it, freshly issued. */
  offered: readonly PaymentRequirement[];
}

export interface VerifyResult {
  valid: boolean;
  /** `null` when valid. A code from {@link VerifyFailureReason} when not. */
  reason: VerifyFailureReason | null;
  /** The payer's account, in the network's own format. `null` when unknown. */
  payer: string | null;
  /** Free text for a human reading a log. Never parsed. */
  detail?: string;
}

/**
 * Proof that a payment settled, in a form the audit trail can store.
 *
 * Every field is either a primitive or opaque. `transaction` is a Hedera
 * transaction id on one rail and an EVM transaction hash on the other; the
 * service stores and echoes it and never parses it.
 */
export interface Receipt {
  /** Which rail settled this. Matches {@link PaymentRail.id}. */
  railId: string;
  /**
   * The rail-native settlement identifier, and the key {@link PaymentRail.receipt}
   * looks up. Empty string only when `success` is false and nothing was submitted.
   */
  transaction: string;
  success: boolean;
  network: NetworkId;
  /** Payer account in the network's own format. `null` when the rail cannot say. */
  payer: string | null;
  /** Integer string in the asset's smallest unit — what actually moved. */
  amount: string | null;
  asset: string | null;
  /** Unix milliseconds the rail observed settlement. */
  settledAt: number;
  /** `null` on success. Free text on failure. */
  error: string | null;
  /**
   * Rail-specific settlement detail — consensus timestamp, block number, an
   * HCS sequence number. Never read by `seller/service/`.
   */
  extra?: Record<string, unknown>;
}

/** Static facts about a rail, for `/health` and for the 402's advertised set. */
export interface RailInfo {
  id: string;
  /** Human-readable, e.g. "Hedera testnet USDC via Blocky402". */
  label: string;
  scheme: string;
  network: NetworkId;
  asset: { id: string; symbol: string; decimals: number };
  /**
   * The token this rail is advertised as in the on-chain `turnstile:rails` text
   * record on `liquidity.turnstile.eth`.
   *
   * Not the same as {@link RailInfo.id}, and deliberately so — the ENS record is
   * cold-key-written and reads `x402,usdc-arc` (verified on Sepolia 2026-09-07),
   * while the implementation directories are `hedera-x402` and `arc-usdc`. A
   * buyer that discovered us through ENS matches on this field; one that read a
   * live 402 matches on `id`. `rails/registry.test.ts` asserts the two sets
   * reconcile, so the record and the wire cannot drift apart unnoticed.
   */
  ensRailToken: string;
  /**
   * `false` while the rail is a placeholder that cannot move real value.
   *
   * A stub that advertises itself as live is a lie told on the wire to a payer,
   * so this also appears in the challenge as `extra.turnstileSettlement`.
   */
  live: boolean;
}

/**
 * The seam. Four methods, and nothing above them knows which chain answered.
 *
 * All four are async on purpose, including `challenge` — pricing an HBAR
 * denominated rail needs an FX rate and an Arc rail may probe its facilitator's
 * `/supported`. A synchronous signature would force every rail to cache or
 * block, and widening it later would break both implementations at once.
 */
export interface PaymentRail {
  /** Stable identifier — `hedera-x402`, `arc-usdc`. Matches the directory name. */
  readonly id: string;
  readonly info: RailInfo;

  /** What goes in the 402. One `accepts[]` entry. */
  challenge(req: ChallengeRequest): Promise<PaymentRequirement>;

  /**
   * Is this payment good? Locally, or through the facilitator's `/verify`.
   *
   * Must not move value and must be safe to call more than once — the service
   * calls it before doing the work, so that a payer whose payment is bad is not
   * charged for an answer they will not receive.
   *
   * `context` is what the service knows about the request; see
   * {@link VerifyContext}. It is optional, so ignoring it is a valid rail.
   */
  verify(payload: PaymentPayload, context?: VerifyContext): Promise<VerifyResult>;

  /**
   * Move the value. The facilitator's `/settle`.
   *
   * Called only after `verify` returned `{ valid: true }` and after the work
   * succeeded. A rail that cannot settle returns `{ success: false, error }`
   * rather than throwing — a settlement failure after the work was done is an
   * accounting problem, not a crash, and the service has an answer to deliver.
   */
  settle(payload: PaymentPayload): Promise<Receipt>;

  /**
   * Audit-trail lookup by `Receipt.transaction`.
   *
   * `null` when this rail has never settled that id. Absence is an ordinary
   * answer here — a buyer polling for a receipt that has not landed yet is not
   * an error — so it is in the return type rather than an exception.
   */
  receipt(id: string): Promise<Receipt | null>;
}

/**
 * Thrown when a rail cannot answer at all — the facilitator is unreachable, a
 * key is missing, the config is wrong.
 *
 * Distinct from `verify` returning `{ valid: false }`, which means the rail
 * worked and the payment was bad. The service maps this to `503`, and a bad
 * payment to `402`, because they tell the buyer to do different things.
 */
export class PaymentRailError extends Error {
  readonly railId: string;
  readonly reason: VerifyFailureReason;

  constructor(railId: string, reason: VerifyFailureReason, message: string, options?: { cause?: unknown }) {
    super(`[${railId}] ${message}`, options);
    this.name = 'PaymentRailError';
    this.railId = railId;
    this.reason = reason;
  }
}

/** Convert dollars to an integer string in an asset's smallest unit. */
export function usdToAtomic(priceUsd: number, decimals: number, usdPerUnit = 1): string {
  if (!Number.isFinite(priceUsd) || priceUsd < 0) throw new RangeError(`priceUsd must be a non-negative number, got ${priceUsd}`);
  if (!Number.isFinite(usdPerUnit) || usdPerUnit <= 0) throw new RangeError(`usdPerUnit must be positive, got ${usdPerUnit}`);
  // Scale through an integer so 0.07 * 1e6 does not arrive as 69999.99999999999.
  const units = (priceUsd / usdPerUnit) * 10 ** decimals;
  return String(Math.round(units));
}
