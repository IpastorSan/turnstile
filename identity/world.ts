// The World ID side: sign a request context, verify a proof.
//
// Two halves, and the split matters. `signRpContext` proves to World that a
// proof request came from us, and needs the signing key — so it is server-only,
// and `@worldcoin/idkit-core/signing` enforces that itself by throwing outside
// Node. `verifyProof` checks a returned proof with the Developer Portal, and
// must also be server-side: a client-side "verification" is a client telling
// itself it passed.
//
// The nullifier is the only part we keep. It is a per-app, per-action
// pseudonym: the same human verifying twice yields the same nullifier, and the
// same human on a different app yields a different one. That is exactly enough
// to count listings per person and not enough to identify anyone.

import { hashSignal } from '@worldcoin/idkit-core/hashing';
import { signRequest } from '@worldcoin/idkit-core/signing';

/** Where the Developer Portal verifies proofs. Versioned; `rp_id` is a path segment. */
const VERIFY_BASE = 'https://developer.world.org/api/v4/verify';

/**
 * The action a proof is bound to.
 *
 * Nullifiers are scoped to (app, action), so this string is load-bearing: change
 * it and every existing verification stops matching, silently, because the same
 * human now hashes to a different nullifier. It is pinned here rather than
 * passed in for that reason.
 */
export const OPERATOR_ACTION = 'turnstile-operator';

/**
 * Created 2026-09-09 on app `app_8094ddfd…`:
 * `action_510dae3cb03dd2094ac5e41faba08e49`, status active, external nullifier
 * `0x00d1368f3b2613054e3774de9690d9b39f50614e97649a593fc2bd00492f6fe3`.
 *
 * **`max_verifications` is 0 — unlimited — and that is deliberate.** The portal
 * defaults it to 1, which makes World refuse a person's SECOND verification. The
 * limit a judge would then see is World's, not ours. Turnstile's control is that
 * one human may hold three listings and is refused the fourth, by us, with a
 * reason. World proves personhood; Turnstile sets policy. Changing this to 1
 * silently moves that boundary and voids the claim.
 */

export interface WorldConfig {
  appId: string;
  rpId: string;
  signingKeyHex: string;
}

export interface RpContext {
  rp_id: string;
  nonce: string;
  created_at: number;
  expires_at: number;
  signature: string;
}

export interface VerifiedProof {
  nullifier: string;
  /** Whatever the portal returned, kept for the audit trail. */
  raw: unknown;
}

export type VerifyOutcome =
  | { ok: true; proof: VerifiedProof }
  | { ok: false; status: number; reason: string; raw?: unknown };

/** Read the World credentials, naming what is missing and where it comes from. */
export function worldConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WorldConfig {
  const appId = env['WORLD_APP_ID'];
  const rpId = env['WORLD_RP_ID'];
  const signingKeyHex = env['WORLD_RP_SIGNING_KEY'];
  if (!appId) throw new Error('set WORLD_APP_ID (Developer Portal → your app, `app_…`)');
  if (!rpId) throw new Error('set WORLD_RP_ID (Developer Portal → your app, `rp_…`). It is a path segment on the verify URL, not a header');
  if (!signingKeyHex) throw new Error('set WORLD_RP_SIGNING_KEY (Developer Portal → your app → signing key). Backend only; it must never reach a browser');
  return { appId, rpId, signingKeyHex };
}

export function worldIsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env['WORLD_APP_ID'] && env['WORLD_RP_ID'] && env['WORLD_RP_SIGNING_KEY']);
}

/**
 * Sign a request context for the client to hand to IDKit.
 *
 * **The field names change shape here and it is silent when wrong.**
 * `signRequest` returns `sig` / `createdAt` / `expiresAt`; the `RpContext` the
 * widget consumes wants `signature` / `created_at` / `expires_at`. Passing the
 * returned object through unmapped produces a context that looks populated and
 * is rejected, so the mapping is written out rather than spread.
 */
