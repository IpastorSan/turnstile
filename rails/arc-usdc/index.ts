// Arc testnet, settled through **Circle Gateway Nanopayments**. USDC, gasless,
// batched.
//
// **Correction (2026-09-07, MOV-225):** this file previously wrapped
// `createStubRail()`, declared `NETWORK = 'eip155:0-PLACEHOLDER-arc'` and
// `ASSET = 'PLACEHOLDER-arc-usdc'`, pointed at a facilitator host
// (`https://facilitator.arc.circle.com`) that does not resolve, and emitted
// `extra.turnstileSettlement: 'stub'`. All of that is now real; the verified
// values and how to re-check them are in `./config.ts`.
//
// It also described the buyer's wallet as holding "zero native token, gas
// sponsored by a Paymaster". **That was incoherent on this chain** and is
// corrected below and in `CLAUDE.md`, `CHECKLIST.md` and `docs/architecture.md`.
//
// ## The flow, and the two things that are not like the Hedera rail
//
// x402's `exact` scheme on an EVM chain is an EIP-3009 authorization: the payer
// signs a message and someone else turns it into a transfer, so the payer needs
// no gas. That much is textbook. Gateway changes two things about it, and both
// are the reason this rail exists:
//
//   1. **The `verifyingContract` is the GatewayWallet, not USDC.** The payer
//      pre-deposits USDC into `GatewayWallet` and then signs authorizations
//      against *that* contract. So a signature is a claim on a Gateway balance
//      rather than on a token allowance.
//   2. **Settlement is batched and asynchronous.** `/settle` credits the seller
//      immediately and returns an **authorization id**, not a transaction hash.
//      Circle's batcher redeems many authorizations in one on-chain transaction
//      a couple of minutes later. Measured on Arc testnet 2026-09-07: 100
//      consecutive transfers resolved to **9 distinct transaction hashes**,
//      12–13 authorizations each, ~2 minutes from `received` to `completed`.
//
// That second point is why nanopayments work at all. A $0.0013 payment cannot
// pay for its own transaction anywhere; amortised across thirteen of them it
// can. It is also why `PaymentRail.receipt` returns `Receipt | null` — for a
// short window after `settle()` there is a real, credited payment with no
// transaction hash yet, and that is a correct state rather than an error.
//
// ## The zero-gas property, stated so it can be falsified
//
// **Correction (2026-09-07, MOV-225):** the claim this rail used to make — the
// hot wallet "holds zero native token, gas sponsored by a Paymaster" — cannot be
// true on Arc, because **USDC is Arc's native gas token**. `eth_getBalance(a)`
// and `USDC.balanceOf(a)` are two views of one balance at two precisions (18 dp
// and 6 dp; measured numbers in `./config.ts`). A wallet holding zero native
// token holds zero USDC and can pay nobody. There is no Paymaster in this
// design and there never was one.
//
// What is true, and is stronger:
//
// > The hot wallet signs an EIP-3009 authorization **offchain and never submits
// > a transaction**, so it pays exactly zero gas. Circle's batcher submits.
//
// The on-chain evidence is its **nonce**. `eth_getTransactionCount(agent)`
// staying `0` across every settled payment is unforgeable proof that the wallet
// never broadcast anything, and therefore that it never paid a wei of gas. Its
// Gateway balance meanwhile falls from the mandate allowance to zero.
//
// The wallet's Gateway balance is funded by the **warm tier** through
// `depositFor(amount, agent)` — the org wallet pays the deposit's gas and the
// resulting balance belongs to the agent. That is not a workaround; it is the
// cold/warm/hot split in `CLAUDE.md` expressed in one contract call. The hot key
// cannot deposit, cannot withdraw (that also costs gas it does not have), and
// cannot widen its own allowance.
//
// `scripts/arc-paid-request.ts` prints the nonce and both balances before and
// after, so the claim is checked on every run rather than asserted here.
//
// ## What is checked, where, and by whom
//
// | Check | Where | Catches |
// |---|---|---|
// | amount >= quoted, asset and payout match a live offer | `seller/service/x402.ts` | buying the $0.35 tier with a $0.07 payment |
// | payout account, replay by nonce, resource binding | `verify()` here | one authorization reused for a second answer |
// | signature, amount parity, payee | Gateway `/verify` | a forged or edited authorization |
// | **payer's balance** | Gateway `/settle` — **not** `/verify` | an authorization with no money behind it |
//
// That last row is the trap. Unlike Blocky402, Gateway's `/verify` does not look
// at the payer's balance: an authorization from an empty wallet verifies clean
// and then fails settlement with `insufficient_balance`. Verified 2026-09-07;
// see `./gateway.ts`. So `verify()` here can never return `insufficient_funds`,
// and the seller learns about an empty wallet only after doing the work.

