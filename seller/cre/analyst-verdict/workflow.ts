// Turnstile's premium tier: the LP-safety verdict, scored inside a TEE.
//
// ── Why this exists ────────────────────────────────────────────────────────
//
// Turnstile's other twelve pieces answer "how does an agent pay for one
// answer". None of them answers the harder question underneath: why would a
// seller with a genuine edge ever list? Publishing an analyst reveals the
// analyst. Selling its output one query at a time only works if the buyer
// cannot reconstruct the thing that produced it — and cannot be defrauded
// either, because a verdict you have to take on trust is worth nothing.
//
// A confidential workflow is the answer, and it is a precise one. Three things
// go into an attested Nitro enclave and one small thing comes out:
//
//   in ▸ the seller's calibration      (Vault DON secret — the tuned thresholds)
//   in ▸ the seller's evidence bundle  (confidential HTTP — 9kB the buyer never sees)
//   in ▸ the scorer                    (in the binary, and public: see below)
//   out ▸ rating, confidence, two 7-bit signal masks, keccak256(evidence)
//
// The buyer gets a verdict they can verify and cannot reproduce. Sell the
// answer, keep the method.
//
// ── What is and is not confidential, precisely ─────────────────────────────
//
// This matters enough to be exact about, because it is easy to overclaim. The
// workflow *binary* is supplied to the enclave by the Workflow DON, so the
// binary is not secret — this file is MIT and readable in the repo, and so is
// `scoring.ts`. What the enclave keeps confidential is the *data* the binary
// computes over: Vault DON secrets, the request and response payloads of HTTP
// calls made from inside, and intermediate values.
//
// So the split is drawn where the confidentiality actually is. The *shape* of
// the judgement — which seven signals, which of them are structural, how a
// structural failure forces AVOID — is public, and it should be, because that
// is what makes a verdict auditable rather than an oracle. The *calibration*
// and the *evidence* are private, and those are the parts that cost money to
// get right. `activeHourFailShare` is 0.2 rather than 0.1 only because a real
// TRUMP/WETH run said so; that is what live data buys, and that is what stays
// in the Vault.
//
// ── The one-way door ───────────────────────────────────────────────────────
//
// `runtime.usingTheDons()` is documented as a one-way crossing: everything
// after it runs on ordinary Workflow DON nodes and is no longer confidential.
// So it is crossed exactly once, at the very end, carrying a 105-byte compact
// verdict and nothing else. The raw bundle, the calibration and the full
// reasoning never appear on that side of the line.

import {
	bytesToHex,
	cre,
	getNetwork,
	prepareReportRequest,
	TxStatus,
	ok,
	text,
	type Runtime,
	type TeeRuntime,
} from '@chainlink/cre-sdk'
import { keccak256, toHex, type Address } from 'viem'
import { z } from 'zod'
import { assess, type Calibration } from '../../analyst/scoring.ts'
import type { AnalystInput } from '../../analyst/types.ts'
import { compact, describeCompact, encodeVerdictReport, type CompactVerdict } from '../verdict.ts'

// ─── Config Schema ──────────────────────────────────────────
export const configSchema = z.object({
	schedule: z.string(),
	/** The seller's evidence endpoint. Answers only to the sealed bearer token. */
	evidenceUrl: z.string(),
	/** Secret id in secrets.yaml holding that bearer token. */
	evidenceSecretId: z.string(),
	/** Secret id holding the seller's calibration, as a JSON object of threshold overrides. */
	calibrationSecretId: z.string(),
	/**
	 * Also score with the *public* calibration and log whether the two agree.
	 *
	 * This exists to make the simulation legible: it proves the Vault secret
	 * genuinely changed the answer rather than being fetched and ignored. It
	 * leaks one bit about the private calibration, which is a fine trade in a
	 * demo and not one to make in production — hence the flag, and hence the
	 * production config setting it false.
	 */
	compareToPublicCalibration: z.boolean(),
	evm: z.object({
		chainSelectorName: z.string(),
		/** The VerdictConsumer. `0x0…0` skips the write, so the enclave path can be run alone. */
		verdictConsumer: z.string(),
		gasLimit: z.string().optional(),
	}),
})
type Config = z.infer<typeof configSchema>

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

