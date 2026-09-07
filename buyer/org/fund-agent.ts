// The org's one treasury operation: funding the agent's mandate on Arc.
//
// `approve()` on USDC, then `depositFor(token, agent, value)` on Circle's
// GatewayWallet. Two transactions, both signed inside Privy under the mandate
// policy, both broadcast over Arc's public RPC by this process.
//
// **The mechanism is unchanged from MOV-225** — the org pays the gas, the agent
// receives the Gateway balance, the agent never submits a transaction and its
// nonce stays 0. What changed is who holds the org key: it used to be
// `ARC_ORG_PRIVATE_KEY` in `.env`, and it is now a Privy server wallet whose
// private half exists only inside Privy's enclave and whose every signature is
// checked against the mandate before it is produced.
//
// ## Sign here, broadcast there
//
// Privy's `eth_sendTransaction` needs Privy to hold an RPC for the chain, and it
// does not hold one for Arc testnet. `eth_signTransaction` needs only the chain
// id, because that is all an EIP-155 signature covers. So this module asks Privy
// for a signed transaction and posts it to `https://rpc.testnet.arc.network`
// itself.
//
// The split is the honest one anyway: custody and policy belong to the enclave,
// and broadcasting is a public act that needs neither.
//
// ## Why the nonce and fees are read here
//
// Privy signs exactly the transaction it is given — it does not fill in a nonce,
// estimate gas, or read a base fee. Everything below the signature is this
// module's job, and getting the nonce wrong is the failure that looks like a
// policy problem and is not.

import { createWalletClient, encodeFunctionData, getAddress, http, type Address, type Hex } from 'viem';
import { arcTestnet } from 'viem/chains';

import { GATEWAY_WALLET, RPC_URL, USDC_ASSET, arcscanTransactionUrl } from '../../rails/arc-usdc/config.ts';
import { arcClient } from '../../rails/arc-usdc/wallet.ts';
import { APPROVE_ABI, DEPOSIT_FOR_ABI, usdToUsdcAtomic } from '../mandate/policy.ts';
import type { AuthorizationKey } from './authorization-key.ts';
import { signTransaction, type PrivyTransactionRequest } from './org-wallet.ts';
import type { PrivyClient } from './privy.ts';

/** Gas limits. Fixed rather than estimated: `eth_estimateGas` on Arc needs the sender to hold a balance, and a failed estimate reads as a policy refusal. */
const APPROVE_GAS = 80_000n;
const DEPOSIT_GAS = 120_000n;

export interface FundAgentResult {
  /** Absent when the GatewayWallet already had enough allowance. */
  approvalTxHash?: Hex;
  depositTxHash: Hex;
  /** USDC atomic units deposited. */
  amount: bigint;
  /** The address whose Gateway balance grew — the agent, not the org. */
  depositor: Address;
}

export interface FundAgentOptions {
  privy: PrivyClient;
  walletId: string;
  /** The org wallet's address. Needed to read its nonce and allowance. */
  walletAddress: Address;
  /** The hot tier. This is the address that ends up with the Gateway balance. */
  agentAddress: Address;
  /** Decimal US dollars. Must be within the mandate policy's cap or Privy refuses. */
  amountUsd: number;
  /** Approvals satisfying the org wallet's **operations** quorum — one operator. */
  approvals: readonly AuthorizationKey[];
  rpcUrl?: string;
  /** Called with progress. Lets `scripts/arc-setup.ts` print a transcript without this module owning a console. */
  onStep?: (message: string) => void;
}

const ALLOWANCE_ABI = [
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;

/**
 * Fund the agent's Gateway balance, with the org wallet paying the gas.
 *
 * Throws {@link PrivyError} with `code: policy_violation` when `amountUsd` is
 * over the mandate cap — which is the *correct* outcome for an over-cap request
 * and is what `scripts/privy-mandate.ts` demonstrates. Raising the cap is a
 * separate, quorum-gated operation in `buyer/mandate/policy.ts`.
 */
export async function fundAgentMandate(options: FundAgentOptions): Promise<FundAgentResult> {
  const { privy, walletId, walletAddress, agentAddress, amountUsd, approvals } = options;
  const step = options.onStep ?? (() => {});

  const usdc = getAddress(USDC_ASSET);
  const gateway = getAddress(GATEWAY_WALLET);
  const amount = usdToUsdcAtomic(amountUsd);
  if (amount === 0n) throw new Error(`$${amountUsd} rounds to zero USDC atomic units`);

  const rpcUrl = options.rpcUrl ?? process.env['ARC_RPC_URL'] ?? RPC_URL;
  const publicClient = arcClient(rpcUrl);
  const broadcaster = createWalletClient({ chain: arcTestnet, transport: http(rpcUrl) });

  const [allowance, fees] = await Promise.all([
    publicClient.readContract({ address: usdc, abi: ALLOWANCE_ABI, functionName: 'allowance', args: [walletAddress, gateway] }) as Promise<bigint>,
    publicClient.estimateFeesPerGas(),
  ]);
  let nonce = await publicClient.getTransactionCount({ address: walletAddress });

  // Privy's RPC validates these as either a JSON number or a `0x`-prefixed hex
  // string, and rejects a decimal string with
  // `Invalid input: must start with "0x"`. Fee values on Arc overflow a safe
  // integer, so hex is the only form that works for all three — and passing hex
  // everywhere keeps one rule instead of two.
  const hex = (value: bigint) => `0x${value.toString(16)}`;

  const base = {
    chain_id: arcTestnet.id,
    max_fee_per_gas: hex(fees.maxFeePerGas),
    max_priority_fee_per_gas: hex(fees.maxPriorityFeePerGas),
    type: 2 as const,
  };

  /** Ask Privy to sign, then put it on chain ourselves. */
  const signAndSend = async (transaction: PrivyTransactionRequest): Promise<Hex> => {
    const signed = await signTransaction(privy, { walletId, transaction, approvals });
    const hash = await broadcaster.sendRawTransaction({ serializedTransaction: signed as Hex });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`transaction reverted: ${arcscanTransactionUrl(hash)}`);
    return hash;
  };

  const result: FundAgentResult = { depositTxHash: '0x' as Hex, amount, depositor: agentAddress };

  if (allowance < amount) {
    step(`approve(${gateway}, ${amount}) — the org pays this`);
    result.approvalTxHash = await signAndSend({
      ...base,
      to: usdc,
      data: encodeFunctionData({ abi: APPROVE_ABI, functionName: 'approve', args: [gateway, amount] }),
      value: 0,
      nonce,
      gas_limit: hex(APPROVE_GAS),
    });
    step(`approve  ${result.approvalTxHash}  ${arcscanTransactionUrl(result.approvalTxHash)}`);
    nonce += 1;
  } else {
    step(`allowance already ${allowance} — skipping approve`);
  }

  step(`depositFor(USDC, ${agentAddress}, ${amount}) — the org pays this, the agent receives the balance`);
  result.depositTxHash = await signAndSend({
    ...base,
    to: gateway,
    data: encodeFunctionData({ abi: DEPOSIT_FOR_ABI, functionName: 'depositFor', args: [usdc, agentAddress, amount] }),
    value: 0,
    nonce,
    gas_limit: hex(DEPOSIT_GAS),
  });
  step(`deposit  ${result.depositTxHash}  ${arcscanTransactionUrl(result.depositTxHash)}`);

  return result;
}
