// Payment gateways that sit in front of this service and settle on its behalf.
//
// A Bazantic agent gateway is a reverse proxy with its own paywall: it answers
// the caller's request with its own x402/MPP challenge, takes the payment, and
// forwards the call here. It never pays a second, upstream 402 (verified
// 2026-09-11: the forwarded request carries no payment header of any scheme,
// and the gateway's auth options are API key, basic, or none). Its payout to us
// is routed on Bazantic's side, to the receiving address on the listing.
//
// So a gateway call must be let through without a 402, and nothing else may be.
// The gateway proves who it is with a shared secret in one header, configured
// as an "extra header" on the listing. Whoever holds the secret gets the
// answer unpaid here, which is exactly the trust we extend to the gateway and
// no one else.
//
// Configured as TURNSTILE_GATEWAY_KEYS="bazantic=<secret>[,other=<secret>]".
// Unset means no gateway is trusted and every call is challenged, as before.

import { createHash, timingSafeEqual } from 'node:crypto';

export const GATEWAY_KEY_HEADER = 'x-turnstile-gateway-key';

/** Below this a key is guessable enough to be a free pass. 32 chars of hex is 128 bits. */
const MIN_KEY_LENGTH = 32;

export interface GatewayTrust {
  /** The name of the gateway this key belongs to, or null if it belongs to none. */
  identify(key: string | undefined): string | null;
  readonly names: readonly string[];
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * @param spec - `name=secret` pairs, comma-separated
 * @throws on a malformed pair or a key too short to be a secret, so a typo in
 *   the environment stops the seller instead of opening it
 */
export function parseGatewayKeys(spec: string | undefined): GatewayTrust {
  const entries: { name: string; key: Buffer }[] = [];
  for (const raw of (spec ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    const eq = raw.indexOf('=');
    const name = eq > 0 ? raw.slice(0, eq).trim() : '';
    const secret = eq > 0 ? raw.slice(eq + 1).trim() : '';
    if (!name || !secret) {
      throw new Error(`TURNSTILE_GATEWAY_KEYS: expected name=secret, got '${raw.slice(0, eq > 0 ? eq : 8)}…'`);
    }
    if (secret.length < MIN_KEY_LENGTH) {
      throw new Error(`TURNSTILE_GATEWAY_KEYS: the key for '${name}' is shorter than ${MIN_KEY_LENGTH} characters`);
    }
    entries.push({ name, key: digest(secret) });
  }

  return {
    names: entries.map(e => e.name),
    identify(key) {
      if (!key || entries.length === 0) return null;
      // Compare digests, so every comparison is the same length and constant time.
      const presented = digest(key);
      let match: string | null = null;
      for (const entry of entries) {
        if (timingSafeEqual(presented, entry.key)) match = entry.name;
      }
      return match;
    },
  };
}

export const NO_GATEWAYS: GatewayTrust = parseGatewayKeys(undefined);
