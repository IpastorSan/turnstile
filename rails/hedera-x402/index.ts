// Hedera testnet, settled through the Blocky402 facilitator. **Live — this rail
// moves real value on a real network.**
//
// **Correction (2026-09-07, MOV-220):** this file previously wrapped
// `createStubRail()`, declared `NETWORK = 'eip155:296'` and
// `ASSET = 'PLACEHOLDER-hedera-testnet-usdc'`, and emitted
// `extra.turnstileSettlement: 'stub'`. All four are now real. The network in
// particular was *wrong*, not merely unverified — see the correction note in
// `./config.ts`. The asset changed from USDC to native HBAR, for the reason
// recorded there.
//
// ## The flow, and the one thing that is not like EVM
//
// x402's `exact` scheme on an EVM chain is an EIP-3009 authorization: the payer
// signs a message, the facilitator turns it into a transfer, and the payer needs
// no gas because someone else submits it. Hedera has no EIP-3009, so the scheme
// does the same job a different way, and this is the part worth understanding
// before reading anything below:
//
//   1. `challenge()` asks Blocky402 which `(scheme, network)` it settles and
//      what account it pays gas from. That account id goes on the wire as
//      `extra.feePayer`.
//   2. The payer builds a `TransferTransaction` debiting itself and crediting
//      `payTo`, sets the **transaction id to the facilitator's account** — which
//      is what makes the facilitator the fee payer — freezes it, signs it, and
//      sends the serialized bytes back as `payload.transaction`.
//   3. The transaction is now *partially* signed: valid in shape, unsubmittable,
//      because the fee payer has not signed. That is the whole security property.
//      A payer cannot broadcast it themselves and we cannot alter it.
//   4. `settle()` POSTs it to Blocky402, which adds the fee payer's signature,
//      submits it and waits for consensus.
//
// So the payer spends no gas and holds no relationship with us, and the seller
// never handles the payer's key. The four `PaymentRail` methods absorb all of it
// without a new interface method, because the transaction body travels in
// `extra` and the signed bytes travel in `payload` — both opaque to
// `seller/service/`.
//
// ## What is checked, where, and by whom
//
// Three layers, none of which subsumes the others:
//
// | Check | Where | Catches |
// |---|---|---|
// | amount >= quoted, asset and payout match a live offer | `seller/service/x402.ts` | buying the $0.35 tier with a $0.07 payment |
// | resource binding, replay, payout account | `verify()` here | a payment reused for a second answer |
// | signature, transfer semantics, payer balance | Blocky402 `/verify` | anything about the transaction itself |
//
// **On the resource binding, honestly:** `rails/README.md` says a real rail's
// requirement is "covered by the payer's signature", which makes the
// `extra.resource` comparison load-bearing rather than advisory. That is not
// true on this rail and the README is corrected in this branch. The payer signs
// a Hedera transaction, and a Hedera transaction commits to `payTo`, `amount`,
// `asset` and `feePayer` — it does not commit to a URL. Blocky402's parity check
// compares only `asset`, `amount`, `payTo`, `maxTimeoutSeconds` and
// `extra.feePayer` between `payload.accepted` and the requirements we post, so a
// payer is free to edit `extra.resource` in their copy.
//
// What actually stops a payment buying the wrong resource, therefore, is the
// pair of checks that do not depend on the payer's honesty: the service's amount
// comparison against a freshly issued offer, and the replay guard below. The
// binding check stays because it costs nothing and catches an honest client
// pointed at the wrong URL — but it is advisory here, and calling it more than
// that would be the kind of claim a reviewer should be able to falsify by
// reading the code.

import type {
  ChallengeRequest, PaymentPayload, PaymentRail,
  PaymentRequirement, RailInfo, Receipt, VerifyContext, VerifyResult,
} from '../PaymentRail.ts';
import { PaymentRailError, usdToAtomic } from '../PaymentRail.ts';
import {
  FACILITATOR_URL, HBAR_ASSET, HBAR_DECIMALS, MIRROR_NODE_URL,
  NETWORK, hashscanTransactionUrl, toMirrorNodeTransactionId,
} from './config.ts';
import { Blocky402Facilitator, FacilitatorError, toVerifyFailureReason } from './facilitator.ts';
import type { FacilitatorOptions } from './facilitator.ts';
import { HcsReceiptTopic } from './hcs.ts';
import type { HcsReceiptTopicOptions } from './hcs.ts';
import { HbarRate } from './rate.ts';
import type { RateOptions } from './rate.ts';

