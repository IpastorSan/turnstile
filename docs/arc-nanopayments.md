# The Arc rail — Circle Gateway Nanopayments

MOV-225. **Real USDC moved on Arc testnet on 2026-09-07**, and the same query
settled over both rails in the same run. Every number, address and response body
below was captured from that run. Where something could not be verified, it says
so — per `CLAUDE.md`, silence reads as confidence.

- **Buyer agent (hot tier):** [`0x0633a193017939Bb1eB242982397224c66948e2F`](https://testnet.arcscan.app/address/0x0633a193017939Bb1eB242982397224c66948e2F)
- **Buyer org (warm tier):** [`0xdFe3088aC34e7329006407C246C9F6D7534B2aC5`](https://testnet.arcscan.app/address/0xdFe3088aC34e7329006407C246C9F6D7534B2aC5)
- **Seller payout:** `0x0Adca6e14bA956201D221feC767e4f24194bf5F2` — the `addr(60)`
  record on `liquidity.turnstile.eth`
- **Mandate funded by:** [`0xe031e97c80b6aefc3e8b851fdab7d33d8cdef2ed47037f1ecff4abc5a0cffc1c`](https://testnet.arcscan.app/tx/0xe031e97c80b6aefc3e8b851fdab7d33d8cdef2ed47037f1ecff4abc5a0cffc1c)
  — `depositFor(0.25 USDC, agent)`, paid for by the **org**, not the agent
- **Seven payments settled**, one at $0.07 and six at $0.000500 — **all seven in
  one on-chain transaction**:
  [`0xd6e77a59ad4740e5f89c9c601a05e7cf7859c9253fb1b3c31a8eae97e859a0c1`](https://testnet.arcscan.app/tx/0xd6e77a59ad4740e5f89c9c601a05e7cf7859c9253fb1b3c31a8eae97e859a0c1)
  (block 60940635, 22 payments in total including other Gateway users', 0.133111
  USDC moved, gas paid by Circle's batcher)

Reproduce it:

```bash
npm run arc:setup                  # depositFor() the mandate allowance
npm run arc:pay                    # the transcript: both rails, zero gas, nanopayments
npm run arc:receipts -- --ours     # resolve authorizations into their batch transaction
```

---

## What Gateway Nanopayments actually is

Not a Paymaster, and not two products bolted together. One mechanism:

1. The payer deposits USDC into the **GatewayWallet** contract once. This costs
   gas, and in our design the **warm tier pays it** via `depositFor(amount,
   agent)` — the caller pays, the named address receives the balance.
2. To buy something, the payer signs an **EIP-3009 `TransferWithAuthorization`**
   whose `verifyingContract` is the **GatewayWallet, not USDC**. This is
   offchain. No transaction, no gas.
3. The seller posts that authorization to Gateway's `/v1/x402/settle`. Gateway
   **credits the seller immediately** and returns an **authorization id** — a
   UUID, not a transaction hash.
4. Circle's batcher later redeems many authorizations in **one** on-chain
   transaction against the GatewayWallet.

Step 4 is what makes a $0.0005 payment possible. No chain settles a payment that
size on its own — the deposit that funded this whole mandate cost **0.0019 USDC**
in gas, roughly four times the price of one nanopayment query. Amortised across a
batch, it works.

### Two identifiers for one chain

Mixing these up is the failure mode that already cost the Hedera rail a day, in
the opposite direction. Both are correct in their own place:

| | Value | Used by |
|---|---|---|
| CAIP-2 | `eip155:5042002` | the x402 wire — `PaymentRequirements.network`, Gateway's `/supported` |
| Circle chain name | `arcTestnet` | the Circle SDK — `GatewayClient({ chain })`, `CHAIN_CONFIGS` |

`GatewayClient({ chain: 'eip155:5042002' })` throws; a challenge quoting
`arcTestnet` as its `network` matches no supported kind. `rails/arc-usdc/config.ts`
holds both and says which is which.

---

## What was verified, and what was not

| Claim | Status |
|---|---|
| Arc testnet is `eip155:5042002` | **Verified** 2026-09-07 two ways — `eth_chainId` on `https://rpc.testnet.arc.network` returns `0x4cef52`, and Gateway's `/supported` advertises that CAIP-2 id |
| Arc testnet needs no API key to read | **Verified** — the public RPC answers unauthenticated |
| Circle Gateway's testnet facilitator needs no API key | **Verified** — `GET /v1/x402/supported` and `GET /v1/x402/transfers` both answer unauthenticated. Our `CIRCLE_API_KEY` is a Circle Mint sandbox key and is **not used by this rail at all** |
| USDC on Arc testnet is `0x3600…0000`, 6 decimals | **Verified** — off `/supported` |
| The EIP-712 `verifyingContract` is the GatewayWallet `0x0077777d…19B9`, not USDC | **Verified** — off `/supported`, and the rail reads it live on every challenge rather than hardcoding it |
| USDC is Arc's native gas token | **Verified by measurement** — see below |
| The agent paid zero gas | **Verified** — its nonce is `0` after seven settled payments |
| A payment really settled | **Verified** — Gateway returned `success: true` with an authorization id and debited the agent's Gateway balance 0.25 → 0.177 USDC |
| The same query settles over both rails | **Verified** — one run, one URL, Arc and Hedera both returned 200 with the same verdict |
| Gateway cannot settle below the signed amount | **Verified** — see [Partial settlement](#partial-settlement-the-answer-for-mov-227) |
| Gateway's `/verify` does **not** check the payer's balance | **Verified** — an unfunded authorization returned `{"isValid":true}` and then failed `/settle` with `insufficient_balance` |
| Batching: many authorizations share one transaction | **Verified on our own payments.** All seven settled in `0xd6e77a59…a0c1`, alongside fifteen other Gateway users' payments — 22 in one transaction |
| The batch transaction's gas is paid by Circle, not the payer | **Verified** — the transaction's `from` is Circle's batcher `0xc73ef0d8…a884` and its `to` is the GatewayWallet. No payer appears as a sender |
| The agent's nonce is still 0 **after** the batch mined | **Verified** — `eth_getTransactionCount` and `eth_getBalance` both still `0` |
| Anything on Arc **mainnet** | **Not attempted.** Testnet only, and Arc mainnet has no public RPC |

---

## USDC is the gas token, and what that breaks

`CLAUDE.md`, `README.md` and `docs/architecture.md` all used to describe the hot
tier as holding *"zero native token (Paymaster)"*. That is incoherent here, and
all three are corrected.

`eth_getBalance(a)` and `USDC.balanceOf(a)` are **two views of one balance at two
precisions**. Measured against a live Arc address on 2026-09-07:

```
eth_getBalance   285144556003000000   (18 dp) = 0.285144556003 USDC
USDC.balanceOf              285144   ( 6 dp) = 0.285144       USDC
```

The ERC-20 view is the truncated one. So a wallet holding zero native token holds
zero USDC and cannot pay anybody. There is no Paymaster in Turnstile.

`rails/arc-usdc/wallet.ts` has `sameBalance()`, which checks the identity rather
than trusting this paragraph, and `npm run arc:pay` prints it.

### The claim that replaced it

> The hot wallet signs an EIP-3009 authorization **offchain and never submits a
> transaction**, so it pays exactly zero gas. Circle's batcher submits.

The proof is the **nonce**, and it is on chain and unforgeable. From the run:

```
agent 0x0633a193017939Bb1eB242982397224c66948e2F
  nonce          0 -> 0
  on chain       0.000000 -> 0.000000 USDC
  native         0 -> 0 wei
  gateway        0.25 -> 0.177 USDC
```

Seven payments went out. The wallet's on-chain balance was zero the whole time,
its nonce never moved, and its Gateway balance fell by exactly what it spent. A
wallet that has never submitted a transaction has never paid a wei of gas.

This is also the key hierarchy from `CLAUDE.md` enforced by the chain rather than
by our code: the hot key cannot deposit, withdraw or transfer, because each is a
transaction and it has no gas for any of them. It can only spend what the warm
tier deposited **for** it.

---

## The transcript

### 1. One query, a 402 advertising both rails

```
GET http://127.0.0.1:.../analyze/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640 -> HTTP 402
  exact  hedera:testnet     839746     HBAR  -> 0.0.10403961
  exact  eip155:5042002     70000      USDC  -> 0x0Adca6e14bA956201D221feC767e4f24194bf5F2
```

The Arc entry in full — note `verifyingContract` is the GatewayWallet:

```json
{
  "scheme": "exact",
  "network": "eip155:5042002",
  "asset": "0x3600000000000000000000000000000000000000",
  "amount": "70000",
  "payTo": "0x0Adca6e14bA956201D221feC767e4f24194bf5F2",
  "maxTimeoutSeconds": 300,
  "extra": {
    "name": "GatewayWalletBatched",
    "version": "1",
    "verifyingContract": "0x0077777d7eba4688bdef3e311b846f25870a19b9",
    "minValiditySeconds": 604800,
    "chainName": "arcTestnet",
    "settlementModel": "gateway-batched-authorization",
    "settlementTiming": "batched-asynchronous",
    "turnstileSettlement": "live"
  }
}
```

### 2. The same query, paid on Arc

```
HTTP 200 in 0.3s
{
  "success": true,
  "transaction": "fa4ca648-863c-4f61-9a1e-2953eb789f7f",
  "network": "eip155:5042002",
  "payer": "0x0633a193017939bb1eb242982397224c66948e2f",
  "amount": "70000"
}
```

`transaction` is an **authorization id**, not a hash. A caller that builds an
explorer link out of it gets a broken link.

### 3. The same query, paid on Hedera

```
HTTP 200
  transaction  0.0.7162784@1788800327.098234984
  network      hedera:testnet
  HashScan     https://hashscan.io/testnet/transaction/0.0.7162784@1788800327.098234984
  bought       tier=standard rating=ACCEPTABLE
```

Same URL, same seller, same code path, same answer. Only the buyer's mandate
changed. `seller/service/no-chain-code.test.ts` fails the build if any file on
the payment path so much as names a chain, so this is not a claim about
discipline — it is enforced.

### 5. Nanopayments

```
$0.000500 each = 500 USDC atomic units per query.

   1. paid $0.000500 -> authorization fc21f8b5-a7ed-45ac-9815-5b3a042fa154
   2. paid $0.000500 -> authorization 9d428620-e21c-44e3-ab73-64afe583cdb5
   3. paid $0.000500 -> authorization 3aa16a71-e64f-4da3-8d02-21b94fdee1c1
   4. paid $0.000500 -> authorization 4eaa5195-156b-42ac-9860-a13efaca5e73
   5. paid $0.000500 -> authorization 76e18397-5eee-4cac-8227-800bda93411d
   6. paid $0.000500 -> authorization 5dfaa167-ba05-457c-b6df-8f90d09b7c42

agent gateway balance: 0.25 -> 0.177 USDC
agent nonce:           0   (still zero, after 7 payments)
```

The service's own cheapest tier is $0.07, pinned to the `turnstile:price` record
on `liquidity.turnstile.eth`; a sub-cent tier there would make that record a lie.
So the nanopayment section runs a **second app instance** at $0.0005 — same
rails, same registry, same 402 machinery, different price.

---

## The batch: 22 payments, one transaction

**Batching is real and observable on Arc testnet.** Sampling 100 consecutive
Gateway transfers on `eip155:5042002` on 2026-09-07:

```
100 transfers -> 9 distinct txHash values
  0xd7971b3b…7ebb6  13 transfers
  0x129df866…490c0  13 transfers
  0x4b59a23a…d9147  12 transfers
  …
```

One of them, checked directly against the chain:

```
0x36f4129088ce33ff33d4183acefdd207443870f6319a7766948985339c91f188
  status success   block 60937011   gasUsed 97196
  to    0x0077777d7eba4688bdef3e311b846f25870a19b9   (the GatewayWallet)
  from  0xc73ef0d80c6c5e7d632d8ff8f651ffca8654a884   (Circle's batcher)
```

<https://testnet.arcscan.app/tx/0x36f4129088ce33ff33d4183acefdd207443870f6319a7766948985339c91f188>

Thirteen payments, one transaction, and the `from` is **Circle's batcher** rather
than any payer. That is the zero-gas property visible from the other side. One of
the thirteen was for `1308` atomic units — $0.001308, a genuine nanopayment.

### Our own seven payments

All seven settled in **one** transaction:

```
7 payment(s) settled in 1 on-chain transaction(s):
  0xd6e77a59ad4740e5f89c9c601a05e7cf7859c9253fb1b3c31a8eae97e859a0c1
    7 of these payments, 0.073000 USDC
```

| | |
|---|---|
| Transaction | [`0xd6e77a59…a0c1`](https://testnet.arcscan.app/tx/0xd6e77a59ad4740e5f89c9c601a05e7cf7859c9253fb1b3c31a8eae97e859a0c1) |
| Block | 60940635, `status: success`, `gasUsed: 155848` |
| From | `0xc73ef0d80c6c5e7d632d8ff8f651ffca8654a884` — **Circle's batcher** |
| To | `0x0077777d7eba4688bdef3e311b846f25870a19b9` — the GatewayWallet |
| Payments in it | **22** (ours and fifteen other Gateway users'), 0.133111 USDC |
| Ours | 7 — the $0.07 tier payment and all six $0.000500 nanopayments |

Six sub-cent payments and one seven-cent payment, mined together with fifteen
strangers' payments, for one transaction's worth of gas that **none of us paid**.
That is the mechanism, end to end.

And after the batch mined, the agent is unchanged:

```
agent nonce now: 0
agent native now: 0n
```

### The latency is Circle's, and it varies — plan a demo around that

This took **~13 minutes**, not the ~2 minutes an earlier window that afternoon
showed. The first `arc:pay` run polled for six minutes and exited with all seven
authorizations still at `status: received`.

That was **not specific to us**. Circle's batcher had stalled across the whole
chain — its most recent completion was `16:57:03Z`, our payments landed at
`16:58:50Z`, and twenty-two transfers from every Gateway user on Arc testnet were
queued behind the same stall. It cleared at `17:12:16Z` and took the whole queue
with it, which is why our batch has 22 payments in it rather than the 12–13 that
was typical earlier.

So, stated as a property rather than a number:

- the payments **settle** at `/settle` — Gateway returns `success: true`, credits
  the seller and debits the payer. From the seller's point of view the money is
  theirs at that moment, and the answer is delivered;
- the **batch transaction is Circle's to submit**, and its latency is not ours to
  promise. Observed between ~2 and ~13 minutes on one afternoon;
- `npm run arc:receipts -- --ours` resolves authorizations into their batch
  transaction whenever it lands. That is why it is a separate script.

**For a demo:** run `arc:pay`, then `arc:receipts -- --ours --watch` as a second
step. Do not script the take around the batch appearing inside a fixed window.

---

## Partial settlement: the answer for MOV-227

**No. Arc cannot settle below the authorized amount, and this is not a
configuration choice.**

An EIP-3009 authorization signs a fixed `value` as part of the EIP-712 digest.
Redeeming a different amount is not a policy Gateway declines to offer; it is a
different message with a different hash, and the signature does not cover it.

Verified against the live API on 2026-09-07 — one authorization signed for
`70000`, then verified against three different `paymentRequirements.amount`
values:

| `requirements.amount` | vs signed `value` | Gateway's answer |
|---|---|---|
| `70000` | equal | `{"isValid":true}` |
| `35000` | **below** | `{"isValid":false,"invalidReason":"amount_mismatch"}` |
| `350000` | above | `{"isValid":false,"invalidReason":"amount_mismatch"}` |

`exact` means exact, in both directions.

### What this means for the standing decision

The standing decision is that **we never charge the premium price for a
standard-tier delivery**. On this rail, "settle for less" is not available as a
way to honour it. The only correct implementations are:

1. **Decide the tier before quoting.** If the premium tier's attested verdict
   cannot be produced, the 402 should quote the standard price, and the buyer
   signs for that. This is where the decision belongs.
2. **Refuse and re-quote.** If the degradation is discovered *after* the buyer
   signed for $0.35, do not settle. Return 402 with a fresh challenge at $0.07.
   The buyer signs again; the first authorization is never redeemed and costs
   them nothing. `seller/service/x402.ts` already withholds the answer when
   settlement does not succeed, so this path exists.

**Do not assume this differs on Hedera.** It does not. A Hedera `exact` payment
is a frozen `TransferTransaction` that the payer signed, and Blocky402 co-signs
and submits it unaltered — changing the amount would invalidate the payer's
signature exactly as it does here. So a per-rail branch is **not** needed for
this, and the global assumption that is safe is "no rail can settle below the
authorized amount", not the reverse.

---

## Rough edges in Circle's SDK and API

Recorded here rather than in `FEEDBACK.md` (Uniswap) or `WORLD-FEEDBACK.md`
(World), both of which are scored deliverables for other sponsors.

1. **`@x402/evm` is documented as an optional peer dependency and is not one.**
   `package.json` marks it `peerDependenciesMeta: { "@x402/evm": { optional:
   true } }` and the README says it is "only needed if using `CompositeEvmScheme`
   or `GatewayEvmScheme`". But `dist/server/index.mjs` line 316 is a top-level
   `import { ExactEvmScheme } from "@x402/evm/exact/server"`, and ESM hoists
   imports — so importing `BatchFacilitatorClient`, the one thing a resource
   server needs and which uses neither of those classes, fails with
   `ERR_MODULE_NOT_FOUND` until you install it. Cost: one confusing crash.

2. **The SDK defaults to mainnet.** `BatchFacilitatorClient` and
   `createGatewayMiddleware` both default `url` to
   `https://gateway-api.circle.com`. A testnet integration that forgets to pass
   the URL points at production and fails in a way that does not say so. Worth a
   louder default or a required argument.

3. **`/verify` does not check the payer's balance.** An authorization from a
   wallet with a zero Gateway balance returns `{"isValid":true}`; the same
   payment then fails `/settle` with `insufficient_balance`. This is defensible —
   verify is about the signature — but it is not documented on the endpoint, and
   an x402 resource server that does the work between verify and settle (as the
   protocol intends) will do that work for free. Blocky402 catches it at verify.

4. **`paymentPayload.resource` is required and undocumented.** Omitting it gives
   `400 Invalid request: paymentPayload.resource: Required`, which reads like a
   protocol violation rather than a Gateway-specific requirement. It is not part
   of the `PaymentPayload` the x402 core types describe, and the field is not
   covered by the payer's signature, so it is advisory data presented as
   mandatory.

5. **`pageSize` over 100 is a 400, not a clamp.** `GET /v1/x402/transfers?pageSize=200`
   returns `Page size cannot exceed 100` rather than returning 100.

6. **The testnet faucet has no machine path.** `faucet.circle.com` is
   reCAPTCHA-gated (threshold 0.7), `faucet.circle.com/mcp` 307s to `/`, and
   `POST https://api.circle.com/v1/faucet/drips` answers **403 Forbidden** to a
   Circle Mint sandbox API key. So an automated testnet integration cannot fund
   itself, and every CI run of a Gateway integration needs a human first. A
   scoped faucet key would fix this.

---

## Files

| File | What it is |
|---|---|
| `rails/arc-usdc/config.ts` | Every verified constant, and the two-identifiers note |
| `rails/arc-usdc/gateway.ts` | The Gateway client: SDK for x402, plain HTTP for transfers |
| `rails/arc-usdc/index.ts` | `createArcRail()` — the `PaymentRail` implementation |
| `rails/arc-usdc/wallet.ts` | Nonce and balance reads. Not on the payment path |
| `rails/arc-usdc/testing.ts` | Captured Gateway responses, so tests run offline |
| `buyer/watchdog/arc-signer.ts` | The buyer's `RailSigner` |
| `scripts/arc-setup.ts` | `depositFor()` the mandate allowance |
| `scripts/arc-paid-request.ts` | The transcript above |
| `scripts/arc-receipts.ts` | Authorization id → batch transaction, at any later time |
