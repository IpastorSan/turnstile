'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * A route marked `pending` is a real route with nothing real behind it yet. They
 * are marked in the navigation rather than hidden, because a judge clicking
 * through should find out what is not built from the site itself rather than
 * from a README.
 *
 * `/mandate` was marked pending until 2026-09-08 and no longer is: it reads the
 * live organization from Privy, shows what the agent actually settled on both
 * rails, and lets anyone create their own. `/onboard` was marked pending until
 * 2026-09-13: the World Sandbox approval arrived on 2026-09-09, a real Selfie Check
 * proof was verified on 2026-09-11, and the market reads it (MOV-277).
 */
const LINKS = [
  { href: '/', label: 'Market', pending: false },
  { href: '/seller', label: 'Seller', pending: false },
  { href: '/mandate', label: 'Mandate', pending: false },
  { href: '/mandate/new', label: 'Create', pending: false },
  { href: '/onboard', label: 'Onboard', pending: false },
];

export function Rail() {
  const pathname = usePathname();
  return (
    <header className="rail">
      <div className="wrap rail-inner">
        <Link href="/" className="wordmark">
          <svg className="gate" viewBox="0 0 17 17" aria-hidden="true">
            <rect x="0.5" y="1" width="2" height="15" fill="var(--chalk)" />
            <rect x="14.5" y="1" width="2" height="15" fill="var(--chalk)" />
            <rect x="2.5" y="7.5" width="12" height="2" fill="var(--brass)" />
          </svg>
          Turnstile
        </Link>
        <nav className="nav">
          {LINKS.map((l) => {
            const active = l.href === '/' ? pathname === '/' : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`nav-link${l.pending ? ' pending' : ''}`}
                aria-current={active ? 'page' : undefined}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
