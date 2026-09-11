// The x402 resource-server half of the flow, as Express middleware.
//
//   GET /resource                        -> 402 + PAYMENT-REQUIRED
//   GET /resource  PAYMENT-SIGNATURE: .. -> verify, do the work, settle,
//                                           200 + PAYMENT-RESPONSE
//
// ## Nothing here knows what a chain is
//
// This file names no network, no asset, no address and no signature format. It
// asks `RailRegistry` for `accepts[]`, routes the payer's choice back to the
// rail that issued it, and copies opaque strings in both directions.
// `seller/service/no-chain-code.test.ts` asserts that mechanically over the
// whole directory, so the property is enforced rather than merely intended.
//
// ## Why the wire format comes from `@x402/core` and the middleware does not
//
// The header codecs and the zod schemas are the SDK's, so the bytes on the wire
// are the specification's rather than our reading of it, and
// `x402-interop.test.ts` proves it the only way that really counts: the real
// `@x402/fetch` client pays this server.
//
// The SDK's own resource-server middleware is not used, and the reason is
// specific rather than aesthetic. It splits challenge construction into
// `parsePrice(price, network)` and `enhancePaymentRequirements(reqs, kind, ext)`,
// and **neither is given the resource being sold**. A rail therefore cannot bind
// its challenge to the URL it was issued for, which is what stops a payment
// authorized for the cheap tier being replayed against the premium one. Adopting
// that split would also have pushed the SDK's scheme-server shape — asset
// transfer methods, payment flows, facilitator `/supported` sync — onto MOV-220
// and MOV-225 as the thing they implement, instead of four methods. The seam is
// the deliverable here, so the ~120 lines below are the cheaper trade.
//
// ## Ordering, and who eats the loss
//
// verify -> do the work -> settle. A payer whose payment is bad is refused
// before any work is done, and value moves only once there is an answer to hand
// over. If settlement then fails, the answer is **not** delivered: the response
// is a 402 naming the failure. That is deliberate — we neither give the work
// away nor charge for something undelivered, and the buyer can retry.

import type { Request, RequestHandler, Response } from 'express';
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http';

import type { PaymentPayload, PaymentRequirement, Receipt } from '../../rails/PaymentRail.ts';
import { PaymentRailError } from '../../rails/PaymentRail.ts';
import type { RailRegistry } from '../../rails/registry.ts';
import type { Tier } from './tiers.ts';
import { GATEWAY_KEY_HEADER, NO_GATEWAYS } from './gateway.ts';
import type { GatewayTrust } from './gateway.ts';

export const X402_VERSION = 2;

/** The 402 body. Structurally the x402 v2 `PaymentRequired`. */
export interface PaymentRequiredBody {
  x402Version: number;
  error?: string;
  resource: { url: string; description?: string; mimeType?: string; serviceName?: string };
  accepts: PaymentRequirement[];
  extensions?: Record<string, unknown>;
}

export interface PaidRouteOptions {
  registry: RailRegistry;
  tier: Tier;
  serviceName?: string;
  /** Overrides the tier description on the wire — used for per-pool descriptions. */
  describe?: (req: Request) => string;
  /** Gateways that settle in front of us and are let through unchallenged. See gateway.ts. */
  gateways?: GatewayTrust;
}

/**
 * Produces the response body once payment has been verified.
 *
 * Runs **before** settlement, so a handler that throws costs the payer nothing.
 */
export type PaidHandler = (req: Request) => Promise<unknown>;

function absoluteUrl(req: Request): string {
  return `${req.protocol}://${req.get('host') ?? 'localhost'}${req.originalUrl}`;
}

/** `PAYMENT-REQUIRED` goes in a header *and* the body: the header is what the */
/* protocol reads, the body is what a human or a curl sees. Same object. */
function sendChallenge(res: Response, body: PaymentRequiredBody): void {
  // The `as never` is the one place SDK and rail types meet: the SDK types
  // `network` as `${string}:${string}` and we type it as an opaque string. Same
  // bytes on the wire; `x402-interop.test.ts` pins the two shapes together.
  res.set('PAYMENT-REQUIRED', encodePaymentRequiredHeader(body as never));
  // A challenge is priced for one moment and one resource; a cache serving it to
  // the next buyer would hand them someone else's quote.
  res.set('Cache-Control', 'no-store');
  res.status(402).json(body);
}

