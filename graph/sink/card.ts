// Registration-document parsing and off-module fetching.
//
// A Substreams module is a deterministic function of the block, so it can
// resolve exactly the documents the chain already carries — `data:` URIs and
// bare-JSON literals — and nothing else. In a survey of 1,200 live
// registrations that left `ipfs` 195, `https` 315 and `http` 94 unresolved:
// roughly 72% of the directory is invisible until someone makes a network
// call. This file is where that call happens.
//
// The parser is deliberately as tolerant as the Rust one, because real
// registrations vary in ways the spec does not sanction. Keeping the two in
// step matters: an agent whose document is read one way in-module and another
// way here would appear to change when nothing changed.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import type { AgentDocument, AgentEndpoint, AgentPrice } from './db.ts';

export const DEFAULT_TIMEOUT_MS = 8_000;
export const MAX_BODY_BYTES = 1_048_576;
export const MAX_REDIRECTS = 3;

/**
 * IPFS gateways, tried in order. Public gateways rate-limit and go down, so a
 * failure on the first is not a failure of the agent.
 */
export const DEFAULT_IPFS_GATEWAYS = [
  'https://ipfs.io/ipfs/',
  'https://dweb.link/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
];

export type FetchStatus =
  | 'resolved'
  | 'http_error'
  | 'timeout'
  | 'network_error'
  | 'parse_error'
  | 'unsupported_scheme'
  | 'blocked_host';

export interface FetchOutcome {
  status: FetchStatus;
  source: 'https' | 'http' | 'ipfs' | 'in_module';
  fetchedUrl?: string;
  httpStatus?: number;
  error?: string;
  durationMs: number;
  raw?: string;
  document?: AgentDocument;
}

// --- tolerant document parsing ---------------------------------------------

const asString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

const asBool = (v: unknown): boolean | undefined => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (v.toLowerCase() === 'true') return true;
    if (v.toLowerCase() === 'false') return false;
  }
  return undefined;
};

const asStringArray = (v: unknown): string[] | undefined => {
  if (Array.isArray(v)) {
    const out = v.map(asString).filter((s): s is string => s !== undefined);
    return out.length > 0 ? out : undefined;
  }
  const single = asString(v);
  return single ? [single] : undefined;
};

/** Read the first key that is present. Field names drift; the spec is a hint. */
function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

function parseEndpoint(value: unknown): AgentEndpoint | undefined {
  if (typeof value === 'string') return { uri: value };
  if (typeof value !== 'object' || value === null) return undefined;
  const o = value as Record<string, unknown>;
  // An MCP service lists its `tools`, which are capabilities in every sense
  // that matters here. Its `capabilities` key is NOT: it holds MCP protocol
  // features ("tools", "resources", "prompts"), the same three strings on every
  // MCP endpoint in the directory, so indexing it would put thousands of agents
  // behind a capability nobody would ever search for.
  const endpoint: AgentEndpoint = {
    // The spec calls this `name`; agents also ship `type`, `protocol` and `id`.
    name: asString(pick(o, ['name', 'type', 'protocol', 'id'])),
    // `endpoint` per the spec, but `url`, `serviceEndpoint`, `uri` and `value`
    // all appear in the wild.
    uri: asString(pick(o, ['endpoint', 'url', 'serviceEndpoint', 'uri', 'value', 'address'])),
    version: asString(pick(o, ['version', 'protocolVersion'])),
    skills: [
      ...(asStringArray(pick(o, ['skills', 'skill'])) ?? []),
      ...(asStringArray(o.tools) ?? []),
    ],
    domains: asStringArray(pick(o, ['domains', 'domain', 'categories'])),
  };
  if (endpoint.skills?.length === 0) endpoint.skills = undefined;
  return endpoint.name || endpoint.uri ? endpoint : undefined;
}