export { NETWORK, HBAR_ASSET as ASSET, hashscanTransactionUrl } from './config.ts';
export { Blocky402Facilitator } from './facilitator.ts';
export { HcsReceiptTopic } from './hcs.ts';
export { HbarRate } from './rate.ts';

const RAIL_ID = 'hedera-x402';

/** The Hedera `exact` payload: base64 of a frozen, partially-signed transaction. */
export interface ExactHederaPayload {
  transaction: string;
}

export interface HederaRailOptions {
  /** The seller's payout account, `0.0.x`. Defaults to `HEDERA_PAYOUT_ACCOUNT`, then `HEDERA_OPERATOR_ID`. */
  payTo?: string;
  /** Blocky402 base URL. Defaults to `BLOCKY402_URL`, then the hosted testnet facilitator. */
  facilitatorUrl?: string;
  network?: string;
  /** `0.0.0` for HBAR, or an HTS token id such as `0.0.429274` for testnet USDC. */
  asset?: string;
  decimals?: number;
  symbol?: string;
  /**
   * USD per whole unit of `asset`. Omit for HBAR and the live network exchange
   * rate is used; pass `1` for a dollar stablecoin.
   */
  usdPerUnit?: number;
  maxTimeoutSeconds?: number;
  facilitator?: Blocky402Facilitator;
  facilitatorOptions?: FacilitatorOptions;
  rate?: HbarRate;
  rateOptions?: RateOptions;
  receiptTopic?: HcsReceiptTopic;
  receiptTopicOptions?: HcsReceiptTopicOptions;
  /** Used by `receipt()` for its mirror-node fallback. Injectable for tests. */
  mirrorNodeFetch?: typeof globalThis.fetch;
}

/** In-memory settlement log, plus the replay guard. Survives one process. */
class SettlementBook {
  private readonly byTransaction = new Map<string, Receipt>();
  /** Base64 transactions already spent here. Keyed on the bytes the payer signed. */
  private readonly spent = new Set<string>();

  record(receipt: Receipt, signedTransaction: string): Receipt {
    if (receipt.transaction) this.byTransaction.set(receipt.transaction, receipt);
    if (receipt.success) this.spent.add(signedTransaction);
    return receipt;
  }

  isSpent(signedTransaction: string): boolean {
    return this.spent.has(signedTransaction);
  }

  find(transaction: string): Receipt | null {
    return this.byTransaction.get(transaction) ?? null;
  }
}

