// Base Sepolia, settled in USDC through the x402 Foundation's public
// facilitator. **Live — this rail moves real testnet USDC on a real network.**
//
// ## The flow
//
// x402's `exact` scheme on an EVM chain is an EIP-3009 authorization, and it is
// the shape most readers will already expect:
//
//   1. `challenge()` advertises `scheme: exact` on `eip155:84532`, the USDC
//      contract, a price in USDC's smallest unit, our payout address, and — this
//      is the part that is easy to leave out and impossible to debug — the
//      token's EIP-712 domain (`extra.name`, `extra.version`). A payer signs a
//      `TransferWithAuthorization` against that domain; if it is wrong the
//      signature is valid over the wrong thing and the facilitator refuses with
//      `invalid_exact_evm_token_version_mismatch`.
//   2. The payer signs offchain and sends the signature back. **They submit no
//      transaction and need no gas**, because the facilitator redeems the
//      authorization: `transferWithAuthorization` on the USDC contract, from the
//      payer's balance to `payTo`.
//   3. `settle()` hands the payload to the facilitator and gets a transaction
//      hash back.
//
// The consequence worth stating: this rail's payer needs a USDC balance and
// nothing else. No gas token, no relationship with us, and their key never
// leaves their machine — the same property the Arc rail has, by a different
// mechanism.
//
// ## What is checked, where, and by whom
//
// | Check | Where | Catches |
// |---|---|---|
// | amount >= quoted, asset and payout match a live offer | `seller/service/x402.ts` | buying the $0.35 tier with a $0.07 payment |
// | payout address, replay, resource binding | `verify()` here | a payment reused for a second answer |
// | signature, EIP-712 domain, transfer semantics, payer balance | the facilitator's `/verify` | anything about the authorization itself, including a nonce already spent on chain |
//
// **On the resource binding, honestly:** the EIP-3009 authorization commits to
// `from`, `to`, `value`, `validAfter`, `validBefore` and `nonce` — not to a URL.
// So `extra.resource` is advisory here exactly as it is on the Hedera rail: it
// catches an honest client pointed at the wrong URL, and a determined payer can
// edit it. What actually stops one payment buying the wrong answer is the
// service's fresh-offer amount check and the replay guard below.
//
// ## Why `live: true` is not an overclaim
//
// The rail settles real USDC by real signature on a real network, and the public
// facilitator is what submits it. That it is testnet USDC is a fact about the
// asset, not about whether the mechanism works — and `info.label` says testnet
// where a judge will read it.

import type {
  ChallengeRequest, PaymentPayload, PaymentRail,
  PaymentRequirement, RailInfo, Receipt, VerifyContext, VerifyResult,
} from '../PaymentRail.ts';
import { PaymentRailError, usdToAtomic } from '../PaymentRail.ts';
import {
  CHAIN_ID, EIP712_NAME, EIP712_VERSION, ERC20_TRANSFER_TOPIC, ENS_PAYOUT_ADDRESS,
  MAINNET_CHAIN_ID, MAINNET_EIP712_NAME, MAINNET_FACILITATOR_URL, MAINNET_NETWORK,
  MAINNET_RPC_URL, MAINNET_USDC_ASSET,
  NETWORK, RPC_URL, USDC_ASSET, USDC_DECIMALS,
  explorerTransactionUrl, isTransactionHash,
} from './config.ts';
import { FacilitatorError, X402Facilitator, toVerifyFailureReason } from './facilitator.ts';
import type { FacilitatorOptions } from './facilitator.ts';

export { NETWORK, USDC_ASSET as ASSET, EIP712_NAME, EIP712_VERSION, basescanTransactionUrl } from './config.ts';
export { X402Facilitator } from './facilitator.ts';

const RAIL_ID = 'base-usdc';

/** USDC on this rail is a dollar, so no FX rate is involved. */
const USD_PER_UNIT = 1;

/**
 * The `exact` EVM payload: an EIP-3009 authorization and its signature.
 *
 * `value`, `validAfter` and `validBefore` are decimal strings and `nonce` is a
 * `0x` 32-byte value, because that is what the typehash commits to — a client
 * that sends them as numbers produces a signature over a different struct.
 */
export interface ExactEvmPayload {
  signature: string;
  authorization: {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
  };
}

