# Manual steps

Actions only a human can take, and why. Everything else in this project is automated —
if something is here, an agent genuinely cannot do it (physical hardware, a browser
session, a human approval queue, or an authorization nobody delegated).

Status as of 2026-09-07.

---

## 1. Ledger key ring — `wallet-cli ring init` (MOV-213)

**Why manual:** requires the physical device plugged in, unlocked, with a button press.

**Before you start:** the package was audited on 2026-09-07. Maintainers are byte-identical
to `@ledgerhq/hw-transport` and `@ledgerhq/device-management-kit`; there are **no install
scripts** on either the launcher or the platform binary, so `npm i` cannot execute code; the
launcher is 1.3 KB of readable JS that resolves a platform npm package rather than fetching
anything at runtime. Against that: **no provenance attestation**, no repository link, and the
real payload is a 163 MB Bun-compiled binary that is effectively unauditable. It also bundles
`@segment/analytics-node` — there is telemetry. The seed never leaves the device, so this is
not a funds risk; the exposure is whatever you seal.

```bash
# 1. udev rules — REQUIRED on Arch. Without them wallet-cli cannot see the device over USB
#    as a non-root user and genuine-check simply hangs with no useful error.
wget -q -O - https://raw.githubusercontent.com/LedgerHQ/udev-rules/master/add_udev_rules.sh | sudo bash

# 2. Plug in the Ledger, unlock it, open the Ethereum app.

# 3. Install and confirm the device is genuine.
npm i -g @ledgerhq/wallet-cli
wallet-cli genuine-check

# 4. Provision the key ring. `read -rs` keeps the password out of shell history.
read -rsp "key ring password: " WALLET_PASS && export WALLET_PASS && echo
wallet-cli ring init
wallet-cli ring keys

# 5. Prove the round trip on a throwaway value.
echo "smoke-test" | wallet-cli ring encrypt -o /tmp/t.enc --key turnstile-seller
wallet-cli ring decrypt -i /tmp/t.enc && rm /tmp/t.enc
```

- **Do not use `--unsecure-no-password`.** Ledger's own docs say not to for anything holding
  real data.
- `gnome-keyring-daemon` is **not running** on this machine, so `secret-tool` will not
  retrieve the password later. Keep it somewhere recoverable — the sealed `.enc` files are
  useless without it.
- `ring init` is the **only** step needing the device. Everything after is device-free, and
  that decoupling is the entire basis of the Ledger submission (MOV-224).

---

## 2. Create the subgraph in Graph Studio (MOV-215)

**Why manual:** a Studio deploy key can deploy *to* a subgraph but cannot create one.
`graph create` returns `Method not found` — Studio's JSON-RPC exposes only `subgraph_deploy`.
Creation is a `createSubgraph` GraphQL mutation requiring a **wallet-signed browser session**.
Signing that with `DEPLOYER_PRIVATE_KEY` was deliberately not attempted: that key was
provisioned for ENS/Sepolia, and opening a session on the Graph account is a different
authorization.

> **thegraph.com/studio → Create a Subgraph**
> slug exactly `turnstile-uniswap-v3-messari`, network **Ethereum mainnet**

Then the deploy is a one-liner from `dev`. Everything else — code, cross-protocol query,
live-data proof — is already merged.

**How much it costs if it slips:** less than it looks. The composability claim rests on the
cross-protocol query run against *live published subgraphs through the gateway*, which
already satisfies "consume live data from a Graph provider". Our own deployment strengthens
the "authoring a Standardized Subgraph" half. Upside, not a prerequisite.

---

## 3. World ID Sandbox access (MOV-210)

**Why manual:** a human-approved Google Form with unknown turnaround. The only queue-gated
item in the project.

- Form: https://forms.gle/mqbaiwMvX5MzmKdY8 — **submitted**
- Developer Portal app: `app_8094ddfd713d285d5b1d7655a25f9697` — **done**, in `.env`
- `WORLD_SANDBOX_KEY` — **still empty, waiting on them**

If it does not arrive, escalate in the World Discord rather than waiting silently. If it
never arrives, the $3,500 World track (MOV-223) is dead and should be written off
deliberately rather than discovered on day 11.

Regardless of approval status, **`WORLD-FEEDBACK.md` must be appended to continuously** —
it is a hard qualification requirement covering docs, Developer Portal navigation, and
Sandbox states/errors/edge cases. The signup friction is exactly the material they ask for
and it cannot be reconstructed convincingly at the end.

---

## 4. Before submitting — these forfeit prizes if missed

| Action | Why it is manual | Cost of missing |
|---|---|---|
| `gh repo edit IpastorSan/turnstile --visibility public` | Outward-facing publish | **All 12 submissions.** Every sponsor requires a public repo |
| `substreams registry publish` for the `.spkg` | Interactive browser login | Weakens the Graph composability contribution claim |
| Uniswap feedback form: https://developers.uniswap.org/hackathon-feedback | Web form; must include the link to `FEEDBACK.md` | **$3,000** |

The visibility flip and the `.spkg` publish are both "go public at the end" actions and
should fire together. All three are tracked in `CHECKLIST.md`.

---

## Already done — no action needed

- `turnstile.eth` registered on Sepolia, owner `0x0Adca6e1…4bf5F2`, expiry 2027-09.
  Automated in `scripts/register-turnstile-eth.sh` (idempotent) if it ever needs redoing.
  Note it is paid in **free-mint MockUSDC**, not ETH.
- `TurnstileRegistry` + `TurnstileRegistrar` deployed and Etherscan-verified.
- `liquidity.turnstile.eth` minted with live ENSIP-25/26 records.