function receiptToSettleResponse(receipt: Receipt) {
  return {
    success: receipt.success,
    transaction: receipt.transaction,
    network: receipt.network,
    ...(receipt.payer ? { payer: receipt.payer } : {}),
    ...(receipt.amount ? { amount: receipt.amount } : {}),
    ...(receipt.error ? { errorReason: 'settlement_failed', errorMessage: receipt.error } : {}),
  };
}

/**
 * Is this payment good for *this* resource at *this* price?
 *
 * The check the service owns, and the only one it can make without reading a
 * rail's `extra`: the payer's chosen entry must name a rail we currently offer,
 * with the same asset and payout account, for at least the amount that rail
 * quotes for this tier right now.
 *
 * The `>=` rather than `===` is what keeps a rail whose asset is not a dollar
 * stablecoin workable — an FX move between the challenge and the payment must
 * not reject an honest payer — and it is safe in the direction that matters: a
 * challenge issued for the $0.07 tier can never satisfy the $0.35 one.
 */
function matchesOffer(chosen: PaymentRequirement, offered: readonly PaymentRequirement[]): { ok: true } | { ok: false; detail: string } {
  const sameRail = offered.filter(o => o.scheme === chosen.scheme && o.network === chosen.network);
  if (sameRail.length === 0) {
    return { ok: false, detail: `${chosen.scheme} on ${chosen.network} is not offered for this resource` };
  }
  for (const offer of sameRail) {
    if (offer.asset !== chosen.asset) continue;
    if (offer.payTo !== chosen.payTo) continue;
    let quoted: bigint;
    let paid: bigint;
    try {
      quoted = BigInt(offer.amount);
      paid = BigInt(chosen.amount);
    } catch {
      return { ok: false, detail: 'amount is not an integer string' };
    }
    if (paid < quoted) {
      return { ok: false, detail: `amount ${chosen.amount} is below the ${offer.amount} quoted for this resource` };
    }
    return { ok: true };
  }
  return { ok: false, detail: 'asset or payTo does not match what this resource is offered for' };
}

/**
 * Gate one route behind a payment.
 *
 * @param options - the rails on offer and the tier being sold
 * @param handler - produces the response body, once, after verification
 */
