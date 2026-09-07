# MOV-218 — ENSIP-25/26 offer records + cold/hot EAC role split

Date: 2026-09-07
Builds on: `docs/ensv2-notes.md` (MOV-212), `docs/ensv2-deploy.md` (MOV-217)
Network: Sepolia, chain id 11155111. **Everything below is live and was read
back from the chain**, not simulated.

## TL;DR

`liquidity.turnstile.eth` exists, carries a full offer written with **standard**
ENSIP-25/26 keys, and is guarded by a two-tier key split enforced by ENS's own
`PermissionedResolver`:

- The **cold key** owns the name, publishes the offer, sets the payout address,
  raises the price ceiling, and rotates the hot key.
- The **hot key** is authorized on exactly two text records —
  `agent-endpoint[mcp]` and `turnstile:price` — and on nothing else. Its attempt
  to move the payout address **reverts on-chain**, with the transcript below.

No name is hard-coded anywhere. The full name, its DNS encoding and its namehash
are walked out of the ENSv2 registry hierarchy at run time.

## Addresses

| | |
| --- | --- |
| Turnstile resolver (`PermissionedResolver` proxy) | [`0xb1B4Da2C49814c8CbF975E7a48fbB014EA0b075B`](https://sepolia.etherscan.io/address/0xb1B4Da2C49814c8CbF975E7a48fbB014EA0b075B) |
| ENS `PermissionedResolverImpl` (behind it) | `0x7E4B2d59938930168024201752EE5503df402303` |
| TurnstileRegistry | `0x10969a72952F6a78C6c6087F07DdACcE9c7C2d24` |
| TurnstileRegistrar | `0x8e428Cc025a1FA3C004b96fBAcd47332CE9D656a` |
| ERC-8004 `IdentityRegistry` (Sepolia) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| Cold key (seller operator) | `0x0Adca6e14bA956201D221feC767e4f24194bf5F2` |
| Hot key (seller day-to-day signer) | `0x16244874881c60881CEA827fe856Ea91d3186367` |
| `liquidity.turnstile.eth` namehash | `0xb030c3d897a1f9b98ee7f09bb6a860a77d4e53c717cce7f53fbf4bf00f667acd` |
| ERC-8004 agent id | `10127` |

Recorded in `contracts/addresses.turnstile.sepolia.json`.

`VerifiableFactory.verifyContract(0xb1B4…075B)` returns
`0x7E4B2d59938930168024201752EE5503df402303` — the resolver is provably a stock
ENS `PermissionedResolver`, not a look-alike that answers `text()` honestly for a
while. That check is the reason a buyer's agent can trust a price it reads there.

## The records

Standard first, Turnstile-specific on top. An agent that has never heard of us
can still discover the service and connect to it.

| Key | Standard | Value | Writable by |
| --- | --- | --- | --- |
| `agent-context` | ENSIP-26 | service description | cold |
| `agent-endpoint[mcp]` | ENSIP-26 | MCP endpoint URI | **hot** |
| `agent-registration[<erc7930>][10127]` | ENSIP-25 | `1` | cold |
| `turnstile:price` | ours | `0.07` | **hot** |
| `turnstile:price-ceiling` | ours | `0.50` | cold |
| `turnstile:rails` | ours | `x402,usdc-arc` | cold |
| `turnstile:operator-proof` | ours | `ledger-key-ring` | cold |
| `addr(60)` — **the payout address** | ENSIP-1 | the seller's payout | cold |

The payout is deliberately the name's `addr()` record rather than a
`turnstile:payout` text key. It is the one field every ENS client already knows
means "send funds here"; hiding the most security-relevant value behind a schema
nobody else reads would have been the wrong trade.

### The ENSIP-25 key, decoded

```
agent-registration[0x0001000003aa36a7148004a818bfb912233c491871b3d84c89a494bd9e][10127]
                    ^^^^ version 1
                        ^^^^ chain type 0x0000 = eip155
                            ^^ chain reference length = 3
                              ^^^^^^ 0xaa36a7 = 11155111 (Sepolia)
                                    ^^ address length = 20
                                      ^^^^^^^^^^^^^^^^ ERC-8004 IdentityRegistry
```

`contracts/test/OfferRecords.t.sol::test_agentRegistrationKeyMatchesTheEnsip25Example`
reproduces the specification's own worked example
(`agent-registration[0x000100000101148004a169fb4a3325136eb29fa0ceb6d2e539a432][42]`)
byte for byte, so the encoder cannot drift from the standard silently. A
malformed key still stores and still reads back — it is just invisible to every
ENSIP-25 client, which is exactly the kind of bug no other test would catch.

The link is genuinely two-way, not a one-sided assertion:

```
$ cast call 0x8004A818BFB912233c491871b3d84c89A494BD9e "ownerOf(uint256)(address)" 10127
0x0Adca6e14bA956201D221feC767e4f24194bf5F2       # our cold key

$ cast call 0x8004A818BFB912233c491871b3d84c89A494BD9e "tokenURI(uint256)(string)" 10127
"liquidity.turnstile.eth"                        # points back at the name
```

## Reading the offer back

```
$ R=0xb1B4Da2C49814c8CbF975E7a48fbB014EA0b075B
$ N=0xb030c3d897a1f9b98ee7f09bb6a860a77d4e53c717cce7f53fbf4bf00f667acd

$ cast call $R "text(bytes32,string)(string)" $N "agent-context"
"Uniswap v4 pool liquidity analytics over Sepolia and mainnet. Priced per query, paid on x402 or USDC. Sells answers, not the method."

$ cast call $R "text(bytes32,string)(string)" $N "agent-endpoint[mcp]"
"https://mcp-eu.turnstile.xyz/liquidity.turnstile.eth/sse"

$ cast call $R "text(bytes32,string)(string)" $N \
    "agent-registration[0x0001000003aa36a7148004a818bfb912233c491871b3d84c89a494bd9e][10127]"
"1"

$ cast call $R "text(bytes32,string)(string)" $N "turnstile:price"
"0.07"
$ cast call $R "text(bytes32,string)(string)" $N "turnstile:price-ceiling"
"0.50"
$ cast call $R "text(bytes32,string)(string)" $N "turnstile:rails"
"x402,usdc-arc"
$ cast call $R "text(bytes32,string)(string)" $N "turnstile:operator-proof"
"ledger-key-ring"

$ cast call $R "addr(bytes32)(address)" $N
0x0Adca6e14bA956201D221feC767e4f24194bf5F2

$ cast call 0x10969a72952F6a78C6c6087F07DdACcE9c7C2d24 "getResolver(string)(address)" "liquidity"
0xb1B4Da2C49814c8CbF975E7a48fbB014EA0b075B

$ cast call 0x118Bc31A50d559F7015a8Da26d54B3b030CdB70F "verifyContract(address)(address)" $R
0x7E4B2d59938930168024201752EE5503df402303
```

## How the role split works

`PermissionedResolver` scopes EAC roles by `resource(node, part)`, where `part`
is a record-type identifier. That makes a role scopeable to **one text key on one
name**. Exactly three setters are part-scoped this way — `setText(key)`,
`setData(key)` and `setAddr(coinType)`. The rest (`setName`, `setABI`,
`setContenthash`, `setPubkey`, `setInterface`, `clearRecords`) pass `part = 0`
and are name-level; `setAlias` is root-only.

So the grant is:

```solidity
resolver.authorizeTextRoles(dnsName, "agent-endpoint[mcp]", hotKey, true);
resolver.authorizeTextRoles(dnsName, "turnstile:price",     hotKey, true);
```

and nothing else. The hot key holds `ROLE_SET_ADDR` on no resource at all, so
`onlyPartRoles` falls through to the widest resource — the name — and reverts
there. It also never holds `ROLE_SET_TEXT_ADMIN`, so it cannot grant itself more.

`turnstile:price-ceiling` is where the invariant from `CLAUDE.md` bites: the hot
key sets the price, the cold key sets the bound, so **the key that transacts
cannot raise its own limit**. What the resolver enforces on-chain is *who may
write which key*; comparing the two values is the buyer's agent's job, and it is
two `text()` calls. Making the ceiling bind mechanically would mean routing the
hot key's writes through a Turnstile gatekeeper contract that holds the grant and
rejects `price > ceiling` — a clean follow-up, and deliberately not done here
because it changes who holds the authorization.

## Live proof: what the hot key can and cannot do

### It reprices and moves its endpoint, with no cold key involved

```
$ cast send $R "setText(bytes32,string,string)" $N "turnstile:price" "0.07" \
    --private-key $TURNSTILE_HOT_PRIVATE_KEY
status               1 (success)
transactionHash      0xdb9689152e364e55427cbcccf62b103f981f40155d059a78f8d32b6e58c75a3f

$ cast send $R "setText(bytes32,string,string)" $N "agent-endpoint[mcp]" \
    "https://mcp-eu.turnstile.xyz/liquidity.turnstile.eth/sse" \
    --private-key $TURNSTILE_HOT_PRIVATE_KEY
status               1 (success)
transactionHash      0xda7015d1425fd071b63c92e36c4f81929231edae392244b1c10e187824600a1f
```

### It cannot move the payout address

```
$ cast call $R "setAddr(bytes32,address)" $N 0x…dEaD --from $TURNSTILE_HOT_KEY
Error: execution reverted:
  EACUnauthorizedAccountRoles(
    87140393317148622081856579921496229094570723339484417348903196786160147430199,
    1,
    0x16244874881c60881CEA827fe856Ea91d3186367
  )
```

`1` is `ROLE_SET_ADDR`. The resource is `keccak256(node, 0)` — the name-level
resource, which is where `onlyPartRoles` reverts once no part-scoped grant
matched.

A stolen hot key costs the seller a wrong price for as long as it takes the cold
key to rotate it. It cannot cost them a single payment.

### It cannot raise its own ceiling

```
$ cast call $R "setText(bytes32,string,string)" $N "turnstile:price-ceiling" "999" \
    --from $TURNSTILE_HOT_KEY
Error: execution reverted:
  EACUnauthorizedAccountRoles(8714039331714862208…430199, 16, 0x1624…6367)
```

`16` is `ROLE_SET_TEXT` (`1 << 4`).

### It cannot widen its own authority

```
$ cast call $R "authorizeAddrRoles(bytes,uint256,address,bool)" $DNS 60 $HOT true --from $HOT
Error: execution reverted: EACCannotGrantRoles(8714039331714862208…430199, 1,  0x1624…6367)

$ cast call $R "authorizeTextRoles(bytes,string,address,bool)" $DNS "turnstile:price-ceiling" $HOT true --from $HOT
Error: execution reverted: EACCannotGrantRoles(8714039331714862208…430199, 16, 0x1624…6367)

$ cast call $R "grantRoles(uint256,uint256,address)" 0 1 $HOT --from $HOT
Error: execution reverted: EACCannotGrantRoles(0, 1, 0x1624…6367)
```

The DNS-encoded name used above is
`0x096c6971756964697479097475726e7374696c650365746800`
(`\x09liquidity\x09turnstile\x03eth\x00`).

## Live proof: the cold key rotates the hot key

Run end to end on Sepolia and then rotated back, so the deployed state matches
`addresses.turnstile.sepolia.json`.

| Step | Tx |
| --- | --- |
| revoke hot#1 on `agent-endpoint[mcp]` | `0x6f4aa7479c4bd580d28625d9ff3aeeb517fbbbba0cc70dda69f3fe779e754211` |
| revoke hot#1 on `turnstile:price` | `0xe0f98eb83ba8e052ce4df330da3b1a53bdc0534ffeeb2ab68a546fc7eac7280c` |
| authorize hot#2 on `agent-endpoint[mcp]` | `0x132b8b418fd3b8ea222f7215ddace9ebabb68087abff56b389079a5ad495ee1d` |
| authorize hot#2 on `turnstile:price` | `0x2d68148056026b8601ad73db80bc627f7c6b7e4e39816bf5d0ae46e6a44a32a1` |
| rotate back (4 txs) | `0x11b3fa38…`, `0x2911d0a5…`, `0xf7a468aa…`, `0x6a4aaab1…` |

Immediately after the rotation:

```
the OLD hot key is now inert
  EACUnauthorizedAccountRoles(8714039331714862208…430199, 16, 0x1624…6367)

the NEW hot key works
  -> no revert: hot#2 may write turnstile:price

...and still cannot touch the payout
  EACUnauthorizedAccountRoles(8714039331714862208…430199, 1,  0x…00b2)
```

The cold key changing the payout address is tx
`0x922ea0bb33bfc9267c929e0415cc590afbf731b4fe66d7a4f781b0876cff2fe4` in the
deployment below — the same `setAddr` call that reverts for the hot key,
succeeding for the cold one.

## The deployment

`forge script script/PublishOffer.s.sol:PublishOffer --rpc-url "$SEPOLIA_RPC_URL"
--broadcast --slow`, 2026-09-07. All eight transactions succeeded.

```
cold key           0x0Adca6e14bA956201D221feC767e4f24194bf5F2
hot key            0x16244874881c60881CEA827fe856Ea91d3186367
registry           0x10969a72952F6a78C6c6087F07DdACcE9c7C2d24
registrar          0x8e428Cc025a1FA3C004b96fBAcd47332CE9D656a
resolver impl      0x7E4B2d59938930168024201752EE5503df402303
seller name        liquidity.turnstile.eth
namehash           0xb030c3d897a1f9b98ee7f09bb6a860a77d4e53c717cce7f53fbf4bf00f667acd
resolver           0xb1B4Da2C49814c8CbF975E7a48fbB014EA0b075B (deployed)
default resolver   set
erc-8004 agent     registered: 10127
seller name        minted, token 84804459743585640999492341093635394304172261892188928833175833963717682266112
  paid (wei)        999999968976000
resolver attached  already
offer              published
  ensip-25 key      agent-registration[0x0001000003aa36a7148004a818bfb912233c491871b3d84c89a494bd9e][10127]
  payout            0x0Adca6e14bA956201D221feC767e4f24194bf5F2
hot key authorized  agent-endpoint[mcp]
hot key authorized  turnstile:price
```

| # | Call | Tx | Gas |
| --- | --- | --- | --- |
| 1 | `VerifiableFactory.deployProxy` (the resolver) | `0xd58754edf733f66375043a0e9373b25d46b5a1bba23b90c87354a4730385099a` | 176,505 |
| 2 | `TurnstileRegistrar.setDefaultResolver` | `0xcb00d644e3e248286765cb0d8f6638670639c93e5b28d85600f432f8392e9709` | 47,276 |
| 3 | `IdentityRegistry.register("liquidity.turnstile.eth")` | `0xb996bbafae8737ad1574d7bd50278f0fccb47093d798d051f3a6e3a70f8c86ff` | 132,644 |
| 4 | `TurnstileRegistrar.register("liquidity", …)` | `0x7da8e4f4f69e8b1feda8e5dfe0b89b6e14629c443ef8185887d2c6901585beee` | 194,321 |
| 5 | `PermissionedResolver.multicall` (6 text records) | `0x162b3145a2041754dbf58bfafa49a9ee2265128b0d4eb5626074718eb7ee537c` | 435,283 |
| 6 | `PermissionedResolver.setAddr` (the payout) | `0x922ea0bb33bfc9267c929e0415cc590afbf731b4fe66d7a4f781b0876cff2fe4` | 64,559 |
| 7 | `authorizeTextRoles(agent-endpoint[mcp], hot)` | `0x70b46f9e4c9ff0d19ee4c8a75da1b371794dbb6662dbeb476dad3e0b87423af0` | 90,186 |
| 8 | `authorizeTextRoles(turnstile:price, hot)` | `0x1c400a966f3f0acf8e880acf1316e7955241e7a10e35b562a316222fb0bf5f83` | 90,138 |

Hot key funded with 0.01 ETH in
`0xae39e6b08d80fb486407b5d715b73328b8c76512f0ec55c485ad11f12872fdf0`.

Total spent from the cold key across MOV-218, including the rotation demo:
0.197455 → 0.184456 ETH, i.e. **0.013 ETH**, of which 0.001 is the name itself.

The script is idempotent. The resolver lands at a CREATE2 address derived from a
salt; every other step reads the state it would establish first. The ERC-8004
registration additionally checks `ownerOf(recordedId) == coldKey`, which is what
makes a **dry run safe**: a simulation writes the offer file too, so without that
check the id minted in simulation would be recorded and the real broadcast would
skip registration and publish a record pointing at an agent that does not exist.

## No hard-coded names

An explicit ENS prize gate, and `src/TurnstileName.sol` is the answer. Every
record we write and every role we grant is keyed by namehash, and a namehash is
only computable from the whole name. The obvious implementation is a constant —
and a constant is wrong the moment the parent name changes, the registry is
re-parented, or the code is pointed at a second seller. Worse, it is wrong
*silently*: a stale namehash still resolves, it just resolves to a name nobody
owns.

ENSv2 carries the answer on-chain. `IRegistry.getParent()` returns the parent
registry and the label this registry hangs off it under, and the chain terminates
at the root, whose parent is the zero address. Verified against live Sepolia:

```
$ cast call 0x10969a72952F6a78C6c6087F07DdACcE9c7C2d24 "getParent()(address,string)"
0x67b728a792e789a8978b30cF1b3b641f19354b43
"turnstile"

$ cast call 0x67b728a792e789a8978b30cF1b3b641f19354b43 "getParent()(address,string)"
0x11b5BfbE9078D826b1eDBDd1cFC12f5828D9F50C
"eth"

$ cast call 0x11b5bfbe9078d826b1edbdd1cfc12f5828d9f50c "getParent()(address,string)"
0x0000000000000000000000000000000000000000
""
```

So `("liquidity", TurnstileRegistry)` walks out to `liquidity.turnstile.eth`, and
the seller label itself comes from `TURNSTILE_SELLER_LABEL`. The walk is bounded
at eight hops so a registry with a cyclic parent — attacker-controlled for any
registry we do not own — reverts by name instead of running out of gas.
`test_derivedNameFollowsAReparent` re-parents the registry and asserts the
derived name and namehash move with it.

## Correction to `docs/ensv2-notes.md`

MOV-212 recorded a third `grantRoles` trap:

> `PermissionedResolver.sol:720` has an override at the same arity whose first
> argument *is* a resource. Identical signatures, opposite meanings.

**That is wrong.** At the pinned revision `PermissionedResolver` does not
reinterpret the argument — it **disables the function outright**. Both
`grantRoles` (`:720`) and `revokeRoles` (`:734`) are `pure` and revert
unconditionally with `EACCannotGrantRoles` / `EACCannotRevokeRoles`. Every
resolver grant has to go through
`authorize(Name|Text|Data|Addr)Roles`.

This one is loud rather than silent, but only if you try it: code written from
the notes reaches for `grantRoles(resource, …)` and gets a revert with no hint
about the replacement. Pinned by
`test_resolverDisablesGrantRolesEntirely`, alongside the two registry traps in
`test/Roles.t.sol`.

MOV-212's second note also said "eight roles are per-record". At this revision it
is **three** — `setText(key)`, `setData(key)` and `setAddr(coinType)` are the only
part-scoped setters. Everything else passes `part = 0`.

## Tests

`forge test` — **66 passing**: the 37 from MOV-217, 22 new local tests in
`test/OfferRecords.t.sol`, and 7 new fork tests in `test/fork/SepoliaOffer.t.sol`
that read the live deployment.

```
Ran 22 tests for test/TurnstileRegistrar.t.sol:TurnstileRegistrarTest
Suite result: ok. 22 passed; 0 failed; 0 skipped
Ran 9 tests for test/Roles.t.sol:RolesTest
Suite result: ok. 9 passed; 0 failed; 0 skipped
Ran 22 tests for test/OfferRecords.t.sol:OfferRecordsTest
Suite result: ok. 22 passed; 0 failed; 0 skipped
Ran 6 tests for test/fork/SepoliaEnsV2.t.sol:SepoliaEnsV2Test
[PASS] testFork_ethIsStillTheKnownEthRegistry() (gas: 22141)
[PASS] testFork_fullMintFlowAgainstLiveContracts() (gas: 1793422)
[PASS] testFork_predictAddressMatchesTheLiveFactory() (gas: 199377)
[PASS] testFork_recordedAddressesStillHaveCode() (gas: 1303516)
[PASS] testFork_verifyContractReturnsAnImplementationAddress() (gas: 206748)
[PASS] testFork_weHoldNoRegistrarRoleOnTheEthRegistry() (gas: 45009)
Suite result: ok. 6 passed; 0 failed; 0 skipped
Ran 7 tests for test/fork/SepoliaOffer.t.sol:SepoliaOfferTest
[PASS] testFork_erc8004RegistrationPointsBack() (gas: 49083)
[PASS] testFork_hotKeyCanStillReprice() (gas: 80899)
[PASS] testFork_hotKeyCannotChangeThePayoutOnChain() (gas: 79290)
[PASS] testFork_hotKeyIsStillScopedToTwoRecords() (gas: 100128)
[PASS] testFork_nameIsDerivedFromTheLiveHierarchy() (gas: 122579)
[PASS] testFork_offerResolvesWithStandardEnsipKeys() (gas: 199672)
[PASS] testFork_resolverIsAttachedAndVerifiable() (gas: 413571)
Suite result: ok. 7 passed; 0 failed; 0 skipped
Ran 5 test suites: 66 tests passed, 0 failed, 0 skipped (66 total tests)
```

`SepoliaEnsV2Test` is the canary for ENS redeploying under us.
`SepoliaOfferTest` is the canary for the demo: it asserts against the live
resolver that the offer still resolves, the hot key still holds exactly its two
authorizations, and `setAddr` from the hot key still reverts. A green local test
proves the design; only the fork test proves the deployment — and the role split
is state, which any careless transaction of ours could change the day before a
demo. Both skip rather than fail when the RPC is unreachable, so a network-less
run is never reported as green.

The local tests run against the **real** `PermissionedResolver` compiled from the
same revision as the Sepolia implementation, behind the real `VerifiableFactory`
— not a mock's idea of EAC semantics. Compiling it needs the nested contracts-v2
remappings, which is why `contracts/remappings.txt` gained `ens-contracts`,
`buffer`, `solady`, `unruggable-gateways` and ens-contracts' own OZ v4 context
remapping.

## Build note

Foundry was not on `PATH` in this environment and `~/.foundry/bin` did not exist,
despite `~/.foundry/cache` having been written to the same day. Reinstalling with
the current `foundryup-init` puts the toolchain in
`~/.config/.foundry/bin` (it honours `XDG_CONFIG_HOME`), not `~/.foundry/bin`.
The versions were already present and merely re-activated, so nothing was
downloaded twice. If `forge` disappears again, that is where it is.

## Open / not verified

- **The price ceiling is not mechanically binding.** The resolver enforces who
  may write each key, not the relationship between two values. A buyer's agent
  must compare `turnstile:price` against `turnstile:price-ceiling` itself. See
  the gatekeeper-contract sketch above.
- **`agentURI` convention.** We registered the ERC-8004 agent with the bare ENS
  name `liquidity.turnstile.eth` as its URI, which makes the ENSIP-25 link
  readable from both ends. ERC-8004 clients that expect an HTTPS agent-card URL
  will not follow it. ENSIP-27 (`/.well-known/agent.json`) is the likely landing
  place and was not implemented here.
- **The MCP endpoint URL does not resolve.** `https://mcp-eu.turnstile.xyz/…` is
  a placeholder until MOV-219/220 land the real service. The record is real; the
  host is not.
- **Etherscan verification.** The resolver proxy is a factory-deployed clone;
  verification of the clone was not attempted. `verifyContract` from the factory
  is the stronger check and it passes.
- **hot#2 in the rotation demo** is `0x…00b2`, an address nobody holds the key
  to. It was used to prove the authorization moved, via `cast call --from`, not
  to send a transaction.
- **The hot key in `.env` is a throwaway** generated 2026-09-07 for this demo,
  funded with 0.01 Sepolia ETH. It is not device-backed; the cold tier in
  `CLAUDE.md` is the Ledger Key Ring, and wiring that as the cold signer is
  MOV-209's job, not this one's. Everything here treats
  `DEPLOYER_PRIVATE_KEY` as standing in for it.
