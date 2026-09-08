import { redirect } from 'next/navigation';

import { knownSellers } from '../../lib/ens.ts';

export const dynamic = 'force-dynamic';

/**
 * There is no seller index literal here on purpose. The names come from the
 * deployment manifest, so this route follows a rename rather than needing one.
 */
export default function SellerIndex() {
  const sellers = knownSellers();
  if (sellers.length === 0) {
    return (
      <div className="wrap placeholder">
        <span className="placeholder-badge">No seller</span>
        <h1 className="placeholder-title">The manifest names no seller.</h1>
        <p className="placeholder-body">
          contracts/addresses.turnstile.sepolia.json has no sellerName, so there is no ENSv2 name to
          read records from.
        </p>
      </div>
    );
  }
  redirect(`/seller/${encodeURIComponent(sellers[0]!.ensName)}`);
}
