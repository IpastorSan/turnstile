// Turning an identifier into an offer a buyer's agent can act on — for any
// seller, not for ours.
//
// This is the file the "reusable infrastructure" claim lives or dies on. If
// anything below only works because it knows about `liquidity.turnstile.eth`,
// the MCP server is a client for one service wearing a directory's clothes. So
// the rule here is that **every seller-specific value arrives as data**: the ENS
// name comes from the caller, the resolver address comes from the store or from
// an argument, the resource URL comes from the agent's own registration, and the
// price comes from that agent's records or from its own 402. There is no
// constant in this file naming a seller, a price, a host or a chain.
//
// ## The three ways a price can be known, and the fourth that looks like one
//
//   1. **An ENSv2 `turnstile:price` record.** Exact, published in advance,
//      readable by anyone. Only Turnstile sellers have one.
//   2. **A live HTTP 402.** The price at the moment you ask. This is the only
//      route that works for an agent that has never heard of Turnstile, and it
//      is the one `purchase` actually needs.
//   3. **A price object in the registration document.** ERC-8004
//      registration-v1 has no price field, so this is non-standard. Zero of the
//      197 agents in the shipped store carry one.
//   4. A cached 402 from a previous probe, which is a price that *was* true.
//
// A published price is not a quote. `liquidity.turnstile.eth` publishes $0.07 on
// chain and the MCP endpoint that record names does not resolve — so the offer
// carries a price and `purchasable.ok === false`, with the DNS failure as the
// reason. Reporting that as "buyable for seven cents" would be the single most
// misleading thing this server could do.

import type { DatabaseSync } from 'node:sqlite';

import { normalizePriceUsd } from '../seller/service/discovery.ts';
import type { PriceSource } from '../seller/service/discovery.ts';
import { probeEndpoint } from '../graph/sink/probe-x402.ts';
import type { ProbeResult } from '../graph/sink/probe-x402.ts';
import { makePublicClient, readSellerOffer } from '../graph/sink/ens.ts';
import type { SellerOffer } from '../graph/sink/ens.ts';
import { DEFAULT_TIMEOUT_MS } from '../graph/sink/card.ts';

export type RefKind = 'ens' | 'agent_uid' | 'url' | 'unknown';

/**
 * What kind of thing the caller named.
 *
 * A buyer's agent gets an `agentUid` back from `find_sellers` and an ENS name
 * off a website; both have to work, and so does a bare URL, because an agent
 * that already knows where it is buying should not have to go through a
 * directory to do it.
 */
export function classifyRef(ref: string): RefKind {
  const value = ref.trim();
  if (/^https?:\/\//i.test(value)) return 'url';
  // `<namespace>:<reference>:<registry>/<agentId>` — the join key the Substreams
  // module emits and `find_sellers` returns. Matched loosely on purpose: today
  // every one of them is `eip155:<chainId>:<0x…40 hex>/<n>`, and pinning that
  // shape here would make the tool reject the first registry that is not an EVM
  // contract for a reason that has nothing to do with anything.
  if (/^[a-z0-9-]+:[^\s/:]+:[^\s/]+\/[^\s/]+$/i.test(value)) return 'agent_uid';
  // A dotted name with no scheme, path or port. `.eth` is not required: the
  // records this reads are ENSIP-25/26, which are not TLD-specific.
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value)) return 'ens';
  return 'unknown';
}

export interface OfferAgentEndpoint {
  name: string | null;
  uri: string | null;
}

export interface OfferAgent {
  agentUid: string;
  name: string | null;
  description: string | null;
  network: string;
  chainId: number;
  registry: string;
  agentId: string;
  owner: string;
  /** `agentWallet` — the address the registry says this agent is paid at. */
  payTo: string;
  x402Support: boolean;
  active: boolean;
  documentState: string;
  capabilities: string[];
  endpoints: OfferAgentEndpoint[];
}

