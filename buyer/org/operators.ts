// The humans, and the two quorums they form.
//
// A buyer organization is not one key. It is a handful of people with different
// authority, and the thing that makes Turnstile's warm tier a *treasury* rather
// than a second hot wallet is that those differences are enforced by something
// other than our own code.
//
// ## Two quorums, and why it is two and not one
//
// | Quorum | Threshold | Owns | So this needs |
// |---|---|---|---|
// | **operations** | 1 of N | the org wallet | any one operator, for a routine treasury op |
// | **board** | 2 of N | the mandate policy | two operators, to widen what the agent may spend |
//
// One quorum cannot express that. If the wallet needed 2-of-N, funding the agent
// would need a meeting; if the policy needed 1-of-N, a single compromised
// operator key could raise the cap and then spend against it, which is exactly
// the failure `CLAUDE.md` says the whole design exists to prevent:
//
// > **the key that spends can never raise its own limit.**
//
// Splitting them gives the ordinary operation one signature and the *change to
// the rules* two. That asymmetry is the entire B2B control, and it is why the
// wallet's owner and the policy's owner are deliberately different objects.
//
// ## Where the keys actually live
//
// Each operator holds a P-256 authorization key. In this repo they are generated
// by `scripts/privy-org-setup.ts` and pasted into `.env`, which is honest for a
// hackathon and **wrong for production** — there, each key belongs on its
// operator's own device or HSM, and the server holding the Privy app secret
// should never be able to read one. The design does not change: Privy verifies
// signatures against registered public keys and does not care where the private
// half slept.

import { generateAuthorizationKey, loadAuthorizationKey, type AuthorizationKey } from './authorization-key.ts';
import type { PrivyClient } from './privy.ts';

/** A human operator of the buyer organization. */
export interface Operator {
  /** Short handle used in env var names and logs — `alice`, `bob`. */
  handle: string;
  /** What this person is allowed to be, in the org's own words. For the demo transcript. */
  role: string;
  /** Their Privy user id (`did:privy:…`). */
  userId: string;
  /** Their Privy **embedded wallet** address — the person's own wallet, not the org's. */
  walletAddress: string;
  /** Their authorization key. The private half is what makes an approval theirs. */
  key: AuthorizationKey;
}

/** The subset of a Privy user we care about. */
interface PrivyUser {
  id: string;
  linked_accounts: { type: string; address?: string; chain_type?: string; connector_type?: string }[];
}

export interface OnboardOperatorOptions {
  handle: string;
  role: string;
  email: string;
  /**
   * Reuse an existing authorization key instead of minting one.
   *
   * Rerunning setup with the operator's key from `.env` keeps the quorums and
   * the policy owner stable, which matters because a regenerated key silently
   * locks the org out of its own mandate.
   */
  existingKey?: AuthorizationKey | string;
}

/**
 * Onboard one human: a Privy user with an **embedded wallet**, plus the
 * authorization key that lets them approve org actions.
 *
 * The embedded wallet is *pre-generated server-side* — no browser, no login
 * screen. That is a real Privy feature and not a shortcut around one: the user
 * exists, the wallet is theirs, and when the operator eventually signs in with
 * this email they get that same wallet rather than a new one.
 *
 * Note that this wallet is **not** the org wallet and never spends the mandate.
 * It is the operator's identity inside the organization — the thing MOV-223's
 * `verified_operator_only` will eventually bind a World proof-of-personhood to.
 */
export async function onboardOperator(privy: PrivyClient, options: OnboardOperatorOptions): Promise<Operator> {
  const key =
    options.existingKey === undefined
      ? generateAuthorizationKey()
      : typeof options.existingKey === 'string'
        ? loadAuthorizationKey(options.existingKey)
        : options.existingKey;

  const user = await privy.post<PrivyUser>('/v1/users', {
    linked_accounts: [{ type: 'email', address: options.email }],
    wallets: [{ chain_type: 'ethereum' }],
  });

  const wallet = user.linked_accounts.find(account => account.type === 'wallet' && account.chain_type === 'ethereum');
  if (!wallet?.address) {
    throw new Error(`Privy created user ${user.id} without an embedded ethereum wallet — got ${JSON.stringify(user.linked_accounts.map(a => a.type))}`);
  }

  return { handle: options.handle, role: options.role, userId: user.id, walletAddress: wallet.address, key };
}

export interface KeyQuorum {
  id: string;
  display_name: string | null;
  authorization_threshold: number;
  authorization_keys: { public_key: string; display_name: string | null }[];
}

/**
 * Register a key quorum: these public keys, this many signatures.
 *
 * `threshold` is checked here rather than only by Privy because the failure it
 * prevents is silent — a threshold above the member count creates a quorum that
 * can never approve anything, and you find out at the moment you need it.
 */
export async function createKeyQuorum(
  privy: PrivyClient,
  options: { displayName: string; threshold: number } & (
    | { members: readonly Operator[]; publicKeys?: never }
    // For operators whose private key we never see: the browser generates the
    // pair and sends only this. A quorum has only ever needed public keys —
    // `members` was always reduced to `m.key.publicKey` on the next line — so
    // this is the same call with the secret left out of the process entirely.
    | { publicKeys: readonly string[]; members?: never }
  ),
): Promise<KeyQuorum> {
  const { displayName, threshold } = options;
  const publicKeys = options.publicKeys ?? options.members!.map(m => m.key.publicKey);
  if (publicKeys.length === 0) throw new Error('a key quorum needs at least one member');
  if (threshold < 1 || threshold > publicKeys.length) {
    throw new Error(`threshold ${threshold} is unsatisfiable with ${publicKeys.length} member(s) — it would lock the org out`);
  }
  return privy.post<KeyQuorum>('/v1/key_quorums', {
    display_name: displayName.slice(0, 50),
    public_keys: [...publicKeys],
    authorization_threshold: threshold,
  });
}

/** An operator Privy knows about, whose signing key we deliberately do not hold. */
export interface RegisteredOperator {
  handle: string;
  role: string;
  userId: string;
  walletAddress: string;
  /** base64 SPKI DER. The public half, and the only half that ever reaches us. */
  publicKey: string;
}

/**
 * Onboard an operator from a public key alone.
 *
 * `onboardOperator` generates the keypair server-side, which is right for
 * `npm run privy:setup` on an operator's own machine and wrong for a hosted
 * flow: it would mean this server briefly held the secret that authorises
 * someone else's treasury. Here the browser generates the pair, keeps the
 * private half, and sends only `publicKey`. There is no code path by which the
 * secret reaches us, which is a stronger statement than promising not to log it.
 */
export async function registerOperator(
  privy: PrivyClient,
  options: { handle: string; role: string; email: string; publicKey: string },
): Promise<RegisteredOperator> {
  const user = await privy.post<PrivyUser>('/v1/users', {
    linked_accounts: [{ type: 'email', address: options.email }],
    wallets: [{ chain_type: 'ethereum' }],
  });

  const wallet = user.linked_accounts.find(account => account.type === 'wallet' && account.chain_type === 'ethereum');
  if (!wallet?.address) {
    throw new Error(`Privy created user ${user.id} without an embedded ethereum wallet — got ${JSON.stringify(user.linked_accounts.map(a => a.type))}`);
  }

  return { handle: options.handle, role: options.role, userId: user.id, walletAddress: wallet.address, publicKey: options.publicKey };
}
