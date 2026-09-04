# contracts

Foundry project — ENSv2 subname registry + registrar, deployed to **Sepolia**.

- `src/TurnstileRegistry.sol` — UserRegistry proxy via the Verifiable Factory
- `src/TurnstileRegistrar.sol` — pricing, availability, mint (cf. `SimpleSubnameRegistrar`)
- `script/Deploy.s.sol` — deployment
- `test/` — Foundry tests

ENS features must be **central, not cosmetic**, and the demo must run with **no
hard-coded values** — both are binary gates in `CHECKLIST.md`.

## Toolchain

Foundry 1.8.1 (`forge`, `cast`, `anvil`, `chisel`), installed at
`~/.config/.foundry/bin` — the installer honored `XDG_CONFIG_HOME`, so it is not
the usual `~/.foundry`. The `PATH` export is already in `~/.bashrc`.

```bash
forge --version   # forge Version: 1.8.1
```

⚠️ The ENSv2 Sepolia addresses are **not settled** — checklist gate 8. Get them
from `ensdomains/contracts-v2` by grepping
`broadcast/<script>/11155111/run-latest.json`. Do not trust doc-scraped
addresses; the ones found on 09-04 could not be corroborated and may be
fabricated.
