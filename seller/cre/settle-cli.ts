// Settle a verdict on Sepolia — the rehearsal path.
//
// ⚠️ READ THIS BEFORE QUOTING ANYTHING THIS PRINTS.
//
// In production the report reaching `VerdictConsumer.onReport` is delivered by
// the CRE Forwarder, signed by the Workflow DON after it verified the Nitro
// enclave's attestation. That is the whole point: the on-chain verdict is not
// "the seller says AVOID", it is "an attested enclave said AVOID".
//
// This script does NOT produce that. It cannot: `cre workflow deploy` requires
// deployment access, which this organization does not have (`cre account
// access`, 2026-09-07: "Deployment access is not yet enabled for your
// organization"), and Confidential Workflows is separately in private beta. The
// simulator runs the whole workflow including the write path, but returns a
// zero tx hash — it simulates the chain write rather than broadcasting it.
//
// So what this script settles is the *report bytes*, delivered by the seller's
// own key into a rehearsal consumer whose `forwarder` is that key. It proves,
// on real chain:
//
//   - the encoding in verdict.ts and the decoding in VerdictConsumer.sol agree;
//   - `assess()` is deterministic across the boundary — the same fixture and the
//     same calibration reproduce, byte for byte, the verdict the enclave
//     returned inside the TEE, which is the property that makes an attested
//     verdict mean anything;
//   - the storage, the event and the evidence commitment behave as designed.
//
// It proves nothing about attestation, and the production consumer at the
// address in contracts/addresses.verdict.sepolia.json will reject this script
// outright, because its forwarder is the real one.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  encodePacked,
  http,
  keccak256,
  toHex,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { assess, type Calibration } from '../analyst/scoring.ts';
import type { AnalystInput } from '../analyst/types.ts';
import { FIXTURES_DIR } from './evidence-server.ts';
import { compact, decodeVerdictReport, describeCompact, encodeVerdictReport } from './verdict.ts';

const ON_REPORT_ABI = [
  {
    type: 'function',
    name: 'onReport',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'metadata', type: 'bytes' },
      { name: 'report', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

const VERDICT_OF_ABI = [
  {
    type: 'function',
    name: 'verdictOf',
    stateMutability: 'view',
    inputs: [{ name: 'pool', type: 'address' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'rating', type: 'uint8' },
          { name: 'confidenceBp', type: 'uint16' },
          { name: 'failMask', type: 'uint8' },
          { name: 'warnMask', type: 'uint8' },
          { name: 'assessedAt', type: 'uint64' },
          { name: 'evidenceHash', type: 'bytes32' },
          { name: 'settledAt', type: 'uint64' },
        ],
      },
    ],
  },
] as const;

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

/**
 * The Forwarder packs metadata rather than ABI-encoding it:
 * `bytes32 workflowId | bytes10 workflowName | address workflowOwner`.
 * `VerdictConsumer._decodeMetadata` reads exactly that layout.
 */
function packMetadata(workflowId: `0x${string}`, workflowName: string, owner: Address): `0x${string}` {
  const nameBytes = toHex(new TextEncoder().encode(workflowName.padEnd(10).slice(0, 10)));
  return encodePacked(['bytes32', 'bytes10', 'address'], [workflowId, nameBytes as `0x${string}`, owner]);
}

const fixture = arg('--fixture') ?? 'usdc-weth-500.json';
const consumer = (arg('--consumer') ?? process.env.TURNSTILE_VERDICT_CONSUMER) as Address | undefined;
const broadcast = process.argv.includes('--broadcast');

// The bytes, read exactly as the evidence server serves them and exactly as the
// enclave hashed them. Nothing here re-serializes: a re-encode would reorder
// nothing today and something tomorrow, and the buyer's check would fail for a
// reason nobody could find.
const bytes = await readFile(join(FIXTURES_DIR, fixture));
const body = bytes.toString('utf8');
const input = JSON.parse(body) as AnalystInput;
const evidenceHash = keccak256(toHex(body));

const calibrationRaw = process.env.TURNSTILE_CALIBRATION;
const calibration = calibrationRaw ? (JSON.parse(calibrationRaw) as Partial<Calibration>) : null;

const verdict = assess(input, calibration);
const settled = compact(verdict, evidenceHash, input.now);
const report = encodeVerdictReport(settled);

console.log(`pool          ${input.pool.name}  ${settled.poolAddress}`);
console.log(`evidence      ${bytes.length} bytes, keccak256 ${evidenceHash}`);
console.log(`calibration   ${calibration ? `${Object.keys(calibration).length} sealed overrides` : 'public thresholds only'}`);
console.log(`verdict       ${describeCompact(settled)}`);
console.log(`report        ${report.length / 2 - 1} bytes`);
console.log(`              ${report}`);

// The encoding has to survive its own round trip before it is worth sending.
const roundTripped = decodeVerdictReport(report);
if (JSON.stringify(roundTripped) !== JSON.stringify(settled)) {
  throw new Error('report does not round-trip through its own codec');
}
console.log('round trip    ok');

if (!broadcast) {
  console.log('\nDry run. Pass --broadcast --consumer 0x… to settle it on Sepolia.');
  console.log('Remember what that is and is not: see the header of this file.');
  process.exit(0);
}

if (!consumer) throw new Error('--consumer (or TURNSTILE_VERDICT_CONSUMER) is required to broadcast');
const rpcUrl = process.env.SEPOLIA_RPC_URL;
if (!rpcUrl) throw new Error('SEPOLIA_RPC_URL is required to broadcast');
const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!key) throw new Error('DEPLOYER_PRIVATE_KEY is required to broadcast');

const account = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`);
const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, chain: sepolia, transport: http(rpcUrl) });

// The workflow id the DON would supply. Here it is derived from the workflow
// name so the value is at least stable and legible, rather than zero pretending
// to be an identity.
const workflowId = keccak256(toHex('turnstile-analyst-verdict-staging'));
const metadata = packMetadata(workflowId, 'a1b2c3d4e5', account.address);

const data = encodeFunctionData({ abi: ON_REPORT_ABI, functionName: 'onReport', args: [metadata, report] });
const hash = await walletClient.sendTransaction({ to: consumer, data });
console.log(`\ntx            ${hash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log(`status        ${receipt.status}  block ${receipt.blockNumber}  gas ${receipt.gasUsed}`);
console.log(`explorer      https://sepolia.etherscan.io/tx/${hash}`);

const stored = await publicClient.readContract({
  address: consumer,
  abi: VERDICT_OF_ABI,
  functionName: 'verdictOf',
  args: [settled.poolAddress],
});
console.log('\nread back from chain:');
console.log(`  rating        ${stored.rating}  (${settled.rating})`);
console.log(`  confidenceBp  ${stored.confidenceBp}`);
console.log(`  failMask      0b${stored.failMask.toString(2).padStart(7, '0')}`);
console.log(`  warnMask      0b${stored.warnMask.toString(2).padStart(7, '0')}`);
console.log(`  assessedAt    ${stored.assessedAt}`);
console.log(`  evidenceHash  ${stored.evidenceHash}`);
console.log(
  stored.evidenceHash === evidenceHash
    ? '  ✓ the chain commits to the exact bundle on disk — this is the check a buyer runs'
    : '  ✗ evidence hash mismatch',
);
