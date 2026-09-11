# identity

World Selfie Check — nullifier bound to the seller cold key. A risk/eligibility signal, not a login.

**Correction (2026-09-11, MOV-277):** the nullifier is bound to a **listing**,
not to a cold key. Nothing in this directory reads a key. What it does:

- `limits.ts`: three listings per human, the fourth refused.
- `world.ts`: sign the request context, check the proof's signal against the
  listing string, verify with the Developer Portal.
- `canonical.ts`: decide the key a proof is stored under. A registered
  `turnstile.eth` name becomes its ERC-8004 agent uid, which the market joins
  on. An unregistered subname is a reservation keyed by the name. The first
  real proof (2026-09-11) was stored under the name and never reached the
  market; this is the fix.
- `store.ts`: read and write `world_verification`, count listings per nullifier.
