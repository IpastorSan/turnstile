# Corrections

Claims in this repo that turned out to be wrong, what replaced them, and why.

Nothing here is deleted from the record. A hackathon repo that quietly edits its
own history is worth less than one that shows the correction, and every entry
below was found and fixed before a judge read it rather than after.

These blocks lived in `README.md` until 2026-09-08. They were moved here because
they had grown to a hundred lines sitting between the pitch and the
architecture, which meant the first thing a reader met was a list of things that
had been wrong. That is the wrong order for a reader and the wrong emphasis for
the work. The content is unchanged.

Current state of every claim: [`docs/EVIDENCE.md`](./docs/EVIDENCE.md).

---

**Correction (2026-09-08, MOV-000):** the Cold row previously named **Ledger Key
Ring (`wallet-cli ring`)** as the vendor and claimed it "seals upstream API
keys". Both are withdrawn — **we do not use a Ledger device and never got one
working.** `wallet-cli ring init` fails on the only device available to us, a
**Ledger Nano S** (the original 2016 model, EOL, firmware capped at 2.1.0): it
creates the local member credentials and then fails at the device step with an
untyped "unknown error". LKRP is the trustchain behind Ledger Recover, which has
never supported the Nano S. It is not permissions (udev verified, `uaccess` tag
present, hidraw readable), not transport (`genuine-check` returns a *typed*
error, so the device does answer), and not the package — the model cannot do it.
The Ledger prize track is **not pursued**; see `CHECKLIST.md`.

**What is unchanged: the cold tier itself, and every other row.** Ledger was only
ever going to be *where the cold key lives*, never *what makes it cold*. The
cold/hot split is enforced by the resolver's role checks, and it is proven on
chain rather than in prose — MOV-218 demonstrated the hot key's `setAddr` payout
change **reverting** with `EACUnauthorizedAccountRoles`, live on Sepolia, with
passing Forge tests and a fork test behind it. What falls is only the custody
story: the cold key is **not** hardware-backed. No substitute vendor is
claimed.

**Correction (2026-09-08, MOV-005): "held offline" was not true, and this row
said it in four files.** When the Ledger track was dropped, the Cold row's vendor
became "A cold key held offline". That traded an unverifiable vendor claim for an
unverifiable *custody* claim. `contracts/addresses.turnstile.sepolia.json` records
`coldKey` and `deployer` as the **same address**
(`0x0Adca6e14bA956201D221feC767e4f24194bf5F2`), and its private key is
`DEPLOYER_PRIVATE_KEY` in `.env` on the working laptop, loaded by every deploy
script. It is not offline in any sense.

**What is true, and is the claim worth making.** The tiers are a separation of
*authority*, not of custody, and that separation is real and enforced by the
chain rather than by our prose:

- Two distinct keys exist. `0x0Adca6e1…f5F2` holds the root roles on
  `liquidity.turnstile.eth`. The hot key `0x16244874…6367` holds roles scoped to
  exactly two records, `agent-endpoint[mcp]` and `turnstile:price`.
- The hot key **cannot** move the payout address. MOV-218 demonstrated its
  `setAddr` reverting with `EACUnauthorizedAccountRoles`, live on Sepolia, with
  Forge tests and a fork test behind it.

So: say "a separate key holds the only roles that can move the payout address,
and the chain enforces it". Do **not** say cold storage, hardware, or offline.
Making the custody genuinely cold means generating that key on an offline machine
and keeping it out of `.env` entirely, signing the rare cold-tier transactions
air-gapped. That is not done, and claiming it would be the same mistake twice.



**Correction (2026-09-07, MOV-225):** the Hot row previously read "holds zero
native token (Paymaster)". That is **wrong on Arc** — it names a mechanism that
does not exist in this design, and it cannot be true on a chain where USDC *is*
the gas token. The row above replaces it with a stronger claim, and the evidence
for it is on chain.

**The claim, and how to falsify it.** The hot wallet signs an EIP-3009
authorization offchain and **never submits a transaction**, so it pays exactly
zero gas — Circle Gateway's batcher submits, and pays. The proof is the wallet's
**nonce**, because a wallet that has never broadcast a transaction has never paid
a wei of gas, and a nonce cannot be faked or back-dated. After **eleven** settled
payments:

```
agent 0x0633a193017939Bb1eB242982397224c66948e2F
  eth_getTransactionCount   0        <-- never submitted anything
  eth_getBalance            0
  USDC.balanceOf            0
                            read at block 60943091, 2026-09-07T17:33:02Z
```

