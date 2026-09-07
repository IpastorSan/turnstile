// The audit trail: settlement receipts on a Hedera Consensus Service topic,
// read back through the public mirror node, and checked against the ledger.
//
// ## Why this reads the mirror node and not our own database
//
// A seller knows every payment it took. A row in the seller's own SQLite saying
// so is worth nothing to a buyer deciding whether to trust it. An HCS message is
// ordered and timestamped by the network and readable by anyone with no key, so
// the number a buyer computes here is the number a third party computes, by the
// same route. That is the only reason settled volume is worth ranking on.
//
// ## The gap this tool does not paper over
//
// **Nothing on chain binds a seller to a receipt topic.** `turnstile:rails`
// names rails, not topics, and there is no ENSIP record for one. So the topic
// arrives as an argument or from the environment, and a caller that has one is
// trusting whoever handed it over. That is a real hole in the design and it is
// reported in every result rather than hidden.
//
// ## And the one this tool closes
//
// The topic `0.0.10408013` has **no submit key** — verified against the mirror
// node on 2026-09-07 — so anyone can write a message to it, and a receipt is
// therefore a *claim*, not proof. `verify: true` turns the claim into evidence:
// every receipt names a Hedera transaction id, and the mirror node will say
// whether that transaction exists, succeeded, and actually moved the claimed
// amount to the claimed payee. A forged receipt survives the read and fails the
// verification.
//
// Reading the messages is not delegated to `HcsReceiptTopic.read()` because that
// method drops the sequence number and consensus timestamp, which are most of
// what makes an audit trail one.

import { MIRROR_NODE_URL } from '../rails/hedera-x402/config.ts';
import type { HcsReceiptMessage } from '../rails/hedera-x402/hcs.ts';

export interface ReceiptEntry {
  /** Consensus order on the topic. Assigned by the network, not by the seller. */
  sequenceNumber: number;
  consensusTimestamp: string;
  message: HcsReceiptMessage;
  /** Present when `verify` was set. */
  verification?: ReceiptVerification;
}

export type VerificationStatus = 'confirmed' | 'mismatch' | 'not_found' | 'unverifiable' | 'error';

export interface ReceiptVerification {
  status: VerificationStatus;
  detail: string;
  /** What the ledger says moved, in the asset's smallest unit. */
  ledgerAmount?: string;
  ledgerResult?: string;
  /** The account that paid the network fee. On this rail that is the facilitator. */
  feePayer?: string;
}

export interface ReceiptsResult {
  topic: string | null;
  mirrorNode: string;
  /**
   * `null` means the topic has no submit key: anyone may append to it, so a
   * message is a claim until verified.
   */
  submitKey: string | null;
  receipts: ReceiptEntry[];
  totals: {
    receipts: number;
    /** Sum of `priceUsd`. Only meaningful across rails because it is dollars. */
    settledUsd: number;
    byPayee: { payTo: string; count: number; usd: number }[];
    byRail: Record<string, number>;
    verified?: Record<VerificationStatus, number>;
  };
  window: { firstConsensus: string; lastConsensus: string } | null;
  notes: string[];
}

