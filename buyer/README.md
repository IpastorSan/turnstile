# buyer

The buyer half: an agent that may spend, without ever holding a key that can
raise its own limit.

| Directory | Tier | What it is |
|---|---|---|
| `org/` | **warm** | The Privy organization wallet, its human operators, and the two key quorums |
| `mandate/` | **warm** | What the organization authorized, and the two places it is enforced |
| `watchdog/` | **hot** | The agent. Signs offchain, submits nothing, spends inside the mandate |

Read them in that order. `docs/privy-mandate.md` is the writeup for the first
two; `docs/arc-nanopayments.md` for the third.

The invariant all three defend, from `CLAUDE.md`:

> **the key that spends can never raise its own limit.**

`watchdog/` reads a mandate it cannot write. `mandate/` projects that mandate
into a Privy policy that Privy's own enclave enforces. `org/` needs two operators
to change that policy. Each layer is a thing the layer below cannot do.
