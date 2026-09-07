import { Placeholder } from '../../components/Placeholder.tsx';

export const metadata = { title: 'Onboard — not built yet · Turnstile' };

export default function OnboardPage() {
  return (
    <Placeholder
      badge="Not built — MOV-223"
      title="Prove there is a person behind the org."
      body={
        <>
          <p style={{ marginTop: 0 }}>
            A buyer organization is operated by a human, and a mandate issued by nobody is worth
            nothing. This page will run World Selfie Check once per operator, and record the result
            against the organization.
          </p>
          <p>
            It is not built, and it cannot be faked in the meantime. The discovery store already
            carries a <span className="mono">world_verification</span> table; it is empty, and every
            agent on the market page therefore reports{' '}
            <span className="mono">unknown</span> — deliberately not{' '}
            <span className="mono">unverified</span>, which would be a claim we have not earned.
          </p>
        </>
      }
      spec={[
        { key: 'Delivered by', value: 'MOV-223 — World Selfie Check for buyer organization operators' },
        {
          key: 'Blocked on',
          value:
            'A World Sandbox approval that has not arrived. Without it there is no credential to verify against, so no verification can be performed or shown.',
        },
        {
          key: 'Will contain',
          value:
            'Run Selfie Check for an operator, bind the result to the organization, and surface a verification state on every seller and buyer in the directory.',
        },
        {
          key: 'Visible today',
          value:
            'The seam is already wired. world_verification is a real table with a real reader, returning unknown for all 197 agents because it holds no rows.',
        },
      ]}
    />
  );
}
