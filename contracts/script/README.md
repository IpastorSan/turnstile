# contracts/script

- `Deploy.s.sol` — idempotent Sepolia deployment. Reads `DEPLOYER_PRIVATE_KEY`,
  writes `addresses.turnstile.sepolia.json`.
- `EnsSepolia.sol` — loads ENS's Sepolia addresses out of `addresses.sepolia.json`
  at run time, so an ENS redeploy is a one-file fix rather than a recompile.
