import { MandateView } from '../../components/MandateView.tsx';
import { readMandate } from '../../lib/mandate.ts';
import { readSpend } from '../../lib/spend.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'The mandate · Turnstile' };

export default async function MandatePage() {
  const agentAddress = process.env['ARC_AGENT_ADDRESS'] ?? '0x0633a193017939Bb1eB242982397224c66948e2F';
  const [read, spend] = await Promise.all([readMandate(), readSpend(agentAddress)]);
  // The demo org is the only one whose operator keys are in `.env`, so it is the
  // only one where the cap-raise probe has anything to sign with.
  return <MandateView read={read} spend={spend} probe />;
}
