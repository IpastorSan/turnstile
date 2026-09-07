// The Privy REST client, and nothing else.
//
// Privy publishes a Node SDK. This is a hand-rolled client over `fetch` instead,
// for one reason worth stating rather than apologising for: the interesting part
// of this integration is the **authorization signature**, and an SDK that
// computes it for you is an SDK that hides the thing a reviewer needs to see.
// `buyer/org/authorization-key.ts` computes it in twenty readable lines, and
// this file shows exactly where it goes on the wire. It is also one fewer
// dependency on the payment path.
//
// Two authentications stack here and they are not alternatives:
//
//   1. **HTTP basic auth** with `app_id:app_secret`. Proves *which app* is
//      calling. Every request carries it.
//   2. **`privy-authorization-signature`**, one per approving operator. Proves
//      *who authorized this specific request*. Only requests that mutate an
//      owned resource carry it.
//
// The app secret alone cannot raise the mandate cap. That is the point: our
// server is compromised and the cap still holds, because Privy's enclave wants
// signatures from keys our server never sees. See `buyer/mandate/README.md`.

import { signAuthorizationPayload, type AuthorizationKey, type AuthorizationPayload } from './authorization-key.ts';

export const PRIVY_API_BASE = 'https://api.privy.io';

export interface PrivyCredentials {
  appId: string;
  appSecret: string;
  /** Override for tests. Defaults to {@link PRIVY_API_BASE}. */
  baseUrl?: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Read `PRIVY_APP_ID` / `PRIVY_APP_SECRET` out of the environment, or say
 * clearly which one is missing.
 */
export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): PrivyCredentials {
  const appId = env['PRIVY_APP_ID'];
  const appSecret = env['PRIVY_APP_SECRET'];
  if (!appId) throw new Error('set PRIVY_APP_ID (Privy dashboard → app settings)');
  if (!appSecret) throw new Error('set PRIVY_APP_SECRET (Privy dashboard → app settings). Never commit it');
  return { appId, appSecret };
}

export class PrivyError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(method: string, path: string, status: number, body: unknown) {
    const detail = typeof body === 'object' && body !== null ? JSON.stringify(body) : String(body);
    super(`Privy ${method} ${path} → ${status}: ${detail}`);
    this.name = 'PrivyError';
    this.status = status;
    this.body = body;
  }

  /**
   * Did this fail because the request was one approval short?
   *
   * The refusal we *want* in the quorum demo, as distinct from a typo in a
   * policy id. Privy answers 401 for a missing or insufficient authorization
   * signature.
   */
  get isMissingApproval(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface RequestOptions {
  /**
   * Operator keys approving this request, one signature each.
   *
   * Order does not matter to Privy, but it does to a reader, so callers pass
   * them proposer-first.
   */
  approvals?: readonly AuthorizationKey[];
  /** Privy deduplicates identical requests carrying the same key for 24h. */
  idempotencyKey?: string;
}

/**
 * A thin, honest client. One method per HTTP verb, and `request` doing the work.
 */
export class PrivyClient {
  readonly appId: string;
  readonly #appSecret: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(credentials: PrivyCredentials) {
    this.appId = credentials.appId;
    this.#appSecret = credentials.appSecret;
    this.#baseUrl = (credentials.baseUrl ?? PRIVY_API_BASE).replace(/\/+$/, '');
    this.#fetch = credentials.fetch ?? globalThis.fetch;
  }

  async request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    const url = `${this.#baseUrl}${path}`;

    const privyHeaders: Record<string, string> = { 'privy-app-id': this.appId };
    if (options.idempotencyKey) privyHeaders['privy-idempotency-key'] = options.idempotencyKey;

    const headers: Record<string, string> = {
      ...privyHeaders,
      authorization: `Basic ${Buffer.from(`${this.appId}:${this.#appSecret}`).toString('base64')}`,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';

    const approvals = options.approvals ?? [];
    if (approvals.length > 0) {
      if (method === 'GET') throw new Error('a GET is not signed — Privy only checks authorization signatures on mutations');
      // The signed payload must mirror the request byte for byte on Privy's
      // side: same URL (no trailing slash), same body object, and *only* the
      // `privy-` headers. Anything else here silently breaks every signature.
      const payload: AuthorizationPayload = {
        version: 1,
        method,
        url,
        body: body ?? {},
        headers: privyHeaders,
      };
      headers['privy-authorization-signature'] = approvals
        .map(key => signAuthorizationPayload(key.privateKey, payload))
        .join(',');
    }

    const response = await this.#fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }

    if (!response.ok) throw new PrivyError(method, path, response.status, parsed);
    return parsed as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, body, options);
  }
  patch<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('PATCH', path, body, options);
  }
}
