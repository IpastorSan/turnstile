# mcp-turnstile

Four MCP tools that let one agent find, price, pay and audit another, over
ERC-8004 registries, ENSv2 offer records and x402 payments.

**This is the reusable artifact, not an end-user app.** Nothing in it knows what
is being sold. It finds, prices, pays and audits *any* x402 seller, and
[`examples/`](examples/) proves that by buying from two unrelated ones with the
same buyer code.

- **[`SKILL.md`](SKILL.md)** — install it, run it, and the list of things it does
  not know. Start there.
- **[`examples/`](examples/)** — the worked example, and a captured transcript
  with real Hedera transaction ids.

```bash
npx -y mcp-turnstile                      # published package
claude mcp add turnstile -- npx -y mcp-turnstile

node mcp-turnstile/server.ts              # from a clone, running the sources
node mcp-turnstile/server.ts --db path/to/discovery.db
```

Needs Node 22.18+. No database server, no compiler, no native module, no API key.
Transport is stdio, so stdout is the wire — every diagnostic goes to stderr.

## Tools

| tool | what it answers |
|---|---|
| `find_sellers` | who exists, across every chain with an ERC-8004 registry, and what we do and do not know about their prices |
| `get_offer` | an ENS name, an `agentUid` or a URL → a quote, and whether it can actually be bought right now |
| `purchase` | pay a 402 inside a spending mandate, and hand back the answer and the settlement id |
| `receipts` | what a seller has actually been paid, read off a public consensus topic with no key and checked against the ledger |

`SKILL.md` documents each one properly, including the five distinct ways
`purchase` can decline.

## Layout

| file | |
|---|---|
| `server.ts` | registers the four tools over stdio |
| `store.ts` | finds the discovery store, and refuses to invent an empty one |
| `offer.ts` | identifier → offer. The file the reusability claim lives or dies on |
| `purchase.ts` | the x402 flow. Protocol, not product |
| `receipts.ts` | the HCS audit trail, and the ledger check that makes it evidence |
| `signers.ts` | which rails this buyer can pay on, and precisely why not for the rest |
| `tools/` | the MCP wrappers: schemas, descriptions, and the prose summary each returns |
| `examples/` | the worked example |
| `scripts/prepack.mjs` | assembles the publishable tarball |

Each tool returns a short prose summary **followed by** the full JSON. The
summary exists because the caller is an agent about to spend money, and the
things it most needs to notice — that a ranking is a placeholder, that a
published price is not a quote, that a dollar figure came from the seller's own
arithmetic — should not be something it has to dig out of a nested object.

## Packaging

Working in this repository needs no build step: Node runs the `.ts` sources
directly. **Publishing does**, and for one specific reason — Node refuses to
strip types for anything under `node_modules` and throws
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` (verified on Node 26.7, 2026-09-07,
by installing a `.ts`-bin tarball and running its `bin`). A published package is
expected to ship JavaScript.

So `scripts/prepack.mjs` walks the import graph from `server.ts`, compiles what
it finds into `_bundle/` **mirroring the repository layout** — so every relative
import resolves unchanged — and copies `schema.sql` and the discovery snapshot
beside it. There is no hand-maintained file list: adding an import anywhere in
the graph packs it.

```bash
cd mcp-turnstile && npm pack        # runs prepack; produces mcp-turnstile-<version>.tgz
```

`_bundle/` is generated and gitignored. The tarball carries the 197-agent
discovery snapshot, so `npx mcp-turnstile` answers a real query on a machine that
has never run an indexer.
