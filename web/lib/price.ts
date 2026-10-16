// How a price — or the absence of one — is described to a buyer.
//
// The six sources are not six styles of the same thing. Some are a number in a
// unit you can act on; one (Virtuals ACP) is a number with no unit at all; the
// rest are different reasons you cannot get one, and a buyer's agent has to
// tell them apart to decide whether to ask, to skip, or to look elsewhere.
// Collapsing them into a blank cell is the bug this whole page argues against,
// so each has its own words.
//
// **Correction (2026-10-16, TUR-1):** this page used to have three tones and,
// in practice, one priced row: ours. Capminal's live x402 v2 quote and 76
// Virtuals ACP job prices were in the store's reach and were missed. `raw` is
// the tone for a price published with no currency, so a number nobody can
// compare is not drawn in the same brass as one that can.

import type { PriceSource, SellerResult } from './discovery.ts';

export type Tone = 'turnstile' | 'raw' | 'ask' | 'none';

export interface SlotCopy {
  /**
   * Which visual state this price gets. `turnstile` is any price in a unit we
   * can convert to dollars, whoever published it; `raw` is a published number
   * with no convertible unit.
   */
  tone: Tone;
  source: string;
  value: string;
  note: string;
}

/** Copy for the sources that carry a number. Tone and value come from the number itself. */
const PUBLISHED: Partial<Record<PriceSource, { source: string; note: string }>> = {
  turnstile: {
    source: 'ENS resolver record',
    note: 'Published as turnstile:price on this seller’s ENSv2 name. Readable by anyone, without asking the seller.',
  },
  x402: {
    source: 'live x402 quote',
    note: 'Quoted by one of this agent’s endpoints in an HTTP 402 response when we probed it. A quote is perishable; ask again before paying.',
  },
  document: {
    source: 'registration document',
    note: 'Stated in the agent’s own registration document.',
  },
  acp: {
    source: 'Virtuals ACP job offerings',
    note: 'Per-job prices from the Virtuals-only jobOfferings field in this agent’s document. No currency or asset is published, so they are shown as written and never compared to a dollar ceiling.',
  },
};

export function priceSlot(seller: SellerResult): SlotCopy {
  const price = seller.price;
  // `price` is null for both 'ask_x402' and 'none', so it cannot be the thing
  // that distinguishes them. `priceSource` carries the reason.
  const source: PriceSource = seller.priceSource;
  const copy = PUBLISHED[source];

  if (price && copy) {
    return {
      ...copy,
      // A number with no convertible unit is `raw`, not brass.
      tone: price.usd !== null ? 'turnstile' : 'raw',
      value: price.usd !== null ? `$${price.usd.toFixed(2)}` : `${price.raw}${price.currency ? ` ${price.currency}` : ''}`,
    };
  }

  if (source === 'ask_x402') {
    return {
      tone: 'ask',
      source: 'x402 advertised',
      value: 'No knowable price',
      note: 'The agent says it takes x402 payments, but no endpoint of it has answered a payable 402 on record, and its document states no price.',
    };
  }

  return {
    tone: 'none',
    source: 'nothing published',
    value: 'No knowable price',
    note: 'No price on chain, in its document, or behind an endpoint that can be asked.',
  };
}

/** The buckets the legibility strip is drawn from, in strip order. */
export const TONE_ORDER: Tone[] = ['turnstile', 'raw', 'ask', 'none'];

export function shortAddress(a: string | null | undefined): string {
  if (!a) return '—';
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
