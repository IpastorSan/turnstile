import Link from 'next/link';

import { SelfieCheck } from '../../components/SelfieCheck.tsx';
import { LISTINGS_PER_HUMAN, OPERATOR_ACTION, worldIsConfigured } from '../../../identity/index.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Prove a human is behind it · Turnstile' };

const SELLER = 'liquidity.turnstile.eth';

export default function OnboardPage() {
  const configured = worldIsConfigured();

  return (
    <div className="wrap seller">
      <div className="seller-head">
        <div>
          <p className="eyebrow">The abuse model · World Selfie Check</p>
          <h1 className="seller-name">Prove a human is behind it</h1>
        </div>
      </div>

      <p className="lede">
        A registry anyone can write to is a registry anyone can flood. One operator with a script
        can hold two hundred subnames, publish two hundred prices, and bury every honest seller in
        a ranking. Proof of personhood is what makes &ldquo;one human&rdquo; checkable, and it caps
        how much of the market a single person may occupy.
      </p>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">What this is, and is not</h2>
        </div>
        <p className="section-note">
          It is <b>not a login</b>. Nothing here signs you in, and no account is created. Selfie
          Check answers exactly one question — is this the same human as that other listing — and
          the answer is used for one thing: {LISTINGS_PER_HUMAN} listings per person, and the
          {' '}{LISTINGS_PER_HUMAN + 1}th is refused.
        </p>
        <p className="section-note">
          {LISTINGS_PER_HUMAN} rather than one, because a real operator sells more than one thing.
          A liquidity analyst and a depth analyst are different services at different prices. The
          limit is here to make farming expensive, not to make a second honest listing impossible.
        </p>
        <p className="section-note">
          The proof is verified by World&rsquo;s Developer Portal on our backend, never in your
          browser, and the nullifier it returns is never sent back to the page. A nullifier is a
          stable pseudonym for one person within one app, so handing it to a browser would let
          anyone correlate listings to a human. We keep it, count with it, and return only the
          tally.
        </p>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Verify {SELLER}</h2>
          <p className="results-count">action {OPERATOR_ACTION}</p>
        </div>

        {configured ? (
          <SelfieCheck agentUid={SELLER} />
        ) : (
          <div className="probe">
            <p className="probe-result is-bad">
              <b>Not configured on this deployment.</b>
              <br />
              WORLD_APP_ID, WORLD_RP_ID and WORLD_RP_SIGNING_KEY are read from the environment and
              at least one is missing. The page says so rather than showing a button that cannot
              work.
            </p>
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">What it changes</h2>
        </div>
        <p className="section-note">
          Every agent on the market page carries a verification state. Before any proof exists that
          state is <span className="mono">unknown</span>, never{' '}
          <span className="mono">unverified</span> — absence of a proof is not evidence of a failed
          one, and reporting it as a failure would be a claim we have not earned.
        </p>
        <p className="section-note">
          A mandate can also require one. <span className="mono">verifiedOperatorOnly</span> in{' '}
          <span className="mono">buyer/mandate/</span> refuses to pay a seller whose operator is not
          verified, so a buyer&rsquo;s agent can decline to trade with anonymous sellers without
          anyone maintaining a list.
        </p>
        <p className="section-note">
          <Link href="/">← The market page, with every agent&rsquo;s verification state</Link>
        </p>
      </section>
    </div>
  );
}
