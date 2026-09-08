// How a price — or the absence of one — is described to a buyer.
//
// The five sources are not five styles of the same thing. Two of them are a
// number you can act on; three of them are different reasons you cannot get
// one, and a buyer's agent has to tell them apart to decide whether to ask, to
// skip, or to look elsewhere. Collapsing them into a blank cell is the bug this
// whole page argues against, so each has its own words.

import type { PriceSource, SellerResult } from './discovery.ts';

export interface SlotCopy {
  /** Which of the three visual states this price gets. */
  tone: 'turnstile' | 'ask' | 'none';
  source: string;
  value: string;
  note: string;
}

export function priceSlot(seller: SellerResult): SlotCopy {
  const price = seller.price;
  // `price` is null for both 'ask_x402' and 'none', so it cannot be the thing
  // that distinguishes them. `priceSource` carries the reason.
  const source: PriceSource = seller.priceSource;

  if (source === 'turnstile' && price) {
    return {
      tone: 'turnstile',
      source: 'ENS resolver record',
      value: price.usd !== null ? `$${price.usd.toFixed(2)}` : price.raw,
      note: 'Published as turnstile:price on this seller’s ENSv2 name. Readable by anyone, without asking the seller.',
    };
  }

  if (source === 'x402' && price) {
    return {
      tone: 'turnstile',
      source: 'live 402 quote',
      value: price.usd !== null ? `$${price.usd.toFixed(2)}` : price.raw,
      note: 'Quoted by the endpoint just now, in an HTTP 402 response.',
    };
  }

  if (source === 'document' && price) {
    return {
      tone: 'turnstile',
      source: 'registration document',
      value: price.usd !== null ? `$${price.usd.toFixed(2)}` : price.raw,
      note: 'Stated in the agent’s own registration document.',
    };
  }

  if (source === 'ask_x402') {
    return {
      tone: 'ask',
      source: 'x402 advertised',
      value: 'No knowable price',
      note: 'A price exists, but only this agent’s endpoint can quote it, and it does not answer a 402.',
    };
  }

  return {
    tone: 'none',
    source: 'nothing published',
    value: 'No knowable price',
    note: 'No price on chain, in its document, or behind an endpoint that can be asked.',
  };
}

/** The three buckets the legibility strip is drawn from, in strip order. */
export function priceTone(seller: SellerResult): 'turnstile' | 'ask' | 'none' {
  return priceSlot(seller).tone;
}

export function shortAddress(a: string | null | undefined): string {
  if (!a) return '—';
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