// ─── Inside the enclave ─────────────────────────────────────

/**
 * Fetch the evidence bundle over confidential HTTP, gated on a Vault secret.
 *
 * The gate is doing real work. `serveEvidence()` answers 401 without the exact
 * bearer token, so a successful fetch is itself the proof that the Vault DON
 * released the secret into this enclave — no logging of the token required,
 * and none done.
 *
 * `HTTPClient.sendRequest()` has a `TeeRuntime` overload, which is what keeps
 * the request and the response payload confidential from node operators. Do
 * NOT reach for `ConfidentialHTTPClient` here: it has no `TeeRuntime` overload
 * and is not meant to be called from a TEE handler.
 */
function fetchEvidence(runtime: TeeRuntime<Config>, token: string): string {
	const response = new cre.capabilities.HTTPClient()
		.sendRequest(runtime, {
			url: runtime.config.evidenceUrl,
			method: 'GET',
			multiHeaders: {
				Authorization: { values: [`Bearer ${token}`] },
			},
		})
		.result()

	if (!ok(response)) {
		// A 401 here means the Vault secret did not arrive, or the seller rotated
		// the token without updating the Vault. Either way there is no verdict to
		// give, and a verdict scored on absent evidence would be worse than none.
		throw new Error(`evidence fetch failed with status ${response.statusCode}`)
	}

	return text(response)
}

/**
 * Parse the seller's calibration out of a Vault secret.
 *
 * Total on purpose. A malformed or absent calibration must not take the
 * workflow down silently or, worse, produce a verdict that *looks* premium
 * while being the public one. It returns null, the caller scores with the
 * public thresholds, and the log says which happened.
 */
function parseCalibration(raw: string): Partial<Calibration> | null {
	const trimmed = raw.trim()
	if (trimmed.length === 0) return null
	const parsed = JSON.parse(trimmed) as unknown
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
	const out: Record<string, number> = {}
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
	}
	return Object.keys(out).length > 0 ? (out as Partial<Calibration>) : null
}

/**
 * The confidential half. Everything in here runs inside AWS Nitro; the runtime
 * is a `TeeRuntime`, not a `Runtime`, and the type system enforces the
 * difference until `usingTheDons()` is called.
 */
export const onCronTrigger = (runtime: TeeRuntime<Config>): string => {
	const config = runtime.config

	// ── 1. Two secrets, released by the Vault DON into this enclave only ──
	// There is nothing to declare upfront; they are decrypted at the moment
	// `getSecret()` runs, inside the attestation.
	const evidenceToken = runtime.getSecret({ id: config.evidenceSecretId }).result().value
	const calibrationRaw = runtime.getSecret({ id: config.calibrationSecretId }).result().value

	// ── 2. The evidence, over confidential HTTP ──
	const body = fetchEvidence(runtime, evidenceToken)
	const input = JSON.parse(body) as AnalystInput

	// The commitment to the evidence, taken over the bytes as received. The
	// seller's `premium.ts` hashes the file on disk the same way, so a buyer who
	// has paid can prove the report on chain is about the bundle they hold.
	const evidenceHash = keccak256(toHex(body))

	// ── 3. Score, with the seller's calibration ──
	const calibration = parseCalibration(calibrationRaw)
	const verdict = assess(input, calibration)
	const settled = compact(verdict, evidenceHash, input.now)

	// ⚠️ Enclave logs are visible in the simulator and nowhere else — in a real
	// run they do not leave the TEE. Even so, nothing logged here is a secret:
	// the hash and the compact verdict both go on chain a few lines below, and
	// the calibration is described by *how many* thresholds it overrode, never
	// by their values.
	runtime.log(`evidence: ${body.length} bytes for ${input.pool.name}, keccak256 ${evidenceHash}`)
	runtime.log(
		calibration === null
			? 'calibration: NONE — no Vault override, scoring with the public thresholds'
			: `calibration: ${Object.keys(calibration).length} sealed threshold overrides applied`,
	)
	runtime.log(`verdict: ${describeCompact(settled)}`)

	if (config.compareToPublicCalibration && calibration !== null) {
		const publicVerdict = assess(input)
		const agrees =
			publicVerdict.rating === verdict.rating &&
			Math.round(publicVerdict.confidence * 100) === Math.round(verdict.confidence * 100)
		runtime.log(
			agrees
				? `public calibration agrees on ${publicVerdict.rating} — the edge did not change this call`
				: `public calibration says ${publicVerdict.rating} at ${Math.round(publicVerdict.confidence * 100)}%, ` +
					`the sealed one says ${verdict.rating} at ${Math.round(verdict.confidence * 100)}% — ` +
					'this is the difference the Vault secret bought',
		)
	}

	// ── 4. The one-way door ──
	// Past this line we are on ordinary Workflow DON nodes and nothing is
	// confidential any more. So only `settled` crosses: no bundle, no
	// calibration, no reasoning. `input`, `body` and `calibration` are not
	// referenced again, and that is a rule, not an accident.
	const donRuntime = runtime.usingTheDons()

	return settleOnChain(donRuntime, config, settled)
}

