// Operator authorization keys — the P-256 keypairs that make a Privy key quorum
// mean something.
//
// A Privy resource (a wallet, a policy) can name an **owner**. Once it has one,
// Privy's server refuses to mutate it unless the request carries enough
// `privy-authorization-signature` headers to satisfy that owner's quorum
// threshold. The signature is over the request itself, so it cannot be replayed
// against a different body or a different URL.
//
// That is the whole reason the quorum is not theatre: **the check runs on
// Privy's side, not ours.** Deleting our approval code does not raise the
// mandate cap; the PATCH still comes back 401 with one signature short. This is
// `CLAUDE.md`'s invariant — the key that spends can never raise its own limit —
// held up by something outside this repo.
//
// ## Three encodings, and mixing them up is the first hour you lose
//
// | Where | Encoding |
// |---|---|
// | `key_quorums.public_keys[]` | base64 **SPKI DER** — the body of a PEM public key, no armour |
// | Privy's own dashboard export | base64 **PKCS#8 DER** with a literal `wallet-auth:` prefix |
// | `privy-authorization-signature` | base64 of the **DER-encoded** ECDSA signature (not raw r‖s) |
//
// Node's `crypto.sign('sha256', …)` on a P-256 key already emits DER, so the
// third is free. The first two are what {@link loadAuthorizationKey} normalises.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as ecdsaSign } from 'node:crypto';

/**
 * One operator's authorization keypair.
 *
 * Both halves are base64 DER with no PEM armour and no `wallet-auth:` prefix,
 * because those are the two forms Privy's API actually accepts.
 */
export interface AuthorizationKey {
  /** base64 PKCS#8 DER. The secret. Never logged, never committed. */
  privateKey: string;
  /** base64 SPKI DER. What `key_quorums.public_keys[]` wants. */
  publicKey: string;
}

/** Generate a fresh P-256 (secp256r1) authorization keypair. */
export function generateAuthorizationKey(): AuthorizationKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });
  return { privateKey: privateKey.toString('base64'), publicKey: publicKey.toString('base64') };
}

/**
 * Read a private key in any of the shapes it arrives in, and derive its public
 * half.
 *
 * Accepts a bare base64 PKCS#8 blob, the same blob with Privy's `wallet-auth:`
 * prefix, or a full PEM. Deriving the public key rather than storing it means an
 * operator's `.env` holds one secret instead of a pair that can drift apart.
 */
export function loadAuthorizationKey(secret: string): AuthorizationKey {
  const trimmed = secret.trim();
  const base64 = trimmed.startsWith('wallet-auth:') ? trimmed.slice('wallet-auth:'.length) : trimmed;

  const key = base64.includes('-----BEGIN')
    ? createPrivateKey({ key: base64, format: 'pem' })
    : createPrivateKey({ key: pem(base64, 'PRIVATE KEY'), format: 'pem' });

  const asn1 = key.export({ type: 'pkcs8', format: 'der' }) as Buffer;
  const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' }) as Buffer;
  return { privateKey: asn1.toString('base64'), publicKey: publicKey.toString('base64') };
}

function pem(base64: string, label: string): string {
  const body = base64.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n').trimEnd();
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
}

/**
 * The object Privy signs: the request, reduced to the five things that identify
 * it.
 *
 * `headers` carries only the `privy-` prefixed ones, so a proxy adding a
 * `user-agent` does not invalidate a signature.
 */
export interface AuthorizationPayload {
  version: 1;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Full URL, no trailing slash. */
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

/**
 * RFC 8785 JSON Canonicalization Scheme, for the shapes Privy payloads actually
 * contain.
 *
 * Written out rather than pulled from npm because it is twenty lines and it is
 * on the security path: a canonicalizer that disagrees with Privy's by one
 * character produces a signature that verifies against nothing, and a dependency
 * is a worse place to debug that than this file.
 *
 * **Scope, stated rather than implied:** objects, arrays, strings, booleans,
 * `null`, and integers within `Number.MAX_SAFE_INTEGER`. Privy's payloads are
 * exactly that. Non-integer numbers are *rejected* rather than serialized,
 * because RFC 8785 mandates ECMAScript `Number::toString` for them and a
 * half-right implementation would fail silently at signature-check time instead
 * of here. `undefined` members are dropped, as `JSON.stringify` drops them.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new Error(`canonicalize: only safe integers are supported, got ${value}`);
    }
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(v => canonicalize(v === undefined ? null : v)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    // RFC 8785 sorts by UTF-16 code unit, which is what `<` on JS strings does.
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
  }
  throw new Error(`canonicalize: unsupported value of type ${typeof value}`);
}

/**
 * Sign a request payload with one operator's key.
 *
 * Returns the base64 of a DER ECDSA signature — one element of the
 * comma-separated `privy-authorization-signature` header.
 */
export function signAuthorizationPayload(privateKeyBase64: string, payload: AuthorizationPayload): string {
  const key = createPrivateKey({ key: pem(privateKeyBase64, 'PRIVATE KEY'), format: 'pem' });
  return ecdsaSign('sha256', Buffer.from(canonicalize(payload), 'utf8'), key).toString('base64');
}