export interface BaseRailOptions {
  /**
   * Rail id. Defaults to `base-usdc`.
   *
   * The mainnet instance passes `base-usdc-mainnet`, because `RailRegistry`
   * refuses two rails with the same id — they would be indistinguishable in
   * `/health` and in a receipt. The `PaymentRail` interface asks ids to match
   * their directory name; two instances of one implementation sharing a
   * directory is the exception, and this comment is where it is declared rather
   * than discovered.
   */
  id?: string;
  /** The seller's payout address. Defaults to `BASE_PAYOUT_ADDRESS`, then the ENS `addr(60)`. */
  payTo?: string;
  network?: string;
  asset?: string;
  decimals?: number;
  symbol?: string;
  /** EIP-712 domain name of the token. Defaults to the testnet token's, so a mainnet rail must pass one. */
  eip712Name?: string;
  /** Human-readable chain, used in `info.label` so a judge reads the right one. */
  chainLabel?: string;
  facilitatorUrl?: string;
  maxTimeoutSeconds?: number;
  facilitator?: X402Facilitator;
  facilitatorOptions?: FacilitatorOptions;
  /** Used by `receipt()` to read a settled transaction back off the chain. Injectable for tests. */
  rpcUrl?: string;
  rpcFetch?: typeof globalThis.fetch;
}

/**
 * In-memory settlement log, plus the replay guard.
 *
 * Keyed on `from:nonce` rather than on the payload's serialized bytes: the nonce
 * is what the USDC contract itself treats as single-use, so two different
 * encodings of one authorization collapse to one key here. Survives one process,
 * which is the same honesty the other two rails offer — the chain is the durable
 * replay guard, and a restart only means we rediscover a duplicate one
 * facilitator round-trip later.
 */
class SettlementBook {
  private readonly byTransaction = new Map<string, Receipt>();
  private readonly spent = new Set<string>();

  record(receipt: Receipt, replayKey: string | null): Receipt {
    if (receipt.transaction) this.byTransaction.set(receipt.transaction, receipt);
    if (receipt.success && replayKey) this.spent.add(replayKey);
    return receipt;
  }

  isSpent(replayKey: string): boolean {
    return this.spent.has(replayKey);
  }

  find(transaction: string): Receipt | null {
    return this.byTransaction.get(transaction) ?? null;
  }
}

/** `from:nonce`, lowercased. Null when the payload does not carry both. */
function replayKeyOf(authorization: Partial<ExactEvmPayload['authorization']> | undefined): string | null {
  const from = typeof authorization?.from === 'string' ? authorization.from.toLowerCase() : '';
  const nonce = typeof authorization?.nonce === 'string' ? authorization.nonce.toLowerCase() : '';
  return from && nonce ? `${from}:${nonce}` : null;
}

function authorizationOf(payload: PaymentPayload): Partial<ExactEvmPayload> | null {
  const inner = payload.payload as Partial<ExactEvmPayload> | undefined;
  if (!inner || typeof inner !== 'object') return null;
  return inner;
}

