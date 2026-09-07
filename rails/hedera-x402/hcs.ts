// Settlement receipts, written to a Hedera Consensus Service topic.
//
// ## Why a topic and not a database row
//
// The receipt is the one number in this system an agent cannot fake. Discovery
// ranks sellers by settled volume for exactly that reason
// (`seller/service/discovery.ts`), and a ranking is only worth as much as the
// evidence under it: a seller that keeps its own receipts in its own SQLite can
// write whatever it likes there. An HCS message is ordered, timestamped and
// signed by the network, readable by anyone through the public mirror node with
// no key, and cannot be edited after the fact. So the receipt goes on-chain and
// the SQLite table becomes a cache of something checkable rather than the record
// itself.
//
// It also costs about $0.0001 per message and needs no contract.
//
// ## What is in a message, and what is not
//
// A receipt names the transaction, the rail, the amount, the asset, the payer
// and the resource that was bought. It does **not** carry the answer that was
// sold, or anything derived from it. The topic is public: writing the analyst's
// verdict into it would give away, permanently and to everyone, the thing the
// buyer just paid for.
//
// ## Failure is not fatal
//
// `submit()` returns `null` rather than throwing when the topic is not
// configured or the write fails. A payment that settled on chain and whose
// receipt did not get logged is still a payment — refusing to deliver the
// answer over a bookkeeping failure would punish the buyer for our problem.
// `PaymentRail.settle()` records the outcome in `Receipt.extra.hcs` either way,
// so a missing receipt is visible rather than silent.

import { Client, PrivateKey, TopicId, TopicMessageSubmitTransaction } from '@hiero-ledger/sdk';

import type { Receipt } from '../PaymentRail.ts';
import { MIRROR_NODE_URL } from './config.ts';

/** One line of the audit trail, as it appears on the topic. */
export interface HcsReceiptMessage {
  /** Schema marker, so a reader can tell our messages from anyone else's. */
  v: 1;
  kind: 'turnstile.settlement';
  railId: string;
  network: string;
  /** Hedera transaction id of the settlement itself. */
  transaction: string;
  payer: string | null;
  payTo: string;
  /** Integer string, smallest unit of `asset`. */
  amount: string;
  asset: string;
  /** Decimal USD the seller charged. The rate is on the challenge, not here. */
  priceUsd: number | null;
  /** URL that was bought. The audit trail's link back to what was sold. */
  resource: string | null;
  settledAt: number;
}

export interface HcsSubmitResult {
  topicId: string;
  sequenceNumber: string;
  consensusTimestamp: string | null;
  /** The topic-message transaction, distinct from the payment's own id. */
  transactionId: string;
}

export interface HcsReceiptTopicOptions {
  topicId?: string;
  operatorId?: string;
  operatorKey?: string;
  mirrorNodeUrl?: string;
  network?: 'testnet' | 'mainnet' | 'previewnet';
  fetch?: typeof globalThis.fetch;
}

export class HcsReceiptTopic {
  readonly topicId: string | null;
  private readonly operatorId: string | null;
  private readonly operatorKey: string | null;
  private readonly mirrorNodeUrl: string;
  private readonly network: 'testnet' | 'mainnet' | 'previewnet';
  private readonly doFetch: typeof globalThis.fetch;

  constructor(options: HcsReceiptTopicOptions = {}) {
    this.topicId = options.topicId ?? process.env['HEDERA_RECEIPT_TOPIC_ID'] ?? null;
    this.operatorId = options.operatorId ?? process.env['HEDERA_OPERATOR_ID'] ?? null;
    this.operatorKey = options.operatorKey ?? process.env['HEDERA_OPERATOR_KEY'] ?? null;
    this.mirrorNodeUrl = (options.mirrorNodeUrl ?? process.env['HEDERA_MIRROR_NODE_URL'] ?? MIRROR_NODE_URL).replace(/\/+$/, '');
    this.network = options.network ?? 'testnet';
    this.doFetch = options.fetch ?? globalThis.fetch;
  }

  /** False when no topic or no operator key is configured. Writes are skipped, reads still work. */
  get canWrite(): boolean {
    return Boolean(this.topicId && this.operatorId && this.operatorKey);
  }

  /** The message body, split out so a test can assert its shape without a network. */
  static messageFor(receipt: Receipt, context: { payTo: string; priceUsd: number | null; resource: string | null }): HcsReceiptMessage {
    return {
      v: 1,
      kind: 'turnstile.settlement',
      railId: receipt.railId,
      network: receipt.network,
      transaction: receipt.transaction,
      payer: receipt.payer,
      payTo: context.payTo,
      amount: receipt.amount ?? '0',
      asset: receipt.asset ?? '',
      priceUsd: context.priceUsd,
      resource: context.resource,
      settledAt: receipt.settledAt,
    };
  }

  /** Returns `null` when unconfigured or when the write failed. Never throws. */
  async submit(message: HcsReceiptMessage): Promise<HcsSubmitResult | { error: string } | null> {
    if (!this.canWrite) return null;
    const client = Client.forName(this.network);
    try {
      client.setOperator(this.operatorId!, PrivateKey.fromStringECDSA(this.operatorKey!));
      const response = await new TopicMessageSubmitTransaction()
        .setTopicId(TopicId.fromString(this.topicId!))
        .setMessage(JSON.stringify(message))
        .execute(client);
      // `getReceipt` is what waits for consensus. Without it the sequence number
      // is not yet assigned and a "successful" submit can still have failed.
      const receipt = await response.getReceipt(client);
      return {
        topicId: this.topicId!,
        sequenceNumber: receipt.topicSequenceNumber?.toString() ?? '',
        consensusTimestamp: null,
        transactionId: response.transactionId.toString(),
      };
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : String(cause) };
    } finally {
      client.close();
    }
  }

  /**
   * Read the topic back through the public mirror node.
   *
   * No key and no SDK client — this is the path a third party auditing our
   * settled volume would take, which is the point of putting it on HCS at all.
   */
  async read(limit = 100): Promise<HcsReceiptMessage[]> {
    if (!this.topicId) return [];
    const url = `${this.mirrorNodeUrl}/api/v1/topics/${this.topicId}/messages?limit=${limit}&order=asc`;
    const res = await this.doFetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`mirror node ${url} returned ${res.status}`);
    const body = await res.json() as { messages?: { message: string; sequence_number: number; consensus_timestamp: string }[] };
    const out: HcsReceiptMessage[] = [];
    for (const entry of body.messages ?? []) {
      try {
        // Mirror node returns the message base64-encoded.
        const parsed = JSON.parse(Buffer.from(entry.message, 'base64').toString('utf8')) as HcsReceiptMessage;
        // Someone else's message on our topic is possible if the topic has no
        // submit key. Filtering on the marker is cheaper than trusting it.
        if (parsed?.kind === 'turnstile.settlement') out.push(parsed);
      } catch {
        // A message that is not ours and not JSON. Skipping it is correct; the
        // alternative is one bad write making the whole audit trail unreadable.
      }
    }
    return out;
  }
}