// ─── Outside the enclave, on the DON ────────────────────────

/**
 * Put the compact verdict on chain through the CRE Forwarder.
 *
 * The report is signed by the DON after it has verified the enclave
 * attestation, so what lands in `VerdictConsumer` is not "the seller says
 * AVOID" — it is "an attested enclave running this published binary, over
 * evidence committed to by this hash, said AVOID". That distinction is the
 * entire product.
 */
function settleOnChain(runtime: Runtime<Config>, config: Config, settled: CompactVerdict): string {
	const summary = describeCompact(settled)

	if (config.evm.verdictConsumer.toLowerCase() === ZERO_ADDRESS) {
		// Deliberate escape hatch: the enclave half is worth running on its own
		// while the consumer is not yet deployed, and a workflow that cannot run
		// without a chain is a workflow nobody can debug.
		runtime.log('verdictConsumer is the zero address — skipping the on-chain write')
		return `${summary} (not settled: no consumer configured)`
	}

	const network = getNetwork({
		chainFamily: 'evm',
		chainSelectorName: config.evm.chainSelectorName,
		isTestnet: true,
	})
	if (!network) throw new Error(`network not found: ${config.evm.chainSelectorName}`)

	const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector)
	const payload = encodeVerdictReport(settled)

	const report = runtime.report(prepareReportRequest(payload)).result()
	const write = evmClient
		.writeReport(runtime, {
			receiver: config.evm.verdictConsumer as Address,
			report,
			gasConfig: config.evm.gasLimit ? { gasLimit: config.evm.gasLimit } : undefined,
		})
		.result()

	if (write.txStatus !== TxStatus.SUCCESS) {
		throw new Error(`verdict write failed: ${write.errorMessage || write.txStatus}`)
	}
	if (
		write.receiverContractExecutionStatus !== undefined &&
		write.receiverContractExecutionStatus !== 0
	) {
		throw new Error(`VerdictConsumer reverted: status ${write.receiverContractExecutionStatus}`)
	}

	const txHash = bytesToHex(write.txHash || new Uint8Array(32))
	runtime.log(`settled on ${config.evm.chainSelectorName}: ${txHash}`)
	return `${summary} — settled at ${txHash}`
}

// ─── Workflow Init ──────────────────────────────────────────
export function initWorkflow(config: Config) {
	const cronTrigger = new cre.capabilities.CronCapability()

	return [
		// `cre.handlerInTee`, not `cre.handler`. The third argument is the
		// `TeeConstraint`: this handler will only run in an AWS Nitro enclave in
		// us-west-2, which at the time of writing is the only registered TEE type
		// and region. Naming both rather than passing `{}` is the point — a
		// constraint you did not state is a constraint nobody verified.
		cre.handlerInTee(cronTrigger.trigger({ schedule: config.schedule }), onCronTrigger, [
			{ tee: 'nitro', regions: ['us-west-2'] },
		]),
	]
}
