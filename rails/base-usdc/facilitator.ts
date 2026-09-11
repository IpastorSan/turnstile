// The x402 facilitator HTTP client — three endpoints and a reason-code table.
//
// Same protocol as Blocky402's in `../hedera-x402/facilitator.ts`, different
// operator: this one is the x402 Foundation's public facilitator, which settles
// the standard EVM `exact` scheme. `/verify` checks the EIP-3009 authorization,
// `/settle` submits it and pays the gas, so a payer needs USDC and nothing else.
//
// The two rails' clients are deliberately separate files rather than one shared
// client with a base URL: the two facilitators agree on the wire shape and
// disagree about everything behind it (Hedera co-signs a partially-signed
// transaction; this one broadcasts an EIP-3009 transfer). Their reason codes are
// different vocabularies, and mapping them in one place would mean a table that
// has to be right about two chains at once.
//
// Plain `fetch` rather than an SDK import, for the reason recorded in the
// Hedera rail: `@x402/evm` ships facilitator-side and client-side halves, and
// the resource-server half is these two POSTs. `@x402/core`'s `facilitator`
// export is for *running* a facilitator, not for calling one.

import type { PaymentPayload, PaymentRequirement, VerifyFailureReason } from '../PaymentRail.ts';
import { FACILITATOR_URL } from './config.ts';

/** `GET /supported`. One entry per (scheme, network) the facilitator will settle. */
export interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
  extra?: Record<string, unknown>;
}

export interface SupportedResponse {
  kinds: SupportedKind[];
  extensions?: unknown[];
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
  /** An EVM transaction hash on this rail. */
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
  /** Milliseconds. `/settle` waits for a transaction to be mined, so this is generous. */
  timeoutMs?: number;
  /** How long `/supported` is cached. It only changes when the facilitator does. */
  supportedTtlMs?: number;
}

/**
 * Translate a facilitator reason code into one of ours.
 *
 * The codes are `@x402/evm`'s, read out of the shipped implementation
 * (`node_modules/@x402/evm/dist/esm`, grep `invalid_exact_evm_`) rather than
 * guessed from the spec. The mapping matters because the buyer branches on it:
 * `expired` means re-fetch the challenge, `unsupported_rail` means try the
 * other `accepts[]` entry, `insufficient_funds` means stop. An unrecognised code
 * becomes `unknown` rather than being forced into a neighbouring bucket, because
 * a buyer that retries on a code we misclassified wastes a payment.
 */
export function toVerifyFailureReason(invalidReason: string | undefined, message?: string): VerifyFailureReason {
  const reason = invalidReason ?? '';
  const detail = `${reason} ${message ?? ''}`.toLowerCase();

  if (reason.includes('signature')) return 'invalid_signature';
  // `nonce_already_used` is the on-chain replay refusal: the payer's EIP-3009
  // nonce is single-use, so this code means the money already moved.
  if (reason.includes('nonce_already_used') || reason.includes('duplicate')) return 'already_settled';
  if (reason.includes('insufficient_balance') || detail.includes('insufficient')) return 'insufficient_funds';
  if (reason.includes('value_mismatch') || reason.includes('authorization_value') || reason === 'invalid_amount') {
    return 'wrong_amount';
  }
  if (reason.includes('recipient_mismatch') || reason.includes('pay_to') || reason.includes('receiver')) {
    return 'wrong_recipient';
  }
  if (reason.includes('valid_before') || reason.includes('valid_after') || detail.includes('expired')) {
    return 'expired';
  }
  if (
    reason.includes('network_mismatch') ||
    reason.includes('scheme') ||
    reason.includes('token_name_mismatch') ||
    reason.includes('token_version_mismatch') ||
    reason.includes('asset')
  ) {
    return 'unsupported_rail';
  }
  return 'unknown';
}

export class X402Facilitator {
  readonly baseUrl: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly supportedTtlMs: number;
  private cachedSupported: { at: number; value: SupportedResponse } | null = null;

  constructor(options: FacilitatorOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env['X402_FACILITATOR_URL'] ?? FACILITATOR_URL).replace(/\/+$/, '');
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
      // verdict comes back as a 200 with `isValid: false`. Keeping the two
      // distinct is what lets the service answer 503 rather than 402.
      throw new FacilitatorError(`${path} returned ${res.status}: ${text.slice(0, 400)}`, res.status);
    }
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new FacilitatorError(`${path} returned unparseable JSON: ${text.slice(0, 200)}`, res.status, { cause });
    }
  }

  /** `GET /supported`, cached. */
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
   * Asking rather than assuming is the point: if the facilitator drops Base
   * Sepolia, `challenge()` fails loudly at the seller instead of minting quotes
   * nobody can pay.
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
