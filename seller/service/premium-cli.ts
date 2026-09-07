// Terminal front end for the premium tier.
//
// This is what a buyer sees for their money: the whole verdict, and underneath
// it the on-chain record with an honest statement of how much that record is
// worth. Payment is not this script's business — see the seam note at the top
// of premium.ts.
//
//   node seller/service/premium-cli.ts \
//     --evidence seller/cre/fixtures/usdc-weth-500.json \
//     --consumer 0xEE72d3d0E4b090eBB8Db6abc26547bcd1fc9C5F2
//
// | Flag | |
// |---|---|
// | `--pool <address>` | the pool, when gathering fresh evidence |
// | `--evidence <file>` | score a pinned bundle instead — required to match a settled verdict |
// | `--consumer <address>` | where to look for the attested verdict (or TURNSTILE_VERDICT_CONSUMER) |
// | `--public` | score with the public thresholds, ignoring TURNSTILE_CALIBRATION |
// | `--json` | machine-readable |

import { onChainAttestations } from '../cre/attestation.ts';
import type { Calibration } from '../analyst/scoring.ts';
import { answerPremium } from './premium.ts';

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

const evidenceFile = arg('--evidence');
const pool = arg('--pool');
if (!pool && !evidenceFile) {
  console.error('need --pool <address> or --evidence <file>');
  process.exit(1);
}

const raw = process.argv.includes('--public') ? undefined : process.env.TURNSTILE_CALIBRATION;
const calibration = raw ? (JSON.parse(raw) as Partial<Calibration>) : null;

// The CLI is the composition root for the on-chain half, the same way
// `server.ts` is for the rails: it names the consumer once, here, and
// `premium.ts` never learns what one is.
const consumer = arg('--consumer') ?? process.env.TURNSTILE_VERDICT_CONSUMER;

const answer = await answerPremium({
  pool: pool ?? '',
  evidenceFile,
  calibration,
  attestations: consumer ? onChainAttestations({ consumer: consumer as `0x${string}` }) : undefined,
});

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(answer, null, 2));
  process.exit(0);
}

console.log(answer.rendered);
console.log();
console.log('─'.repeat(78));
console.log(`EVIDENCE   ${answer.evidence.bytes} bytes`);
console.log(`           keccak256 ${answer.evidence.hash}`);
console.log('           Hash the bundle in this response yourself and compare it to the chain.');
console.log();

const attestation = answer.attestation;
if (attestation === null) {
  console.log('ATTESTATION  none requested — pass --consumer <address>');
} else {
  console.log(`ATTESTATION  ${attestation.strength}`);
  console.log(`             ${attestation.note}`);
  if (attestation.strength !== 'none') {
    console.log(`             ${attestation.rating} at ${(attestation.confidenceBp / 100).toFixed(0)}% on chain`);
    if (attestation.failed.length > 0) console.log(`             failing ${attestation.failed.join(', ')}`);
    if (attestation.warned.length > 0) console.log(`             warning on ${attestation.warned.join(', ')}`);
    console.log(`             assessed ${new Date(attestation.assessedAt * 1000).toISOString()}`);
    console.log(`             settled  ${new Date(attestation.settledAt * 1000).toISOString()}`);
    console.log(
      `             evidence commitment ${attestation.commitsToEvidence ? 'MATCHES the bundle above' : 'DOES NOT match the bundle above'}`,
    );
    console.log(`             ${attestation.explorer}`);
  }
}

if (answer.caveats.length > 0) {
  console.log();
  console.log('WHAT THIS DOES NOT SAY');
  for (const caveat of answer.caveats) console.log(`  - ${caveat}`);
}
