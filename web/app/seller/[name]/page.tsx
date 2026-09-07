import Link from 'next/link';

import { readOffer } from '../../../lib/ens.ts';
import { shortAddress } from '../../../lib/price.ts';

export const dynamic = 'force-dynamic';

export default async function SellerPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const offer = await readOffer(decodeURIComponent(name));

  if (!offer.ok) {
    return (
      <div className="wrap placeholder">
        <span className="placeholder-badge">Not read</span>
        <h1 className="placeholder-title">{offer.ensName ?? decodeURIComponent(name)}</h1>
        <p className="placeholder-body">{offer.reason}</p>
        <p className="placeholder-body">
          <Link href="/">Back to the market</Link>
        </p>
      </div>
    );
  }

  const o = offer.offer;
  const explorer = `https://sepolia.etherscan.io/address/${offer.resolver}`;

  return (
    <div className="wrap seller">
      <div className="seller-head">
        <div>
          <p className="eyebrow">ENSv2 name · chain {offer.chainId} · read live</p>
          <h1 className="seller-name">{offer.ensName}</h1>
        </div>
        <p className="readout">
          read at block <b>{offer.readAtBlock.toLocaleString('en-US')}</b>
          <br />
          resolver{' '}
          <a href={explorer} target="_blank" rel="noreferrer">
            {shortAddress(offer.resolver)}
          </a>
          <br />
          {new Date(offer.readAt).toISOString().replace('T', ' ').slice(0, 19)} UTC
        </p>
      </div>

      {o.agentContext ? <p className="lede">{o.agentContext}</p> : null}

      <div className="price-band">
        <div className="band-cell is-price">
          <p className="band-label">Price per query</p>
          <p className="band-value">{o.price ? `$${o.price}` : 'unset'}</p>
          <p className="band-sub">
            turnstile:price, written by the hot key. This is the number the market page shows, read
            from the same record.
          </p>
        </div>
        <div className="band-cell">
          <p className="band-label">Ceiling</p>
          <p className="band-value">{o.priceCeiling ? `$${o.priceCeiling}` : 'unset'}</p>
          <p className="band-sub">
            Written by the cold key. The key that sets the price cannot raise this.
          </p>
        </div>
        <div className="band-cell">
          <p className="band-label">Rails</p>
          <p className="band-value" style={{ fontSize: 17 }}>{o.rails ?? 'unset'}</p>
          <p className="band-sub">How a buyer may settle for an answer.</p>
        </div>
        <div className="band-cell">
          <p className="band-label">Payout</p>
          <p className="band-value" style={{ fontSize: 17 }}>{shortAddress(o.payoutAddr)}</p>
          <p className="band-sub">Where payment lands, from the resolver’s addr record.</p>
        </div>
      </div>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">What the resolver returns</h2>
          <p className="results-count">{offer.records.filter((r) => r.value !== null).length} of {offer.records.length} keys set</p>
        </div>
        <p className="section-note">
          Every row is one <span className="mono">text(node, key)</span> call against resolver{' '}
          <span className="mono">{offer.resolver}</span> on Sepolia, made when this page was
          requested. Nothing here is cached, and no value is stored in the app — reload and the
          block number moves.
        </p>
        <ul className="records">
          {offer.records.map((r) => (
            <li className="record" key={r.key}>
              <div>
                <span className={`record-family${r.family === 'turnstile' ? ' is-turnstile' : ''}`}>
                  {r.family === 'addr' ? 'resolver addr' : r.family}
                </span>
                <div className="record-key">{r.key}</div>
              </div>
              <div>
                <p className={`record-value${r.value === null ? ' is-unset' : ''}`}>
                  {r.value ?? 'unset on chain'}
                </p>
                {r.note ? <p className="record-note">{r.note}</p> : null}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">What was checked</h2>
        </div>
        <p className="section-note">
          A name can claim any agent id it likes, and any contract can call itself a resolver. Both
          claims are checked against the other side before this page treats the price as one a buyer
          could act on.
        </p>
        <div className="checks">
          <div className={`check-card is-${offer.linked ? 'pass' : 'fail'}`}>
            <p className="check-title">Two-way agent link</p>
            <p className="check-body">
              {offer.linked
                ? `The name carries the ENSIP-25 record naming agent ${offer.agentId}, and the registry’s tokenURI(${offer.agentId}) returns this name back.`
                : 'The two directions do not agree, so this name’s claim on that agent id is unilateral and is not trusted.'}
            </p>
          </div>
          <div className={`check-card is-${o.resolverVerified ? 'pass' : 'fail'}`}>
            <p className="check-title">Resolver verified</p>
            <p className="check-body">
              {o.resolverVerified
                ? `VerifiableFactory.verifyContract returned the stock ENS PermissionedResolver implementation at ${shortAddress(o.resolverImplementation)}.`
                : 'The resolver did not verify as a stock ENS implementation, so its records are a claim rather than a guarantee.'}
            </p>
          </div>
          <div className="check-card is-pass">
            <p className="check-title">ERC-8004 registration</p>
            <p className="check-body">
              Agent {offer.agentId} in registry {shortAddress(offer.identityRegistry)}.{' '}
              <span className="mono">{offer.agentUid}</span>
            </p>
          </div>
          <div className={`check-card is-${o.operatorProof ? 'pass' : 'fail'}`}>
            <p className="check-title">Operator proof</p>
            <p className="check-body">
              {o.operatorProof
                ? `The operator identity is held as ${o.operatorProof} — the cold tier, which is the only key that may move the payout address or raise the ceiling.`
                : 'No operator proof record is set.'}
            </p>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Where to ask</h2>
        </div>
        <p className="section-note">
          The MCP endpoint published in <span className="mono">agent-endpoint[mcp]</span> is{' '}
          <span className="mono">{o.mcpEndpoint ?? 'unset'}</span>.{' '}
          <strong style={{ color: 'var(--chalk)' }}>
            That host does not answer yet — the seller service is MOV-219/220 and is not deployed.
          </strong>{' '}
          The record is real and readable on chain; the service behind it is not up. This page says
          so rather than showing a working endpoint it cannot demonstrate.
        </p>
      </section>
    </div>
  );
}
