'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { DiscoveryResponse, FindSellersResult, SellerResult } from '../lib/discovery.ts';
import { priceSlot, shortAddress } from '../lib/price.ts';

type Tone = 'turnstile' | 'ask' | 'none';

interface Props {
  initial: FindSellersResult;
  provenanceLabel: string;
  capturedAt: string | null;
}

interface Filters {
  capability: string;
  chains: string[];
  maxPrice: string;
  x402Only: boolean;
  tones: Tone[];
}

const EMPTY: Filters = { capability: '', chains: [], maxPrice: '', x402Only: false, tones: [] };

/** Server-side filters go to /api/sellers; the tone filter is a view of what came back. */
function toQuery(f: Filters): string {
  const sp = new URLSearchParams();
  if (f.capability.trim()) sp.set('capability', f.capability.trim());
  if (f.chains.length) sp.set('chain', f.chains.join(','));
  if (f.maxPrice.trim() && Number.isFinite(Number(f.maxPrice))) sp.set('maxPrice', f.maxPrice.trim());
  if (f.x402Only) sp.set('x402', 'true');
  sp.set('includeUnknownPrice', 'true');
  sp.set('limit', '200');
  return sp.toString();
}

export function Market({ initial, provenanceLabel, capturedAt }: Props) {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [result, setResult] = useState<FindSellersResult>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef(true);

  const query = toQuery(filters);

  useEffect(() => {
    // The first render already has server-rendered data; do not refetch it.
    if (first.current) {
      first.current = false;
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    fetch(`/api/sellers?${query}`, { signal: controller.signal })
      .then(async (r) => {
        const body = (await r.json()) as DiscoveryResponse | { error: string };
        if (!r.ok || !('ok' in body) || !body.ok) {
          throw new Error('error' in body ? body.error : 'The discovery store did not answer.');
        }
        setResult(body.result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [query]);

  const withTone = useMemo(
    () => result.sellers.map((s) => ({ seller: s, slot: priceSlot(s) })),
    [result],
  );

  const counts = useMemo(() => {
    const c: Record<Tone, number> = { turnstile: 0, ask: 0, none: 0 };
    for (const { slot } of withTone) c[slot.tone] += 1;
    return c;
  }, [withTone]);

  const shown = useMemo(
    () => (filters.tones.length ? withTone.filter((r) => filters.tones.includes(r.slot.tone)) : withTone),
    [withTone, filters.tones],
  );

  // Grouped, so the strip reads as a proportion and the single readable price
  // sits at the head of it rather than being lost somewhere in the middle.
  const strip = useMemo(() => {
    const order: Tone[] = ['turnstile', 'ask', 'none'];
    return order.flatMap((tone) => withTone.filter((r) => r.slot.tone === tone).map((r) => ({ tone, ...r })));
  }, [withTone]);

  const toggleTone = useCallback((tone: Tone) => {
    setFilters((f) => ({
      ...f,
      tones: f.tones.includes(tone) ? f.tones.filter((t) => t !== tone) : [...f.tones, tone],
    }));
  }, []);

  const toggleChain = useCallback((network: string) => {
    setFilters((f) => ({
      ...f,
      chains: f.chains.includes(network) ? f.chains.filter((c) => c !== network) : [...f.chains, network],
    }));
  }, []);

  const total = result.coverage.totalAgents;
  const dirty = query !== toQuery(EMPTY) || filters.tones.length > 0;

  return (
    <>
      <section className="hero">
        <div className="wrap">
          <div className="hero-top">
            <div>
              <p className="eyebrow">
                Live ERC-8004 directory · {result.coverage.chains.length} chains ·{' '}
                {provenanceLabel}
                {capturedAt ? ` · captured ${capturedAt.slice(0, 10)}` : ''}
              </p>
              <h1 className="display">
                {withTone.length} agents.<br />
                <span className="lit">{counts.turnstile === 1 ? 'One posts a price.' : `${counts.turnstile} post a price.`}</span>
              </h1>
              <p className="lede">
                Every agent here is a real registration read off the ERC-8004 Identity Registry on
                Base, Ethereum mainnet and Sepolia. Registration carries no price field, and under
                x402 the quote lives in an HTTP 402 response that has to be asked for. So almost
                nobody in this directory can tell you what they cost.
              </p>
            </div>
            <p className="thesis">
              The registry tells you <span className="lit">who exists</span>.<br />
              Turnstile tells you <span className="lit">what they cost</span>.
            </p>
          </div>

          <div className="legibility">
            <ul
              className="legibility-strip"
              style={{ ['--cells' as string]: Math.max(withTone.length, 1) }}
              aria-label={`Price legibility across ${withTone.length} agents`}
            >
              {strip.map(({ seller, tone }, i) => (
                <li
                  key={seller.agentUid}
                  className={`cell is-${tone}`}
                  style={{ animationDelay: `${Math.min(i * 3, 600)}ms` }}
                  title={`${seller.name ?? seller.agentUid} — ${priceSlot(seller).value}`}
                />
              ))}
            </ul>
            {counts.turnstile > 0 ? (
              <p className="legibility-marker">
                <span aria-hidden="true">↑</span> the readable {counts.turnstile === 1 ? 'one' : `${counts.turnstile}`}
              </p>
            ) : null}

            <ul className="legend">
              {([
                ['turnstile', counts.turnstile, 'posted on chain'],
                ['ask', counts.ask, 'askable · none answer'],
                ['none', counts.none, 'no price at all'],
              ] as [Tone, number, string][]).map(([tone, n, label]) => (
                <li key={tone}>
                  <button
                    type="button"
                    className="legend-item"
                    aria-pressed={filters.tones.includes(tone)}
                    onClick={() => toggleTone(tone)}
                  >
                    <span className={`swatch is-${tone}`} aria-hidden="true" />
                    <span className="legend-count">{n}</span>
                    <span>{label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <div className="wrap market">
        <aside className="filters">
          <div className="field">
            <label className="field-label" htmlFor="capability">Capability</label>
            <input
              id="capability"
              className="input"
              placeholder="liquidity, mcp, reputation…"
              value={filters.capability}
              onChange={(e) => setFilters((f) => ({ ...f, capability: e.target.value }))}
            />
          </div>

          <div className="field">
            <span className="field-label">Chain</span>
            {result.coverage.chains.map((c) => (
              <label key={c.network} className="check">
                <input
                  type="checkbox"
                  checked={filters.chains.includes(c.network)}
                  onChange={() => toggleChain(c.network)}
                />
                {c.network}
                <span className="check-count">{c.agents}</span>
              </label>
            ))}
          </div>

          <div className="field">
            <label className="field-label" htmlFor="maxPrice">Max price (USD)</label>
            <input
              id="maxPrice"
              className="input"
              inputMode="decimal"
              placeholder="0.10"
              value={filters.maxPrice}
              onChange={(e) => setFilters((f) => ({ ...f, maxPrice: e.target.value }))}
            />
            <span className="record-note" style={{ margin: 0 }}>
              Agents with no knowable price stay in the list, flagged. A ceiling cannot exclude a
              price nobody can read.
            </span>
          </div>

          <div className="field">
            <span className="field-label">Signals</span>
            <label className="check">
              <input
                type="checkbox"
                checked={filters.x402Only}
                onChange={(e) => setFilters((f) => ({ ...f, x402Only: e.target.checked }))}
              />
              advertises x402
            </label>
          </div>

          {dirty ? (
            <button type="button" className="reset" onClick={() => setFilters(EMPTY)}>
              Clear filters
            </button>
          ) : null}
        </aside>

        <section>
          <div className="results-head">
            <p className="results-count">
              <b>{shown.length}</b> shown · <b>{withTone.length}</b> matched · <b>{total}</b> in the
              directory
              {loading ? ' · reading…' : ''}
            </p>
            <p className="results-count">
              ranked by {result.ranking.basis.replace(/_/g, ' ')}
              {result.ranking.placeholder ? ' — placeholder' : ''}
            </p>
          </div>

          {result.ranking.placeholder ? (
            <p className="notice" style={{ margin: '18px 0 0' }}>
              <span className="notice-title">Ranking is not a reputation signal</span>
              {result.ranking.note.replace(/^PLACEHOLDER:\s*/, '')}
            </p>
          ) : null}

          {error ? (
            <p className="notice is-warn" style={{ margin: '18px 0 0' }}>
              <span className="notice-title">The directory did not answer</span>
              {error}
            </p>
          ) : null}

          {shown.length === 0 ? (
            <div className="empty">
              <p className="empty-title">Nothing matches those filters.</p>
              <p>No agent in the directory fits. Widen the capability or clear a chain.</p>
            </div>
          ) : (
            <ul className="rows">
              {shown.map(({ seller, slot }) => (
                <Row key={seller.agentUid} seller={seller} slot={slot} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

function Row({ seller, slot }: { seller: SellerResult; slot: ReturnType<typeof priceSlot> }) {
  const ens = seller.turnstile?.ensName;
  return (
    <li className={`row${ens ? ' is-seller' : ''}`}>
      <div>
        <p className="row-meta">
          <span className="chain-tag">{seller.network}</span>
          <span className="mono">#{seller.agentId}</span>
          {seller.x402Support ? <span>x402</span> : null}
          {seller.documentState === 'failed' ? <span>document unreachable</span> : null}
        </p>
        <h2 className={`row-name${!ens && !seller.name ? ' is-unnamed' : ''}`}>
          {ens ? (
            <Link href={`/seller/${encodeURIComponent(ens)}`}>{ens}</Link>
          ) : (
            seller.name ?? 'No name published'
          )}
        </h2>
        {seller.description ? <p className="row-desc">{seller.description}</p> : null}
        {!seller.name && !ens ? <p className="row-uid">{seller.agentUid}</p> : null}
        <p className="row-meta" style={{ marginTop: 11, marginBottom: 0 }}>
          <span>
            pays to <span className="addr">{shortAddress(seller.payTo)}</span>
          </span>
        </p>
        {seller.capabilities.length ? (
          <ul className="caps">
            {seller.capabilities.slice(0, 8).map((c) => (
              <li key={c} className="cap">{c}</li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className={`slot is-${slot.tone}`}>
        <p className="slot-source">{slot.source}</p>
        <p className="slot-value">{slot.value}</p>
        {seller.turnstile?.priceCeiling ? (
          <p className="slot-ceiling">ceiling ${seller.turnstile.priceCeiling}</p>
        ) : null}
        <p className="slot-note">{slot.note}</p>
      </div>
    </li>
  );
}
