# contracts/src

- `TurnstileRegistry.sol` — library. Deploys the registry as a `UserRegistry`
  proxy through ENS's `VerifiableFactory`, pre-computes its CREATE2 address, and
  defines the operator / registrar / buyer role bitmaps. There is deliberately no
  bespoke registry implementation; see the file header for why.
- `TurnstileRegistrar.sol` — contract. Pricing, availability, mint, renew.
