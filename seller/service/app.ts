// The seller's HTTP service: two priced tiers over the Liquidity Analyst, gated
// by x402.
//
// The app is built from injected parts — a `RailRegistry` and an `AnalystPort` —
// rather than reaching for either at import time. That is what lets
// `app.test.ts` exercise the whole payment flow with no testnet, no facilitator
// and no subgraph, and it is also what keeps this file free of any knowledge of
// which chain took the money.
//
// Routes:
//
//   GET /health                     free    what this seller sells and accepts
//   GET /analyze/:pool              $0.07   the verdict, from the subgraph
//   GET /analyze/:pool/attested     $0.35   the verdict, a live depth ladder,
//                                           and the scorer input behind both
//   GET /receipts/:transaction      free    audit-trail lookup across rails

import express from 'express';
import type { Express, Request } from 'express';

import type { RailRegistry } from '../../rails/registry.ts';
import type { AnalystInput, Verdict } from '../analyst/types.ts';
import { attestOrDegrade, unattestedPort } from './attestation.ts';
import type { AttestationPort } from './attestation.ts';
import { TIERS, assertWithinCeiling } from './tiers.ts';
import type { Tier } from './tiers.ts';
import { paidRoute } from './x402.ts';

/**
 * The analyst, as the service needs it.
 *
 * An interface rather than a direct import so the payment flow can be tested
 * without the network. The real one is in `analyst-port.ts`.
 */
export interface AnalystPort {
  /**
   * @param pool - pool address
   * @param options.liveDepth - quote the pool at the current block as well as
   *   reading the subgraph. This is the standard/premium difference.
   */
  analyze(pool: string, options: { liveDepth: boolean }): Promise<{ verdict: Verdict; input: AnalystInput }>;
}

export interface ServiceOptions {
  registry: RailRegistry;
  analyst: AnalystPort;
  /**
   * Attaches an attested verdict to the premium tier. Defaults to
   * `unattestedPort()`, which says honestly that nobody has attested anything.
   * MOV-227 implements the real one in `seller/cre/` and wires it in
   * `server.ts`.
   */
  attestation?: AttestationPort;
  serviceName?: string;
  tiers?: { standard: Tier; premium: Tier };
}

/**
 * Pool addresses are 20-byte hex. Rejecting the malformed ones here means a
 * payer is never charged for a request that could not have succeeded.
 */
const POOL_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function poolParam(req: Request): string {
  const pool = String(req.params['pool'] ?? '');
  if (!POOL_ADDRESS.test(pool)) {
    throw Object.assign(new Error(`'${pool}' is not a pool address`), { status: 400 });
  }
  return pool.toLowerCase();
}

export function createApp(options: ServiceOptions): Express {
  const { registry, analyst } = options;
  const attestation = options.attestation ?? unattestedPort();
  const tiers = options.tiers ?? { standard: TIERS.standard, premium: TIERS.premium };
  const serviceName = options.serviceName ?? 'liquidity.turnstile.eth';

  // A seller that would charge above its own published ceiling should refuse to
  // start rather than find out on the first sale.
  assertWithinCeiling([tiers.standard, tiers.premium]);

  const app = express();

  // Behind Caddy the socket is plain http, so `req.protocol` reported http and
  // the resource URL in the 402 body read `http://turnstile.moveseventyeight.com/…`
  // on a deployment that is https-only — a payer being asked to pay for a URL it
  // did not request. Trusting the proxy makes that URL the one the client used.
  // A direct connection with no forwarded header still reads http, which is what
  // the tests exercise.
  app.set('trust proxy', true);

  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req, res) => {
    res.json({
      service: serviceName,
      // Says out loud when every advertised rail is still a placeholder. A
      // demo that quietly settles nothing is worse than one that says so.
      settlementLive: registry.rails.some(rail => rail.info.live),
      rails: registry.describe(),
      tiers: Object.values(tiers).map(tier => ({
        id: tier.id, priceUsd: tier.priceUsd, description: tier.description,
      })),
    });
  });

  app.get('/analyze/:pool', paidRoute(
    {
      registry,
      tier: tiers.standard,
      serviceName,
      describe: req => `Liquidity Analyst verdict for pool ${req.params['pool']} (subgraph only)`,
    },
    async req => {
      const pool = poolParam(req);
      const { verdict } = await analyst.analyze(pool, { liveDepth: tiers.standard.liveDepth });
      return { tier: tiers.standard.id, verdict };
    },
  ));

  app.get('/analyze/:pool/attested', paidRoute(
    {
      registry,
      tier: tiers.premium,
      serviceName,
      describe: req => `Liquidity Analyst verdict for pool ${req.params['pool']}, with live depth and the scorer input`,
    },
    async req => {
      const pool = poolParam(req);
      const { verdict, input } = await analyst.analyze(pool, { liveDepth: tiers.premium.liveDepth });
      return {
        tier: tiers.premium.id,
        verdict,
        // The premium tier's actual deliverable, and the MOV-227 seam.
        //
        // `assess()` is a pure total function of this object, so a buyer holding
        // it can re-derive the verdict above and get the same bytes — the claim
        // is checkable rather than merely asserted. The enclave's argument and
        // this payload are one object, which is why attestation needed no new
        // tier and no new field.
        //
        // Measured on a real run against USDC/WETH 0.05% (2026-09-07): 9,210
        // bytes, and `assess(JSON.parse(JSON.stringify(input)))` is byte
        // identical to `assess(input)`. See seller/analyst/README.md, and
        // attestation.ts for why an implementation must hash exactly these bytes.
        analystInput: input,
        // Passed `input` rather than a copy or a re-fetch, so whatever the port
        // hashes is what the buyer above receives.
        attestation: await attestOrDegrade(attestation, input, verdict),
      };
    },
  ));

  app.get('/receipts/:transaction', async (req, res) => {
    const receipt = await registry.findReceipt(String(req.params['transaction'] ?? ''));
    if (!receipt) {
      res.status(404).json({ error: 'no rail has a receipt for that transaction' });
      return;
    }
    res.json(receipt);
  });

  // Express 5 forwards a rejected handler promise here.
  app.use((err: Error & { status?: number }, _req: Request, res: express.Response, _next: express.NextFunction) => {
    const status = err.status ?? 500;
    res.status(status).json({ error: err.message });
  });

  return app;
}
