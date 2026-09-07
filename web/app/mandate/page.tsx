import { Placeholder } from '../../components/Placeholder.tsx';

export const metadata = { title: 'Mandate — not built yet · Turnstile' };

export default function MandatePage() {
  return (
    <Placeholder
      badge="Not built — MOV-228"
      title="Issue a mandate."
      body={
        <>
          <p style={{ marginTop: 0 }}>
            A mandate is the warm tier: an organization wallet authorises an agent to spend up to a
            cap, on named rails, without ever handing it the key that set the cap. This page will be
            where that mandate is issued and revoked.
          </p>
          <p>
            It is not built. It needs the Privy organization wallet and policy engine from MOV-228,
            which has not been started. Rather than show a mandate form backed by nothing, this
            route says what it will be.
          </p>
        </>
      }
      spec={[
        { key: 'Delivered by', value: 'MOV-228 — Privy warm-tier organization wallet and mandate policy' },
        { key: 'Blocked on', value: 'MOV-228 not started. No Privy app, no policy engine, no mandate to display.' },
        {
          key: 'Will contain',
          value:
            'Issue a mandate against an organization wallet; set a spending cap and allowed rails; add or remove an agent; revoke. Quorum is required to raise a cap.',
        },
        {
          key: 'The invariant',
          value:
            'The hot key spends within the mandate and can never widen it. Raising a cap is a warm-tier action; rotating a key or moving a payout address is a cold-tier one.',
        },
      ]}
    />
  );
}
