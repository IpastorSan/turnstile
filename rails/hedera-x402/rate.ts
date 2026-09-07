// HBAR/USD, from Hedera's own network exchange rate.
//
// The seller prices in dollars and this rail settles in HBAR, so something has
// to convert. `PaymentRail.challenge()` is async precisely so that this can be a
// network read — see the note on it in `rails/PaymentRail.ts`.
//
// The rate used is the one Hedera itself uses to price transaction fees, served
// by the public mirror node at `/api/v1/network/exchangerate`. Two reasons to
// prefer it over a price API:
//
//   1. no key, no rate limit worth worrying about, and it is already a dependency
//      of this rail (the facilitator's own preflight reads the same mirror node);
//   2. it is the rate the network agrees on, so a payer can check our arithmetic
//      against a source neither of us controls.
//
// It is quantized and updated hourly, so it is not a market price. That is fine
// here and would not be on mainnet: what we need is a number both sides can
// derive, applied consistently between the challenge and the payment.

import { HBAR_USD_FALLBACK, MIRROR_NODE_URL } from './config.ts';

/** `GET /api/v1/network/exchangerate`. `hbar_equivalent` HBAR are worth `cent_equivalent` cents. */
interface ExchangeRateResponse {
  current_rate: { cent_equivalent: number; hbar_equivalent: number; expiration_time: number };
  next_rate?: { cent_equivalent: number; hbar_equivalent: number; expiration_time: number };
  timestamp: string;
}

export interface Rate {
  /** US dollars per whole HBAR. */
  usdPerHbar: number;
  /** Where it came from, verbatim into the challenge's `extra.rateSource`. */
  source: string;
}

export interface RateOptions {
  mirrorNodeUrl?: string;
  fetch?: typeof globalThis.fetch;
  /**
   * How long a fetched rate is reused.
   *
   * This is not only a courtesy to the mirror node. The service re-issues the
   * challenge on the paid request and compares the payer's chosen amount against
   * it, so a rate that moved between the two would quote a different number of
   * tinybars for the same seven cents. The comparison in
   * `seller/service/x402.ts` is `paid >= quoted`, which absorbs a rate move in
   * one direction only; caching absorbs both, and one HTTP round trip per
   * challenge is not the cost worth paying to find that out live.
   */
  ttlMs?: number;
  /** Overrides everything and skips the network. `HEDERA_HBAR_USD` sets it. */
  fixedUsdPerHbar?: number;
}

export class HbarRate {
  private readonly mirrorNodeUrl: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly ttlMs: number;
  private readonly fixed: number | null;
  private cached: { at: number; value: Rate } | null = null;

  constructor(options: RateOptions = {}) {
    this.mirrorNodeUrl = (options.mirrorNodeUrl ?? process.env['HEDERA_MIRROR_NODE_URL'] ?? MIRROR_NODE_URL).replace(/\/+$/, '');
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    const fromEnv = options.fixedUsdPerHbar ?? Number(process.env['HEDERA_HBAR_USD'] ?? Number.NaN);
    this.fixed = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : null;
  }

  /**
   * Never throws. A rail that cannot price is a rail that cannot be paid, and an
   * unreachable mirror node is not a good enough reason to take the seller
   * offline — so the fallback is used and *said*, in `extra.rateSource`, rather
   * than passed off as live.
   */
  async get(): Promise<Rate> {
    if (this.fixed !== null) return { usdPerHbar: this.fixed, source: 'HEDERA_HBAR_USD (configured)' };
    if (this.cached && Date.now() - this.cached.at < this.ttlMs) return this.cached.value;

    try {
      const res = await this.doFetch(`${this.mirrorNodeUrl}/api/v1/network/exchangerate`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`exchangerate returned ${res.status}`);
      const body = await res.json() as ExchangeRateResponse;
      const { cent_equivalent: cents, hbar_equivalent: hbar } = body.current_rate;
      if (!Number.isFinite(cents) || !Number.isFinite(hbar) || hbar <= 0 || cents <= 0) {
        throw new Error(`unusable exchange rate ${JSON.stringify(body.current_rate)}`);
      }
      const value: Rate = {
        usdPerHbar: cents / hbar / 100,
        source: `hedera mirror node /api/v1/network/exchangerate (${cents} cents per ${hbar} HBAR)`,
      };
      this.cached = { at: Date.now(), value };
      return value;
    } catch (cause) {
      return {
        usdPerHbar: HBAR_USD_FALLBACK,
        source: `FALLBACK ${HBAR_USD_FALLBACK} USD/HBAR — mirror node unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
  }
}
