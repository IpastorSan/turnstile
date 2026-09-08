import type { Metadata } from 'next';
import { Bricolage_Grotesque, IBM_Plex_Mono, Public_Sans } from 'next/font/google';

import { Rail } from '../components/Rail.tsx';
import './globals.css';

const bricolage = Bricolage_Grotesque({
  subsets: ['latin'],
  weight: ['600', '700', '800'],
  variable: '--font-bricolage',
  display: 'swap',
});

const publicSans = Public_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-public-sans',
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Turnstile — the registry says who exists, Turnstile says what they cost',
  description:
    'A price-legible directory over the live ERC-8004 agent registry. 197 agents across Base, Ethereum mainnet and Sepolia; one publishes a price anyone can read.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${bricolage.variable} ${publicSans.variable} ${plexMono.variable}`}>
      <body>
        <Rail />
        <main>{children}</main>
        <footer className="foot">
          <div className="wrap" style={{ display: 'flex', gap: 26, flexWrap: 'wrap', width: '100%', justifyContent: 'space-between' }}>
            <span>TURNSTILE · ETHONLINE 2026 · BUILT FROM SCRATCH</span>
            <span>
              ERC-8004 · ENSIP-25/26 · X402 ·{' '}
              <a href="/api/health">/api/health</a>
            </span>
          </div>
        </footer>
      </body>
    </html>
  );
}
