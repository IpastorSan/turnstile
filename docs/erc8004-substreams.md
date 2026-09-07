# MOV-221 — ERC-8004 agent-registry Substreams: live verification

Date: 2026-09-07
Artifact: `graph/substreams/` → `erc8004-agent-registry-v0.1.0.spkg`
Endpoint auth: Graph Market JWT (`SUBSTREAMS_API_TOKEN`), `substreams` CLI v1.22.0

Every run below was executed against **the packaged `.spkg`**, not the source
tree, from a directory with no checkout — i.e. exactly what a third-party
consumer runs.

## The finding that mattered

ERC-8004 has real, heavy usage on both target chains, so no test data was needed
anywhere:

| Chain | Identity Registry | Deployed at | Agents registered |
| --- | --- | --- | --- |
| Ethereum mainnet (1) | `0x8004a169…a432` | block 24,339,871 (2026-01-29) | ~32,000 |
| Base mainnet (8453) | `0x8004a169…a432` | block 41,663,783 (2026-02-03) | ~85,000 |
| Ethereum Sepolia (11155111) | `0x8004a818…bd9e` | block 9,989,393 | >1,000 |
| Base Sepolia (84532) | `0x8004a818…bd9e` | block 36,304,145 | >1,000 |

Base mainnet is where the volume is — agent 85,066 was live at the time of
writing. Counts are floors: the Etherscan page limit is 1,000, and Base was
counted from RPC log windows.

Base's deployment block was found by binary-searching `eth_getCode` over an
archive RPC; Etherscan v2 refuses chain 8453 on the free plan, and both
Blockscout endpoints for Base were erroring.

## Run 1 — Ethereum mainnet, block 25,002,360

Inline `data:` registration; the document is resolved in-module.

```
$ substreams run ./erc8004-agent-registry-v0.1.0.spkg map_agent_registrations \
    --network mainnet -s 25002360 -t 25002361 -o json
```

```json
{
  "@module": "map_agent_registrations",
  "@block": 25002360,
  "@type": "turnstile.erc8004.v1.AgentRegistrations",
  "@data": {
    "chain": "eip155:1",
    "chainId": "1",
    "network": "mainnet",
    "blockNumber": "25002360",
    "blockHash": "0xa3aa2e2aafde91c42a6629a181a6479fca64872a1a0787501762d805ca5b289c",
    "blockTimestamp": "1777665755",
    "registrations": [
      {
        "agentUid": "eip155:1:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432/32055",
        "namespace": "eip155",
        "chainId": "1",
        "network": "mainnet",
        "registry": "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432",
        "agentId": "32055",
        "owner": "0xeb0abb367540f90b57b3d5719fd2b9c740a15022",
        "operator": "0xeb0abb367540f90b57b3d5719fd2b9c740a15022",
        "operatorSource": "OPERATOR_SOURCE_AGENT_WALLET",
        "agentUri": "data:application/json;base64,eyJuYW1lIjoidHJ1c3RydXN0LmV0aCJ9",
        "uriScheme": "URI_SCHEME_DATA",
        "registrationResolved": true,
        "name": "trustrust.eth",
        "active": true,
        "event": "REGISTRATION_EVENT_REGISTERED",
        "blockNumber": "25002360",
        "blockTimestamp": "1777665755",
        "transactionHash": "0x5984f563efb6f1b1e13302f2db55c5a031e104b78c2fae95a7a9299658bb8f36",
        "logIndex": 1032,
        "ordinal": "44513"
      }
    ],
    "walletUpdates": [
      {
        "agentUid": "eip155:1:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432/32055",
        "chainId": "1",
        "network": "mainnet",
        "registry": "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432",
        "agentId": "32055",
        "wallet": "0xeb0abb367540f90b57b3d5719fd2b9c740a15022",
        "blockNumber": "25002360",
        "blockTimestamp": "1777665755",
        "transactionHash": "0x5984f563efb6f1b1e13302f2db55c5a031e104b78c2fae95a7a9299658bb8f36",
        "logIndex": 1033,
        "ordinal": "44515"
      }
    ]
  }
}
```

