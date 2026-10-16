// When the seller reads its price, and what it charges when it cannot.
//
// The price lives in two records on the seller's name (`tiers.ts` has why). This
// file decides how often to read them and what to do when a read goes wrong. It
// does not know where the records live: it is handed a `PriceReader`, and
// `price-records.ts` is the one that knows it is an ENS resolver.
//
// ## Freshness
//
// A read is cached for `ttlMs` (60s by default). The first request after expiry
// waits for a fresh read, so a hot-key reprice reaches the 402 within a minute
// with no code change and no redeploy, and a quiet seller makes no RPC calls at
// all — one read per minute at most, never one per request. Concurrent requests
// share a single read. The wait is bounded by `readTimeoutMs`; past it, the
// request is answered from what is already known and the read finishes in the
// background.
//
// ## Failure: last-known-good once loaded, closed before that
//
// A read can fail four ways: the endpoint is unreachable, a record is unset, a
// record is not a price, or the price is above the ceiling. All four are treated
// alike, because to a buyer they are alike — the seller does not know a price it
// is entitled to charge.
//
//   - **Once a good read has happened**, the seller keeps charging that price
//     and reports itself stale (in `/health`, and once in the log). The last
//     good price was published on chain under the ceiling, so charging it is
//     the smallest departure from the record available; refusing every sale
//     because an RPC provider hiccupped would hand availability to whoever runs
//     the RPC. A bad record does not displace a good one, so a hot-key typo
//     cannot take the service down either.
//   - **If no read has ever succeeded**, every paid route answers 503 with the
//     reason. There is nothing true to charge, and any number here — a default,
//     a constant, the last deploy's value — would be a guessed price presented
//     as the published one, which is the bug this file exists to remove.
//
// A failed read is retried after `retryMs` (5s), not `ttlMs`, so a seller that
// started while its RPC was down recovers within seconds of the RPC coming back.

import { priceTiers } from './tiers.ts';
import type { PricedTiers, PriceRecords } from './tiers.ts';

/** Reads the two price records. Rejects when the records cannot be read at all. */
export type PriceReader = () => Promise<PriceRecords & {
  /** Where and when the read happened, for logs and `/health`. */
  provenance?: string;
}>;

export type PriceState =
  /** `stale`: charging the last good read, and `reason` says why the latest one failed. */
  | { ok: true; tiers: PricedTiers; readAt: number; provenance?: string; stale: boolean; reason?: string }
  | { ok: false; reason: string };

/** What the app needs from pricing. `PriceBook` is the real one. */
export interface TierPricing {
  current(): Promise<PriceState>;
}

export interface PriceBookOptions {
  read: PriceReader;
  /** How long a good read is trusted. Default 60s. */
  ttlMs?: number;
  /** How soon a failed read is retried. Default 5s. */
  retryMs?: number;
  /** How long a request waits for a read. Default 5s. */
  readTimeoutMs?: number;
  /** Injected for tests. */
  now?: () => number;
  /** Price changes and failures. Default: silent. */
  log?: (line: string) => void;
}

export class PriceBook implements TierPricing {
  readonly #read: PriceReader;
  readonly #ttlMs: number;
  readonly #retryMs: number;
  readonly #readTimeoutMs: number;
  readonly #now: () => number;
  readonly #log: (line: string) => void;

  #good: { tiers: PricedTiers; readAt: number; provenance?: string } | undefined;
  #failure: string | undefined;
  #nextReadAt = Number.NEGATIVE_INFINITY;
  #inflight: Promise<void> | undefined;

  constructor(options: PriceBookOptions) {
    this.#read = options.read;
    this.#ttlMs = options.ttlMs ?? 60_000;
    this.#retryMs = options.retryMs ?? 5_000;
    this.#readTimeoutMs = options.readTimeoutMs ?? 5_000;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (() => {});
  }

  async current(): Promise<PriceState> {
    if (this.#now() >= this.#nextReadAt) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<void>(resolve => { timer = setTimeout(resolve, this.#readTimeoutMs); });
      await Promise.race([this.#refresh(), timedOut]);
      clearTimeout(timer);
    }
    return this.#state();
  }

  #state(): PriceState {
    if (!this.#good) {
      return { ok: false, reason: this.#failure ?? 'the price records have not been read yet' };
    }
    return { ok: true, ...this.#good, stale: this.#failure !== undefined, reason: this.#failure };
  }

  /** One read at a time; callers that arrive mid-read share it. */
  #refresh(): Promise<void> {
    this.#inflight ??= this.#readOnce().finally(() => { this.#inflight = undefined; });
    return this.#inflight;
  }

  async #readOnce(): Promise<void> {
    let tiers: PricedTiers;
    let provenance: string | undefined;
    try {
      const records = await this.#read();
      provenance = records.provenance;
      tiers = priceTiers(records);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      if (reason !== this.#failure) {
        this.#log(this.#good
          ? `[price] read failed, still charging the last good price ($${this.#good.tiers.standard.priceUsd}): ${reason}`
          : `[price] read failed and no price has ever loaded; paid routes answer 503: ${reason}`);
      }
      this.#failure = reason;
      this.#nextReadAt = this.#now() + Math.min(this.#retryMs, this.#ttlMs);
      return;
    }

    const before = this.#good?.tiers.records.price;
    if (before !== tiers.records.price || this.#failure !== undefined) {
      this.#log(`[price] standard $${tiers.standard.priceUsd}, premium $${tiers.premium.priceUsd}, ceiling $${tiers.ceilingUsd}` +
        (provenance ? ` (${provenance})` : ''));
    }
    this.#good = { tiers, readAt: this.#now(), provenance };
    this.#failure = undefined;
    this.#nextReadAt = this.#now() + this.#ttlMs;
  }
}
