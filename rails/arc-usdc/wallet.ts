// Reading an Arc wallet, for the proof rather than for the payment.
//
// Nothing in the payment path imports this. It exists so
// `scripts/arc-paid-request.ts` and `scripts/arc-setup.ts` can *check* the
// zero-gas claim on every run instead of asserting it in a comment, and so the
// numbers behind the `CLAUDE.md` correction can be reproduced by anyone with a
// terminal.
//
// The three numbers that matter, and why each one is here:
//
//   `nonce`          — `eth_getTransactionCount`. **The proof.** A wallet that
//                      has never submitted a transaction has nonce 0, and a
//                      wallet that has never submitted a transaction has never
//                      paid gas. This is unforgeable and it is on chain.
//   `native`         — `eth_getBalance`, 18 dp.
//   `usdc`           — `USDC.balanceOf`, 6 dp.
//
// `native` and `usdc` are the **same balance at two precisions**, which is the
// fact that makes "holds zero native token via a Paymaster" incoherent on Arc:
// zero native is zero USDC. `sameBalance()` below checks the identity rather
// than trusting this comment.

import { createPublicClient, http } from 'viem';
import type { Address, PublicClient } from 'viem';
import { arcTestnet } from 'viem/chains';

import { FACILITATOR_URL, GATEWAY_DOMAIN, NATIVE_DECIMALS, RPC_URL, USDC_ASSET, USDC_DECIMALS } from './config.ts';

const BALANCE_OF = [{
  name: 'balanceOf', type: 'function', stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }],
}] as const;

export interface ArcWalletState {
  address: Address;
  /** `eth_getTransactionCount`. Zero means this wallet has never submitted a transaction. */
  nonce: number;
  /** `eth_getBalance`, in wei (18 dp). */
  native: bigint;
  /** `USDC.balanceOf`, in USDC atomic units (6 dp). */
  usdc: bigint;
}

export function arcClient(rpcUrl = process.env['ARC_RPC_URL'] ?? RPC_URL): PublicClient {
  return createPublicClient({ chain: arcTestnet, transport: http(rpcUrl) }) as PublicClient;
}

export async function readArcWallet(address: Address, client: PublicClient = arcClient()): Promise<ArcWalletState> {
  const [nonce, native, usdc] = await Promise.all([
    client.getTransactionCount({ address }),
    client.getBalance({ address }),
    client.readContract({ address: USDC_ASSET as Address, abi: BALANCE_OF, functionName: 'balanceOf', args: [address] }) as Promise<bigint>,
  ]);
  return { address, nonce, native, usdc };
}

/**
 * Are the native and ERC-20 views the same balance?
 *
 * They are, on Arc, and the ERC-20 view is the truncated one — 18 dp down to 6.
 * So the test is not equality but that the native balance floors to the ERC-20
 * balance across the 1e12 scale factor.
 */
export function sameBalance(state: Pick<ArcWalletState, 'native' | 'usdc'>): boolean {
  const scale = 10n ** BigInt(NATIVE_DECIMALS - USDC_DECIMALS);
  return state.native / scale === state.usdc;
}

/** `1234` → `0.001234`. For printing, never for arithmetic. */
export function formatUsdc(atomic: bigint | string): string {
  const value = BigInt(atomic);
  const unit = 10n ** BigInt(USDC_DECIMALS);
  const whole = value / unit;
  return `${whole}.${String(value % unit).padStart(USDC_DECIMALS, '0')}`;
}

/**
 * The address's **Gateway** balance — the spendable one.
 *
 * Added by MOV-228. The Circle SDK exposes this as `GatewayClient.getBalances()`,
 * but a `GatewayClient` cannot be constructed without a private key, and after
 * MOV-228 the org has no private key to give it: the warm tier is a Privy server
 * wallet whose secret lives in an enclave. The endpoint itself needs no key and
 * no auth header — verified 2026-09-07 — so reading it directly is both simpler
 * and the only option left.
 *
 * Returns `null` when Gateway has never seen this depositor, which is a normal
 * state (a wallet that has not been funded yet) rather than an error.
 */
export async function gatewayBalance(
  address: Address,
  options: { facilitatorUrl?: string; fetch?: typeof globalThis.fetch } = {},
): Promise<{ available: string; total: string } | null> {
  const url = `${options.facilitatorUrl ?? FACILITATOR_URL}/v1/balances`;
  const response = await (options.fetch ?? globalThis.fetch)(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'USDC', sources: [{ depositor: address, domain: GATEWAY_DOMAIN }] }),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { balances?: { balance?: string; withdrawing?: string }[] };
  const first = body.balances?.[0];
  if (!first?.balance) return null;
  const available = first.balance;
  const withdrawing = first.withdrawing ?? '0';
  return { available, total: (Number(available) + Number(withdrawing)).toFixed(USDC_DECIMALS) };
}