Anyone can re-run that against `https://rpc.testnet.arc.network` and get the same
answer at that block. `scripts/arc-paid-request.ts` prints it before and after
every run, so a regression fails visibly instead of quietly.

**Why the old wording was incoherent** (supporting detail, not the claim). USDC
is Arc's native gas token, so `eth_getBalance(a)` and `USDC.balanceOf(a)` are two
views of one balance at two precisions — the ERC-20 view truncates 18 dp to 6.
Measured on **our own** org wallet, one block before it funded the mandate:

```
0xdFe3088aC34e7329006407C246C9F6D7534B2aC5
  eth_getBalance   20000000000000000000   (18 dp) = 20.000000 USDC
  USDC.balanceOf              20000000   ( 6 dp) = 20.000000 USDC
                   read at block 60938781, 2026-09-07T16:56:10Z
```

A wallet holding zero native token therefore holds zero USDC and can pay nobody.
There is no Paymaster anywhere in Turnstile, and there never was one — the word
was carried over from a chain where gas and payment are different assets.

The hot wallet's Gateway balance is funded by the **warm tier** calling
`depositFor(amount, agent)`: the org pays the deposit's gas and the resulting
balance belongs to the agent. That is this table's own hierarchy expressed in one
contract call — the hot key cannot deposit, withdraw or widen its allowance,
because each is a transaction and it has no gas for one.

**What is unchanged:** every other row, and the invariant below the table. Only
the mechanism named in the Hot row was wrong.

---

**Correction (2026-09-09, MOV-262):** `web/lib/spend.ts` claimed that "each
failure is contained" and that a rail which could not be read reports an error
rather than a zero, so that "we could not read Arc" and "the agent has never paid
on Arc" stay distinguishable. **That was true of the Arc rail and not of the
Hedera one.** `readReceipts` answers an unreachable mirror node with an *empty
result and a note* rather than a throw — deliberately, and its own tests pin that
— so an outage arrived at `Promise.allSettled` as a **fulfilled** read of zero
receipts. The /mandate page would have rendered "0 payments, $0.00 settled on
Hedera" with no error shown, which is the exact collapse the module exists to
prevent, in the one place a judge reads a settled-volume number.

Found by writing the test the claim implied, which is the only reason it was
found at all: the branch fires only when the mirror node is down, and it never
was during a demo.

**Fixed in the same branch.** `ReceiptsResult` gained `unreadable: string | null`
— set on all three failed-read paths (no topic configured, a non-2xx answer, an
unreachable node) and `null` on a real read — and `readSpend` now treats a
fulfilled-but-unreadable Hedera read as a failure, reporting `usd: null` with the
reason. It also no longer reports `topicIsOpen` from a failed read, since one
learns nothing about the submit key and "anyone can append" is not a property to
infer from an outage.

**What is unchanged:** the Arc rail, which always behaved as documented because
its Gateway client throws; the containment design itself, which was right; and
`readReceipts`' choice to answer a page-rendering caller with an empty result
rather than a throw. Only the Hedera rail's *detection* of that result was
missing. `web/lib/spend.test.ts` now pins the property in both directions, with
a genuinely-empty topic as the negative control so `null` and `0` stay different
answers.

---

**Correction (2026-09-11, MOV-277): the first real World proof was verified and
then never shown.** A Sandbox App proof was verified by World's Developer Portal
on 2026-09-11 at 09:06:02 UTC. `/onboard` hard-coded
`const SELLER = 'liquidity.turnstile.eth'` and posted it as `agentUid`, and the
verify route stored the proof under whatever the client sent. The market view
joins `world_verification` on the ERC-8004 agent uid
(`eip155:11155111:0x8004a818…/10127`), so the proof was orphaned and
`/api/sellers` reported the seller as `unknown`. Verified against the live
store: exactly one row, keyed by the name.

**Fixed in the same branch.** The route no longer trusts the client for the key:
`identity/canonical.ts` resolves a registered `turnstile.eth` name to its agent
uid from the discovery store, keeps an unregistered subname as a labelled
reservation keyed by the name, and refuses anything else. The proof's signal is
still checked against the exact string the client signed. `/onboard` picks
listings from the store. `scripts/world-rekey.ts` moves the orphaned row.

Two adjacent holes were closed while there: a second human could take over a
verified listing by verifying it, and a refused attempt overwrote the verified
row it was refused for. Both now leave the verified row alone.

**What is unchanged:** the three-listing cap, the nullifier never reaching the
browser, and `unknown` rather than `unverified` for agents with no proof.
