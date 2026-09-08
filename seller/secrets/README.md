# seller/secrets

Sealed `.enc` blobs plus the headless decrypt entrypoint. The `.enc` files ARE
tracked — they are ciphertext by design.

**Correction (2026-09-08, MOV-000):** this file previously said "Ledger Key Ring
sealed .enc blobs". Two things were wrong. The Ledger track is **not pursued** —
`wallet-cli ring init` fails on our only device, a Ledger Nano S, which LKRP has
never supported (see the cold-tier correction in `CLAUDE.md`). And this directory
holds **no `.enc` files and no decrypt entrypoint** today — only this README,
verified 2026-09-08. Nothing here is sealed by anything yet; treat the sentence
above as the intended shape, not as a description of what is in the repo.
