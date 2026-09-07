// A placeholder rail. It speaks the whole `PaymentRail` interface and settles
// nothing.
//
// It exists for three reasons, in order of importance:
//
//   1. **The 402 has to advertise two rails from day one.** The buyer's mandate
//      picks one from `accepts[]`, so a service that only ever offered one entry
//      would never exercise the choice, and the multi-rail path would be written
//      for the first time on the day both real rails existed.
//   2. `seller/service/` has to be testable without a testnet, a facilitator, or
//      a funded key.
//   3. It is the worked example a rail author reads. Everything MOV-220 and
//      MOV-225 must supply is a named field here.
//
// **It never claims to be live.** `info.live` is false and every challenge it
// issues carries `extra.turnstileSettlement: 'stub'`, so a payer inspecting the
// 402 can see that this entry moves no value. Advertising a rail that cannot
// settle, without saying so, would be a lie told on the wire to whoever is
// deciding whether to pay us.

import type {
  ChallengeRequest, NetworkId, PaymentPayload, PaymentRail,
  PaymentRequirement, RailInfo, Receipt, VerifyContext, VerifyResult,
} from './PaymentRail.ts';
import { usdToAtomic } from './PaymentRail.ts';

export interface StubRailConfig {
  id: string;
  label: string;
  scheme: string;
  network: NetworkId;
  asset: { id: string; symbol: string; decimals: number };
  ensRailToken: string;
  /** The seller's payout account, in this network's own address format. */
  payTo: string;
  /**
   * USD per whole unit of `asset`. `1` for a dollar stablecoin.
   *
   * A rail denominated in a volatile asset needs a live rate here, which is the
   * reason `challenge()` is async on the real interface.
   */
  usdPerUnit?: number;
  maxTimeoutSeconds?: number;
  /** Merged into every challenge's `extra`. Where a real rail puts chain detail. */
  extra?: Record<string, unknown>;
}

/**
 * In-memory settlement log. A real rail reads its chain or its facilitator;
 * MOV-220 will read HCS receipts, which is also what unblocks discovery's
 * `settledVolume` ranking.
 */
class ReceiptBook {
  private readonly byTransaction = new Map<string, Receipt>();
  private counter = 0;

  nextTransaction(railId: string): string {
    this.counter += 1;
    return `stub:${railId}:${String(this.counter).padStart(6, '0')}`;
  }

  record(receipt: Receipt): Receipt {
    this.byTransaction.set(receipt.transaction, receipt);
    return receipt;
  }

  find(transaction: string): Receipt | null {
    return this.byTransaction.get(transaction) ?? null;
  }
}

export function createStubRail(config: StubRailConfig): PaymentRail {
  const info: RailInfo = {
    id: config.id,
    label: config.label,
    scheme: config.scheme,
    network: config.network,
    asset: config.asset,
    ensRailToken: config.ensRailToken,
    live: false,
  };
  const book = new ReceiptBook();
  const maxTimeoutSeconds = config.maxTimeoutSeconds ?? 300;

  return {
    id: config.id,
    info,

    async challenge(req: ChallengeRequest): Promise<PaymentRequirement> {
      return {
        scheme: config.scheme,
        network: config.network,
        asset: config.asset.id,
        amount: usdToAtomic(req.priceUsd, config.asset.decimals, config.usdPerUnit ?? 1),
        payTo: config.payTo,
        maxTimeoutSeconds: req.maxTimeoutSeconds ?? maxTimeoutSeconds,
        extra: {
          ...config.extra,
          // Everything below this line is what `seller/service/` must never read.
          decimals: config.asset.decimals,
          symbol: config.asset.symbol,
          priceUsd: req.priceUsd,
          // Binding the challenge to the resource it was issued for. A payment
          // authorized for the cheap tier must not buy the premium one.
          resource: req.resource,
          turnstileSettlement: 'stub',
          turnstileNote: `PLACEHOLDER: ${config.id} advertises the shape of a real ${config.scheme} payment and settles nothing.`,
        },
      };
    },

    async verify(payload: PaymentPayload, context?: VerifyContext): Promise<VerifyResult> {
      const signature = payload.payload['signature'];
      if (typeof signature !== 'string' || signature.length === 0) {
        return { valid: false, reason: 'invalid_signature', payer: null, detail: 'payload.signature missing or empty' };
      }
      if (payload.accepted.payTo !== config.payTo) {
        return { valid: false, reason: 'wrong_recipient', payer: null, detail: `payTo ${payload.accepted.payTo} is not this seller's payout account` };
      }
      // The binding the service cannot check for us, because it lives in `extra`:
      // a challenge minted for the $0.07 route must not buy the $0.35 one.
      //
      // **A real rail must not copy this shape.** The value being compared here
      // is the payer's own copy of `accepted`, so a payer can simply delete
      // `extra.resource` and skip the check — which this stub allows, because a
      // stub signs nothing and has no honest way to tell a tampered requirement
      // from an untampered one. On a real rail the requirement is covered by the
      // payer's signature, so the comparison is meaningful; that is what makes
      // this check load-bearing there and advisory here.
      //
      // The downgrade attack itself is still blocked either way, by the
      // amount check in `seller/service/x402.ts` — which is exactly why that
      // check lives in the service rather than being delegated to rails.
      if (context) {
        const boundTo = payload.accepted.extra['resource'];
        if (typeof boundTo === 'string' && boundTo !== context.resource) {
          return { valid: false, reason: 'wrong_recipient', payer: null, detail: `payment was issued for ${boundTo}, not ${context.resource}` };
        }
      }
      const payer = typeof payload.payload['payer'] === 'string' ? payload.payload['payer'] as string : null;
      return { valid: true, reason: null, payer };
    },

    async settle(payload: PaymentPayload): Promise<Receipt> {
      const payer = typeof payload.payload['payer'] === 'string' ? payload.payload['payer'] as string : null;
      return book.record({
        railId: config.id,
        transaction: book.nextTransaction(config.id),
        success: true,
        network: config.network,
        payer,
        amount: payload.accepted.amount,
        asset: payload.accepted.asset,
        settledAt: Date.now(),
        error: null,
        extra: { settlement: 'stub', note: 'No value moved. Nothing was submitted to any network.' },
      });
    },

    async receipt(id: string): Promise<Receipt | null> {
      return book.find(id);
    },
  };
}