export interface OfferEnsRecords {
  ensName: string;
  resolver: string | null;
  chainId: number | null;
  /** ENSIP-26 `agent-context`. */
  agentContext: string | null;
  /** ENSIP-26 `agent-endpoint[mcp]`. */
  mcpEndpoint: string | null;
  price: string | null;
  priceCeiling: string | null;
  /** `turnstile:rails`, the comma-separated tokens a buyer's mandate matches on. */
  rails: string[];
  operatorProof: string | null;
  payoutAddr: string | null;
  /** `VerifiableFactory.verifyContract` agreed the resolver is a stock ENS one. */
  resolverVerified: boolean;
  /** `store` — read by `hydrate-sellers`; `live` — read from the chain just now. */
  readFrom: 'store' | 'live';
  readAt: number | null;
}

/**
 * How a dollar figure was arrived at, which decides whether it can be trusted.
 *
 * The distinction that matters is `seller_declared`. An x402 challenge quotes an
 * integer in the asset's smallest unit — 84,770,051 tinybars — and helpfully
 * includes the seller's own `priceUsd` and `usdPerUnit` beside it. Using that
 * number to check a budget would let a seller quoting 12 HBAR for "seven cents",
 * with a rate that makes 12 HBAR look like seven cents, pass a cap computed from
 * its own arithmetic. From CLAUDE.md: the key that spends can never raise its
 * own limit, and a cap a counterparty can move is not a cap.
 *
 * So a seller-declared figure is reported — it is genuinely informative — and
 * `comparable` is false for it. `purchase` re-prices the same offer with the
 * buyer's own rate before the mandate sees it.
 */
export type PriceBasis =
  /** A `turnstile:price` record: decimal US dollars by construction. */
  | 'ens_record'
  /** An integer in the smallest unit of a recognised dollar stablecoin. */
  | 'stablecoin_unit'
  /** The seller's own `extra.priceUsd` or `extra.usdPerUnit`. Informative, not checkable. */
  | 'seller_declared'
  /** A non-standard price object in the registration document. */
  | 'document'
  | 'unknown';

export interface OfferTerms {
  /** The URL to buy from, or `null` when nothing published one. */
  resource: string | null;
  /**
   * Best available dollar figure. **Read `basis` before comparing it to a
   * budget**: when `comparable` is false this number came from the seller.
   */
  priceUsd: number | null;
  basis: PriceBasis;
  /** As quoted, in the unit its source uses. */
  priceRaw: string | null;
  currency: string | null;
  asset: string | null;
  network: string | null;
  scheme: string | null;
  /** Payout account as the *price source* gives it — not as the registry does. */
  payTo: string | null;
  /**
   * `x402_live` is a quote fetched during this call; `x402` is a cached one.
   * The difference matters: a cached quote is a price that was true.
   */
  source: PriceSource | 'x402_live';
  /** `priceUsd` is set AND was not computed from the seller's own numbers. */
  comparable: boolean;
  /** Unix seconds the quote was taken, for the live and cached x402 cases. */
  quotedAt: number | null;
  note?: string;
}

/**
 * What the agent published in advance, kept whole.
 *
 * A live quote replaces `offer` but never overwrites this: an agent that
 * publishes $0.07 on chain and quotes something else on the wire is exactly the
 * case a buyer needs both halves of.
 */
export interface PublishedTerms {
  priceUsd: number | null;
  priceRaw: string;
  currency: string | null;
  source: PriceSource;
  basis: PriceBasis;
  /** The cold-key ceiling the seller's hot key cannot price above. */
  ceilingUsd: number | null;
  payTo: string | null;
}

