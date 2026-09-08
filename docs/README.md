# docs

Architecture notes, submission copy, evidence (tx hashes, HashScan links, terminal output).

- `bazantic-gateway.md` — Bazantic gateway registration and the Recipe copy (MOV-231): the real `@bazantic/cli` surface, the exact `gateway add` run, why registration is blocked on a browser login and a public HTTPS origin, and the Recipe chaining The Graph with Uniswap depth. The service’s own OpenAPI document lives at `seller/service/openapi.yaml`.
- `graph-notes.md` — The Graph tooling notes: the Subgraph MCP server (what it does and does not do, the precise authentication behaviour, and why it cannot see a Studio deployment), plus the two consumer-side traps in our own subgraph. Kept out of `FEEDBACK.md`, which is a Uniswap deliverable.
- `arc-nanopayments.md` — The Arc rail (MOV-225): Circle Gateway Nanopayments, the zero-gas proof as a nonce that never moves, the batching evidence, the answer to whether a payment can settle below the authorized amount, and six rough edges in Circle's SDK and API.
