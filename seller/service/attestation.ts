// The MOV-227 seam: where an attested verdict is attached to the premium tier.
//
// Same shape as `AnalystPort`, and for the same reason — an interface here, the
// implementation somewhere that is allowed to know about chains. MOV-227's
// enclave and its Sepolia `VerdictConsumer` belong in `seller/cre/`, not in this
// directory; `no-chain-code.test.ts` will fail a file here that names either.
//
// ## What the premium tier is actually selling
//
// Not "a verdict with a badge on it". The claim is *sell the answer, keep the
// method*: the buyer can check that the verdict they were sold came from an
// attested run over exactly the input they hold, without ever seeing
// `scoring.ts`. Two properties of `seller/analyst/` make that possible, and both
// are load-bearing rather than incidental:
//
//   - `assess()` is a pure total function of `AnalystInput` — no clock, no
//     network, no module state;
//   - `assess(JSON.parse(JSON.stringify(input)))` is byte-identical to
//     `assess(input)`, measured on a real run (9,210 bytes, USDC/WETH 0.05%,
//     2026-09-07 — `seller/analyst/README.md`).
//
// So whatever an implementation hashes into its evidence, **it must hash exactly
// the bytes the buyer receives in `analystInput`.** Hash a normalized form, a
// re-fetched input, or anything with a timestamp the buyer cannot reconstruct,
// and the premium tier silently stops being checkable — it becomes an assertion
// with extra steps, which is the one thing this design exists to avoid. Nothing
// downstream would fail; the buyer would simply find the hash never matches.
// `docs/x402-service.md` says the same thing where a judge will read it.

import type { AnalystInput, Verdict } from '../analyst/types.ts';

/**
 * What the premium response's `attestation` field carries.
 *
 * `status` is the only field this directory reads, and it is the only one
 * pinned. Everything else — MOV-227's consumer address, pool key and evidence
 * hash — is that issue's to define and opaque here, the same way a rail's
 * `extra` is opaque to the payment path.
 */
export interface Attestation {
  status: 'unattested' | 'attested' | 'failed';
  /** Human-readable. Always set when `status` is not `'attested'`. */
  note?: string;
  [key: string]: unknown;
}

export interface AttestationPort {
  /**
   * @param input - the exact object the buyer will receive as `analystInput`
   * @param verdict - the verdict `assess(input)` produced
   */
  attest(input: AnalystInput, verdict: Verdict): Promise<Attestation>;
}

/**
 * The default, and what shipped in MOV-219: the answer is reproducible but
 * nobody has attested it.
 *
 * `'unattested'` rather than `'failed'` — no attestation was attempted, and
 * claiming a failure we did not have would be the same category of error as
 * discovery reporting `'unverified'` where it means `'unknown'`.
 */
export function unattestedPort(): AttestationPort {
  return {
    async attest(): Promise<Attestation> {
      return {
        status: 'unattested',
        note: 'Reproducible but not yet attested. MOV-227 runs assess() over exactly this input inside a Chainlink TEE and returns the attestation here.',
      };
    },
  };
}

/**
 * Run a port without letting it fail the request.
 *
 * A dead enclave degrades the answer rather than withholding it, and that is a
 * deliberate asymmetry with how a settlement failure is handled in `x402.ts`.
 * The difference is what the buyer still has: on a settlement failure they have
 * nothing and have paid nothing, so withholding is clean. Here they have the
 * verdict *and* the `AnalystInput` behind it, and can re-derive the verdict
 * themselves — which is precisely the fallback `scoring.ts` being pure buys us.
 * Throwing away a delivered, checkable answer because the notary was offline
 * would be worse for the buyer than handing it over with `status: 'failed'`.
 *
 * **Open question, deliberately not decided here:** they still paid the premium
 * price for an attestation they did not get. Whether that should be discounted,
 * refused up front when the enclave is known to be down, or left as is, is a
 * pricing decision for MOV-227 and the lead — not something this file should
 * settle by accident.
 */
export async function attestOrDegrade(
  port: AttestationPort,
  input: AnalystInput,
  verdict: Verdict,
): Promise<Attestation> {
  try {
    return await port.attest(input, verdict);
  } catch (cause) {
    return {
      status: 'failed',
      note: `attestation unavailable: ${cause instanceof Error ? cause.message : String(cause)}. `
        + 'The verdict and the input behind it are delivered and unchanged; assess(analystInput) re-derives this verdict byte for byte.',
    };
  }
}
