// The Circle Gateway client. Three x402 endpoints, a transfers API, and a reason
// code table.
//
// Unlike the Hedera rail — which talks to Blocky402 through a hand-rolled
// `fetch` client because `@x402/hedera`'s server half wants the fee payer's
// private key — this rail uses **Circle's own SDK**, because
// `@circle-fin/x402-batching/server`'s `BatchFacilitatorClient` *is* the
// resource-server half and wants no key at all. Importing it costs us nothing we
// would not otherwise have to write, and it is the piece Circle will keep in
// step with their API.
//
// What is wrapped around it here is the three things the SDK does not do:
//
//   1. **Cache `/supported`.** `challenge()` needs `extra.verifyingContract` on
//      every quote, and the SDK re-fetches it every call.
//   2. **Map reason codes into `VerifyFailureReason`.** The buyer branches on
//      these and the codes are Circle's, not ours.
//   3. **Read the transfers API**, which is how an authorization id becomes a
//      batch transaction hash. That is the whole asynchronous-settlement story
//      and it has no SDK surface on the server side — `GatewayClient` has
//      `getTransferById`, but `GatewayClient` is the *buyer's* object and
//      constructing one requires a private key the seller does not have.
//
// ## The one asymmetry with Blocky402 worth knowing before you trust `verify()`
//
// **Gateway's `/verify` does not check the payer's balance.** Verified
// 2026-09-07: an authorization signed by a wallet with a zero Gateway balance
// comes back `{"isValid":true}`, and the same payment then fails `/settle` with
// `insufficient_balance`. Blocky402 catches this at verify time through its
// preflight hook; Gateway does not.
//
// So on this rail a successful `verify()` means "this signature is well formed,
// covers this amount, and names this payee" — it does **not** mean the money is
// there. `insufficient_funds` is therefore a settlement outcome here rather than
// a verification one, which is exactly why `PaymentRail.settle` returns
// `{ success: false, error }` instead of throwing: the seller has already done
// the work by then.

import { BatchFacilitatorClient } from '@circle-fin/x402-batching/server';

import type { PaymentPayload, PaymentRequirement, VerifyFailureReason } from '../PaymentRail.ts';
import { FACILITATOR_URL } from './config.ts';

/** One `(scheme, network)` Gateway will settle, plus the EIP-712 domain for it. */
export interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
  /**
   * `{ name: 'GatewayWalletBatched', version: '1', verifyingContract, minValiditySeconds, assets }`.
   *
   * The first three are not optional garnish: a payer cannot construct the
   * EIP-712 domain without them, so `challenge()` copies this object into the
   * requirement's `extra` verbatim.
   */
  extra?: Record<string, unknown>;
}

export interface SupportedResponse {
  kinds: SupportedKind[];
  extensions: unknown[];
  signers?: Record<string, string[]>;
}

export interface GatewayVerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface GatewaySettleResponse {
  success: boolean;
  /**
   * The Gateway authorization id — a UUID, **not** a transaction hash.
   *
   * Empty string on failure. See {@link GatewayTransfer} for what it becomes.
   */
  transaction: string;
  network: string;
  payer?: string;
  errorReason?: string;
}

/**
 * One credited authorization, as the transfers API reports it.
 *
 * `status` walks `received` → `batched` → `completed`, and **`txHash` is null
 * until the batch lands**. Observed 2026-09-07: ~2 minutes from `received` to
 * `completed` on Arc testnet, 12–13 transfers sharing one `txHash`.
 *
 * Extra fields are preserved rather than picked, because Circle's own types say
 * "shape may evolve".
 */
export interface GatewayTransfer {
  id: string;
  status: 'received' | 'batched' | 'confirmed' | 'completed' | 'failed';
  token: string;
  sendingNetwork: string;
  recipientNetwork: string;
  fromAddress: string;
  toAddress: string;
  amount: string;
  nonce: string;
  /** The batch transaction. `null` until the batch is submitted. */
  txHash: string | null;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export class GatewayError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GatewayError';
    this.status = status;
  }
}

export interface GatewayOptions {
  baseUrl?: string;
  /** Injectable so the rail's tests never touch the network. */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** How long `/supported` is cached. Its `verifyingContract` changes only on a redeploy. */
  supportedTtlMs?: number;
  /** Injectable for tests. Defaults to a `BatchFacilitatorClient` on `baseUrl`. */
  facilitator?: Pick<BatchFacilitatorClient, 'verify' | 'settle' | 'getSupported'>;
}

/**
 * Translate a Gateway reason code into one of ours.
 *
 * The codes here were read off the live API rather than guessed:
 * `amount_mismatch` and `insufficient_balance` are both quoted verbatim from
 * responses captured on 2026-09-07 and recorded in `docs/arc-nanopayments.md`.
 *
 * Anything unrecognised becomes `unknown` rather than being forced into a
 * neighbouring bucket, for the reason the Hedera rail gives: a buyer that
 * retries on a code we misclassified wastes a payment.
 */
export function toVerifyFailureReason(reason: string | undefined): VerifyFailureReason {
  const code = (reason ?? '').toLowerCase();
  if (code.includes('insufficient') || code.includes('balance')) return 'insufficient_funds';
  if (code.includes('amount')) return 'wrong_amount';
  if (code.includes('signature') || code.includes('invalid_authorization')) return 'invalid_signature';
  if (code.includes('recipient') || code.includes('pay_to') || code.includes('payto')) return 'wrong_recipient';
  if (code.includes('network') || code.includes('unsupported') || code.includes('asset')) return 'unsupported_rail';
  if (code.includes('nonce') || code.includes('used') || code.includes('duplicate')) return 'already_settled';
  if (code.includes('expired') || code.includes('validity')) return 'expired';
  return 'unknown';
}