export function paidRoute(options: PaidRouteOptions, handler: PaidHandler): RequestHandler {
  const { registry, tier } = options;
  const gateways = options.gateways ?? NO_GATEWAYS;

  return async function x402Gate(req, res) {
    // A gateway that already took the caller's payment. Checked before any rail
    // is asked for a challenge, so a rail outage cannot fail a call that was
    // settled elsewhere. A wrong or absent key falls through to the normal 402.
    const gateway = gateways.identify(req.header(GATEWAY_KEY_HEADER));
    if (gateway) {
      if (process.env.TURNSTILE_LOG_ATTEMPTS !== '0') {
        console.log(
          `[paid] ${req.method} ${req.originalUrl} payment=gateway gateway=${gateway}` +
            ` ua=${JSON.stringify(req.header('user-agent') ?? '')} xff=${req.header('x-forwarded-for') ?? '-'}`,
        );
      }
      const body = await handler(req);
      res.set('X-Turnstile-Settled-By', gateway);
      res.set('Cache-Control', 'no-store');
      res.status(200).json(body);
      return;
    }

    const resource = absoluteUrl(req);
    const description = options.describe ? options.describe(req) : tier.description;
    const resourceInfo = {
      url: resource,
      description,
      mimeType: 'application/json',
      ...(options.serviceName ? { serviceName: options.serviceName } : {}),
    };

    const { accepts, failed } = await registry.challengeAll({ resource, description, priceUsd: tier.priceUsd });
    if (accepts.length === 0) {
      // Every rail failed. This is our fault, not the payer's, and 402 would
      // wrongly tell them to try paying again.
      res.status(503).json({
        error: 'no payment rail could issue a challenge',
        rails: failed,
      });
      return;
    }

    const challenge: PaymentRequiredBody = {
      x402Version: X402_VERSION,
      error: 'Payment required',
      resource: resourceInfo,
      accepts,
      extensions: {
        // Named so a buyer can tell the two tiers apart without parsing prices.
        turnstileTier: tier.id,
        ...(failed.length > 0 ? { turnstileRailsUnavailable: failed } : {}),
      },
    };

    const signature = req.header('PAYMENT-SIGNATURE');

    // Provenance for every attempt on a paid route: who called, and whether they
    // arrived with a payment at all. Response bodies cannot distinguish "our 402
    // travelled back up through a gateway" from "they never paid us"; this line
    // can, and it is the whole difference when someone else's platform sits in
    // front of this service. Header *names* only, and the signature is never
    // written out — not even truncated. Set TURNSTILE_LOG_ATTEMPTS=0 to silence.
    if (process.env.TURNSTILE_LOG_ATTEMPTS !== '0') {
      const paymentish = Object.keys(req.headers).filter((h) => /payment|authorization|x-mpp|mpp/i.test(h));
      console.log(
        `[paid] ${req.method} ${req.originalUrl} payment=${signature ? 'present' : 'absent'}` +
          ` paymentHeaders=${JSON.stringify(paymentish)}` +
          ` ua=${JSON.stringify(req.header('user-agent') ?? '')}` +
          ` xff=${req.header('x-forwarded-for') ?? '-'}`,
      );
    }

    if (!signature) {
      sendChallenge(res, challenge);
      return;
    }

    let payload: PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(signature) as unknown as PaymentPayload;
    } catch (cause) {
      challenge.error = `PAYMENT-SIGNATURE could not be decoded: ${cause instanceof Error ? cause.message : String(cause)}`;
      sendChallenge(res, challenge);
      return;
    }

    const offerCheck = matchesOffer(payload.accepted, accepts);
    if (!offerCheck.ok) {
      challenge.error = `payment does not match this resource: ${offerCheck.detail}`;
      sendChallenge(res, challenge);
      return;
    }

    let verified;
    let rail;
    try {
      rail = registry.routeOrThrow(payload);
      verified = await rail.verify(payload, { resource, offered: accepts });
    } catch (cause) {
      if (cause instanceof PaymentRailError) {
        // The rail could not answer — an unreachable facilitator, a missing key.
        // Not the payer's fault, so not a 402.
        res.status(503).json({ error: cause.message, reason: cause.reason, railId: cause.railId });
        return;
      }
      throw cause;
    }

    if (!verified.valid) {
      challenge.error = `payment rejected by ${rail.id}: ${verified.reason ?? 'unknown'}${verified.detail ? ` — ${verified.detail}` : ''}`;
      sendChallenge(res, challenge);
      return;
    }

    // Verified. Do the work before any value moves, so a handler that fails
    // costs the payer nothing.
    const body = await handler(req);

    let receipt: Receipt;
    try {
      receipt = await rail.settle(payload);
    } catch (cause) {
      res.status(402).json({
        error: `settlement failed on ${rail.id}: ${cause instanceof Error ? cause.message : String(cause)}`,
        x402Version: X402_VERSION,
        accepts,
      });
      return;
    }

    if (!receipt.success) {
      // The work is done but unpaid. Withholding it is the only option that
      // neither gives the answer away nor charges for one not delivered.
      res.status(402).json({
        error: `settlement failed on ${rail.id}: ${receipt.error ?? 'unknown'}`,
        x402Version: X402_VERSION,
        accepts,
      });
      return;
    }

    res.set('PAYMENT-RESPONSE', encodePaymentResponseHeader(receiptToSettleResponse(receipt) as never));
    res.set('Cache-Control', 'no-store');
    res.status(200).json(body);
  };
}
