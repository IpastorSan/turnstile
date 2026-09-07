// The Blocky402 HTTP client. Three endpoints and a reason code table.
//
// Blocky402 is an open-source (MIT) x402 facilitator from BlockyDevs, hosted at
// `https://api.testnet.blocky402.com`. It covers Hedera testnet, Polygon Amoy
// and Solana devnet. **Verified 2026-09-07: no signup, no API key, no
// Authorization header on testnet** — `GET /supported` and `GET /health` both
// answer an unauthenticated request.
//
// What it does for us is the part of Hedera's x402 flow that has no EVM
// analogue: the payer signs a `TransferTransaction` but does *not* pay for it,
// so the transaction names Blocky402's account (`0.0.7162784`) as its fee payer
// and arrives here partially signed. `/settle` adds the second signature, submits
// it, and waits for consensus. That is why the seller never needs the payer to
// hold gas, and why `extra.feePayer` is not optional garnish — the client SDK
// throws without it and the facilitator rejects a transaction whose
// `transactionId` account is anyone else.
//
// This file is deliberately a plain `fetch` client rather than an SDK import.
// `@x402/hedera` ships a *facilitator-side* scheme (it wants the fee payer's
// private key) and a *client-side* signer; neither is the resource-server half,
// which is just these two POSTs. Depending on the SDK here would buy nothing and
// couple our rail to a package whose server half we already declined to use for
// the reason in `seller/service/x402.ts`.

import type { PaymentPayload, PaymentRequirement, VerifyFailureReason } from '../PaymentRail.ts';
import { FACILITATOR_URL } from './config.ts';

/** `GET /supported`. One entry per (scheme, network) the facilitator will settle. */
export interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
  /** For Hedera, `{ feePayer: '0.0.7162784' }` — the account that pays the gas. */
  extra?: Record<string, unknown>;
}

export interface SupportedResponse {
  kinds: SupportedKind[];
  extensions: unknown[];
  /** Keyed by CAIP-2 family — `hedera:*`, `eip155:*`, `solana:*`. */
  signers?: Record<string, string[]>;
}

export interface FacilitatorVerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  invalidMessage?: string;
  payer?: string;
}

export interface FacilitatorSettleResponse {
  success: boolean;
  /** Hedera transaction id, `0.0.7162784@1788789662.378811934`. */
  transaction: string;
  network: string;
  payer?: string;
  errorReason?: string;
  errorMessage?: string;
}

export class FacilitatorError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FacilitatorError';
    this.status = status;
  }
}

export interface FacilitatorOptions {
  baseUrl?: string;
  /** Injectable so the rail's tests never touch the network. */
  fetch?: typeof globalThis.fetch;
  /** Milliseconds. `/settle` waits for Hedera consensus, so this is generous. */
  timeoutMs?: number;
  /** How long `/supported` is cached. Its `feePayer` changes only if Blocky402 rotates. */
  supportedTtlMs?: number;
}

/**
 * Translate a facilitator reason code into one of ours.
 *
 * The codes are `@x402/hedera`'s, read out of its facilitator scheme rather than
 * guessed. The mapping matters because the buyer branches on it: `expired` means
 * re-fetch the challenge, `unsupported_rail` means try the other `accepts[]`
 * entry, `insufficient_funds` means stop. Anything unrecognised becomes
 * `unknown` rather than being forced into a neighbouring bucket — a buyer that
 * retries on a code we misclassified wastes a payment.
 */
export function toVerifyFailureReason(invalidReason: string | undefined, message?: string): VerifyFailureReason {
  const reason = invalidReason ?? '';
  const detail = `${reason} ${message ?? ''}`.toLowerCase();

  // The preflight hook is the only place a balance problem surfaces, and it
  // reports it in prose rather than in the code, so the code alone is not enough.
  if (detail.includes('insufficient') || detail.includes('balance')) return 'insufficient_funds';
  if (reason.includes('signature_invalid')) return 'invalid_signature';
  if (reason.includes('amount_mismatch') || reason === 'invalid_amount') return 'wrong_amount';
  if (reason.includes('pay_to') || reason.includes('receiver')) return 'wrong_recipient';
  if (reason === 'accepted_payment_requirements_mismatch') return 'wrong_amount';
  if (reason === 'network_mismatch' || reason === 'unsupported_scheme' || reason === 'invalid_asset') return 'unsupported_rail';
  if (reason === 'fee_payer_not_managed_by_facilitator' || reason.includes('fee_payer')) return 'unsupported_rail';
  if (reason.includes('duplicate') || detail.includes('duplicate')) return 'already_settled';
  if (reason.includes('expired') || detail.includes('expired') || detail.includes('transaction_expired')) return 'expired';
  return 'unknown';
}

export class Blocky402Facilitator {
  readonly baseUrl: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly supportedTtlMs: number;
  private cachedSupported: { at: number; value: SupportedResponse } | null = null;

  constructor(options: FacilitatorOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env['BLOCKY402_URL'] ?? FACILITATOR_URL).replace(/\/+$/, '');
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.supportedTtlMs = options.supportedTtlMs ?? 5 * 60_000;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await this.doFetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (cause) {
      throw new FacilitatorError(`${url} is unreachable: ${cause instanceof Error ? cause.message : String(cause)}`, null, { cause });
    }
    const text = await res.text();
    if (!res.ok) {
      // A 4xx here is a malformed request, not a bad payment — the payment
      // verdict comes back as a 200 with `isValid: false`. Keeping them
      // distinct is what lets the service answer 503 rather than 402.
      throw new FacilitatorError(`${path} returned ${res.status}: ${text.slice(0, 400)}`, res.status);
    }
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new FacilitatorError(`${path} returned unparseable JSON: ${text.slice(0, 200)}`, res.status, { cause });
    }
  }

  /** `GET /supported`, cached. Where `extra.feePayer` comes from. */
  async supported(): Promise<SupportedResponse> {
    const fresh = this.cachedSupported && Date.now() - this.cachedSupported.at < this.supportedTtlMs;
    if (fresh && this.cachedSupported) return this.cachedSupported.value;
    const value = await this.request<SupportedResponse>('/supported');
    this.cachedSupported = { at: Date.now(), value };
    return value;
  }

  /**
   * The `(scheme, network)` entry this rail settles on, or `null`.
   *
   * Asking rather than assuming is the point: if Blocky402 drops Hedera testnet
   * or rotates its fee payer, `challenge()` fails loudly at the seller instead of
   * minting quotes nobody can pay.
   */
  async kindFor(scheme: string, network: string): Promise<SupportedKind | null> {
    const { kinds } = await this.supported();
    return kinds.find(k => k.scheme === scheme && k.network === network) ?? null;
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirement): Promise<FacilitatorVerifyResponse> {
    return this.request<FacilitatorVerifyResponse>('/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x402Version: payload.x402Version, paymentPayload: payload, paymentRequirements: requirements }),
    });
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirement): Promise<FacilitatorSettleResponse> {
    return this.request<FacilitatorSettleResponse>('/settle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x402Version: payload.x402Version, paymentPayload: payload, paymentRequirements: requirements }),
    });
  }
}