/**
 * Gateway's `/verify` and `/settle` require a `resource` on the payload that our
 * `PaymentPayload` does not carry.
 *
 * Verified 2026-09-07: omitting it is a **400**, `paymentPayload.resource:
 * Required` — not a payment rejection, a malformed request. So the rail
 * synthesizes it, and this is exactly the kind of chain-specific plumbing that
 * belongs behind the rail boundary rather than in `seller/service/`.
 *
 * It is **not covered by the payer's signature.** The EIP-3009 authorization
 * commits to `(from, to, value, validAfter, validBefore, nonce)` and to nothing
 * else — no URL. So this field tells Gateway what was being bought; it does not
 * prove it. Same conclusion as the Hedera rail reached for the same reason, and
 * the same consequence: the resource binding is advisory on both rails.
 */
function withResource(payload: PaymentPayload, resource: string): Record<string, unknown> {
  return {
    ...payload,
    resource: { url: resource, description: 'Turnstile', mimeType: 'application/json' },
  };
}

export class CircleGateway {
  readonly baseUrl: string;
  private readonly facilitator: Pick<BatchFacilitatorClient, 'verify' | 'settle' | 'getSupported'>;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly supportedTtlMs: number;
  private cachedSupported: { at: number; value: SupportedResponse } | null = null;

  constructor(options: GatewayOptions = {}) {
    // The SDK defaults to **mainnet**, so this must be passed rather than
    // omitted. `ARC_FACILITATOR_URL` overrides it for a local Gateway mock.
    this.baseUrl = (options.baseUrl ?? process.env['ARC_FACILITATOR_URL'] ?? FACILITATOR_URL).replace(/\/+$/, '');
    this.facilitator = options.facilitator ?? new BatchFacilitatorClient({ url: this.baseUrl });
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.supportedTtlMs = options.supportedTtlMs ?? 5 * 60_000;
  }

  /** `GET /v1/x402/supported`, cached. Where the EIP-712 domain comes from. */
  async supported(): Promise<SupportedResponse> {
    const fresh = this.cachedSupported && Date.now() - this.cachedSupported.at < this.supportedTtlMs;
    if (fresh && this.cachedSupported) return this.cachedSupported.value;
    let value: SupportedResponse;
    try {
      value = await this.facilitator.getSupported() as unknown as SupportedResponse;
    } catch (cause) {
      throw new GatewayError(`${this.baseUrl}/v1/x402/supported failed: ${cause instanceof Error ? cause.message : String(cause)}`, null, { cause });
    }
    this.cachedSupported = { at: Date.now(), value };
    return value;
  }

  /**
   * The `(scheme, network)` entry this rail settles on, or `null`.
   *
   * Asking rather than assuming is the point, exactly as on the Hedera rail: if
   * Circle redeploys the GatewayWallet, `challenge()` fails loudly at the seller
   * instead of minting quotes whose EIP-712 domain no longer verifies.
   */
  async kindFor(scheme: string, network: string): Promise<SupportedKind | null> {
    const { kinds } = await this.supported();
    return kinds.find(k => k.scheme === scheme && k.network === network) ?? null;
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirement, resource: string): Promise<GatewayVerifyResponse> {
    try {
      return await this.facilitator.verify(withResource(payload, resource) as never, requirements as never) as GatewayVerifyResponse;
    } catch (cause) {
      throw new GatewayError(`verify failed: ${cause instanceof Error ? cause.message : String(cause)}`, null, { cause });
    }
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirement, resource: string): Promise<GatewaySettleResponse> {
    try {
      return await this.facilitator.settle(withResource(payload, resource) as never, requirements as never) as GatewaySettleResponse;
    } catch (cause) {
      throw new GatewayError(`settle failed: ${cause instanceof Error ? cause.message : String(cause)}`, null, { cause });
    }
  }

  private async getJson<T>(path: string): Promise<T | null> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await this.doFetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (cause) {
      throw new GatewayError(`${url} is unreachable: ${cause instanceof Error ? cause.message : String(cause)}`, null, { cause });
    }
    // A 404 means "no such transfer", which is an ordinary answer for a receipt
    // lookup rather than a failure — see `PaymentRail.receipt`.
    if (res.status === 404) return null;
    const text = await res.text();
    if (!res.ok) throw new GatewayError(`${path} returned ${res.status}: ${text.slice(0, 300)}`, res.status);
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new GatewayError(`${path} returned unparseable JSON: ${text.slice(0, 200)}`, res.status, { cause });
    }
  }

  /** One authorization by id. `null` when Gateway has never seen it. */
  async transfer(id: string): Promise<GatewayTransfer | null> {
    return this.getJson<GatewayTransfer>(`/v1/x402/transfers/${encodeURIComponent(id)}`);
  }

  /**
   * Search authorizations.
   *
   * `nonce` is the useful one: the EIP-3009 nonce is chosen by the payer and
   * travels in the payload, so it identifies a payment independently of anything
   * Gateway hands back. That makes it the recovery path when a settle response
   * is lost.
   */
  async searchTransfers(params: { from?: string; to?: string; nonce?: string; network?: string; pageSize?: number } = {}): Promise<GatewayTransfer[]> {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) query.set(k, String(v));
    const body = await this.getJson<{ transfers?: GatewayTransfer[] }>(`/v1/x402/transfers?${query}`);
    return body?.transfers ?? [];
  }
}