export interface ReceiptsOptions {
  /** HCS topic id, `0.0.x`. Falls back to `HEDERA_RECEIPT_TOPIC_ID`. */
  topic?: string;
  /** Only the receipt for this settlement transaction id. */
  transaction?: string;
  /** Only receipts paying this account. */
  payTo?: string;
  /** Only receipts whose `resource` contains this string. */
  resource?: string;
  /** Cross-check each receipt against the ledger. Costs one request each. */
  verify?: boolean;
  limit?: number;
  mirrorNodeUrl?: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * `0.0.7162784@1788791871.396045089` -> `0.0.7162784-1788791871-396045089`.
 *
 * Hedera writes a transaction id one way and the mirror node's REST paths
 * another. Getting this wrong produces a 404 that reads exactly like "that
 * payment never happened", which is the worst possible way to be wrong here.
 */
export function toMirrorTransactionId(transactionId: string): string {
  return transactionId.replace('@', '-').replace(/\.(\d+)$/, '-$1');
}

interface MirrorTransfer { account: string; amount: number }
interface MirrorTransaction {
  result?: string;
  charged_tx_fee?: number;
  transfers?: MirrorTransfer[];
  consensus_timestamp?: string;
}

/**
 * Does the ledger agree with what this receipt claims?
 *
 * Checks the three things a forged receipt would have to get right anyway: the
 * transaction exists, it succeeded, and it credited the claimed payee with the
 * claimed amount.
 */
export async function verifyReceipt(
  message: HcsReceiptMessage,
  doFetch: typeof globalThis.fetch,
  mirrorNodeUrl: string,
): Promise<ReceiptVerification> {
  if (!message.transaction) {
    return { status: 'unverifiable', detail: 'the receipt names no transaction' };
  }
  // Only the Hedera rails put a Hedera transaction id here. Another rail's
  // settlement id is not checkable against this mirror node, and saying so
  // beats reporting it as a failure.
  if (!/^\d+\.\d+\.\d+[@-]\d+[.-]\d+$/.test(message.transaction)) {
    return { status: 'unverifiable', detail: `'${message.transaction}' is not a Hedera transaction id; this checker only reads the Hedera mirror node` };
  }

  const url = `${mirrorNodeUrl}/api/v1/transactions/${toMirrorTransactionId(message.transaction)}`;
  let body: { transactions?: MirrorTransaction[] };
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(20_000) });
    if (res.status === 404) return { status: 'not_found', detail: `the mirror node has no transaction ${message.transaction}` };
    if (!res.ok) return { status: 'error', detail: `mirror node returned ${res.status}` };
    body = await res.json() as { transactions?: MirrorTransaction[] };
  } catch (cause) {
    return { status: 'error', detail: cause instanceof Error ? cause.message : String(cause) };
  }

  const tx = body.transactions?.[0];
  if (!tx) return { status: 'not_found', detail: `the mirror node has no transaction ${message.transaction}` };
  if (tx.result !== 'SUCCESS') {
    return { status: 'mismatch', detail: `the transaction exists but its result is ${tx.result}`, ledgerResult: tx.result };
  }

  const credited = (tx.transfers ?? []).find(t => t.account === message.payTo && t.amount > 0);
  if (!credited) {
    return {
      status: 'mismatch',
      detail: `the transaction succeeded but credited nothing to ${message.payTo}`,
      ledgerResult: tx.result,
    };
  }
  const claimed = Number(message.amount);
  if (Number.isFinite(claimed) && credited.amount !== claimed) {
    return {
      status: 'mismatch',
      detail: `the receipt claims ${message.amount} to ${message.payTo}; the ledger moved ${credited.amount}`,
      ledgerAmount: String(credited.amount),
      ledgerResult: tx.result,
    };
  }

  // Whoever paid the fee is not the buyer — on this rail the facilitator is the
  // fee payer, which is what lets the buyer's hot wallet hold no native token.
  const feePayer = (tx.transfers ?? []).find(t => t.amount < 0 && Math.abs(t.amount) === (tx.charged_tx_fee ?? -1));

  return {
    status: 'confirmed',
    detail: `the ledger confirms ${credited.amount} credited to ${message.payTo}, result ${tx.result}`,
    ledgerAmount: String(credited.amount),
    ledgerResult: tx.result,
    ...(feePayer ? { feePayer: feePayer.account } : {}),
  };
}

