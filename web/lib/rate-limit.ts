// A per-IP sliding-window rate limit for the routes that spend our money.
//
// Why this exists: `/api/org/create` creates Privy users, quorums, a policy and
// a wallet under OUR Privy app. It has been public and unlimited since the
// deploy, which makes it a free Privy account farm for anyone who finds it.
// `/api/mandate/raise-cap` and the two `/api/world/*` routes are the same
// problem in smaller print — each hits an external API with our credentials.
//
// In-process state, deliberately. The whole stack is one web container behind
// one Caddy (deploy/compose.yaml), so there is exactly one counter to agree on,
// and adding Redis would be a new service, a new secret and a new way to fail —
// on the day of a demo, for a control that only has to survive a hackathon.
// If the web service is ever scaled past one container, this becomes wrong in a
// way that is invisible: the limit just multiplies by the container count. The
// check lives in `trustedIp` below, which is the same caveat: spoofing an IP
// costs nothing unless the edge rewrites it.
//
// The counters are in module scope, which is the Next.js production server
// process — `next build` emits one bundle and `node web/server.js` runs one
// instance (web/Dockerfile). Dev's module hot-reload resets them on edit; a
// reset here fails OPEN, which is the correct direction for a demo.

import type { NextRequest } from 'next/server';

/** Requests allowed per window, per IP, per route. */
const WINDOW_MS = 60_000;
const DEFAULT_LIMIT = 5;

/** org/create is the expensive one: 4 Privy writes per call, 5 per minute already lets a real buyer through twice. */
const ORG_CREATE_LIMIT = 3;

interface Bucket {
  /** Epoch-ms of each accepted request inside the window. */
  hits: number[];
}

const buckets = new Map<string, Bucket>();

/**
 * The client IP, as far as we can trust it.
 *
 * Caddy is the only thing in front of the app, and `autoconfig` does not
 * rewrite X-Forwarded-For the way a CDN does — but Next's `request.ip` is
 * undefined in a node server, so the header is what there is. NOTE: behind a
 * reverse proxy that does not append (rather than pass through), a caller can
 * forge this header and get an uncounted bucket. That trades against the
 * alternative of counting every visitor as the proxy, which rate-limits the
 * whole internet as one person. Ship the forgable version; it still stops the
 * drive-by script that finds the endpoint by grepping the JS bundle.
 */
function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() || 'unknown';
  return request.headers.get('x-real-ip') ?? 'unknown';
}

/**
 * Returns null when allowed, or the number of seconds to wait when not.
 * Accepts and records the hit in one step — a check-then-record pair across an
 * await is where a race lets two concurrent requests both through.
 */
export function take(name: string, ip: string, limit = DEFAULT_LIMIT): number | null {
  const now = Date.now();
  const key = `${name}|${ip}`;
  const bucket = buckets.get(key) ?? { hits: [] };
  bucket.hits = bucket.hits.filter(t => now - t < WINDOW_MS);
  if (bucket.hits.length >= limit) {
    const retryMs = WINDOW_MS - (now - bucket.hits[0]!);
    buckets.set(key, bucket);
    return Math.ceil(retryMs / 1000);
  }
  bucket.hits.push(now);
  buckets.set(key, bucket);
  return null;
}

/**
 * Guard a route POST. Call it before any parsing, before any upstream fetch —
 * the whole point is that a throttled request costs zero.
 */
export function rateLimit(request: NextRequest, name: string, limit = DEFAULT_LIMIT): Response | null {
  const retryAfter = take(name, clientIp(request), limit);
  if (retryAfter === null) return null;
  return Response.json(
    { ok: false, reason: 'rate limit reached for this endpoint — try again later' },
    { status: 429, headers: { 'retry-after': String(retryAfter) } },
  );
}

export const ORG_CREATE = { name: 'org-create', limit: ORG_CREATE_LIMIT } as const;
export const RAISE_CAP = { name: 'raise-cap', limit: 2 } as const;
export const WORLD_CONTEXT = { name: 'world-context', limit: 6 } as const;
export const WORLD_VERIFY = { name: 'world-verify', limit: 6 } as const;

/** Test seam. Production never calls this; the window is short enough already. */
export function resetRateLimits(): void {
  buckets.clear();
}