import type {
  ChallengeRequest, PaymentPayload, PaymentRail,
  PaymentRequirement, RailInfo, Receipt, VerifyContext, VerifyResult,
} from '../PaymentRail.ts';
import { PaymentRailError, usdToAtomic } from '../PaymentRail.ts';
import {
  EXPLORER_URL, FACILITATOR_URL, GATEWAY_CHAIN_NAME, GATEWAY_DOMAIN,
  NETWORK, RPC_URL, USDC_ASSET, USDC_DECIMALS,
  arcscanTransactionUrl, isAuthorizationId, isBatchTransactionHash,
} from './config.ts';
import { CircleGateway, GatewayError, toVerifyFailureReason } from './gateway.ts';
import type { GatewayOptions, GatewayTransfer } from './gateway.ts';

export {
  NETWORK, USDC_ASSET as ASSET, CHAIN_ID, GATEWAY_CHAIN_NAME, GATEWAY_WALLET,
  FACILITATOR_URL, RPC_URL, EXPLORER_URL, USDC_DECIMALS, NATIVE_DECIMALS,
  arcscanTransactionUrl, arcscanAddressUrl,
} from './config.ts';
export { CircleGateway, GatewayError } from './gateway.ts';
export type { GatewayTransfer } from './gateway.ts';

const RAIL_ID = 'arc-usdc';

/**
 * The Gateway `exact` payload: an EIP-3009 authorization and its signature.
 *
 * Structurally `BatchPayload` from `@circle-fin/x402-batching`. Declared here
 * rather than imported for the reason `PaymentRail.ts` gives about its own
 * types: a rail author should be able to read one file.
 */
export interface BatchedAuthorizationPayload {
  signature: string;
  authorization: {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    /** The EIP-3009 nonce. Chosen by the payer, and this rail's replay key. */
    nonce: string;
  };
}

export interface ArcRailOptions {
  /** The seller's payout address. Defaults to `ARC_PAYOUT_ADDRESS`, then the ENS `addr(60)`. */
  payTo?: string;
  facilitatorUrl?: string;
  network?: string;
  asset?: string;
  decimals?: number;
  symbol?: string;
  maxTimeoutSeconds?: number;
  gateway?: CircleGateway;
  gatewayOptions?: GatewayOptions;
}

/**
 * The payout address published as `addr(60)` on `liquidity.turnstile.eth`,
 * read live off Sepolia on 2026-09-07. It is the cold tier's to change; a hot
 * key trying to move it reverts on-chain (`docs/ens-offer-records.md`).
 */
export const ENS_PAYOUT_ADDRESS = '0x0Adca6e14bA956201D221feC767e4f24194bf5F2';

/** In-memory settlement log, plus the replay guard. Survives one process. */
class SettlementBook {
  private readonly byTransaction = new Map<string, Receipt>();
  /** EIP-3009 nonces already spent here. */
  private readonly spent = new Set<string>();

  record(receipt: Receipt, nonce: string | null): Receipt {
    if (receipt.transaction) this.byTransaction.set(receipt.transaction, receipt);
    if (receipt.success && nonce) this.spent.add(nonce.toLowerCase());
    return receipt;
  }

  isSpent(nonce: string): boolean {
    return this.spent.has(nonce.toLowerCase());
  }

  find(transaction: string): Receipt | null {
    return this.byTransaction.get(transaction) ?? null;
  }
}

