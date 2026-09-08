# graph

The Graph products. Two submissions ride on this: Composable and AI/From Scratch.

- `substreams/` — the ERC-8004 agent-registry module (MOV-221). Published as
  `erc8004-agent-registry-v0.1.0.spkg`; streams mainnet, Base, Sepolia and Base
  Sepolia off one binary.
- `sink/` — the discovery store (MOV-222). Persists that stream, resolves the
  agent documents a Substreams module cannot fetch, and joins in our sellers'
  ENSv2 offer records. `seller/service/discovery.ts` queries it.
- `subgraph/` — the Messari-schema subgraph (MOV-215).
