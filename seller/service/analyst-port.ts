// The real analyst, behind the `AnalystPort` the app is written against.
//
// It is deliberately thin, and the split it preserves is MOV-227's:
//
//   gatherInput(...)  ->  AnalystInput  ->  assess(...)  ->  Verdict
//   ^ does the I/O         ^ plain JSON      ^ pure
//
// Calling the two halves separately rather than `analyzePool()` is what lets the
// premium tier hand back the `AnalystInput` alongside the verdict. When MOV-227
// moves `assess` into a Chainlink TEE, the change is to the middle line here and
// to nothing else — `gatherInput` keeps running outside the enclave and the
// service keeps seeing an `AnalystPort`.

import { gatherInput } from '../analyst/analyst.ts';
import { assess } from '../analyst/scoring.ts';
import type { AnalystInput, Verdict } from '../analyst/types.ts';
import type { AnalystPort } from './app.ts';

export interface LiveAnalystOptions {
  /** Hours of closed snapshots to pull. The analyst's default is 48. */
  hours?: number;
}

export function liveAnalyst(options: LiveAnalystOptions = {}): AnalystPort {
  return {
    async analyze(pool: string, { liveDepth }: { liveDepth: boolean }): Promise<{ verdict: Verdict; input: AnalystInput }> {
      const input = await gatherInput({
        pool,
        // The standard/premium difference, and most of the cost difference: a
        // live quote is an RPC round trip per rung of the depth ladder. The
        // verdict says out loud that it is flying blind without one, and loses
        // confidence for it, rather than quietly scoring on history alone.
        skipDepth: !liveDepth,
        ...(options.hours === undefined ? {} : { hours: options.hours }),
      });
      return { verdict: assess(input), input };
    },
  };
}