function authorizationOf(payload: PaymentPayload): BatchedAuthorizationPayload | null {
  const raw = payload.payload as Partial<BatchedAuthorizationPayload>;
  if (typeof raw.signature !== 'string' || raw.signature.length === 0) return null;
  const auth = raw.authorization;
  if (!auth || typeof auth.from !== 'string' || typeof auth.to !== 'string' || typeof auth.value !== 'string' || typeof auth.nonce !== 'string') return null;
  return raw as BatchedAuthorizationPayload;
}

/**
 * The URL this payment was issued for.
 *
 * Gateway requires a `resource` on the payload (a 400 otherwise), so the rail
 * has to produce one even when the service did not pass a `VerifyContext`. The
 * payer's own copy is the fallback, and is advisory — see `./gateway.ts`.
 */
function resourceFor(payload: PaymentPayload, context?: VerifyContext): string {
  if (context?.resource) return context.resource;
  const bound = payload.accepted.extra['resource'];
  return typeof bound === 'string' && bound.length > 0 ? bound : 'https://turnstile.invalid/unknown';
}

export function createArcRail(options: ArcRailOptions = {}): PaymentRail {
  const payTo = options.payTo ?? process.env['ARC_PAYOUT_ADDRESS'] ?? ENS_PAYOUT_ADDRESS;
  const network = options.network ?? NETWORK;
  const asset = options.asset ?? process.env['ARC_USDC_ASSET'] ?? USDC_ASSET;
  const decimals = options.decimals ?? USDC_DECIMALS;
  const symbol = options.symbol ?? 'USDC';
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? 300;

  const gateway = options.gateway ?? new CircleGateway({
    baseUrl: options.facilitatorUrl,
    ...options.gatewayOptions,
  });
  const book = new SettlementBook();

  const info: RailInfo = {
    id: RAIL_ID,
    label: `Arc testnet ${symbol}, gasless nanopayments batched by Circle Gateway`,
    scheme: 'exact',
    network,
    asset: { id: asset, symbol, decimals },
    // The on-chain `turnstile:rails` record reads `x402,usdc-arc`; this rail is
    // the `usdc-arc` token in it. See RailInfo.ensRailToken.
    ensRailToken: 'usdc-arc',
    live: true,
  };

  /** Turn a Gateway transfer record into a receipt. Shared by `settle` and `receipt`. */
  function receiptFromTransfer(transfer: GatewayTransfer): Receipt {
    const settled = transfer.status === 'completed' || transfer.status === 'confirmed';
    return {
      railId: RAIL_ID,
      transaction: transfer.id,
      success: transfer.status !== 'failed',
      network,
      payer: transfer.fromAddress ?? null,
      amount: transfer.amount ?? null,
      asset,
      settledAt: Date.parse(transfer.updatedAt ?? transfer.createdAt) || Date.now(),
      error: transfer.status === 'failed' ? 'gateway reported the authorization as failed' : null,
      extra: {
        settlement: 'circle-gateway-batched',
        facilitator: gateway.baseUrl,
        authorizationId: transfer.id,
        status: transfer.status,
        // Null until the batch lands. That is a real state, not a missing value:
        // the payment is credited and the transaction has not been mined yet.
        batchTransaction: transfer.txHash,
        arcscan: transfer.txHash ? arcscanTransactionUrl(transfer.txHash) : null,
        batchSettled: settled && Boolean(transfer.txHash),
        nonce: transfer.nonce ?? null,
        payTo: transfer.toAddress ?? null,
      },
    };
  }

  return {
    id: RAIL_ID,
    info,

    async challenge(req: ChallengeRequest): Promise<PaymentRequirement> {
      // Ask the facilitator rather than assume. The EIP-712 domain a payer signs
      // against lives in this response, so if Circle redeploys the GatewayWallet
      // this fails here — with the seller returning 503 — rather than minting
      // quotes whose signatures will not verify.
      let kindExtra: Record<string, unknown>;
      try {
        const kind = await gateway.kindFor('exact', network);
        if (!kind) {
          throw new PaymentRailError(RAIL_ID, 'unsupported_rail', `${gateway.baseUrl} does not settle exact on ${network}`);
        }
        const verifyingContract = kind.extra?.['verifyingContract'];
        if (typeof verifyingContract !== 'string' || verifyingContract.length === 0) {
          throw new PaymentRailError(RAIL_ID, 'facilitator_unavailable', `${gateway.baseUrl} advertises exact on ${network} without a verifyingContract; a payer cannot build the signing domain without one`);
        }
        kindExtra = kind.extra ?? {};
      } catch (cause) {
        if (cause instanceof PaymentRailError) throw cause;
        throw new PaymentRailError(RAIL_ID, 'facilitator_unavailable', `could not read ${gateway.baseUrl}/v1/x402/supported: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
      }

      return {
        scheme: 'exact',
        network,
        asset,
        // USDC is a dollar, so `usdPerUnit` is 1 and there is no rate to fetch.
        // Still routed through `usdToAtomic` so 0.07 does not arrive as 69999.
        amount: usdToAtomic(req.priceUsd, decimals, 1),
        payTo,
        maxTimeoutSeconds: req.maxTimeoutSeconds ?? maxTimeoutSeconds,
        extra: {
          // `name`, `version` and `verifyingContract` are the EIP-712 domain and
          // are not optional: a client cannot sign without them. Spread from the
          // facilitator's own answer rather than restated, so a redeploy on
          // Circle's side propagates without a code change here.
          ...kindExtra,
          facilitator: gateway.baseUrl,
          settlementModel: 'gateway-batched-authorization',
          // The Circle-side name for this chain. Present so a buyer using
          // `GatewayClient` does not have to map CAIP-2 back to it by hand — see
          // the two-identifiers note in `./config.ts`.
          chainName: GATEWAY_CHAIN_NAME,
          chainDomain: GATEWAY_DOMAIN,
          explorer: EXPLORER_URL,
          decimals,
          symbol,
          priceUsd: req.priceUsd,
          usdPerUnit: 1,
          // Advisory — the EIP-3009 authorization does not commit to a URL. Kept
          // because it catches an honest client pointed at the wrong resource.
          resource: req.resource,
          // Settlement is credited now and mined later. Said on the wire so a
          // payer knows before signing that the hash arrives late.
          settlementTiming: 'batched-asynchronous',
          turnstileSettlement: 'live',
        },
      };
    },

    async verify(payload: PaymentPayload, context?: VerifyContext): Promise<VerifyResult> {
      const authorized = authorizationOf(payload);
      if (!authorized) {
        return { valid: false, reason: 'invalid_signature', payer: null, detail: 'payload.signature or payload.authorization missing or malformed' };
      }
      if (payload.accepted.payTo !== payTo) {
        return { valid: false, reason: 'wrong_recipient', payer: null, detail: `payTo ${payload.accepted.payTo} is not this seller's payout account` };
      }
      // The replay guard, keyed on the EIP-3009 nonce. Gateway will itself
      // refuse a nonce twice — but only after we have done the work and handed
      // over the answer. Refusing here is what makes one authorization buy
      // exactly one answer.
      //
      // The nonce is the right key rather than the whole payload because it is
      // what the signature commits to: re-serialising the same authorization
      // differently changes the bytes and not the nonce.
      if (book.isSpent(authorized.authorization.nonce)) {
        return { valid: false, reason: 'already_settled', payer: authorized.authorization.from, detail: 'this authorization has already been settled by this seller' };
      }
      if (context) {
        const boundTo = payload.accepted.extra['resource'];
        if (typeof boundTo === 'string' && boundTo !== context.resource) {
          return { valid: false, reason: 'wrong_recipient', payer: authorized.authorization.from, detail: `payment was issued for ${boundTo}, not ${context.resource}` };
        }
      }

      let response;
      try {
        response = await gateway.verify(payload, payload.accepted, resourceFor(payload, context));
      } catch (cause) {
        // Gateway could not answer at all. Not the payer's fault, so this is a
        // throw the service turns into 503 rather than a 402.
        throw new PaymentRailError(
          RAIL_ID,
          'facilitator_unavailable',
          cause instanceof GatewayError ? cause.message : `verify failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }

      if (!response.isValid) {
        return {
          valid: false,
          reason: toVerifyFailureReason(response.invalidReason),
          payer: response.payer || authorized.authorization.from,
          detail: response.invalidReason ?? 'rejected',
        };
      }
      // Deliberately not a claim about funds — Gateway's /verify does not check
      // the balance. See the table in this file's header.
      return { valid: true, reason: null, payer: response.payer || authorized.authorization.from };
    },

    async settle(payload: PaymentPayload): Promise<Receipt> {
      const authorized = authorizationOf(payload);
      const base = {
        railId: RAIL_ID,
        network,
        asset: payload.accepted.asset,
        amount: payload.accepted.amount,
        settledAt: Date.now(),
      };
      if (!authorized) {
        return { ...base, transaction: '', success: false, payer: null, error: 'payload.signature or payload.authorization missing or malformed' };
      }

      let response;
      try {
        response = await gateway.settle(payload, payload.accepted, resourceFor(payload));
      } catch (cause) {
        // A settlement failure after the work is done is an accounting problem,
        // not a crash — the service still has an answer in hand and needs to
        // decide what to do with it. So this returns rather than throws.
        return { ...base, transaction: '', success: false, payer: authorized.authorization.from, error: cause instanceof Error ? cause.message : String(cause) };
      }

      if (!response.success) {
        return {
          ...base,
          transaction: response.transaction || '',
          success: false,
          payer: response.payer || authorized.authorization.from,
          // `insufficient_balance` arrives here rather than at verify, because
          // Gateway's /verify does not check the balance.
          error: response.errorReason ?? 'settlement failed',
        };
      }

      const receipt: Receipt = {
        ...base,
        settledAt: Date.now(),
        transaction: response.transaction,
        success: true,
        payer: response.payer || authorized.authorization.from,
        error: null,
        extra: {
          settlement: 'circle-gateway-batched',
          facilitator: gateway.baseUrl,
          // The id `receipt()` resolves. **Not a transaction hash** — see the
          // header. The hash arrives when the batch lands, minutes later.
          authorizationId: response.transaction,
          batchTransaction: null,
          arcscan: null,
          batchSettled: false,
          nonce: authorized.authorization.nonce,
          payTo,
          settlementTiming: 'batched-asynchronous',
          note: 'credited immediately; mined later in a batch. Poll receipt() for the batch transaction.',
        },
      };

      return book.record(receipt, authorized.authorization.nonce);
    },

    /**
     * By Gateway authorization id.
     *
     * This is the method that turns "credited" into "mined". The local book
     * answers instantly for this process, but its `batchTransaction` is null
     * until the batch lands — so whenever the cached receipt still has no hash,
     * the transfers API is asked again and the answer is merged. A restarted
     * seller can also produce a receipt for a payment it took last week, because
     * the transfers API is public and needs no key.
     *
     * `null` is an ordinary answer: a buyer polling for a receipt that has not
     * landed yet is not an error.
     */
    async receipt(id: string): Promise<Receipt | null> {
      const local = book.find(id);
      if (local && local.extra?.['batchTransaction']) return local;

      // A stub id — `stub:arc-usdc:000001` — or a batch hash. Neither is a
      // transfer id, and asking Gateway for one would 404 in a way that looks
      // like "this payment does not exist".
      if (!isAuthorizationId(id)) {
        if (isBatchTransactionHash(id)) return local;
        return local;
      }

      let transfer: GatewayTransfer | null;
      try {
        transfer = await gateway.transfer(id);
      } catch {
        // The lookup failed, but a locally recorded receipt is still a true
        // record of a credited payment. Returning it beats returning null.
        return local;
      }
      if (!transfer) return local;

      const resolved = receiptFromTransfer(transfer);
      // Keep what settle() knew and the network could not tell us.
      if (local) resolved.extra = { ...local.extra, ...resolved.extra };
      return book.record(resolved, null);
    },
  };
}