/** Read a topic's settlement receipts, with no key of any kind. */
export async function readReceipts(options: ReceiptsOptions = {}): Promise<ReceiptsResult> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const mirrorNode = (options.mirrorNodeUrl ?? process.env['HEDERA_MIRROR_NODE_URL'] ?? MIRROR_NODE_URL).replace(/\/+$/, '');
  const topic = options.topic ?? process.env['HEDERA_RECEIPT_TOPIC_ID'] ?? null;
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 100);
  const notes: string[] = [
    'Read through the public mirror node with no API key and no wallet — the same route a third ' +
    'party auditing these numbers would take. That is the property that makes settled volume worth ranking on.',
    'No on-chain record binds a seller to a receipt topic: turnstile:rails names rails, not topics. ' +
    'The topic id has to be supplied, so a caller is trusting whoever supplied it.',
  ];

  const empty = (extraNote: string): ReceiptsResult => ({
    topic, mirrorNode, submitKey: null, receipts: [],
    totals: { receipts: 0, settledUsd: 0, byPayee: [], byRail: {} },
    window: null,
    notes: [...notes, extraNote],
  });

  if (!topic) {
    return empty('No topic was given and HEDERA_RECEIPT_TOPIC_ID is unset, so nothing was read.');
  }

  // Topic metadata first: whether it has a submit key decides how much a
  // message on it is worth before verification.
  let submitKey: string | null = null;
  let submitKeyKnown = false;
  try {
    const res = await doFetch(`${mirrorNode}/api/v1/topics/${topic}`, { signal: AbortSignal.timeout(20_000) });
    if (res.ok) {
      const meta = await res.json() as { submit_key?: { key?: string } | null };
      submitKey = meta.submit_key?.key ?? null;
      submitKeyKnown = true;
    }
  } catch { /* metadata is a bonus; the messages are the point */ }

  if (submitKeyKnown) {
    notes.push(
      submitKey
        ? 'The topic has a submit key, so only its holder can append. A message here is signed evidence.'
        : 'The topic has NO submit key: anyone can append to it. A receipt read from it is a CLAIM, ' +
          'not proof. Set verify to cross-check each one against the ledger.',
    );
  }

  let messages: { message: string; sequence_number: number; consensus_timestamp: string }[];
  try {
    const res = await doFetch(
      `${mirrorNode}/api/v1/topics/${topic}/messages?limit=${limit}&order=asc`,
      { signal: AbortSignal.timeout(20_000) },
    );
    if (!res.ok) return empty(`The mirror node returned ${res.status} for topic ${topic}.`);
    messages = ((await res.json()) as { messages?: typeof messages }).messages ?? [];
  } catch (cause) {
    return empty(`The mirror node could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  const entries: ReceiptEntry[] = [];
  let foreign = 0;
  for (const raw of messages) {
    let parsed: HcsReceiptMessage;
    try {
      parsed = JSON.parse(Buffer.from(raw.message, 'base64').toString('utf8')) as HcsReceiptMessage;
    } catch {
      foreign += 1;
      continue;
    }
    // Someone else's message on an unkeyed topic is possible. Filtering on the
    // marker is cheaper than trusting it, and is not a security check.
    if (parsed?.kind !== 'turnstile.settlement') {
      foreign += 1;
      continue;
    }
    if (options.transaction && parsed.transaction !== options.transaction) continue;
    if (options.payTo && parsed.payTo !== options.payTo) continue;
    if (options.resource && !(parsed.resource ?? '').includes(options.resource)) continue;
    entries.push({
      sequenceNumber: raw.sequence_number,
      consensusTimestamp: raw.consensus_timestamp,
      message: parsed,
    });
  }
  if (foreign > 0) {
    notes.push(`${foreign} message(s) on the topic were not turnstile.settlement records and were skipped.`);
  }

  if (options.verify) {
    for (const entry of entries) {
      entry.verification = await verifyReceipt(entry.message, doFetch, mirrorNode);
    }
  }

  const byPayee = new Map<string, { count: number; usd: number }>();
  const byRail: Record<string, number> = {};
  let settledUsd = 0;
  for (const { message } of entries) {
    const usd = typeof message.priceUsd === 'number' && Number.isFinite(message.priceUsd) ? message.priceUsd : 0;
    settledUsd += usd;
    const payee = byPayee.get(message.payTo) ?? { count: 0, usd: 0 };
    payee.count += 1;
    payee.usd += usd;
    byPayee.set(message.payTo, payee);
    byRail[message.railId] = (byRail[message.railId] ?? 0) + 1;
  }

  const verified = options.verify
    ? entries.reduce<Record<string, number>>((acc, e) => {
        const s = e.verification?.status ?? 'error';
        acc[s] = (acc[s] ?? 0) + 1;
        return acc;
      }, {}) as Record<VerificationStatus, number>
    : undefined;

  return {
    topic,
    mirrorNode,
    submitKey,
    receipts: entries,
    totals: {
      receipts: entries.length,
      settledUsd: Number(settledUsd.toFixed(6)),
      byPayee: [...byPayee.entries()]
        .map(([payTo, v]) => ({ payTo, count: v.count, usd: Number(v.usd.toFixed(6)) }))
        .sort((a, b) => b.usd - a.usd),
      byRail,
      ...(verified ? { verified } : {}),
    },
    window: entries.length > 0
      ? { firstConsensus: entries[0]!.consensusTimestamp, lastConsensus: entries.at(-1)!.consensusTimestamp }
      : null,
    notes,
  };
}