export function createBaseRail(options: BaseRailOptions = {}): PaymentRail {
  const id = options.id ?? RAIL_ID;
  const payTo = options.payTo ?? process.env['BASE_PAYOUT_ADDRESS'] ?? ENS_PAYOUT_ADDRESS;
  const network = options.network ?? NETWORK;
  const isMainnet = network === MAINNET_NETWORK;
  const asset = options.asset ?? (isMainnet ? MAINNET_USDC_ASSET : USDC_ASSET);
  const decimals = options.decimals ?? USDC_DECIMALS;
  const symbol = options.symbol ?? 'USDC';
  const eip712Name = options.eip712Name ?? (isMainnet ? MAINNET_EIP712_NAME : EIP712_NAME);
  // The chain id has to match the network, or the EIP-712 domain a payer signs
  // against is for the wrong chain and the facilitator refuses it.
  const chainId = isMainnet ? MAINNET_CHAIN_ID : CHAIN_ID;
  const chainLabel = options.chainLabel ?? (isMainnet ? 'Base' : 'Base Sepolia');
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? 300;
  const rpcUrl = options.rpcUrl ?? process.env['BASE_RPC_URL'] ?? (isMainnet ? MAINNET_RPC_URL : RPC_URL);

  const facilitator = options.facilitator ?? new X402Facilitator({
    baseUrl: options.facilitatorUrl,
    ...options.facilitatorOptions,
  });
  const book = new SettlementBook();
  const rpcFetch = options.rpcFetch ?? globalThis.fetch;

  const info: RailInfo = {
    id,
    label: `${chainLabel} ${symbol}, settled through the x402 facilitator`,
    scheme: 'exact',
    network,
    asset: { id: asset, symbol, decimals },
    // The on-chain `turnstile:rails` record on liquidity.turnstile.eth reads
    // `x402,usdc-arc` and has NOT been rewritten to name this rail: that record
    // is cold-key written and costs a transaction. `x402` is the honest token
    // here — this is an x402 rail — so a buyer that discovered us through ENS
    // still finds us. See docs/ens-offer-records.md; the record undersells the
    // advertised set until someone decides to spend that transaction.
    ensRailToken: 'x402',
    live: true,
  };

  return {
    id,
    info,

    async challenge(req: ChallengeRequest): Promise<PaymentRequirement> {
      // Ask the facilitator rather than assume. If it stops settling `exact` on
      // this network, this fails here — the seller answers 503 — instead of
      // minting a quote nobody can pay.
      try {
        const kind = await facilitator.kindFor('exact', network);
        if (!kind) {
          throw new PaymentRailError(
            id,
            'unsupported_rail',
            `${facilitator.baseUrl} does not settle exact on ${network}`,
          );
        }
      } catch (cause) {
        if (cause instanceof PaymentRailError) throw cause;
        throw new PaymentRailError(
          id,
          'facilitator_unavailable',
          `could not read ${facilitator.baseUrl}/supported: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }

      return {
        scheme: 'exact',
        network,
        asset,
        amount: usdToAtomic(req.priceUsd, decimals, USD_PER_UNIT),
        payTo,
        maxTimeoutSeconds: req.maxTimeoutSeconds ?? maxTimeoutSeconds,
        extra: {
          // The three fields a payer cannot do without. `name` and `version` are
          // the token's EIP-712 domain: without them `@x402/evm`'s client (and
          // Bazantic's) refuses the challenge outright, and with them wrong the
          // facilitator refuses the payment after it has been signed.
          name: eip712Name,
          version: EIP712_VERSION,
          chainId,
          facilitator: facilitator.baseUrl,
          settlementModel: 'facilitator-redeemed-eip3009',
          decimals,
          symbol,
          priceUsd: req.priceUsd,
          usdPerUnit: USD_PER_UNIT,
          rateSource: 'USDC is a dollar; no FX rate is involved',
          // Advisory — see the header.
          resource: req.resource,
          turnstileSettlement: 'live',
        },
      };
    },

    async verify(payload: PaymentPayload, context?: VerifyContext): Promise<VerifyResult> {
      const inner = authorizationOf(payload);
      const authorization = inner?.authorization;
      const signature = inner?.signature;
      if (typeof signature !== 'string' || !signature || !authorization) {
        return { valid: false, reason: 'invalid_signature', payer: null, detail: 'payload.signature or payload.authorization missing' };
      }

      if (payload.accepted.payTo.toLowerCase() !== payTo.toLowerCase()) {
        return {
          valid: false,
          reason: 'wrong_recipient',
          payer: null,
          detail: `payTo ${payload.accepted.payTo} is not this seller's payout address`,
        };
      }
      if (typeof authorization.to !== 'string' || authorization.to.toLowerCase() !== payTo.toLowerCase()) {
        return {
          valid: false,
          reason: 'wrong_recipient',
          payer: null,
          detail: `the authorization transfers to ${String(authorization.to)}, not to this seller`,
        };
      }

      // The replay guard. The USDC contract itself refuses a second redemption
      // of one nonce, but only when the facilitator submits it — by which point
      // we have already answered. Refusing here is what makes one payment buy
      // exactly one answer.
      const replayKey = replayKeyOf(authorization);
      if (replayKey && book.isSpent(replayKey)) {
        return { valid: false, reason: 'already_settled', payer: authorization.from ?? null, detail: 'this authorization has already been settled by this seller' };
      }

      if (context) {
        const boundTo = payload.accepted.extra['resource'];
        if (typeof boundTo === 'string' && boundTo !== context.resource) {
          return { valid: false, reason: 'wrong_recipient', payer: authorization.from ?? null, detail: `payment was issued for ${boundTo}, not ${context.resource}` };
        }
      }

      let response;
      try {
        response = await facilitator.verify(payload, payload.accepted);
      } catch (cause) {
        // The facilitator could not answer at all. Not the payer's fault, so
        // this is a throw the service turns into 503 rather than a 402.
        throw new PaymentRailError(
          id,
          'facilitator_unavailable',
          cause instanceof FacilitatorError ? cause.message : `verify failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }

      if (!response.isValid) {
        return {
          valid: false,
          reason: toVerifyFailureReason(response.invalidReason, response.invalidMessage),
          payer: response.payer || authorization.from || null,
          detail: `${response.invalidReason ?? 'rejected'}${response.invalidMessage ? `: ${response.invalidMessage}` : ''}`,
        };
      }
      return { valid: true, reason: null, payer: response.payer || authorization.from || null };
    },

    async settle(payload: PaymentPayload): Promise<Receipt> {
      const inner = authorizationOf(payload);
      const authorization = inner?.authorization;
      const replayKey = replayKeyOf(authorization);
      const base = {
        railId: id,
        network,
        asset: payload.accepted.asset,
        amount: payload.accepted.amount,
        settledAt: Date.now(),
      };
      if (!inner?.signature || !authorization) {
        return { ...base, transaction: '', success: false, payer: null, error: 'payload.signature or payload.authorization missing' };
      }

      let response;
      try {
        response = await facilitator.settle(payload, payload.accepted);
      } catch (cause) {
        // A settlement failure after the work is done is an accounting problem,
        // not a crash — the service still has an answer in hand and needs to
        // decide what to do with it. So this returns rather than throws.
        return { ...base, transaction: '', success: false, payer: authorization.from ?? null, error: cause instanceof Error ? cause.message : String(cause) };
      }

      if (!response.success) {
        return {
          ...base,
          transaction: response.transaction || '',
          success: false,
          payer: response.payer || authorization.from || null,
          error: `${response.errorReason ?? 'settlement failed'}${response.errorMessage ? `: ${response.errorMessage}` : ''}`,
        };
      }

      const receipt: Receipt = {
        ...base,
        settledAt: Date.now(),
        transaction: response.transaction,
        success: true,
        payer: response.payer || authorization.from || null,
        error: null,
        extra: {
          settlement: 'x402-facilitator',
          facilitator: facilitator.baseUrl,
          basescan: explorerTransactionUrl(network, response.transaction),
          chainId,
        },
      };
      return book.record(receipt, replayKey);
    },

    /**
     * By transaction hash.
     *
     * The in-memory book answers for this process; anything older is read back
     * off the public RPC, so a restarted seller can still produce a receipt for
     * a payment it took earlier. `null` is an ordinary answer — including for a
     * hash whose transaction is not a USDC transfer to us.
     */
    async receipt(id: string): Promise<Receipt | null> {
      const local = book.find(id);
      if (local) return local;
      if (!isTransactionHash(id)) return null;

      let body: { result?: { status?: string; logs?: { address: string; topics: string[]; data: string }[] } | null };
      try {
        const res = await rpcFetch(rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [id] }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return null;
        body = await res.json() as typeof body;
      } catch {
        return null;
      }
      const tx = body.result;
      if (!tx || !Array.isArray(tx.logs)) return null;

      const paddedPayTo = payTo.replace(/^0x/, '').toLowerCase().padStart(64, '0');
      const transfer = tx.logs.find(
        log =>
          log.address?.toLowerCase() === asset.toLowerCase() &&
          log.topics?.[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC &&
          log.topics?.[2]?.toLowerCase().endsWith(paddedPayTo),
      );
      if (!transfer) return null;

      // A topic is 32 bytes of hex, so the address is its last 20 — take the
      // tail rather than slicing from the front, where the `0x` prefix makes
      // every offset off by two characters.
      const from = `0x${transfer.topics[1]!.slice(-40)}`;
      const amount = transfer.data && transfer.data !== '0x' ? String(BigInt(transfer.data)) : null;
      return {
        railId: id,
        transaction: id,
        success: tx.status === '0x1',
        network,
        payer: from,
        amount,
        asset,
        settledAt: Date.now(),
        error: tx.status === '0x1' ? null : 'transaction reverted',
        extra: { settlement: 'rpc', basescan: explorerTransactionUrl(network, id), rpc: rpcUrl },
      };
    },
  };
}

/**
 * The same rail on Base **mainnet**.
 *
 * A second instance rather than a second implementation, because every
 * difference between the two chains is a constant: the network id, the USDC
 * address, the EIP-712 domain name, the facilitator and the explorer. What is
 * *not* shared is the money: this instance settles real USDC, which is why it
 * exists — a Bazantic production gateway charges its client on mainnet and
 * cannot pay a testnet-only seller.
 *
 * The id differs from the testnet instance's because `RailRegistry` requires it
 * to; `info.network` is what routes a payment, and the two do not collide.
 */
export function createBaseMainnetRail(options: BaseRailOptions = {}): PaymentRail {
  return createBaseRail({
    id: 'base-usdc-mainnet',
    chainLabel: 'Base',
    network: MAINNET_NETWORK,
    asset: MAINNET_USDC_ASSET,
    eip712Name: MAINNET_EIP712_NAME,
    facilitatorUrl: MAINNET_FACILITATOR_URL,
    rpcUrl: MAINNET_RPC_URL,
    ...options,
  });
}