export function signRpContext(config: WorldConfig, action: string = OPERATOR_ACTION): RpContext {
  const signed = signRequest({ signingKeyHex: config.signingKeyHex, action });
  return {
    rp_id: config.rpId,
    nonce: signed.nonce,
    created_at: signed.createdAt,
    expires_at: signed.expiresAt,
    signature: signed.sig,
  };
}

/** Pull the nullifier out of whatever shape the portal returns. */
export function nullifierFrom(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  for (const key of ['nullifier_hash', 'nullifier', 'nullifierHash']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  // The portal has nested the proof under different keys across versions, so
  // look one level down rather than failing on a shape change.
  for (const nested of ['result', 'proof', 'verification']) {
    const inner = record[nested];
    if (inner && typeof inner === 'object') {
      const found = nullifierFrom(inner);
      if (found) return found;
    }
  }
  return null;
}

export type SignalCheck =
  | { ok: true; checked: boolean }
  | { ok: false; reason: string };

/**
 * Is this proof bound to `signal`, the exact string the client handed to
 * `selfieCheckLegacy({ signal })`?
 *
 * The portal checks the proof against the `signal_hash` inside the payload, so
 * it will happily verify a proof made for a different listing. This compares
 * that hash with `hashSignal(signal)` before we store anything under the
 * listing the request names. Every `signal_hash` present must match.
 *
 * A payload with no `signal_hash` at all is let through as `checked: false`
 * rather than refused. IDKit documents the field as optional, and the only
 * real proof we have (2026-09-11) was not captured, so we cannot show that
 * World App always sends it. Refusing on absence could break the one working
 * path with no phone on hand to test the fix. Unchecked costs little here: the
 * nullifier is the same for every listing a human verifies under this action,
 * so a replayed proof can only spend its own human's allowance.
 */
export function checkSignal(idkitResult: unknown, signal: string): SignalCheck {
  const responses = (idkitResult as { responses?: unknown } | null)?.responses;
  const hashes = Array.isArray(responses)
    ? responses
        .map(item => (item as { signal_hash?: unknown } | null)?.signal_hash)
        .filter((hash): hash is string => typeof hash === 'string' && hash.length > 0)
    : [];
  if (hashes.length === 0) return { ok: true, checked: false };

  const expected = hashSignal(signal).toLowerCase();
  const mismatch = hashes.find(hash => hash.toLowerCase() !== expected);
  if (mismatch) {
    return { ok: false, reason: `the proof was made for a different listing than "${signal}" (signal hash does not match)` };
  }
  return { ok: true, checked: true };
}

/**
 * Verify a proof with the Developer Portal.
 *
 * The IDKit result is forwarded **as-is**. World's docs are explicit that fields
 * must not be remapped, and remapping is the obvious thing to do when a payload
 * looks untidy — so it is called out here rather than left to a future edit.
 */
export async function verifyProof(
  config: WorldConfig,
  idkitResult: unknown,
  options: { fetch?: typeof globalThis.fetch } = {},
): Promise<VerifyOutcome> {
  const doFetch = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await doFetch(`${VERIFY_BASE}/${encodeURIComponent(config.rpId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(idkitResult),
    });
  } catch (error) {
    return { ok: false, status: 0, reason: `could not reach the Developer Portal: ${(error as Error).message}` };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A non-JSON body on a failure is still worth reporting as a failure.
  }

  if (!response.ok) {
    const detail =
      (body as { detail?: string; code?: string } | null)?.detail ??
      (body as { code?: string } | null)?.code ??
      response.statusText;
    return { ok: false, status: response.status, reason: detail || `verification failed with ${response.status}`, raw: body };
  }

  const nullifier = nullifierFrom(body) ?? nullifierFrom(idkitResult);
  if (!nullifier) {
    // Treated as a failure on purpose. Without a nullifier there is nothing to
    // count listings against, so a "success" here would let one human verify
    // repeatedly and hold unlimited listings.
    return { ok: false, status: response.status, reason: 'the portal accepted the proof but returned no nullifier, so it cannot be counted against a person', raw: body };
  }

  return { ok: true, proof: { nullifier, raw: body } };
}