export interface OfferRecord {
  ref: string;
  refKind: RefKind;
  /** An ordered account of every step taken, so a caller can audit the answer. */
  resolvedVia: string[];
  agent: OfferAgent | null;
  ens: OfferEnsRecords | null;
  offer: OfferTerms;
  /** What was published in advance, if anything. Never overwritten by a quote. */
  published: PublishedTerms | null;
  probe: (ProbeResult & { url: string }) | null;
  /**
   * Whether `purchase` can act on this, and why not when it cannot.
   *
   * True only when a live 402 with a parseable amount was seen. A published
   * price is not a quote, and an endpoint that does not answer cannot be paid
   * however exact the price beside it is.
   */
  purchasable: { ok: boolean; reason: string };
  warnings: string[];
}

export interface GetOfferOptions {
  /** Ask the endpoint for a live 402. Default true; false to stay offline. */
  probe?: boolean;
  /** Buy from this URL instead of the one the agent published. */
  resource?: string;
  /** Read ENS records from the chain rather than the store. */
  live?: boolean;
  /** Resolver address for a live read of a name the store does not hold. */
  resolver?: string;
  rpcUrl?: string;
  chainId?: number;
  timeoutMs?: number;
  /**
   * The probe to use. Injected in tests so the dead-endpoint path — the one this
   * module most needs to get right — can be exercised without a network and
   * without waiting on a DNS failure.
   */
  probeFn?: typeof probeEndpoint;
}

// --- picking an endpoint ----------------------------------------------------

/**
 * Endpoint roles in the order worth *paying*, best first.
 *
 * An agent that publishes both an `x402` service and a Twitter profile has told
 * us which of the two takes money. Same ordering as
 * `graph/sink/probe-x402.ts::selectProbeCandidates`, so a price this finds is
 * the price that file would have cached.
 */
const ENDPOINT_PRIORITY = ['x402', 'api', 'mcp', 'a2a'];

