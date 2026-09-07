# The warm tier — a Privy organization wallet, a mandate, and a quorum

MOV-228. **Every number, id and error message below was captured from the live
Privy API and Arc testnet on 2026-09-07.** Where something was not verified, it
says so — per `CLAUDE.md`, silence reads as confidence.

- **Buyer org wallet (warm tier):** Privy `w0cxyoh1lnc1lqfyi9tb5yej` →
  [`0x3De96375140717193f52c220Df5Ec460971cbE84`](https://testnet.arcscan.app/address/0x3De96375140717193f52c220Df5Ec460971cbE84)
- **Buyer agent (hot tier):** [`0x0633a193017939Bb1eB242982397224c66948e2F`](https://testnet.arcscan.app/address/0x0633a193017939Bb1eB242982397224c66948e2F)
  — nonce **0**, on-chain balance **0**, before and after everything here
- **Operations quorum** `ywnbe62desoz63antrbsu5qs` — 1 of 2, owns the wallet
- **Board quorum** `cvwpn2cxf6z8fxs8fa9gl78x` — 2 of 2, owns the mandate policy
- **Mandate policy** `crykqflf5ffiho8taei8uu7s`
- **Operators:** alice (CFO) `did:privy:cmtrjd1od018y0eldcfi7uauq`, embedded
  wallet `0x31696fc79d9bA288Eb890D043CCD05e907d2172c`; bob (Head of Research)
  `did:privy:cmtrjd2al01kt0ck1jx1cuj2w`, embedded wallet
  `0x0c73BA4D525698E9Ba46753D19C087a03F8739BF`
- **Live deposit, signed by the Privy wallet:**
  [`0x3c526daf…20de`](https://testnet.arcscan.app/tx/0x3c526daf25216ac831ba21f828458e4bdd7562227b012b399b3e05f0869320de)
  (approve) and
  [`0x681ba1cd…7ec3`](https://testnet.arcscan.app/tx/0x681ba1cdbe5b46c6dcd6a7f906265b678099c501e425d62b114793d65c297ec3)
  (`depositFor`). Agent's Gateway balance 0.1055 → 0.3555 USDC.

Reproduce it:

```bash
npm run privy:setup                   # operators, quorums, policy, org wallet
npm run privy:setup -- --status       # read it back
node scripts/arc-setup.ts --seed 2    # one-time: move USDC off the legacy key
npm run arc:setup                     # depositFor(), signed by the org wallet
npm run privy:mandate                 # the refusal, and the quorum that answers it
```

---

## What replaced what

MOV-225 landed the Arc rail with real batched settlement, and it worked. The
`depositFor(token, agent, value)` call that funds the agent's mandate was made by
**`ARC_ORG_PRIVATE_KEY`, a raw secp256k1 key** at
`0xdFe3088aC34e7329006407C246C9F6D7534B2aC5`.

**The mechanism is unchanged.** The org still pays the deposit's gas, the balance
still belongs to the agent, and the agent still never submits a transaction. What
changed is the key holder, and it buys three things a raw key cannot have:

1. **There is no org private key on this machine.** Privy's enclave holds it.
   Reading `.env` no longer yields the ability to spend.
2. **A policy the wallet cannot escape.** Every signature is checked against the
   mandate *by Privy*, before a signature exists.
3. **An owner that is a quorum of humans**, not a file — and raising the cap
   needs two of them.

`scripts/arc-paid-request.ts` — the Arc demo take — also stopped needing the
legacy key. It used to require it purely to construct a `GatewayClient` that
could read the agent's Gateway balance, because the SDK's constructor demands a
private key even for a read. After MOV-228 the org has no private key here at
all, so that requirement would have made the demo depend on the exact thing the
design had just removed. `gatewayBalance()` in `rails/arc-usdc/wallet.ts` reads
Circle's `/v1/balances` directly; it needs no key and no auth header. Re-run
2026-09-07 after the change: two more payments settled, agent nonce still 0,
Gateway balance 0.3555 → 0.2850 USDC.

`ARC_ORG_PRIVATE_KEY` survives for exactly one purpose: `arc-setup.ts --seed`,
the one-time transfer that moves testnet USDC to the new org wallet, because
Circle's faucet is reCAPTCHA-gated and a fresh address cannot fund itself. It is
not on the deposit path.

---

## Two quorums, and why it is two and not one

| Quorum | Threshold | Owns | So this needs |
|---|---|---|---|
| **operations** | 1 of 2 | the org wallet | any one operator, for a routine treasury op |
| **board** | 2 of 2 | the mandate policy | two operators, to widen what the agent may spend |

One quorum cannot express that. If the wallet needed 2-of-N, funding the agent
would need a meeting. If the policy needed 1-of-N, a single compromised operator
key could raise the cap and then spend against it — which is exactly the failure
`CLAUDE.md` exists to prevent:

> **the key that spends can never raise its own limit.**

Splitting them gives the ordinary operation one signature and the *change to the
rules* two. That asymmetry is the entire B2B control.

The org wallet's owner and the policy's owner are therefore deliberately
different objects. A reviewer checking one thing should check that.

---

## The five Privy mechanisms this uses, and what each one is worth

| Mechanism | Where | Generally available? |
|---|---|---|
| Server wallet | the org wallet, `POST /v1/wallets` | yes |
| **Embedded wallets** | one per human operator, pre-generated server-side | yes |
| **Policies** | the spend cap, the pinned depositor | yes |
| **Key quorums** | 1-of-2 operations, 2-of-2 board | yes |
| **Authorization signatures** | every mutation of an owned resource | yes |

No Privy Cards, mocked or otherwise. Nothing here is a preview feature; every
call above answered a plain `curl` with basic auth on 2026-09-07.

---

## The mandate, in the two places it is enforced

The mandate object is five fields — `buyer/mandate/mandate.ts`:

```
spend cap           $0.25   cumulative, and what Privy caps on chain
per-query ceiling   $0.10
rails               arc-usdc > hedera-x402
seller allowlist    0x0Adca6e14bA956201D221feC767e4f24194bf5F2, 0.0.10403961
verified operator   false   MOV-223 seam — blocked on World Sandbox approval
```

| Field | Enforced | By |
|---|---|---|
| `railPreference` | per offer | `enforceMandate`, ours |
| `sellerAllowlist` | per offer | same |
| `maxPerQueryUsd` | per offer | same |
| `spendCapUsd` | per offer, against the ledger's remainder | same |
| `spendCapUsd` | **again**, on the org's deposit | a Privy policy — *not* ours |
| `verifiedOperatorOnly` | before any offer is considered | `mandateSpendingLimits` |

The spend cap appearing twice is not duplication. The first is the agent
declining to overspend. The second is Privy's enclave declining to hand the agent
the money at all — and it would refuse the same request from an attacker holding
our app secret.

### `verified_operator_only` is a seam and refuses when set

MOV-223 binds it to World proof-of-personhood and is blocked on World Sandbox
approval. Until then the flag **refuses** rather than passing: a gate wired to
nothing that returns "allowed" reads as a control in the demo and is not one.
`buyer/mandate/mandate.ts`'s `verifiedOperatorGate` is four lines and says so.

### The cap has to be decided before quoting

MOV-225 verified against live Gateway that **no rail can settle below the
authorized amount** — an EIP-3009 authorization signs `value` into the EIP-712
digest, and `35000` against a `70000` authorization returns `amount_mismatch`.
Hedera is the same, because Blocky402 co-signs a frozen transaction.

So every mandate check above is a **pre-signature** check on the 402 challenge,
and there is deliberately no partial-settlement or refund seam for a later issue
to reach for. The agent refuses; it does not silently downgrade to a cheaper
tier.

---

## The transcript

### `npm run privy:mandate`

```
1. THE MANDATE
spend cap           $0.25   (read back off the live policy — Privy caps this on chain)
per-query ceiling   $0.1
rails               arc-usdc > hedera-x402
seller allowlist    0x0Adca6e14bA956201D221feC767e4f24194bf5F2, 0.0.10403961
verified operator   false (MOV-223 seam — blocked on World Sandbox approval)

org wallet          0x3De96375140717193f52c220Df5Ec460971cbE84
  owner             ywnbe62desoz63antrbsu5qs  operations quorum, 1 of 2
policy              Turnstile mandate — $0.25 cap
  owner             cvwpn2cxf6z8fxs8fa9gl78x  board quorum — raising the cap needs its threshold
operators           alice (CFO), bob (Head of Research)

2. THE AGENT IS REFUSED — OUR CODE, BEFORE A SIGNATURE EXISTS
standard tier, $0.07                   PAY
premium tier,  $0.35                   REFUSED — $0.3500 exceeds the mandate cap of $0.1000
a seller not on the allowlist, $0.07   REFUSED — payee '0x0000…dEaD' is not on the mandate's seller allowlist

3 & 4. THE ORG WALLET FUNDS THE AGENT — PRIVY DECIDES, NOT US
fund $0.25 — at the cap, alice approves        SIGNED  0x02f8d2834cef5280830f4240…
fund $1 — over the cap, alice approves         REFUSED 400 policy_violation
fund $0.25 — nobody approves                   REFUSED 401 Missing `privy-authorization-signature` header

5. RAISING THE CAP NEEDS A QUORUM
alice (CFO) proposes raising the cap $0.25 → $1

alice alone      REFUSED 401 Number of signatures in `privy-authorization-signature` header
                 does not match the wallet's authorization threshold.

bob (Head of Research) approves.

alice + bob      RAISED → Turnstile mandate — $1 cap
fund $1 — the same request as beat 4           SIGNED  0x02f8d2834cef5280830f4240…
```

An agent hit a limit it cannot raise. A human proposed raising it and could not,
alone. A second human approved and the limit moved.

**The honest caveat:** in this demo both operator private keys sit in `.env`, so
this machine can in fact produce both signatures. That is a property of the demo,
not of the design — in production each key lives on its operator's own device and
the server holding the app secret never sees one. Nothing in `buyer/org/` assumes
otherwise; `buyer/org/env.ts` says the same thing at the point where it reads
them.

### `npm run arc:setup` — the money actually moving

```
DEPOSIT 0.25 USDC INTO THE AGENT'S GATEWAY BALANCE
depositFor(USDC, 0x0633a193017939Bb1eB242982397224c66948e2F, 250000)
signed by the Privy org wallet, approved by alice (CFO), within the mandate policy

  approve  0x3c526daf25216ac831ba21f828458e4bdd7562227b012b399b3e05f0869320de
  deposit  0x681ba1cdbe5b46c6dcd6a7f906265b678099c501e425d62b114793d65c297ec3

warm / org    0x3De96375140717193f52c220Df5Ec460971cbE84   (Privy wallet w0cxyoh1lnc1lqfyi9tb5yej)
  nonce       0 -> 2      (it transacts; this is expected to move)
  on chain    2.000000 -> 1.746664 USDC
hot / agent   0x0633a193017939Bb1eB242982397224c66948e2F
  nonce       0 -> 0      <-- the zero-gas proof
  on chain    0.000000 -> 0.000000 USDC   [native 0 wei]
  gateway     0.105500 -> 0.355500 USDC available
```

The org's nonce moved by two and its balance fell by the gas. The agent's nonce
did not move, its on-chain balance stayed zero, and its **Gateway** balance grew
by exactly the deposit. That is the cold/warm/hot hierarchy in one contract call,
now with a quorum on top of it.

---

## What was verified, and what was not

| Claim | Status |
|---|---|
| `POST /v1/wallets`, `/v1/policies`, `/v1/key_quorums`, `/v1/users` all answer our app | **Verified** 2026-09-07, basic auth only |
| Key quorums need no paid plan, no browser, no dashboard step | **Verified** — every object above was created from a terminal |
| Embedded wallets can be pre-generated server-side for a user | **Verified** — `POST /v1/users` with `wallets: [{chain_type}]` returns a `connector_type: "embedded"` account |
| A policy owned by a 2-of-2 quorum rejects a 1-signature PATCH | **Verified** — `401`, message quoted above |
| The same PATCH with 2 signatures succeeds | **Verified** — the policy came back renamed with new rules |
| A wallet policy caps `depositFor.value` | **Verified** — $0.25 signed, $1.00 `policy_violation`, then $1.00 signed after the raise |
| A policy can pin `depositFor.depositor` | **Verified** — a deposit naming a different address was refused |
| `eth_signTransaction` works for Arc testnet (`eip155:5042002`) | **Verified** — Privy signs any chain id; it does not need to route the chain |
| `eth_sendTransaction` works for Arc testnet | **Not attempted.** Privy routes RPCs for chains it knows and Arc testnet is not one, so we sign and broadcast ourselves |
| The signed transaction is valid on chain | **Verified** — two transactions mined, linked above |
| The agent's nonce is still 0 after all of it | **Verified** — `buyer/watchdog/hot-wallet.test.ts` asserts it, and passed against live Arc |
| Privy **Cards** | **Not used at all**, mocked or otherwise |
| Anything on Arc **mainnet** | **Not attempted.** Testnet only |
| Whether an operator can approve from a real device rather than `.env` | **Not attempted.** The signature scheme does not care where the key slept, but we did not build the device half |

---

## Rough edges in Privy's API

Recorded here rather than in `FEEDBACK.md` (Uniswap) or `WORLD-FEEDBACK.md`
(World), both of which are scored deliverables for other sponsors. Each of these
cost real time.

1. **A catch-all `{ method: '*', action: 'DENY' }` rule denies everything**,
   including requests an earlier `ALLOW` rule matched. DENY is a veto, not the
   last word in an ordered list. Since Privy is already deny-by-default — a
   policy with **zero** rules refuses every request — the catch-all is both
   unnecessary and actively harmful, and the docs' framing of rules as a list
   invites writing one. Cost: an hour of every request returning
   `policy_violation` with a policy that looked correct.

2. **Address comparisons are case-sensitive, and the API checksums your rule for
   you.** Submit `value: "0x0077777d7eba…"` and it comes back stored as
   `0x0077777d7EBA…`; a transaction whose `to` is lowercase then fails to match
   and lands in deny-by-default. The error is `policy_violation` with no hint
   that the two addresses were the same address. Cost: the first hour, before the
   one above.

3. **`policy_violation` is one error for every possible cause.** No rule id, no
   condition, no "matched rule X and denied". Debugging a three-condition rule
   means bisecting it by creating new policies. A field naming the rule that
   denied — or, when nothing matched, saying so — would turn an hour into a
   minute.

4. **The RPC accepts a JSON number or a `0x` hex string for `gas_limit`,
   `max_fee_per_gas` and `max_priority_fee_per_gas`, and rejects a decimal
   string** with `Invalid input: must start with "0x"`. Reasonable, but the
   natural JS move — `value.toString()` on a `bigint` that overflows a safe
   integer — produces exactly the rejected form, and the docs' examples all show
   small numbers where the number form works.

5. **`GET /v1/policies` and `GET /v1/key_quorums` return `405 Method not
   allowed`.** There is no way to list what your app has created, so an
   interrupted setup script leaves orphans you cannot enumerate — only fetch by
   id, if you kept it. `GET /v1/wallets` and `GET /v1/users` do list.

6. **Nothing in the API is idempotent by resource identity.** Rerunning setup
   creates a second organization rather than reconciling; `privy-idempotency-key`
   deduplicates a *retry*, not a re-run. `scripts/privy-org-setup.ts` therefore
   refuses to run when `.env` already names an org, which is a guard the API
   could offer.

---

## Files

| File | What it is |
|---|---|
| `buyer/org/authorization-key.ts` | P-256 keys, RFC 8785 canonicalization, the signature |
| `buyer/org/privy.ts` | The REST client. Basic auth, plus one signature per approver |
| `buyer/org/operators.ts` | Humans as Privy users with embedded wallets; the two quorums |
| `buyer/org/org-wallet.ts` | The server wallet, and `eth_signTransaction` |
| `buyer/org/fund-agent.ts` | `approve` + `depositFor`, signed at Privy, broadcast by us |
| `buyer/org/env.ts` | Reassembling the org from `.env`, and the honest note about where keys live |
| `buyer/mandate/mandate.ts` | The five fields, the ledger, the `verified_operator_only` gate |
| `buyer/mandate/enforce.ts` | The mandate projected onto one 402 challenge |
| `buyer/mandate/policy.ts` | The mandate projected onto a Privy policy; `raiseSpendCap` |
| `scripts/privy-org-setup.ts` | Stand the organization up, once |
| `scripts/privy-mandate.ts` | The transcript above |
| `scripts/arc-setup.ts` | `depositFor()`, now signed by the org wallet |
| `buyer/watchdog/hot-wallet.test.ts` | The nonce claim, as an assertion |
