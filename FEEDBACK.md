# Uniswap developer feedback

Written continuously, not reconstructed at the end. Every time we hit a rough
edge in the Uniswap docs, SDKs, APIs or subgraphs, it gets a dated entry below —
that is checklist item 13.

Append-only (`merge=union`): add at the end, never rewrite an existing entry.

At submission time this file's link goes into the form at
https://developers.uniswap.org/hackathon-feedback — the prize requires the
submitted form, not just the file.

**Entry format**

```
### YYYY-MM-DD — one-line summary
- **Surface:** docs page / SDK / API / subgraph, with the URL or package
- **Expected:** what we thought would happen
- **Actual:** what happened
- **Cost:** how long it took to get past, and how
- **Fix we'd suggest:**
```

---

## Docs

## SDKs

## APIs and quoting

## Subgraphs and data

## Everything else

## Substreams / Graph Market — MOV-222 (2026-09-07)

- **Concurrent stream limit is 2, and the error only appears at the third.**
  Sinking three chains in parallel fails one of them with
  `ResourceExhausted: Concurrent stream limit exceeded (active sessions: 2/2)`.
  The limit is not documented anywhere we found before hitting it, and it is not
  in `substreams --help`. A sink that fans out per chain — the obvious shape —
  silently loses a chain unless it checks exit codes.
- **`substreams run` refuses a store as an output module**, so a store can only
  be exercised through a map that reads it, and that map then has to backfill
  the store from its `initialBlock` before it emits anything:
  `this request needs to process 37,200 blocks (37,000 of them to prepare the
  stores)`. For a consumer that wants a recent window, the pure map module plus
  a fold in the sink is dramatically cheaper. Worth saying so in the docs — the
  composable-store story reads as strictly better than the map, and for this
  access pattern it is not.
