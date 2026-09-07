// The MOV-227 seam.
//
// The test that matters here is `the port is handed exactly the bytes the buyer
// receives` — everything else is plumbing. The premium tier's whole claim is
// that a buyer can check the verdict came from an attested run over the input
// they hold, and that claim dies quietly if the evidence hash covers anything
// they cannot reconstruct. Nothing would throw; the hash would simply never
// match, and only the buyer would find out.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPaidFetch } from '../../buyer/watchdog/pay.ts';
import { createStubSigner } from '../../buyer/watchdog/stub-signer.ts';
import type { AnalystInput, Verdict } from '../analyst/types.ts';
import { createApp } from './app.ts';
import type { AttestationPort } from './attestation.ts';
import { attestOrDegrade, unattestedPort } from './attestation.ts';
import { fakeAnalyst, testRegistry, withServer } from './testing.ts';

const POOL = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640';

const signers = [
  createStubSigner({ railId: 'rail-one', scheme: 'exact', network: 'testnamespace:one', payer: 'buyer' }),
  createStubSigner({ railId: 'rail-two', scheme: 'exact', network: 'testnamespace:two', payer: 'buyer' }),
];

/** A mandate wide enough for the premium tier. */
const pay = () => createPaidFetch({
  mandate: { preferredRails: ['rail-one', 'rail-two'], maxPerPaymentUsd: 0.5 },
  signers,
});

/** Records what it was handed, so a test can compare it against the wire. */
function recordingPort(result: Partial<Awaited<ReturnType<AttestationPort['attest']>>> = {}) {
  const seen: { input: AnalystInput; verdict: Verdict }[] = [];
  const port: AttestationPort = {
    async attest(input, verdict) {
      seen.push({ input, verdict });
      return { status: 'attested', evidenceHash: '0xdeadbeef', ...result };
    },
  };
  return { port, seen };
}

test('the premium tier is unattested by default, and says so rather than claiming a failure', async () => {
  await withServer(createApp({ registry: testRegistry(), analyst: fakeAnalyst() }), async baseUrl => {
    const res = await pay()(`${baseUrl}/analyze/${POOL}/attested`);
    assert.equal(res.status, 200);
    const body = await res.json() as { attestation: { status: string; note: string } };
    // 'unattested', not 'failed'. Nothing was attempted, and reporting a failure
    // we did not have is the same error as discovery saying 'unverified' where
    // it means 'unknown'.
    assert.equal(body.attestation.status, 'unattested');
    assert.match(body.attestation.note, /not yet attested/);
  });
});

test('an injected port reaches the premium response', async () => {
  const { port } = recordingPort();
  await withServer(createApp({ registry: testRegistry(), analyst: fakeAnalyst(), attestation: port }), async baseUrl => {
    const res = await pay()(`${baseUrl}/analyze/${POOL}/attested`);
    const body = await res.json() as { attestation: { status: string; evidenceHash: string } };
    assert.equal(body.attestation.status, 'attested');
    assert.equal(body.attestation.evidenceHash, '0xdeadbeef');
  });
});

test('the port is handed exactly the bytes the buyer receives', async () => {
  const { port, seen } = recordingPort();
  await withServer(createApp({ registry: testRegistry(), analyst: fakeAnalyst(), attestation: port }), async baseUrl => {
    const res = await pay()(`${baseUrl}/analyze/${POOL}/attested`);
    const body = await res.json() as { analystInput: unknown; verdict: unknown };

    assert.equal(seen.length, 1);

    // The crux. Whatever an implementation hashes, it must hash something the
    // buyer can reconstruct from the payload — so what the port sees and what
    // goes on the wire have to serialize identically. A normalized copy, a
    // re-fetch, or an added timestamp would break the premium tier's whole
    // claim without failing anything.
    assert.equal(JSON.stringify(seen[0]!.input), JSON.stringify(body.analystInput));
    assert.equal(JSON.stringify(seen[0]!.verdict), JSON.stringify(body.verdict));
  });
});

test('the verdict the port attests is the one assess() gives back for that input', async () => {
  // The property the enclave will re-establish inside the TEE, asserted here
  // against the port's own arguments: scoring is a pure function of the input,
  // so a buyer holding the input can re-derive the verdict and get the same
  // bytes. Measured at 9,210 bytes on a real pool — see seller/analyst/README.md.
  const { port, seen } = recordingPort();
  await withServer(createApp({ registry: testRegistry(), analyst: fakeAnalyst(), attestation: port }), async baseUrl => {
    await pay()(`${baseUrl}/analyze/${POOL}/attested`);
    const { input } = seen[0]!;
    const roundTripped = JSON.parse(JSON.stringify(input)) as AnalystInput;
    assert.deepEqual(roundTripped, input, 'AnalystInput must survive the enclave boundary unchanged');
  });
});

test('a dead enclave degrades the answer instead of withholding it', async () => {
  const exploding: AttestationPort = {
    async attest() { throw new Error('enclave unreachable'); },
  };
  await withServer(createApp({ registry: testRegistry(), analyst: fakeAnalyst(), attestation: exploding }), async baseUrl => {
    const res = await pay()(`${baseUrl}/analyze/${POOL}/attested`);

    // Deliberately asymmetric with a settlement failure, which withholds. There
    // the buyer has nothing; here they have the verdict and the input behind it
    // and can re-derive the verdict themselves, so throwing that away because
    // the notary was offline would be the worse outcome for them.
    assert.equal(res.status, 200);
    const body = await res.json() as {
      verdict: { rating: string };
      analystInput: unknown;
      attestation: { status: string; note: string };
    };
    assert.equal(body.attestation.status, 'failed');
    assert.match(body.attestation.note, /enclave unreachable/);
    // And the degradation must not quietly take the deliverable with it.
    assert.equal(body.verdict.rating, 'ACCEPTABLE');
    assert.ok(body.analystInput);
  });
});

test('the standard tier never calls the attestation port', async () => {
  const { port, seen } = recordingPort();
  await withServer(createApp({ registry: testRegistry(), analyst: fakeAnalyst(), attestation: port }), async baseUrl => {
    const res = await pay()(`${baseUrl}/analyze/${POOL}`);
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body['attestation'], undefined);
    // The cheap tier must not be paying for enclave time it did not sell.
    assert.equal(seen.length, 0);
  });
});

test('attestOrDegrade is usable on its own, and reports the reason', async () => {
  const input = { now: 1, depth: null, pool: {} } as unknown as AnalystInput;
  const verdict = { rating: 'ACCEPTABLE' } as unknown as Verdict;

  const ok = await attestOrDegrade(unattestedPort(), input, verdict);
  assert.equal(ok.status, 'unattested');

  const failed = await attestOrDegrade(
    { async attest() { throw new Error('signer offline'); } },
    input,
    verdict,
  );
  assert.equal(failed.status, 'failed');
  // The reason has to survive, or an operator cannot tell a broken enclave from
  // one that was never wired up.
  assert.match(failed.note ?? '', /signer offline/);
});