function parsePrice(value: unknown): AgentPrice | undefined {
  if (typeof value === 'number' || typeof value === 'string') {
    const amount = asString(String(value));
    return amount ? { amount } : undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const o = value as Record<string, unknown>;
  const raw = pick(o, ['amount', 'maxAmountRequired', 'value', 'price']);
  const price: AgentPrice = {
    amount: raw === undefined ? undefined : asString(String(raw)),
    currency: asString(pick(o, ['currency', 'currencyCode', 'unit'])),
    asset: asString(pick(o, ['asset', 'token', 'tokenAddress'])),
    network: asString(pick(o, ['network', 'chain'])),
    scheme: asString(pick(o, ['scheme'])),
  };
  return price.amount ? price : undefined;
}

/**
 * Parse an ERC-8004 registration document.
 *
 * Returns an empty document rather than throwing on a JSON object that carries
 * none of the fields we know — an agent is allowed to publish something we do
 * not understand, and that is different from a document we could not read.
 */
export function parseAgentDocument(value: unknown): AgentDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const o = value as Record<string, unknown>;

  // Some registries wrap the card, e.g. { "registration": { ... } }.
  const inner = pick(o, ['registration', 'agentCard', 'card']);
  const doc = (typeof inner === 'object' && inner !== null && !Array.isArray(inner))
    ? { ...(inner as Record<string, unknown>), ...o }
    : o;

  const services = pick(doc, ['services', 'endpoints', 'service', 'serviceEndpoints']);
  const endpoints = Array.isArray(services)
    ? services.map(parseEndpoint).filter((e): e is AgentEndpoint => e !== undefined)
    : (() => {
        const single = parseEndpoint(services);
        return single ? [single] : undefined;
      })();

  return {
    name: asString(pick(doc, ['name', 'agentName', 'title'])),
    description: asString(pick(doc, ['description', 'summary', 'about'])),
    image: asString(pick(doc, ['image', 'imageUrl', 'avatar', 'icon'])),
    // `x402Support` per the spec; `x402support` appeared 41 times in 1,200.
    x402Support: asBool(pick(doc, ['x402Support', 'x402support', 'supportsX402'])),
    active: asBool(pick(doc, ['active', 'isActive', 'enabled'])),
    // `supportedTrust` per the spec; `supportedTrusts` appeared 31 times.
    supportedTrust: asStringArray(pick(doc, ['supportedTrust', 'supportedTrusts', 'trustModels'])),
    endpoints: endpoints && endpoints.length > 0 ? endpoints : undefined,
    // Expect this to stay undefined: zero of 1,200 documents carried a price.
    // EIP-8004 registration-v1 has no price field, and under x402 the quote
    // lives in the 402 response, not the registration.
    price: parsePrice(pick(doc, ['price', 'pricing', 'cost'])),
  };
}

// --- fetching ---------------------------------------------------------------

/**
 * Refuse to fetch loopback, link-local and RFC1918 destinations.
 *
 * `agentURI` is attacker-controlled: anyone can register an ERC-8004 agent
 * pointing at `http://169.254.169.254/` or at a service on the sink's own
 * network, and the sink would happily fetch it. This is the one place the
 * discovery pipeline touches arbitrary URLs, so the check belongs here.
 */
export function isBlockedAddress(address: string): boolean {
  if (address === '::1' || address === '0.0.0.0' || address.startsWith('fe80:') || address.startsWith('fc') || address.startsWith('fd')) {
    return true;
  }
  const parts = address.split('.');
  if (parts.length !== 4) return false;
  const [a, b] = parts.map(Number);
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 169 && b === 254) return true;         // cloud metadata
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

export async function isBlockedHost(hostname: string): Promise<boolean> {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    return true;
  }
  if (isIP(host)) return isBlockedAddress(host);
  try {
    const records = await lookup(host, { all: true });
    return records.some((r) => isBlockedAddress(r.address));
  } catch {
    // A name that does not resolve is not a blocked name; let the fetch fail
    // on its own and be recorded as a network error, which is more useful.
    return false;
  }
}