function signedTransactionOf(payload: PaymentPayload): string | null {
  const raw = (payload.payload as Partial<ExactHederaPayload>).transaction;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

export function createHederaRail(options: HederaRailOptions = {}): PaymentRail {
  const payTo = options.payTo ?? process.env['HEDERA_PAYOUT_ACCOUNT'] ?? process.env['HEDERA_OPERATOR_ID'] ?? '0.0.10403961';
  const network = options.network ?? NETWORK;
  const asset = options.asset ?? process.env['HEDERA_ASSET'] ?? HBAR_ASSET;
  const isHbar = asset === HBAR_ASSET;
  const decimals = options.decimals ?? (isHbar ? HBAR_DECIMALS : 6);
  const symbol = options.symbol ?? (isHbar ? 'HBAR' : 'USDC');
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? 300;

  const facilitator = options.facilitator ?? new Blocky402Facilitator({
    baseUrl: options.facilitatorUrl,
    ...options.facilitatorOptions,
  });
  const rate = options.rate ?? new HbarRate(options.rateOptions);
  const receiptTopic = options.receiptTopic ?? new HcsReceiptTopic(options.receiptTopicOptions);
  const book = new SettlementBook();
  const mirrorNodeFetch = options.mirrorNodeFetch ?? globalThis.fetch;

  const info: RailInfo = {
    id: RAIL_ID,
    label: `Hedera testnet ${symbol}, settled through Blocky402`,
    scheme: 'exact',
    network,
    asset: { id: asset, symbol, decimals },
    // The on-chain `turnstile:rails` record reads `x402,usdc-arc`; this rail is
    // the `x402` token in it. See RailInfo.ensRailToken.
    ensRailToken: 'x402',
    live: true,
  };

  /** USD per whole unit of the configured asset, and where the number came from. */
  async function unitPrice(): Promise<{ usdPerUnit: number; source: string }> {
    if (options.usdPerUnit !== undefined) return { usdPerUnit: options.usdPerUnit, source: 'configured (usdPerUnit)' };
    if (!isHbar) return { usdPerUnit: 1, source: 'assumed 1 USD per unit for a dollar-denominated token' };
    const { usdPerHbar, source } = await rate.get();
    return { usdPerUnit: usdPerHbar, source };
  }

  return {
    id: RAIL_ID,
    info,

    async challenge(req: ChallengeRequest): Promise<PaymentRequirement> {
      // Ask the facilitator rather than assume. If Blocky402 drops Hedera
      // testnet or rotates its fee payer, this fails here — with the seller
      // returning 503 — rather than minting quotes nobody can pay.
      let feePayer: string;
      try {
        const kind = await facilitator.kindFor('exact', network);
        if (!kind) {
          throw new PaymentRailError(RAIL_ID, 'unsupported_rail', `${facilitator.baseUrl} does not settle exact on ${network}`);
        }
        const advertised = kind.extra?.['feePayer'];
        if (typeof advertised !== 'string' || advertised.length === 0) {
          throw new PaymentRailError(RAIL_ID, 'facilitator_unavailable', `${facilitator.baseUrl} advertises exact on ${network} without a feePayer; a payer cannot build a transaction without one`);
        }
        feePayer = advertised;
      } catch (cause) {
        if (cause instanceof PaymentRailError) throw cause;
        throw new PaymentRailError(RAIL_ID, 'facilitator_unavailable', `could not read ${facilitator.baseUrl}/supported: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
      }

      const { usdPerUnit, source } = await unitPrice();

      return {
        scheme: 'exact',
        network,
        asset,
        amount: usdToAtomic(req.priceUsd, decimals, usdPerUnit),
        payTo,
        maxTimeoutSeconds: req.maxTimeoutSeconds ?? maxTimeoutSeconds,
        extra: {
          // `feePayer` is the only key here the protocol requires. The client
          // SDK throws without it and the facilitator rejects a transaction
          // whose id names any other account.
          feePayer,
          facilitator: facilitator.baseUrl,
          settlementModel: 'facilitator-cosigned-transaction',
          mirrorNode: MIRROR_NODE_URL,
          decimals,
          symbol,
          priceUsd: req.priceUsd,
          usdPerUnit,
          rateSource: source,
          // Advisory — see the header. Kept because it catches an honest client
          // pointed at the wrong URL, not because it is a security boundary.
          resource: req.resource,
          turnstileSettlement: 'live',
        },
      };
    },

    async verify(payload: PaymentPayload, context?: VerifyContext): Promise<VerifyResult> {
      const signedTransaction = signedTransactionOf(payload);
      if (!signedTransaction) {
        return { valid: false, reason: 'invalid_signature', payer: null, detail: 'payload.transaction missing or empty' };
      }
      if (payload.accepted.payTo !== payTo) {
        return { valid: false, reason: 'wrong_recipient', payer: null, detail: `payTo ${payload.accepted.payTo} is not this seller's payout account` };
      }
      // The replay guard. A frozen Hedera transaction has a unique transaction
      // id, so the network itself rejects a second submission with
      // DUPLICATE_TRANSACTION — but only after we have already done the work and
      // handed over the answer. Refusing here is what makes one payment buy
      // exactly one answer.
      if (book.isSpent(signedTransaction)) {
        return { valid: false, reason: 'already_settled', payer: null, detail: 'this transaction has already been settled by this seller' };
      }
      if (context) {
        const boundTo = payload.accepted.extra['resource'];
        if (typeof boundTo === 'string' && boundTo !== context.resource) {
          return { valid: false, reason: 'wrong_recipient', payer: null, detail: `payment was issued for ${boundTo}, not ${context.resource}` };
        }
      }

      let response;
      try {
        response = await facilitator.verify(payload, payload.accepted);
      } catch (cause) {
        // The facilitator could not answer at all. Not the payer's fault, so
        // this is a throw the service turns into 503 rather than a 402.
        throw new PaymentRailError(
          RAIL_ID,
          'facilitator_unavailable',
          cause instanceof FacilitatorError ? cause.message : `verify failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }

      if (!response.isValid) {
        return {
          valid: false,
          reason: toVerifyFailureReason(response.invalidReason, response.invalidMessage),
          payer: response.payer || null,
          detail: `${response.invalidReason ?? 'rejected'}${response.invalidMessage ? `: ${response.invalidMessage}` : ''}`,
        };
      }
      return { valid: true, reason: null, payer: response.payer || null };
    },

    async settle(payload: PaymentPayload): Promise<Receipt> {
      const signedTransaction = signedTransactionOf(payload);
      const base = {
        railId: RAIL_ID,
        network,
        asset: payload.accepted.asset,
        amount: payload.accepted.amount,
        settledAt: Date.now(),
      };
      if (!signedTransaction) {
        return { ...base, transaction: '', success: false, payer: null, error: 'payload.transaction missing or empty' };
      }

      let response;
      try {
        response = await facilitator.settle(payload, payload.accepted);
      } catch (cause) {
        // A settlement failure after the work is done is an accounting problem,
        // not a crash — the service still has an answer in hand and needs to
        // decide what to do with it. So this returns rather than throws.
        return { ...base, transaction: '', success: false, payer: null, error: cause instanceof Error ? cause.message : String(cause) };
      }

      if (!response.success) {
        return {
          ...base,
          transaction: response.transaction || '',
          success: false,
          payer: response.payer || null,
          error: `${response.errorReason ?? 'settlement failed'}${response.errorMessage ? `: ${response.errorMessage}` : ''}`,
        };
      }

      const settledAt = Date.now();
      const receipt: Receipt = {
        ...base,
        settledAt,
        transaction: response.transaction,
        success: true,
        payer: response.payer || null,
        error: null,
        extra: {
          settlement: 'blocky402',
          facilitator: facilitator.baseUrl,
          feePayer: payload.accepted.extra['feePayer'] ?? null,
          hashscan: hashscanTransactionUrl(response.transaction),
          mirrorNode: `${MIRROR_NODE_URL}/api/v1/transactions/${toMirrorNodeTransactionId(response.transaction)}`,
        },
      };

      // The audit trail. Best effort by design — see `hcs.ts`.
      const hcs = await receiptTopic.submit(HcsReceiptTopic.messageFor(receipt, {
        payTo,
        priceUsd: typeof payload.accepted.extra['priceUsd'] === 'number' ? payload.accepted.extra['priceUsd'] as number : null,
        resource: typeof payload.accepted.extra['resource'] === 'string' ? payload.accepted.extra['resource'] as string : null,
      }));
      receipt.extra!['hcs'] = hcs ?? { skipped: 'no HEDERA_RECEIPT_TOPIC_ID configured' };

      return book.record(receipt, signedTransaction);
    },

    /**
     * By Hedera transaction id.
     *
     * The in-memory book answers for this process; anything older is read back
     * off the public mirror node, so a restarted seller can still produce a
     * receipt for a payment it took last week. `null` is an ordinary answer.
     */
    async receipt(id: string): Promise<Receipt | null> {
      const local = book.find(id);
      if (local) return local;
      // `0.0.7162784@1788791330.918068236` or the mirror node's dashed form.
      // Checking the shape here rather than letting the mirror node 404 keeps a
      // stub receipt id — `stub:hedera-x402:000001` — from being looked up as
      // though it might be real.
      if (!/^\d+\.\d+\.\d+[@-]\d+[.-]\d+$/.test(id)) return null;

      const url = `${MIRROR_NODE_URL}/api/v1/transactions/${toMirrorNodeTransactionId(id)}`;
      let body: { transactions?: { transaction_id: string; result: string; consensus_timestamp: string; transfers?: { account: string; amount: number }[] }[] };
      try {
        const res = await mirrorNodeFetch(url, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) return null;
        body = await res.json() as typeof body;
      } catch {
        return null;
      }
      const tx = body.transactions?.[0];
      if (!tx) return null;

      const credited = tx.transfers?.find(t => t.account === payTo)?.amount ?? null;
      const debited = tx.transfers?.filter(t => t.amount < 0).sort((a, b) => a.amount - b.amount)[0]?.account ?? null;
      return {
        railId: RAIL_ID,
        transaction: tx.transaction_id,
        success: tx.result === 'SUCCESS',
        network,
        payer: debited,
        amount: credited !== null ? String(credited) : null,
        asset,
        settledAt: Math.round(Number(tx.consensus_timestamp) * 1000),
        error: tx.result === 'SUCCESS' ? null : tx.result,
        extra: { settlement: 'mirror-node', hashscan: hashscanTransactionUrl(tx.transaction_id), mirrorNode: url },
      };
    },
  };
}

export { FACILITATOR_URL };
