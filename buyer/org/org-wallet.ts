// The organization's wallet — the warm tier, as a Privy server wallet.
//
// What replaced what, precisely: `scripts/arc-setup.ts` used to hold
// `ARC_ORG_PRIVATE_KEY`, a plain secp256k1 key at
// `0xdFe3088aC34e7329006407C246C9F6D7534B2aC5`, and call Circle's
// `GatewayClient.depositFor()` with it. **The mechanism is unchanged** — the org
// still pays the deposit's gas, the agent still receives the balance, the agent
// still never submits a transaction. Only the key holder changed, and the change
// buys three things a raw key cannot have:
//
//   1. **No private key exists on our side.** Privy's enclave holds it. Reading
//      our `.env` no longer yields spending power.
//   2. **A policy the wallet cannot escape.** Every signature is checked against
//      the mandate *by Privy*, before a signature exists.
//   3. **An owner that is a quorum of humans**, not a file.
//
// ## Sign, then broadcast — and why not `eth_sendTransaction`
//
// Privy offers `eth_sendTransaction`, which needs Privy to hold an RPC for the
// chain. Arc testnet (`eip155:5042002`) is not a chain Privy routes for, so this
// module uses **`eth_signTransaction`** and broadcasts the raw transaction over
// Arc's own public RPC.
//
// That split is a feature rather than a workaround. Signing is the part that
// needs custody and the policy check; broadcasting is public and needs neither.
// It also means this rail keeps working on any EVM chain the day it appears,
// including one Privy has never heard of — which for a chain as new as Arc is
// the difference between shipping and waiting.
//
// Verified 2026-09-07 against the live API: `eth_signTransaction` with
// `chain_id: 5042002` returns a signed type-2 transaction, and the same request
// one dollar over the policy cap returns `400 policy_violation`.

import type { AuthorizationKey } from './authorization-key.ts';
import type { PrivyClient } from './privy.ts';

export interface OrgWallet {
  /** Privy's wallet id — `d6jqc0cuvvlkkcdc3ggj7vdc`. What `/rpc` is addressed to. */
  id: string;
  /** The EVM address. This is what funds the agent and what a block explorer shows. */
  address: string;
  chain_type: string;
  policy_ids: string[];
  owner_id: string | null;
}

/**
 * Create the org wallet: owned by the operations quorum, governed by the mandate
 * policy.
 *
 * Both are set at creation on purpose. A wallet created bare and patched
 * afterwards is briefly a wallet with no owner and no policy, and "briefly" is
 * long enough to matter for something that will hold a treasury.
 */
export async function createOrgWallet(
  privy: PrivyClient,
  options: { ownerQuorumId: string; policyId: string; displayName?: string },
): Promise<OrgWallet> {
  return privy.post<OrgWallet>('/v1/wallets', {
    chain_type: 'ethereum',
    owner_id: options.ownerQuorumId,
    policy_ids: [options.policyId],
    display_name: (options.displayName ?? 'Turnstile buyer org').slice(0, 50),
  });
}

export async function getOrgWallet(privy: PrivyClient, walletId: string): Promise<OrgWallet> {
  return privy.get<OrgWallet>(`/v1/wallets/${walletId}`);
}

/**
 * An EVM transaction as Privy's RPC wants it: snake_case, and numbers as
 * numbers.
 *
 * `chain_id` is required and is the field that makes this work on Arc at all —
 * it is what goes into the EIP-155 signature, and Privy does not need to know
 * the chain to produce it.
 */
export interface PrivyTransactionRequest {
  to: string;
  data?: string;
  value?: number | string;
  chain_id: number;
  nonce: number;
  gas_limit: number | string;
  max_fee_per_gas: number | string;
  max_priority_fee_per_gas: number | string;
  type?: 2;
}

interface SignTransactionResponse {
  method: string;
  data: { signed_transaction: string };
}

/**
 * Have the org wallet sign a transaction, if the mandate policy allows it.
 *
 * `approvals` must satisfy the wallet's owner quorum — one operator for the
 * 1-of-N operations quorum. The returned string is a raw signed transaction
 * ready for `eth_sendRawTransaction`; nothing has been broadcast yet.
 *
 * Throws {@link PrivyError} with `status: 400` and `code: policy_violation` when
 * the mandate refuses it, and `status: 401` when the approvals are short. Those
 * are genuinely different failures — one is the org saying no, the other is
 * nobody having asked — so they are deliberately not collapsed.
 */
export async function signTransaction(
  privy: PrivyClient,
  options: { walletId: string; transaction: PrivyTransactionRequest; approvals: readonly AuthorizationKey[] },
): Promise<string> {
  const response = await privy.post<SignTransactionResponse>(
    `/v1/wallets/${options.walletId}/rpc`,
    { method: 'eth_signTransaction', params: { transaction: options.transaction } },
    { approvals: options.approvals },
  );
  return response.data.signed_transaction;
}
