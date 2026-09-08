// What the agent has actually spent, on both rails, read live.
//
// The rest of /mandate shows what the agent is *allowed* to do. This shows what
// it did. Without it the page is a configuration dump; with it, it is a mandate
// visibly doing its job.
//
// The two rails are read from different places because they settle differently,
// and neither is our own database:
//
//   hedera-x402  an HCS consensus topic, through the public mirror node. The
//                seller publishes a receipt per settlement (rails/hedera-x402
//                submits it); anyone can read the topic with no key.
//   arc-usdc     Circle Gateway's transfers API, queried by the agent's own
//                address. There are no HCS receipts for this rail -- only the
//                Hedera rail publishes them -- so this is the only record.
//
// **What this is not.** It is not one mandate's running balance. The payments
// below span several demo runs, and the cap was raised by a quorum partway
// through, so "total settled" and "current cap" are two true numbers that do not
// subtract from each other. Saying otherwise would be a nicer number and a false
// one. The page words it accordingly.

import { CircleGateway } from '../../rails/arc-usdc/index.ts';
import { NETWORK, arcscanTransactionUrl } from '../../rails/arc-usdc/config.ts';
import { readReceipts } from '../../mcp-turnstile/receipts.ts';

export interface SettledPayment {
  railId: string;
  /** Dollars, or null when the rail's record does not carry a USD price. */
  usd: number | null;
  /** Human amount in the asset actually moved, e.g. "0.000500 USDC". */
  amount: string;
  at: string;
  /** Block explorer or mirror-node link for this individual settlement. */
  href: string | null;
  reference: string;
}

export interface RailSpend {
  railId: string;
  label: string;
  count: number;
  usd: number | null;
  source: string;
  /** Set when this rail could not be read. The page shows it rather than a zero. */
  error?: string;
}

export interface SpendState {
  rails: RailSpend[];
  payments: SettledPayment[];
  totalUsd: number;
  totalCount: number;
  /** True when the HCS topic has no submit key, so a message is a claim until verified. */
  topicIsOpen: boolean;
  topic: string | null;
  readAt: string;
}

const HEDERA_MIRROR_TX = 'https://hashscan.io/testnet/transaction/';
const USDC_DECIMALS = 6;

function usdcToUsd(atomic: string): number {
  return Number(atomic) / 10 ** USDC_DECIMALS;
}

export async function readSpend(agentAddress: string): Promise<SpendState> {
  const rails: RailSpend[] = [];
  const payments: SettledPayment[] = [];
  let topicIsOpen = false;
  let topic: string | null = null;

  // Both rails are read in parallel and each failure is contained: one rail
  // being unreachable must not blank the other, because "we could not read Arc"
  // and "the agent has never paid on Arc" look identical in a total.
  const [hedera, arc] = await Promise.allSettled([
    readReceipts({ limit: 100 }),
    (async () => {
      const gateway = new CircleGateway();
      const result = await gateway.searchTransfers({ from: agentAddress, network: NETWORK, pageSize: 200 });
      return (Array.isArray(result) ? result : ((result as { transfers?: unknown[] })?.transfers ?? [])) as {
        id: string;
        status: string;
        amount: string;
        txHash?: string;
        createdAt: string;
      }[];
    })(),
  ]);

  if (hedera.status === 'fulfilled') {
    const r = hedera.value;
    topic = r.topic;
    topicIsOpen = r.submitKey === null;
    rails.push({
      railId: 'hedera-x402',
      label: 'HBAR on Hedera testnet, settled through Blocky402',
      count: r.totals.receipts,
      usd: r.totals.settledUsd,
      source: `HCS topic ${r.topic ?? 'unset'}, via the public mirror node`,
    });
    for (const entry of r.receipts) {
      payments.push({
        railId: entry.message.railId,
        usd: entry.message.priceUsd,
        amount: `${entry.message.amount} ${entry.message.asset}`,
        at: new Date(Number(entry.consensusTimestamp.split('.')[0]) * 1000).toISOString(),
        href: `${HEDERA_MIRROR_TX}${entry.message.transaction}`,
        reference: entry.message.transaction,
      });
    }
  } else {
    rails.push({
      railId: 'hedera-x402',
      label: 'HBAR on Hedera testnet, settled through Blocky402',
      count: 0,
      usd: null,
      source: 'HCS topic, via the public mirror node',
      error: (hedera.reason as Error)?.message ?? 'the mirror node could not be read',
    });
  }

  if (arc.status === 'fulfilled') {
    const transfers = arc.value;
    let usd = 0;
    for (const t of transfers) {
      const value = usdcToUsd(t.amount);
      usd += value;
      payments.push({
        railId: 'arc-usdc',
        usd: value,
        amount: `${value.toFixed(6)} USDC`,
        at: t.createdAt,
        href: t.txHash ? arcscanTransactionUrl(t.txHash) : null,
        reference: t.txHash ?? t.id,
      });
    }
    rails.push({
      railId: 'arc-usdc',
      label: 'USDC on Arc, batched through Circle Gateway nanopayments',
      count: transfers.length,
      usd,
      source: "Circle Gateway's transfers API, queried by the agent's address",
    });
  } else {
    rails.push({
      railId: 'arc-usdc',
      label: 'USDC on Arc, batched through Circle Gateway nanopayments',
      count: 0,
      usd: null,
      source: "Circle Gateway's transfers API",
      error: (arc.reason as Error)?.message ?? 'the Gateway API could not be read',
    });
  }

  payments.sort((a, b) => (a.at < b.at ? 1 : -1));

  return {
    rails,
    payments,
    totalUsd: rails.reduce((sum, rail) => sum + (rail.usd ?? 0), 0),
    totalCount: rails.reduce((sum, rail) => sum + rail.count, 0),
    topicIsOpen,
    topic,
    readAt: new Date().toISOString(),
  };
}