/** `ipfs://<cid>/<path>` -> gateway URLs, in preference order. */
export function ipfsGatewayUrls(uri: string, gateways: string[] = DEFAULT_IPFS_GATEWAYS): string[] {
  const path = uri.replace(/^ipfs:\/\//i, '').replace(/^ipfs\//i, '');
  return gateways.map((g) => g + path);
}

interface FetchJsonOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * GET a URL and read at most `maxBytes` of it as text.
 *
 * Redirects are followed by hand rather than by `fetch`, so the private-address
 * guard runs on every hop. A public URL that 302s to `http://127.0.0.1:8545`
 * would otherwise walk straight through the check.
 */
async function fetchTextGuarded(url: string, opts: FetchJsonOptions): Promise<{
  status: FetchStatus;
  finalUrl: string;
  httpStatus?: number;
  error?: string;
  text?: string;
}> {
  const maxBytes = opts.maxBytes ?? MAX_BODY_BYTES;
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      return { status: 'unsupported_scheme', finalUrl: current, error: 'malformed URL' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { status: 'unsupported_scheme', finalUrl: current, error: `protocol ${parsed.protocol}` };
    }
    if (await isBlockedHost(parsed.hostname)) {
      return { status: 'blocked_host', finalUrl: current, error: `refusing private host ${parsed.hostname}` };
    }

    let response: Response;
    try {
      response = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        headers: { accept: 'application/json, */*' },
      });
    } catch (err) {
      const name = (err as Error).name;
      const status: FetchStatus = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error';
      return { status, finalUrl: current, error: (err as Error).message.slice(0, 300) };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        return { status: 'http_error', finalUrl: current, httpStatus: response.status, error: 'redirect without location' };
      }
      current = new URL(location, current).toString();
      continue;
    }

    if (!response.ok) {
      return { status: 'http_error', finalUrl: current, httpStatus: response.status, error: `HTTP ${response.status}` };
    }

    try {
      const text = await readCapped(response, maxBytes);
      return { status: 'resolved', finalUrl: current, httpStatus: response.status, text };
    } catch (err) {
      const name = (err as Error).name;
      const status: FetchStatus = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error';
      return { status, finalUrl: current, httpStatus: response.status, error: (err as Error).message.slice(0, 300) };
    }
  }

  return { status: 'http_error', finalUrl: current, error: `more than ${MAX_REDIRECTS} redirects` };
}

/**
 * Read a response body up to a byte budget, then stop.
 *
 * `response.text()` on a URL that streams forever is an unbounded read on a
 * pipeline that has thousands of agents to get through. The budget is the
 * difference between one bad agent costing 8 seconds and costing the run.
 */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      chunks.push(value);
      if (total >= maxBytes) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, maxBytes).toString('utf8');
}

/**
 * Fetch and parse one agent's registration document.
 *
 * Every outcome is a returned value, never a throw. A 404 and a timeout are
 * facts about the directory worth storing: they are the difference between
 * "this agent advertises nothing" and "we could not ask".
 */
export async function fetchAgentCard(
  agentUri: string,
  uriScheme: string,
  opts: FetchJsonOptions & { ipfsGateways?: string[] } = {},
): Promise<FetchOutcome> {
  const started = Date.now();
  const done = (partial: Omit<FetchOutcome, 'durationMs'>): FetchOutcome =>
    ({ ...partial, durationMs: Date.now() - started });

  const scheme = uriScheme.toUpperCase();
  const candidates =
    scheme === 'IPFS' ? ipfsGatewayUrls(agentUri, opts.ipfsGateways)
    : scheme === 'HTTPS' || scheme === 'HTTP' ? [agentUri]
    : [];
  const source = scheme === 'IPFS' ? 'ipfs' : scheme === 'HTTP' ? 'http' : 'https';

  if (candidates.length === 0) {
    return done({ status: 'unsupported_scheme', source, error: `cannot fetch ${scheme}` });
  }

  let last: FetchOutcome | undefined;
  for (const url of candidates) {
    const result = await fetchTextGuarded(url, opts);
    if (result.status !== 'resolved') {
      last = done({
        status: result.status,
        source,
        fetchedUrl: result.finalUrl,
        httpStatus: result.httpStatus,
        error: result.error,
      });
      continue; // next IPFS gateway, if there is one
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.text ?? '');
    } catch (err) {
      return done({
        status: 'parse_error',
        source,
        fetchedUrl: result.finalUrl,
        httpStatus: result.httpStatus,
        error: (err as Error).message.slice(0, 200),
        raw: (result.text ?? '').slice(0, 2000),
      });
    }

    return done({
      status: 'resolved',
      source,
      fetchedUrl: result.finalUrl,
      httpStatus: result.httpStatus,
      raw: result.text,
      document: parseAgentDocument(parsed),
    });
  }

  return last ?? done({ status: 'network_error', source, error: 'no candidate URL succeeded' });
}
