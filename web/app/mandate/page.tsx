import { Placeholder } from '../../components/Placeholder.tsx';

export const metadata = { title: 'Mandate — page not built · Turnstile' };

export default function MandatePage() {
  return (
    <Placeholder
      badge="Page not built — the mandate is live"
      title="Issue a mandate."
      body={
        <>
          <p style={{ marginTop: 0 }}>
            A mandate is the warm tier: an organization wallet authorises an agent to spend up to a
            cap, on named rails, without ever handing it the key that set the cap. This page will be
            where that mandate is issued and revoked.
          </p>
          <p>
            The mandate itself is live. MOV-228 delivered the Privy organization wallet, the
            operations and board key quorums and the policy that governs the cap, and the org
            wallet has signed on chain. What is missing is this page: the flow runs from the CLI
            (<span className="mono">npm run privy:mandate</span>), not from a browser. Rather than
            wrap a working system in a form we have not tested, this route says where it actually
            lives.
          </p>
        </>
      }
      spec={[
        { key: 'Delivered by', value: 'MOV-228 — Privy warm-tier organization wallet and mandate policy. Done.' },
        {
          key: 'Run it today',
          value:
            'npm run privy:mandate — issues a mandate, funds the agent through depositFor, and refuses a cap raise carrying one operator signature where two are required.',
        },
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
