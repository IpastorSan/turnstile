# mcp-turnstile

MCP server + SKILL.md. This is the reusable-infrastructure artifact, not an
end-user app: a buyer's agent talks to this rather than to our HTTP service.

```bash
node mcp-turnstile/server.ts --db graph/sink/data/discovery.db

# register it with a client
claude mcp add turnstile -- node "$PWD/mcp-turnstile/server.ts" --db "$PWD/graph/sink/data/discovery.db"
```

Transport is stdio, so stdout is the wire — diagnostics go to stderr.

## Tools

### `find_sellers`

Find agents that can sell a service, across every chain that hosts an ERC-8004
Identity Registry, and rank them. Implementation:
`tools/find-sellers.ts` → `seller/service/discovery.ts`.

| Argument | |
|---|---|
| `capability` | Tokens; an agent matching any of them qualifies. |
| `maxPriceUsd` | Ceiling. Applied only where a price is knowable. |
| `chains` | `"base"`, `"mainnet"`, … or numeric chain ids. Omit for all. |
| `requireX402` | Only agents advertising `x402Support`. |
| `turnstileOnly` | Only sellers with an ENSv2 price. |
| `includeUnknownPrice` | Keep unpriced agents under a ceiling query. |
| `limit`, `offset` | |

The tool returns a short prose summary followed by the full JSON result. The
summary exists because the caller is an agent about to spend money, and the
things it most needs to notice — that the ranking is a placeholder, that N
agents were dropped for having no knowable price, that M documents could not be
fetched — should not be something it has to dig out of a nested object.

**What the contract guarantees**

- Every seller carries a `priceSource`. `ask_x402` means the agent takes payment
  and has not been quoted; it never means free.
- `ranking.placeholder` is `true` while settled volume does not exist, with a
  note saying why. Do not read that order as reputation.
- Agents whose registration document could not be fetched come back marked
  `documentState: "failed"` rather than being dropped. Their capabilities are
  unknown, not absent.
