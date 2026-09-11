// Probe: does the live seller accept a signed x402 payment on the Base rail?
//
//   set -a; . ./.env; set +a
//   node --disable-warning=ExperimentalWarning scripts/base-pay-probe.ts [eip155:8453]
//
// The optional argument picks the accept entry to pay. Default eip155:84532
// (Base Sepolia, free faucet money); pass eip155:8453 for the mainnet rail, which
// needs real USDC in the payer's wallet.
//
// A diagnostic, not a paid-request flow. It fetches the real 402, picks the
// eip155:84532 entry, signs an EIP-3009 authorization with `BASE_PAYER_KEY` (or
// the Arc agent's key as a fallback) and posts the payment header back. Either
// outcome is informative:
//
//   - refused on balance — the challenge, the signature and the facilitator's
//     verdict all arrived, which is the wiring this tests. That is what it
//     reported on 2026-09-11, its payer holding no USDC on Base Sepolia;
//   - settled — money moved, and there is a BaseScan transaction to show. That
//     needs a funded payer: faucet.circle.com issues Base Sepolia USDC.
//
// It asserts nothing about the response body — it prints what came back, to be
// read. The rails' own suites are where the assertions live.

import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';

const RESOURCE = 'https://turnstile.moveseventyeight.com/analyze/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640';
const CAIP2 = process.argv[2] ?? 'eip155:84532';

const first = await fetch(RESOURCE);
console.log(`unpaid status: ${first.status}`);
const header = first.headers.get('payment-required');
if (!header) throw new Error('no PAYMENT-REQUIRED header: the seller did not issue a challenge');
const challenge = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as {
  x402Version: number;
  resource: unknown;
  accepts: {
    scheme: string; network: string; asset: string; amount: string; payTo: string;
    maxTimeoutSeconds?: number; extra: Record<string, unknown>;
  }[];
};
console.log(`rails offered: ${challenge.accepts.map(a => a.network).join(', ')}`);

const accept = challenge.accepts.find(a => a.network === CAIP2);
if (!accept) throw new Error(`no ${CAIP2} entry in the challenge`);
console.log(`chosen: ${accept.scheme} ${accept.network} ${accept.asset} ${accept.amount} -> ${accept.payTo}`);
console.log(`domain: name=${String(accept.extra['name'])} version=${String(accept.extra['version'])}`);
console.log(`resource extra: ${String(accept.extra['resource'])}`);

const key = process.env['BASE_PAYER_KEY'] ?? process.env['ARC_AGENT_PRIVATE_KEY'];
if (!key) throw new Error('set BASE_PAYER_KEY (or ARC_AGENT_PRIVATE_KEY) — source .env first');
const account = privateKeyToAccount(key.startsWith('0x') ? (key as `0x${string}`) : (`0x${key}` as `0x${string}`));
console.log(`payer: ${account.address}`);

const now = Math.floor(Date.now() / 1000);
const authorization = {
  from: account.address,
  to: accept.payTo as `0x${string}`,
  value: BigInt(accept.amount),
  validAfter: BigInt(now - 60),
  validBefore: BigInt(now + Number(accept.maxTimeoutSeconds ?? 300)),
  nonce: `0x${randomBytes(32).toString('hex')}` as `0x${string}`,
};

const signature = await account.signTypedData({
  domain: {
    name: String(accept.extra['name']),
    version: String(accept.extra['version']),
    chainId: 84532,
    verifyingContract: accept.asset as `0x${string}`,
  },
  types: {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  },
  primaryType: 'TransferWithAuthorization',
  message: {
    from: authorization.from,
    to: authorization.to,
    value: authorization.value,
    validAfter: authorization.validAfter,
    validBefore: authorization.validBefore,
    nonce: authorization.nonce,
  },
});
console.log(`signature: ${signature.slice(0, 12)}…`);

const envelope = {
  x402Version: challenge.x402Version,
  resource: typeof challenge.resource === 'string' ? challenge.resource : (challenge.resource as { url?: string })?.url,
  accepted: accept,
  payload: {
    signature,
    authorization: {
      from: authorization.from,
      to: authorization.to,
      value: authorization.value.toString(),
      validAfter: authorization.validAfter.toString(),
      validBefore: authorization.validBefore.toString(),
      nonce: authorization.nonce,
    },
  },
};

const paid = await fetch(RESOURCE, {
  headers: { 'Payment-Signature': Buffer.from(JSON.stringify(envelope)).toString('base64') },
});
console.log(`paid status: ${paid.status}`);
const receipt = paid.headers.get('payment-response');
if (receipt) {
  console.log(`payment-response: ${Buffer.from(receipt, 'base64').toString('utf8').slice(0, 400)}`);
}
const body = await paid.text();
console.log(`body: ${body.slice(0, 700)}`);