Usage report: 1 block processed, completed successfully. TraceID `2a154bdefcce5b1ac286d081070b9464`.
Tx: [`0x5984f563…8bb8f36`](https://etherscan.io/tx/0x5984f563efb6f1b1e13302f2db55c5a031e104b78c2fae95a7a9299658bb8f36)

## Run 2 — Base mainnet, block 41,700,594

**Same `.spkg`, same module, only `--network` changed.** The manifest's
`networks:` block swaps registry address, chain id and initial block; the WASM
is byte-identical.

```
$ substreams run ./erc8004-agent-registry-v0.1.0.spkg map_agent_registrations \
    --network base -s 41700594 -t 41700595 -o json
```

```json
{
  "@module": "map_agent_registrations",
  "@block": 41700594,
  "@type": "turnstile.erc8004.v1.AgentRegistrations",
  "@data": {
    "chain": "eip155:8453",
    "chainId": "8453",
    "network": "base",
    "blockNumber": "41700594",
    "blockHash": "0xf9273aac68abf99b46e6fb4d25e9e1331023c9908bbac7430051523c54b4168a",
    "blockTimestamp": "1770190535",
    "registrations": [
      {
        "agentUid": "eip155:8453:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432/1293",
        "namespace": "eip155",
        "chainId": "8453",
        "network": "base",
        "registry": "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432",
        "agentId": "1293",
        "owner": "0x7346dc42102b5cdba321d587564612d1f3878ad2",
        "operator": "0x7346dc42102b5cdba321d587564612d1f3878ad2",
        "operatorSource": "OPERATOR_SOURCE_AGENT_WALLET",
        "agentUri": "https://acpx.virtuals.io/agents/74/agent-card/v1",
        "uriScheme": "URI_SCHEME_HTTPS",
        "event": "REGISTRATION_EVENT_REGISTERED",
        "blockNumber": "41700594",
        "blockTimestamp": "1770190535",
        "transactionHash": "0xb0676cf17b6ef2917f500f5059d4011937cedd55ac0e90eb2abf6774d8ebeaee",
        "logIndex": 725,
        "ordinal": "26923"
      }
    ],
    "walletUpdates": [
      {
        "agentUid": "eip155:8453:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432/1293",
        "chainId": "8453",
        "network": "base",
        "registry": "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432",
        "agentId": "1293",
        "wallet": "0x7346dc42102b5cdba321d587564612d1f3878ad2",
        "blockNumber": "41700594",
        "blockTimestamp": "1770190535",
        "transactionHash": "0xb0676cf17b6ef2917f500f5059d4011937cedd55ac0e90eb2abf6774d8ebeaee",
        "logIndex": 726,
        "ordinal": "26925"
      }
    ]
  }
}
```

Usage report: 1 block processed, completed successfully. TraceID `3dc86b8f7047b45d793c4036ac2ff5aa`.
Tx: [`0xb0676cf1…d8ebeaee`](https://basescan.org/tx/0xb0676cf17b6ef2917f500f5059d4011937cedd55ac0e90eb2abf6774d8ebeaee)

Note `chainId`, `network`, `registry` and `agentUid` all follow the network
selection with no code change. Agent `1293` on Base and agent `1293` on mainnet
get different `agentUid`s, which is what makes a cross-chain union safe.

## Run 3 — cross-chain count check

```
$ substreams run ./substreams.yaml map_agent_registrations \
    --network base -s 41700000 -t 41701000 -o json
→ 76 registrations over 1,000 blocks; 548 KiB egress
```

76 is exactly what `eth_getLogs` returns for the same address, topic and range
over a Base archive RPC. The decoder is not dropping or inventing events.

```
$ substreams run ./substreams.yaml map_agent_registrations \
    --network mainnet -s 25000000 -t 25005000 -o json
→ 20 registrations over 5,000 blocks
  uriScheme: IPFS 5, HTTPS 4, DATA 5, EMPTY 6 — 5 resolved in-module
```

## Run 4 — the store actually runs

`substreams run` refuses a store as an output module, so `store_agent_wallets`
is exercised through `map_agent_directory`, which reads it.

Sepolia agent 46 set its `agentWallet` at block 10,007,199 and updated its URI
at block 10,007,206 — a **different block**, so only the store-joined module can
see it:

```
$ substreams run ./substreams.yaml map_agent_registrations \
    --network sepolia -s 10007206 -t 10007207 -o json
  "operatorSource": "OPERATOR_SOURCE_OWNER_DEFAULT"

$ substreams run ./substreams.yaml map_agent_directory \
    --network sepolia -s 10007206 -t 10007207 --limit-processed-blocks 0 -o json
  "operatorSource": "OPERATOR_SOURCE_AGENT_WALLET"
→ 18,021 blocks processed to build the store; completed successfully
```

The provenance flag flips, which is the store lookup firing. (The wallet address
equals the owner here — that agent pointed its wallet at itself — so the flag,
not the address, is the evidence.)

## Run 5 — Base Sepolia, a fully resolved registration

The richest inline documents are on Base Sepolia. Agent 0, block 36,321,136:

```json
{
  "agentUid": "eip155:84532:0x8004a818bfb912233c491871b3d84c89a494bd9e/0",
  "name": "Test Agent 003 (Base)",
  "uriScheme": "URI_SCHEME_DATA",
  "registrationResolved": true,
  "endpoints": [
    { "name": "web",  "uri": "https://example.com/test" },
    { "name": "x402", "uri": "https://example.com/api", "version": "2.0",
      "skills": ["test-skill"], "domains": ["testing"] }
  ],
  "x402Support": true,
  "active": true,
  "supportedTrust": ["reputation"],
  "operatorSource": "OPERATOR_SOURCE_OWNER_DEFAULT"
}
```

All four declared networks stream: `mainnet`, `base`, `sepolia`, `base-sepolia`.

## Data-shape findings worth keeping

Surveyed 1,200 live registrations across mainnet, Sepolia and Base Sepolia:

- **No agent publishes a price.** EIP-8004 registration-v1 has no price field;
  under x402 the quote comes back dynamically in an HTTP 402 response. Zero of
  1,200 documents carried one. `x402Support` (present on 206) is the real
  pricing signal — it means "ask the endpoint". The `Price` message is kept for
  the non-standard `price` objects that may appear, and is shaped like an x402
  payment requirement so the two line up.
- **`agentURI` is a grab-bag.** Across the sample: `https` 315, `data` 336,
  `ipfs` 195, empty 177, `http` 94, and 76 that are a **bare JSON literal** with
  no scheme at all. Only `data:` and bare-JSON can be resolved deterministically
  in a Substreams module; `registration_resolved` says which.
- **Field names drift from the spec.** The spec says `services`; 31 of 441
  service arrays were named `endpoints`. `x402Support` also appears as
  `x402support` (41 times), `supportedTrust` as `supportedTrusts` (31). An
  endpoint's `endpoint` also appears as `url`, `serviceEndpoint`, `uri`,
  `value`. The parser reads all of them.
- **`agentWallet` is sometimes emitted with an empty value.** Every
  `agentWallet` `MetadataSet` on Base Sepolia carries a zero-length
  `metadataValue`, while mainnet carries the expected 20 bytes. The module
  requires 20 bytes before calling something a payout address, so those are
  skipped rather than turned into `0x`.
- **The mainnet registry emits `agentWallet` at mint**, initialised to the
  owner. So `OPERATOR_SOURCE_AGENT_WALLET` with `operator == owner` is the
  common case, not a bug.

## Not done

`substreams registry publish` was **not** run. It needs an interactive browser
login, and publishing to substreams.dev now would put the module in public view
during the 12 private build days that `CLAUDE.md` asks for. The `.spkg` is
committed at `graph/substreams/erc8004-agent-registry-v0.1.0.spkg` and is
consumable as-is; registry publication belongs with the repo visibility flip in
`CHECKLIST.md`.
