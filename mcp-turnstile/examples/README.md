# examples

The narrative this whole package exists to make runnable: **an agent discovers a
seller it has never seen, pays it, and reasons over the answer — with no API key
anywhere in the flow.**

```bash
node mcp-turnstile/examples/discover-pay-reason.ts --dry-run   # no wallet needed
node mcp-turnstile/examples/discover-pay-reason.ts             # real HBAR
```

A captured run, with transaction ids anyone can check on HashScan, is in
[`transcript.md`](transcript.md).

## The three files

**`buyer-agent.ts`** — the buyer, in about a hundred lines. It talks to the
Turnstile MCP server over stdio and to nothing else. **Search it for a seller
name, a price, a payout address, a URL, a chain or a response schema and you will
not find one.** Everything it acts on arrives at runtime.

`reason()` in it is a deliberately dumb, schema-agnostic reader that pulls the
human-readable strings out of whatever JSON came back. In a real deployment that
is a model, and it is the only part of the file that would change. Keeping it
dumb here is the point: a demo whose "reasoning" is a hard-coded path into a
known response shape has quietly re-introduced the coupling everything else is
trying to avoid.

**`stranger-seller.ts`** — a seller that exists to falsify the claim that any of
this only works because it knows about `liquidity.turnstile.eth`. It shares no
seller code with Turnstile's service: no `createApp`, no `paidRoute`, no
`RailRegistry`, no tiers, no analyst. It is a bare `node:http` handler that
builds its own 402 and calls the four `PaymentRail` methods directly. It sells
something Turnstile does not sell, for a price Turnstile does not charge, on a
URL shape Turnstile does not use.

What it *does* share is the Hedera rail and the public facilitator — and that
sharing is the point rather than a compromise. A rail is infrastructure two
unrelated sellers are supposed to have in common, the way two unrelated websites
have TLS in common.

It writes no HCS receipt, deliberately: nothing on chain binds a seller to a
receipt topic, so publishing into Turnstile's would be both wrong and misleading.
Its settlements are real regardless.

**`discover-pay-reason.ts`** — the harness. It starts both sellers, spawns the
MCP server as a subprocess, runs the buyer twice, and prints the transcript.

## What the two acts prove, separately

**Act 1** is the honest half. The buyer asks for a *capability* and gets back
`liquidity.turnstile.eth`, whose name, ENS records, price and payout account it
had never seen. It then discovers that the endpoint published on chain does not
resolve, and `get_offer` refuses to call the offer purchasable — with the $0.07
price still reported beside the refusal. Only then does it buy, from the address
the seller actually serves at.

**Act 2** is the genericity half. The same buyer function, unchanged, buys from a
service with which it shares nothing.

Neither act on its own would be enough. Act 1 alone could be a client for one
seller. Act 2 alone would not touch a registry, a name or a published price.

## Tests

`stranger-seller.test.ts` runs act 2's shape offline, on a stub rail with a stub
signer: no testnet, no facilitator, no funded key. It is the mechanized version
of the reusable-infrastructure claim, so if the server ever grows a dependency on
our own seller, it fails in CI rather than in front of a judge.

```bash
npm test
```
