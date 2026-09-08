# contracts/test

- `TurnstileFixture.sol` — stands up the whole stack locally: real
  `VerifiableFactory`, real `UserRegistry` implementation, two proxies (one
  standing in for `ETHRegistry`), and the registrar wired to it. Only `LabelStore`
  is mocked.
- `TurnstileRegistrar.t.sol` — minting, duplicates, authorisation, payment,
  renewal, label policy, the hierarchy link.
- `Roles.t.sol` — pins `grantRoles` vs `grantRootRoles` so a refactor cannot
  silently regress it.
- `fork/SepoliaEnsV2.t.sol` — against live Sepolia, including the redeploy canary.
