# web

Next.js 16 (App Router). Frontend **and** backend — Arc requires both, so
nothing here is a static export; every route is server-rendered or a real API
route.

```bash
npm install
npm run dev          # http://localhost:3210
npm run build
npm run typecheck
npm run snapshot     # re-cut web/data/ from the live discovery store
```

## Two data dependencies, and what happens when they are missing

| Dependency | Used by | Missing behaviour |
|---|---|---|
| A discovery store (SQLite) | market page, `/api/sellers` | The page says no store is loaded. It does not render placeholder agents. |
| `SEPOLIA_RPC_URL` | seller page, `/api/offer/:name` | The page says the resolver cannot be read. It does not fall back to a cached price. |

`GET /api/health` reports both.

## Where the data comes from

`graph/sink/data/discovery.db` is the working store — rebuilt from chain by
`graph/sink/`, and gitignored, so a deployment has nothing to serve. `npm run
snapshot` writes a VACUUMed copy to `web/data/discovery.db` alongside a
`provenance.json` recording when it was captured, which block ranges it covers
and what is in it.

`lib/discovery.ts` prefers the working store and falls back to the snapshot,
and the UI says which one it is reading. **Both paths run the same
`findSellers` from `seller/service/`** — the price reconciliation and the
placeholder-ranking switch are the tested parts of MOV-222, and a second
implementation here would drift from them.

The one readable price is *not* served from the snapshot. `lib/ens.ts` reads
`turnstile:price` off the Sepolia resolver on every request, because a price
that is not read live is not one this app can vouch for.

## Rules this app is built to

- **No ENS name is hard-coded on the demo path.** Seller identity comes from
  `contracts/addresses.turnstile.sepolia.json` (MOV-218's rule, and an ENS prize
  gate). `/seller` redirects to whatever the manifest names.
- **No fabricated data, anywhere.** The two blocked routes say what they will
  contain and which issue delivers them, and show no example records.
- **"No knowable price" is a state, not a blank.** Three distinct readings, so a
  buyer can tell "ask its endpoint" from "there is nothing to ask".
