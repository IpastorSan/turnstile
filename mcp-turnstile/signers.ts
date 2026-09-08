// Which rails this buyer can actually pay on, and a precise account of why not
// for the ones it cannot.
//
// A wallet is not an API key, and the difference is the whole point of the
// narrative this server exists to demonstrate. Nothing here reads a service
// credential: there is no account with a seller, no bearer token, no signup. The
// one secret is the buyer agent's own key, it is the hot tier from `CLAUDE.md`,
// and it can do exactly one thing — sign a transfer inside a mandate it cannot
// widen. Discovery, quoting and receipt-reading need no secret at all.
//
// A missing key is reported as a named, fixable gap rather than an exception,
// because the tools stay useful without one: `find_sellers` and `get_offer` need
// no credential, and `purchase` still fetches the real 402 and reports the real
// quote before stopping at `no_signer`.

import type { RailSigner } from '../buyer/watchdog/pay.ts';

export interface SignerGap {
  railId: string;
  /** Environment variables that would make this rail available. */
  needs: string[];
  why: string;
}

export interface SignerSet {
  signers: RailSigner[];
  gaps: SignerGap[];
}

/**
 * One entry per buyer-side rail. Adding a rail is adding a row.
 *
 * The factory is a dynamic import so that a rail whose SDK is heavy, or whose
 * constructor reaches for the network to price its asset — the Hedera one reads
 * the network exchange rate, because a cap denominated through the seller's own
 * arithmetic is not a cap — costs nothing when its key is absent.
 */
const RAILS: { railId: string; needs: string[]; load: () => Promise<RailSigner> }[] = [
  {
    railId: 'hedera-x402',
    needs: ['HEDERA_BUYER_ID', 'HEDERA_BUYER_KEY'],
    load: async () => (await import('../buyer/watchdog/hedera-signer.ts')).createHederaSigner(),
  },
];

/**
 * Build every signer whose credentials are present.
 *
 * Never throws for a missing key: that is a gap, and the caller has something
 * useful to do with it. A signer whose construction *fails* — a malformed key,
 * an unreachable rate source — is also a gap, with the error as the reason.
 */
export async function loadSigners(only?: readonly string[]): Promise<SignerSet> {
  const signers: RailSigner[] = [];
  const gaps: SignerGap[] = [];

  for (const rail of RAILS) {
    if (only && only.length > 0 && !only.includes(rail.railId)) continue;
    const missing = rail.needs.filter((name) => !process.env[name]);
    if (missing.length > 0) {
      gaps.push({
        railId: rail.railId,
        needs: rail.needs,
        why: `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set`,
      });
      continue;
    }
    try {
      signers.push(await rail.load());
    } catch (cause) {
      gaps.push({
        railId: rail.railId,
        needs: rail.needs,
        why: `the signer could not be built: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }
  }

  return { signers, gaps };
}

/** Every rail a buyer could hold a signer for, whether or not it is configured. */
export function knownRails(): readonly string[] {
  return RAILS.map((r) => r.railId);
}
