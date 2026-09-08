# ERC-8004 agent registry — Substreams

A normalized, cross-chain feed of **ERC-8004 "Trustless Agents"** registrations.

One pipeline, reused across every EVM chain that hosts an ERC-8004 Identity
Registry. The chain-specific facts — registry address, chain id, first block —
are module *params*, set per network in `substreams.yaml`, so the same WASM
binary streams Ethereum mainnet, Base, Sepolia and Base Sepolia with no code
change and no per-chain build.

Agents come out keyed by an identifier that is unique across chains, so a
consumer can union the output of several chains and get a single directory.

- Standard: [EIP-8004](https://eips.ethereum.org/EIPS/eip-8004)
- Registry contracts: [erc-8004/erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts)
- Naming aligned with the [Agent0 subgraphs](https://thegraph.com/docs/en/subgraphs/existing-subgraphs/agent0/)

---

## Modules

| Module | Kind | Output | What it is for |
|---|---|---|---|
| `map_agent_registrations` | map | `turnstile.erc8004.v1.AgentRegistrations` | The primitive. Decodes one registry, one block, no state. |
| `store_agent_wallets` | store (`set`, string) | `agent_uid → payout address` | Latest `agentWallet` per agent. Read this instead of re-decoding the registry. |
| `map_agent_directory` | map | `turnstile.erc8004.v1.AgentRegistrations` | The same rows, with `operator` resolved against every wallet ever seen. Consume this if you want "who gets paid" to be right. |

`map_agent_registrations` is a pure function of the block, which makes it cheap
and cacheable but means it can only see `agentWallet` changes that happen in the
*same* block as the registration. `map_agent_directory` closes that by joining
`store_agent_wallets` back in, and doubles as the worked example of composing on
top of the map.

### Events decoded

From the Identity Registry only (`abi/identity_registry.json`, written from the
EIP-8004 text):

```solidity
event Registered(uint256 indexed agentId, string agentURI, address indexed owner)
event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)
event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue)
```

`MetadataSet` is read only for `agentWallet`, the one key EIP-8004 reserves.

---

## The message

Full definition in [`proto/turnstile/erc8004/v1/agent_registry.proto`](proto/turnstile/erc8004/v1/agent_registry.proto).

```protobuf
message AgentRegistration {
  string agent_uid = 1;   // "eip155:<chain_id>:<registry>/<agent_id>" — unique across chains
  string namespace = 2;   // "eip155"
  uint64 chain_id = 3;
  string network = 4;
  string registry = 5;    // Identity Registry, lowercase 0x-hex
  string agent_id = 6;    // ERC-721 tokenId, decimal string (it is a uint256)

  string owner = 7;
  string operator = 8;            // agentWallet — the address the agent is paid at
  OperatorSource operator_source = 9;

  string agent_uri = 10;
  UriScheme uri_scheme = 11;
  bool   registration_resolved = 12;
  string name = 13;
  string description = 14;
  string image = 15;
  repeated Endpoint endpoints = 16;
  bool   x402_support = 17;
  bool   active = 18;
  repeated string supported_trust = 19;
  Price  price = 20;

  RegistrationEvent event = 21;   // REGISTERED | URI_UPDATED
  uint64 block_number = 22;
  int64  block_timestamp = 23;
  string transaction_hash = 24;
  uint32 log_index = 25;
  uint64 ordinal = 26;
}
```

`agent_uid` is the join key. It is CAIP-10-shaped, extended with the ERC-721
token id, which is what makes cross-chain union safe: agent `42` on Base and
agent `42` on mainnet are different agents and get different uids.

To fold the stream into current state, keep the highest
`(block_number, log_index)` per `agent_uid`. `REGISTERED` rows are an agent's
first appearance; `URI_UPDATED` rows carry the same identity with a new service
document.

`AgentRegistrations` also carries `wallet_updates` — `agentWallet` changes seen
in the block. They are emitted separately because an agent can repoint its
payout address without ever touching its URI.

### What is and is not resolved on-chain

A Substreams module is a deterministic function of the block: it cannot fetch
`ipfs://` or `https://`. So this module resolves exactly what the chain already
carries and is explicit about the rest.

| `uri_scheme` | `registration_resolved` | Notes |
|---|---|---|
| `DATA` | ✅ | `data:application/json;base64,…` and percent-encoded. |
| `INLINE_JSON` | ✅ | A bare JSON literal in the URI field. Non-conformant, but it happens. |
| `IPFS`, `HTTPS`, `HTTP` | ❌ | `agent_uri` is populated; fetch it yourself. |
| `EMPTY`, `OTHER` | ❌ | |

When `registration_resolved` is `false`, `name` / `endpoints` / `x402_support`
and friends are zero-valued — that is *absence of data*, not a claim that the
agent has none. Roughly a quarter of mainnet registrations are inline and
resolve in-module; the rest need one HTTP or IPFS fetch per agent, which belongs
in your sink, not here.

Document parsing is deliberately tolerant, because real registrations vary:
the spec says `services`, some agents emit `endpoints`; `x402Support` also
appears as `x402support`; `supportedTrust` as `supportedTrusts`; an endpoint's
`endpoint` as `url`, `serviceEndpoint`, `uri` or `value`.

### About `price`

**EIP-8004 registration-v1 does not standardise a price field.** Under x402 the
quote is returned dynamically by the endpoint in an HTTP 402 response, so there
is nothing on-chain to read. A survey of 1,200 live registrations across
Ethereum mainnet, Sepolia and Base Sepolia found *zero* documents carrying a
price.

The `Price` message therefore exists to capture the non-standard `price` /
`pricing` objects some agents do publish, and is shaped like an x402 payment
requirement (`amount`, `currency`, `asset`, `network`, `scheme`) so the two line
up. Expect it to be absent. `x402_support` is the field that actually tells you
whether an agent is priced — it means "ask the endpoint".

---

## Chains

The `networks:` block in `substreams.yaml` is the whole multi-chain story. Same
binary, different params.

| `--network` | Chain id | Identity Registry | Initial block |
|---|---|---|---|
| `mainnet` | 1 | `0x8004a169fb4a3325136eb29fa0ceb6d2e539a432` | 24,339,871 |
| `base` | 8453 | `0x8004a169fb4a3325136eb29fa0ceb6d2e539a432` | 41,663,783 |
| `sepolia` | 11155111 | `0x8004a818bfb912233c491871b3d84c89a494bd9e` | 9,989,393 |
| `base-sepolia` | 84532 | `0x8004a818bfb912233c491871b3d84c89a494bd9e` | 36,304,145 |

ERC-8004 uses a vanity address per environment — `0x8004A169…` on mainnets,
`0x8004A818…` on testnets — so most chains need only a new `networks:` entry
and an initial block, no code.

Adding a chain:

```yaml
  arbitrum:
    initialBlock:
      map_agent_registrations: <deployment block>
      store_agent_wallets: <deployment block>
      map_agent_directory: <deployment block>
    params:
      map_agent_registrations: "registry=0x8004a169fb4a3325136eb29fa0ceb6d2e539a432&chain_id=42161&network=arbitrum"
```

---

## Using it

You need a Substreams API token — a JWT from [thegraph.market](https://thegraph.market)
— in `SUBSTREAMS_API_TOKEN`.

```bash
export SUBSTREAMS_API_TOKEN=...

# straight from the packaged module, no checkout needed
substreams run erc8004-agent-registry-v0.1.0.spkg map_agent_registrations \
  --network base -s 41700000 -t 41701000 -o json

# the same command, another chain
substreams run erc8004-agent-registry-v0.1.0.spkg map_agent_registrations \
  --network mainnet -s 25000000 -t 25005000 -o json

# operator resolved against the wallet store (backfills the store first)
substreams run erc8004-agent-registry-v0.1.0.spkg map_agent_directory \
  --network sepolia -s 10007206 -t 10007207 --limit-processed-blocks 0 -o json
```

Composing from your own package:

```yaml
imports:
  erc8004: https://github.com/IpastorSan/turnstile/raw/main/graph/substreams/erc8004-agent-registry-v0.1.0.spkg

modules:
  - name: my_module
    kind: map
    inputs:
      - map: erc8004:map_agent_directory
      - store: erc8004:store_agent_wallets
```

### Building

```bash
make build     # cargo build --target wasm32-unknown-unknown --release
make test      # unit tests for param and registration-document parsing
make pack      # -> erc8004-agent-registry-v0.1.0.spkg
make protogen  # regenerate src/pb from proto/ (needs the `buf` CLI)
make run NETWORK=base START=41700000
```

Requires the `wasm32-unknown-unknown` target and the
[`substreams` CLI](https://docs.substreams.dev). `make build` symlinks `./target`
at `$CARGO_TARGET_DIR` when that is set, so the manifest's relative binary path
keeps working against the repo's shared build cache.

---

## Why this module

The Graph's own ecosystem already covers DEX and token primitives thoroughly —
[`pinax-network/substreams-evm`](https://github.com/pinax-network/substreams-evm)
normalizes 15+ DEX protocols. Agent registries are the part that is genuinely
emerging: ERC-8004 reached Ethereum mainnet in January 2026 and there is no
composable Substreams primitive for it.

Inside Turnstile this is the discovery backend — the thing that answers "which
agents exist, what do they serve, and at which address do they get paid" before
a buyer agent ever opens its wallet. It is published separately because that
question is not specific to us.

MIT.
