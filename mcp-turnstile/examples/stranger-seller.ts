// A seller the buyer agent has never heard of, and that has never heard of it.
//
// This file exists to falsify one specific claim about the MCP server: that it
// only works because it knows about `liquidity.turnstile.eth`. So it deliberately
// shares **no seller code** with Turnstile's own service — no `createApp`, no
// `paidRoute`, no `RailRegistry`, no `tiers.ts`, no analyst. It is a bare
// `node:http` handler that builds its own 402 by hand and calls the four
// `PaymentRail` methods directly.
//
// What it *does* share is the Hedera rail and the public Blocky402 facilitator,
// and that sharing is the point rather than a compromise: a rail is
// infrastructure two unrelated sellers are supposed to have in common, the same
// way two unrelated websites have TLS in common. If the buyer had to know
// anything about *this* seller — its price, its product, its payout account, its
// URL shape — it would fail here, and it does not: every one of those arrives in
// the 402.
//
// It sells something Turnstile does not sell, at a price Turnstile does not
// charge, on a URL shape Turnstile does not use.
//
//   node mcp-turnstile/examples/stranger-seller.ts --port 8402
//
// ## What it deliberately does not do
//
// It writes no HCS receipt. Nothing on chain binds a seller to a receipt topic,
// so publishing to Turnstile's is not something a stranger would or should do —
// and a seller with no audit trail is the ordinary case the `receipts` tool has
// to be honest about. Its settlements are real either way: real HBAR, a real
// transaction, a real HashScan link.

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';

import type { PaymentPayload, PaymentRail } from '../../rails/PaymentRail.ts';
import { createHederaRail } from '../../rails/hedera-x402/index.ts';

/** Nothing about this resembles Turnstile's `/analyze/:pool` at $0.07. */
export const STRANGER_PRICE_USD = 0.02;
export const STRANGER_PATH = /^\/v1\/gas-window\/([a-z0-9-]+)$/;

/** The product: a made-up gas-fee window. The point is that it is not a verdict. */
function gasWindow(chain: string): Record<string, unknown> {
  const now = Date.now();
  return {
    service: 'strangergas.example',
    chain,
    window: { fromMs: now - 3_600_000, toMs: now },
    baseFeeGwei: { p10: 4.1, p50: 7.8, p90: 19.4 },
    recommendation: 'submit below 8 gwei to land within the hour at p50',
    note: 'A fixture payload. What is real here is the payment, not the gas data.',
  };
}

export interface StrangerSellerOptions {
  rail?: PaymentRail;
  priceUsd?: number;
}

/**
 * A hand-rolled x402 resource server.
 *
 * The order is the one that matters and is the same order Turnstile's service
 * uses, because it is the protocol's rather than ours: verify, then do the work,
 * then settle. A payer whose payment is bad is refused before any work is done,
 * and value moves only once there is something to hand over.
 */
export function createStrangerSeller(options: StrangerSellerOptions = {}) {
  // No receipt topic: `topicId: null` disables it outright, as against omitting
  // it, which would fall back to HEDERA_RECEIPT_TOPIC_ID and write a stranger's
  // sales into Turnstile's audit trail.
  const rail = options.rail ?? createHederaRail({ receiptTopicOptions: { topicId: null } });
  const priceUsd = options.priceUsd ?? STRANGER_PRICE_USD;

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const match = STRANGER_PATH.exec(url.pathname);
      const json = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
        res.end(JSON.stringify(body));
      };

      if (!match) {
        json(404, { error: 'try GET /v1/gas-window/<chain>' });
        return;
      }
      const chain = match[1]!;
      const resource = `${url.origin}${url.pathname}`;
      const description = `Hourly base-fee window for ${chain}`;

      const requirement = await rail.challenge({ resource, description, priceUsd });
      const challenge = {
        x402Version: 2,
        error: 'Payment required',
        resource: { url: resource, description, mimeType: 'application/json', serviceName: 'strangergas.example' },
        accepts: [requirement],
      };

      const signature = req.headers['payment-signature'];
      if (typeof signature !== 'string' || signature.length === 0) {
        json(402, challenge, { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(challenge as never) });
        return;
      }

      let payload: PaymentPayload;
      try {
        payload = decodePaymentSignatureHeader(signature) as unknown as PaymentPayload;
      } catch (cause) {
        json(402, { ...challenge, error: `undecodable PAYMENT-SIGNATURE: ${cause instanceof Error ? cause.message : String(cause)}` });
        return;
      }

      // The seller's own check, and the reason it cannot be delegated: a payment
      // authorized for a cheaper resource must not buy this one.
      if (BigInt(payload.accepted.amount) < BigInt(requirement.amount) || payload.accepted.payTo !== requirement.payTo) {
        json(402, { ...challenge, error: 'the payment does not match what this resource is offered for' });
        return;
      }

      const verified = await rail.verify(payload, { resource, offered: [requirement] });
      if (!verified.valid) {
        json(402, { ...challenge, error: `payment rejected: ${verified.reason ?? 'unknown'}${verified.detail ? ` — ${verified.detail}` : ''}` });
        return;
      }

      const body = gasWindow(chain);

      const receipt = await rail.settle(payload);
      if (!receipt.success) {
        // The work is done and unpaid. Withholding it is the only option that
        // neither gives it away nor charges for something undelivered.
        json(402, { ...challenge, error: `settlement failed: ${receipt.error ?? 'unknown'}` });
        return;
      }

      json(200, body, {
        'PAYMENT-RESPONSE': encodePaymentResponseHeader({
          success: true,
          transaction: receipt.transaction,
          network: receipt.network,
          ...(receipt.payer ? { payer: receipt.payer } : {}),
          ...(receipt.amount ? { amount: receipt.amount } : {}),
        } as never),
      });
    })().catch((cause: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) }));
    });
  });
}

/** Start on an ephemeral port and return the base URL and a stop function. */
export async function startStrangerSeller(options: StrangerSellerOptions & { port?: number } = {}): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = createStrangerSeller(options);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve(); }); }),
  };
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const portArg = process.argv.indexOf('--port');
  const { baseUrl } = await startStrangerSeller({ port: portArg >= 0 ? Number(process.argv[portArg + 1]) : 8402 });
  process.stdout.write(`strangergas.example listening on ${baseUrl}\n  GET ${baseUrl}/v1/gas-window/base  ($${STRANGER_PRICE_USD})\n`);
}
