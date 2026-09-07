# docs

Architecture notes, submission copy, evidence (tx hashes, HashScan links, terminal output).

- `graph-notes.md` — The Graph tooling notes: the Subgraph MCP server (what it does and does not do, the precise authentication behaviour, and why it cannot see a Studio deployment), plus the two consumer-side traps in our own subgraph. Kept out of `FEEDBACK.md`, which is a Uniswap deliverable.
- `arc-nanopayments.md` — The Arc rail (MOV-225): Circle Gateway Nanopayments, the zero-gas proof as a nonce that never moves, the batching evidence, the answer to whether a payment can settle below the authorized amount, and six rough edges in Circle's SDK and API.