export function preferredEndpoint(endpoints: readonly OfferAgentEndpoint[]): OfferAgentEndpoint | null {
  const http = endpoints.filter((e) => e.uri && /^https?:\/\//i.test(e.uri));
  if (http.length === 0) return null;
  const rank = (e: OfferAgentEndpoint): number => {
    const i = ENDPOINT_PRIORITY.indexOf((e.name ?? '').toLowerCase());
    return i === -1 ? ENDPOINT_PRIORITY.length : i;
  };
  return [...http].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

// --- reading the store ------------------------------------------------------

interface AgentRow {
  agent_uid: string; chain_id: number; network: string; registry: string; agent_id: string;
  owner: string; operator: string; name: string | null; description: string | null;
  x402_support: number; active: number; document_state: string;
  turnstile_name: string | null; turnstile_mcp_endpoint: string | null;
  turnstile_rails: string | null; turnstile_price: string | null;
  turnstile_price_ceiling: string | null; turnstile_payout_addr: string | null;
  turnstile_resolver_verified: number | null;
  x402_endpoint: string | null; x402_amount: string | null; x402_currency: string | null;
  x402_asset: string | null; x402_network: string | null; x402_probed_at: number | null;
  doc_price_amount: string | null; doc_price_currency: string | null; doc_price_asset: string | null;
  price_source: PriceSource;
}

function loadAgent(db: DatabaseSync, agentUid: string): AgentRow | null {
  return (db.prepare('SELECT * FROM agent_current WHERE agent_uid = ?').get(agentUid) as unknown as AgentRow) ?? null;
}

function loadEndpoints(db: DatabaseSync, agentUid: string): OfferAgentEndpoint[] {
  return (db.prepare('SELECT name, uri FROM agent_endpoint WHERE agent_uid = ? ORDER BY idx')
    .all(agentUid) as unknown as OfferAgentEndpoint[]);
}

function loadCapabilities(db: DatabaseSync, agentUid: string): string[] {
  return (db.prepare('SELECT capability FROM agent_capability WHERE agent_uid = ? ORDER BY capability')
    .all(agentUid) as unknown as { capability: string }[]).map((r) => r.capability);
}

function toOfferAgent(db: DatabaseSync, row: AgentRow): OfferAgent {
  return {
    agentUid: row.agent_uid,
    name: row.name,
    description: row.description,
    network: row.network,
    chainId: row.chain_id,
    registry: row.registry,
    agentId: row.agent_id,
    owner: row.owner,
    payTo: row.operator,
    x402Support: row.x402_support === 1,
    active: row.active === 1,
    documentState: row.document_state,
    capabilities: loadCapabilities(db, row.agent_uid),
    endpoints: loadEndpoints(db, row.agent_uid),
  };
}

interface SellerRow {
  ens_name: string; resolver: string; chain_id: number; agent_uid: string | null;
  agent_context: string | null; mcp_endpoint: string | null; price: string | null;
  price_ceiling: string | null; rails: string | null; operator_proof: string | null;
  payout_addr: string | null; resolver_verified: number; read_at: number;
}

function splitRails(rails: string | null): string[] {
  return rails ? rails.split(',').map((r) => r.trim()).filter(Boolean) : [];
}

function ensFromStore(row: SellerRow): OfferEnsRecords {
  return {
    ensName: row.ens_name,
    resolver: row.resolver,
    chainId: row.chain_id,
    agentContext: row.agent_context,
    mcpEndpoint: row.mcp_endpoint,
    price: row.price,
    priceCeiling: row.price_ceiling,
    rails: splitRails(row.rails),
    operatorProof: row.operator_proof,
    payoutAddr: row.payout_addr,
    resolverVerified: row.resolver_verified === 1,
    readFrom: 'store',
    readAt: row.read_at,
  };
}

function ensFromChain(offer: SellerOffer): OfferEnsRecords {
  return {
    ensName: offer.ensName,
    resolver: offer.resolver,
    chainId: offer.chainId,
    agentContext: offer.agentContext ?? null,
    mcpEndpoint: offer.mcpEndpoint ?? null,
    price: offer.price ?? null,
    priceCeiling: offer.priceCeiling ?? null,
    rails: splitRails(offer.rails ?? null),
    operatorProof: offer.operatorProof ?? null,
    payoutAddr: offer.payoutAddr ?? null,
    resolverVerified: offer.resolverVerified,
    readFrom: 'live',
    readAt: Math.floor(Date.now() / 1000),
  };
}

// --- the resolution ---------------------------------------------------------

const emptyTerms = (): OfferTerms => ({
  resource: null, priceUsd: null, basis: 'unknown', priceRaw: null, currency: null,
  asset: null, network: null, scheme: null, payTo: null, source: 'none',
  comparable: false, quotedAt: null,
});

interface X402Extra { priceUsd?: unknown; usdPerUnit?: unknown; decimals?: unknown; symbol?: unknown }

/**
 * The seller's own dollar figure, out of the raw 402 body.
 *
 * `probeEndpoint` returns the parsed headline fields and the raw body; `extra`
 * is not among the parsed ones because nothing else needed it. It is read here
 * rather than added there because `extra` is by contract opaque to everything
 * except the rail that wrote it — this is a display value, and it is labelled
 * as the seller's arithmetic wherever it surfaces.
 */
export function sellerDeclaredUsd(rawBody: string | undefined, amount: string | undefined): number | null {
  if (!rawBody) return null;
  let extra: X402Extra | undefined;
  try {
    const body = JSON.parse(rawBody) as { accepts?: { extra?: X402Extra }[]; extra?: X402Extra };
    extra = body.accepts?.[0]?.extra ?? body.extra;
  } catch {
    return null;
  }
  if (!extra) return null;
  if (typeof extra.priceUsd === 'number' && Number.isFinite(extra.priceUsd)) return extra.priceUsd;

  const usdPerUnit = Number(extra.usdPerUnit);
  const decimals = Number(extra.decimals);
  const units = Number(amount);
  if (![usdPerUnit, decimals, units].every(Number.isFinite)) return null;
  const usd = (units / 10 ** decimals) * usdPerUnit;
  return Number.isFinite(usd) ? usd : null;
}

/**
 * Resolve one identifier into an offer.
 *
 * The identifier can be an ENS name, an `agentUid` from `find_sellers`, or a
 * bare URL. Nothing about the resolution is specific to a seller: what varies
 * between them is data in the store or bytes on the wire.
 */
export async function getOffer(db: DatabaseSync, ref: string, options: GetOfferOptions = {}): Promise<OfferRecord> {
  const refKind = classifyRef(ref);
  const resolvedVia: string[] = [];
  const warnings: string[] = [];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let agent: OfferAgent | null = null;
  let ens: OfferEnsRecords | null = null;
  let row: AgentRow | null = null;
  let directResource: string | null = null;

  if (refKind === 'url') {
    // Nothing to look up. An agent that already knows where it is buying does
    // not have to be in anyone's directory to buy there.
    directResource = ref.trim();
    resolvedVia.push(`ref is a URL; the directory was not consulted`);
  } else if (refKind === 'agent_uid') {
    row = loadAgent(db, ref.trim());
    if (row) {
      agent = toOfferAgent(db, row);
      resolvedVia.push(`agent_uid found in the discovery store`);
      if (row.turnstile_name) {
        const seller = db.prepare('SELECT * FROM turnstile_seller WHERE ens_name = ?')
          .get(row.turnstile_name) as unknown as SellerRow | undefined;
        if (seller) {
          ens = ensFromStore(seller);
          resolvedVia.push(`agent is linked to the ENS name ${seller.ens_name}; its offer records were read from the store`);
        }
      }
    } else {
      warnings.push(`${ref} is not in the discovery store. Sink the block range that contains it, or pass its endpoint URL directly.`);
    }
  } else if (refKind === 'ens') {
    const name = ref.trim().toLowerCase();
    const seller = db.prepare('SELECT * FROM turnstile_seller WHERE LOWER(ens_name) = ?')
      .get(name) as unknown as SellerRow | undefined;

    if (seller && !options.live) {
      ens = ensFromStore(seller);
      resolvedVia.push(`ENS offer records read from the store (hydrated at ${new Date(seller.read_at * 1000).toISOString()})`);
    } else {
      // Live read. ENSv2 has no universal resolver we can walk from a name
      // alone on this deployment, so the resolver address is data: either the
      // store already knows it, or the caller supplies it. Guessing one and
      // reading text records off it would produce a confident wrong answer.
      const resolver = options.resolver ?? seller?.resolver;
      const rpcUrl = options.rpcUrl ?? process.env['SEPOLIA_RPC_URL'];
      if (!resolver) {
        warnings.push(
          `${name} is not in the discovery store and no resolver address was given. ` +
          'ENSv2 resolution needs the resolver: pass `resolver`, or hydrate the name first ' +
          '(`node graph/sink/hydrate-sellers.ts --sellers <manifest.json>`).',
        );
      } else if (!rpcUrl) {
        warnings.push(`a live ENS read needs an RPC endpoint: pass rpcUrl or set SEPOLIA_RPC_URL.`);
      } else {
        try {
          const live = await readSellerOffer(makePublicClient(rpcUrl), {
            ensName: name,
            resolver: resolver as `0x${string}`,
            chainId: options.chainId ?? seller?.chain_id ?? 11155111,
          });
          ens = ensFromChain(live);
          resolvedVia.push(`ENS offer records read live from resolver ${resolver} at block ${live.readAtBlock}`);
        } catch (cause) {
          warnings.push(`live ENS read failed: ${cause instanceof Error ? cause.message : String(cause)}`);
          if (seller) {
            ens = ensFromStore(seller);
            resolvedVia.push('fell back to the store copy of the ENS records');
          }
        }
      }
    }

    if (ens && !row) {
      const uid = seller?.agent_uid ?? null;
      if (uid) {
        row = loadAgent(db, uid);
        if (row) {
          agent = toOfferAgent(db, row);
          resolvedVia.push(`the name's ENSIP-25 record links it to ${uid}, which is in the store`);
        }
      } else {
        warnings.push(
          `${name} publishes offer records but is not linked to an ERC-8004 registration in the store. ` +
          'A name can claim any agent id; the link is only written when the registry names the name back.',
        );
      }
    }
  } else {
    warnings.push(
      `'${ref}' is not an ENS name, an agentUid (eip155:<chain>:<registry>/<id>) or an http(s) URL.`,
    );
  }

  // --- where would we buy? --------------------------------------------------

  let resource: string | null = null;
  // Provenance, not the address, decides whether a private host may be probed.
  // A URL the caller typed is trusted the way a command-line argument is; a URL
  // read out of a stranger's on-chain registration is not, and following one of
  // those to `http://169.254.169.254/` would be an SSRF with extra steps.
  let callerSupplied = false;
  if (options.resource) {
    resource = options.resource;
    callerSupplied = true;
    resolvedVia.push('resource URL supplied by the caller, overriding anything published');
  } else if (directResource) {
    resource = directResource;
    callerSupplied = true;
  } else if (ens?.mcpEndpoint) {
    resource = ens.mcpEndpoint;
    resolvedVia.push(`resource taken from the ENSIP-26 agent-endpoint[mcp] record`);
  } else if (agent) {
    const chosen = preferredEndpoint(agent.endpoints);
    if (chosen?.uri) {
      resource = chosen.uri;
      resolvedVia.push(`resource taken from the agent's '${chosen.name ?? 'unnamed'}' endpoint in its registration document`);
    }
  }

  // --- what does it cost? ---------------------------------------------------

  const terms = emptyTerms();
  terms.resource = resource;
  let published: PublishedTerms | null = null;

  if (ens?.price) {
    const { usd, note } = normalizePriceUsd(ens.price, 'usd', 'turnstile');
    const ceiling = ens.priceCeiling === null ? null : Number(ens.priceCeiling);
    published = {
      priceUsd: usd,
      priceRaw: ens.price,
      currency: 'USD',
      source: 'turnstile',
      basis: 'ens_record',
      ceilingUsd: ceiling !== null && Number.isFinite(ceiling) ? ceiling : null,
      payTo: ens.payoutAddr,
    };
    if (note) terms.note = note;
  } else if (row?.doc_price_amount) {
    const { usd, note } = normalizePriceUsd(row.doc_price_amount, row.doc_price_currency, 'document');
    published = {
      priceUsd: usd, priceRaw: row.doc_price_amount, currency: row.doc_price_currency,
      source: 'document', basis: 'document', ceilingUsd: null, payTo: null,
    };
    if (note) terms.note = note;
  } else if (row?.x402_amount) {
    // A cached quote: a price that WAS true. Kept as published rather than as
    // the offer, because nothing can be paid against a stale 402.
    const { usd, note } = normalizePriceUsd(row.x402_amount, row.x402_currency, 'x402');
    published = {
      priceUsd: usd, priceRaw: row.x402_amount, currency: row.x402_currency,
      source: 'x402',
      basis: usd === null ? 'unknown' : 'stablecoin_unit',
      ceilingUsd: null, payTo: null,
    };
    terms.quotedAt = row.x402_probed_at;
    if (note) terms.note = note;
  }

  if (published) {
    terms.priceUsd = published.priceUsd;
    terms.priceRaw = published.priceRaw;
    terms.currency = published.currency;
    terms.basis = published.basis;
    terms.source = published.source;
    terms.payTo = published.payTo;
    terms.comparable = published.priceUsd !== null;
    terms.asset = row?.doc_price_asset ?? row?.x402_asset ?? null;
    terms.network = row?.x402_network ?? null;
  } else if (row?.x402_support === 1) {
    terms.source = 'ask_x402';
  }

  // --- ask the endpoint, which is the only price `purchase` can act on ------

  let probe: (ProbeResult & { url: string }) | null = null;
  if (resource && options.probe !== false) {
    const result = await (options.probeFn ?? probeEndpoint)(resource, timeoutMs, { allowPrivateHosts: callerSupplied });
    probe = { ...result, url: resource };
    resolvedVia.push(`probed ${resource} for a live 402: ${result.status}`);
    if (result.status === 'quoted' && result.amount) {
      // A live quote supersedes a published price, including our own. The
      // published one says what a seller intends to charge; this one is what it
      // will actually take, and it is the number a payment is signed against.
      // `published` above is left intact so both are visible.
      const { usd, note } = normalizePriceUsd(result.amount, result.currency, 'x402');
      const declared = usd === null ? sellerDeclaredUsd(result.raw, result.amount) : null;

      terms.priceRaw = result.amount;
      terms.priceUsd = usd ?? declared;
      terms.basis = usd !== null ? 'stablecoin_unit' : declared !== null ? 'seller_declared' : 'unknown';
      terms.comparable = usd !== null;
      terms.currency = result.currency ?? null;
      terms.asset = result.asset ?? null;
      terms.network = result.network ?? null;
      terms.scheme = result.scheme ?? null;
      terms.payTo = result.payTo ?? null;
      terms.source = 'x402_live';
      terms.quotedAt = Math.floor(Date.now() / 1000);
      // Both halves matter: `note` says why the amount could not be converted
      // independently, and the second sentence says where the dollar figure in
      // `priceUsd` actually came from. Dropping either leaves a caller with a
      // number and no idea how much to trust it.
      const declaredNote = terms.basis === 'seller_declared'
        ? `$${declared} is the SELLER's own conversion of ${result.amount} — informative, not ` +
          "checkable. purchase re-prices this with the buyer's own rate before the mandate sees it."
        : undefined;
      terms.note = [note, declaredNote].filter(Boolean).join(' ') || undefined;

      if (published?.priceUsd != null && terms.priceUsd != null && Math.abs(published.priceUsd - terms.priceUsd) > 1e-9) {
        warnings.push(
          `the published price ($${published.priceUsd}) and the live quote ($${terms.priceUsd}) disagree. ` +
          'The live quote is what a payment would be signed against.',
        );
      }
      if (published?.ceilingUsd != null && terms.priceUsd != null && terms.priceUsd > published.ceilingUsd) {
        warnings.push(
          `the live quote ($${terms.priceUsd}) is above the cold-key price ceiling of ` +
          `$${published.ceilingUsd} published on ${ens?.ensName ?? 'the name'}. The seller is charging ` +
          'more than its own name says it may.',
        );
      }
    }
  }

  // --- can this be bought right now? ---------------------------------------

  let purchasable: OfferRecord['purchasable'];
  if (!resource) {
    purchasable = {
      ok: false,
      reason: 'no resource URL: neither the registration document nor an ENS record names an endpoint to buy from. ' +
        'Pass `resource` if you know one.',
    };
  } else if (options.probe === false) {
    purchasable = { ok: false, reason: 'probing was disabled, so no live quote exists. Only a live 402 can be paid.' };
  } else if (probe?.status === 'quoted') {
    purchasable = { ok: true, reason: `${resource} answered 402 with a payable quote` };
  } else {
    const detail = probe?.error ?? probe?.status ?? 'not probed';
    purchasable = {
      ok: false,
      reason: `${resource} did not return a payable 402 (${detail}). ` +
        (published
          ? 'A published price is not a quote: nothing can be paid until the endpoint answers.'
          : 'No price is knowable for this agent.'),
    };
    if (published?.source === 'turnstile') {
      warnings.push(
        `this agent publishes an exact price on chain but the endpoint it names does not answer. ` +
        'The record is real; the service behind it is not reachable from here.',
      );
    }
  }

  return { ref, refKind, resolvedVia, agent, ens, offer: terms, published, probe, purchasable, warnings };
}
