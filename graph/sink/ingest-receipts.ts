// Read the HCS receipt topic and land it in `settlement_receipt`.
//
//   node graph/sink/ingest-receipts.ts --ens liquidity.turnstile.eth
//   node graph/sink/ingest-receipts.ts --agent-uid <uid> --topic 0.0.10408013
//
// This is the last link in the chain MOV-222 left open. `seller/service/
// discovery.ts` ranks sellers by settled volume when `settlement_receipt` has
// rows and labels the ranking a **placeholder** when it does not, because a
// directory ordered by registration recency and called "reputation" is a lie a
// demo can tell and a user cannot check. The rows come from here.
//
// ## Why it reads the mirror node rather than our own settle() calls
//
// The seller already knows every payment it took — `PaymentRail.settle()`
// returns each one. Writing rows straight from there would be simpler and would
// be worth strictly less: a seller's claim about its own revenue, kept in the
// seller's own database. Going out to the public mirror node and reading back
// what the network recorded means the number in the ranking is the same number
// a third party would compute, by the same route, with no key. That is the
// property that makes settled volume worth ranking on at all.
//
// It also means this can ingest *another* seller's topic, which is what a
// directory would eventually want.
//
// ## The units, which are not what the schema comment used to say
//
// `settlement_receipt.amount` holds **decimal US dollars**, not the asset's
// smallest unit. `settled_volume` is `SUM(CAST(amount AS REAL))` across every
// rail, so it can only be a number that means the same thing on all of them —
// and MOV-222's own test inserts `'5.00'` and expects `5`. The atomic amount
// and the asset stay on the HCS message and on chain, where they are exact.
// See the correction note in `graph/sink/schema.sql`.

import { DEFAULT_DB_PATH, openDb } from './db.ts';
import { HcsReceiptTopic } from '../../rails/hedera-x402/hcs.ts';
import type { HcsReceiptMessage } from '../../rails/hedera-x402/hcs.ts';

export interface IngestResult {
  read: number;
  inserted: number;
  skipped: { transaction: string; why: string }[];
}

/**
 * Upsert receipts for one agent.
 *
 * Idempotent on `receipt_id`, which is the Hedera transaction id — so running it
 * twice, or on a topic that already has half its messages ingested, adds nothing
 * the second time.
 */
export function ingestReceipts(db: ReturnType<typeof openDb>, agentUid: string, messages: readonly HcsReceiptMessage[], topicId: string | null): IngestResult {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO settlement_receipt
      (receipt_id, agent_uid, buyer, amount, currency, asset, rail, settled_at, hcs_topic_id, hcs_sequence, hcs_consensus)
    VALUES (?, ?, ?, ?, 'USD', ?, ?, ?, ?, NULL, NULL)
  `);

  const skipped: IngestResult['skipped'] = [];
  let inserted = 0;
  for (const message of messages) {
    if (!message.transaction) {
      skipped.push({ transaction: '(none)', why: 'message carries no transaction id' });
      continue;
    }
    if (typeof message.priceUsd !== 'number' || !Number.isFinite(message.priceUsd)) {
      // Dropping it is right: a row whose amount cannot be compared across rails
      // would corrupt the ranking rather than improve it.
      skipped.push({ transaction: message.transaction, why: 'no priceUsd, so it cannot be summed with other rails' });
      continue;
    }
    insert.run(
      message.transaction,
      agentUid,
      message.payer,
      message.priceUsd.toFixed(6),
      message.asset,
      // `rail` is the ENS token from `turnstile:rails`, not the rail id — that is
      // what a buyer who discovered us through ENS filters on. See
      // RailInfo.ensRailToken.
      message.railId === 'hedera-x402' ? 'x402' : message.railId,
      message.settledAt,
      topicId,
    );
    inserted += 1;
  }
  return { read: messages.length, inserted, skipped };
}

/** Resolve the agent uid for an ENS name already in the sink, or `null`. */
export function agentUidForEns(db: ReturnType<typeof openDb>, ensName: string): string | null {
  const row = db.prepare('SELECT agent_uid FROM turnstile_seller WHERE ens_name = ?').get(ensName) as { agent_uid: string | null } | undefined;
  return row?.agent_uid ?? null;
}

if (import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const topicId = flag('topic') ?? process.env['HEDERA_RECEIPT_TOPIC_ID'] ?? null;
  if (!topicId) {
    console.error('no topic: pass --topic 0.0.x or set HEDERA_RECEIPT_TOPIC_ID');
    process.exit(1);
  }

  const db = openDb(flag('db') ?? DEFAULT_DB_PATH);
  try {
    const ens = flag('ens') ?? 'liquidity.turnstile.eth';
    const agentUid = flag('agent-uid') ?? agentUidForEns(db, ens);
    if (!agentUid) {
      // Refusing beats inventing a uid: a receipt filed under an agent that does
      // not exist inflates nobody's ranking but silently loses the evidence.
      console.error(`no agent_uid for ${ens} in the sink. Run 'npm run hydrate-sellers' first, or pass --agent-uid.`);
      process.exit(1);
    }

    const messages = await new HcsReceiptTopic({ topicId }).read();
    const result = ingestReceipts(db, agentUid, messages, topicId);
    console.log(`topic ${topicId} -> ${agentUid}`);
    console.log(`read ${result.read}, wrote ${result.inserted}`);
    for (const s of result.skipped) console.log(`  skipped ${s.transaction}: ${s.why}`);

    const total = db.prepare('SELECT COUNT(*) AS n FROM settlement_receipt').get() as { n: number };
    console.log(`settlement_receipt now holds ${total.n} row(s); discovery ranks by settled volume from the first one.`);
  } finally {
    db.close();
  }
}
