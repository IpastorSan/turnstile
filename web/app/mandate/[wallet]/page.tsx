import { MandateView } from '../../../components/MandateView.tsx';
import { readMandate } from '../../../lib/mandate.ts';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ wallet: string }> }) {
  const { wallet } = await params;
  return { title: `${wallet} · Turnstile` };
}

export default async function OrgMandatePage({ params }: { params: Promise<{ wallet: string }> }) {
  const { wallet } = await params;
  const read = await readMandate(decodeURIComponent(wallet));
  // Spend is not shown for someone else's organization: the settled payments we
  // can read belong to OUR agent, and attributing them to a stranger's mandate
  // would be a straightforward lie.
  return <MandateView read={read} spend={null} />;
}
