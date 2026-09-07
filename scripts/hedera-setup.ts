// One-time provisioning for the Hedera rail. Run once, paste the output into
// `.env`, never run it again.
//
//   node scripts/hedera-setup.ts
//
// It creates two things the rail needs and the operator account cannot be:
//
//   1. **A buyer agent account.** The seller's payout account is the operator
//      (`HEDERA_OPERATOR_ID`). A payment from that account to itself nets to
//      zero and Blocky402 rejects it — `payTo` must receive a positive net
//      transfer. So the buyer agent gets its own account, funded from the
//      operator, which is also the honest shape: the hot tier holds a small
//      balance and nothing else.
//   2. **An HCS topic for settlement receipts.** No submit key, on purpose — the
//      receipt trail is meant to be verifiable by a third party through the
//      public mirror node, and a topic anyone can read is worth more here than
//      one only we can write. `HcsReceiptTopic.read()` filters on a marker so a
//      stranger's message cannot corrupt the trail.
//
// Idempotence is not attempted. Creating a second buyer account or a second
// topic is cheap but confusing, so the script prints what to add to `.env` and
// stops rather than editing it — `.env` is a hand-maintained file that several
// worktrees symlink, and a script that rewrites it would surprise someone.

import { AccountCreateTransaction, Client, Hbar, PrivateKey, TopicCreateTransaction } from '@hiero-ledger/sdk';

import { hashscanTopicUrl } from '../rails/hedera-x402/config.ts';

const operatorId = process.env['HEDERA_OPERATOR_ID'];
const operatorKey = process.env['HEDERA_OPERATOR_KEY'];
if (!operatorId || !operatorKey) {
  console.error('HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY must be set. See docs/accounts.md.');
  process.exit(1);
}

/** Enough for hundreds of $0.07 payments; small enough that the hot key holds little. */
const BUYER_FUNDING_HBAR = Number(process.env['HEDERA_BUYER_FUNDING'] ?? 50);

const client = Client.forName('testnet');
client.setOperator(operatorId, PrivateKey.fromStringECDSA(operatorKey));

try {
  const buyerKey = PrivateKey.generateECDSA();
  const created = await new AccountCreateTransaction()
    .setKeyWithoutAlias(buyerKey.publicKey)
    .setInitialBalance(new Hbar(BUYER_FUNDING_HBAR))
    // Without this a transfer of an HTS token to this account fails with
    // TOKEN_NOT_ASSOCIATED_TO_ACCOUNT. We settle in HBAR, which needs no
    // association at all, but the buyer account outlives that decision.
    .setMaxAutomaticTokenAssociations(-1)
    .execute(client);
  const buyerReceipt = await created.getReceipt(client);
  const buyerId = buyerReceipt.accountId!.toString();

  const topicTx = await new TopicCreateTransaction()
    .setTopicMemo('turnstile settlement receipts (MOV-220)')
    .execute(client);
  const topicId = (await topicTx.getReceipt(client)).topicId!.toString();

  console.log('\n=== created ===');
  console.log(`buyer account   ${buyerId}   funded with ${BUYER_FUNDING_HBAR} HBAR`);
  console.log(`receipt topic   ${topicId}   ${hashscanTopicUrl(topicId)}`);
  console.log('\n=== add to .env ===\n');
  console.log(`export HEDERA_BUYER_ID="${buyerId}"`);
  // `toStringRaw()` is the 64-hex form. `toString()` returns DER, which
  // `PrivateKey.fromStringECDSA` also accepts but which does not match the shape
  // docs/accounts.md tells everyone to use.
  console.log(`export HEDERA_BUYER_KEY="${buyerKey.toStringRaw()}"`);
  console.log(`export HEDERA_RECEIPT_TOPIC_ID="${topicId}"`);
  console.log(`export HEDERA_PAYOUT_ACCOUNT="${operatorId}"`);
  console.log();
} finally {
  client.close();
}
