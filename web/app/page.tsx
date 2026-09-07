import { Market } from '../components/Market.tsx';
import { querySellers } from '../lib/discovery.ts';

export const dynamic = 'force-dynamic';

export default function MarketPage() {
  const response = querySellers({ includeUnknownPrice: true, limit: 200 });

  if (!response.ok) {
    return (
      <div className="wrap placeholder">
        <span className="placeholder-badge">No data</span>
        <h1 className="placeholder-title">The directory is not loaded.</h1>
        <p className="placeholder-body">{response.reason}</p>
      </div>
    );
  }

  return (
    <Market
      initial={response.result}
      provenanceLabel={response.provenance.label}
      capturedAt={response.provenance.capturedAt}
    />
  );
}
