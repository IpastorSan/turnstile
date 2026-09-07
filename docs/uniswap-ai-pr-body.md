# PR body — `Uniswap/uniswap-ai`

Paste this into <https://github.com/Uniswap/uniswap-ai/compare/main...IpastorSan:uniswap-ai:fix/quoter-static-call-ethers-v6?expand=1>

**Title:** `fix(uniswap-trading): quote through eth_call, not ethers v5 callStatic`

The branch carries a single commit, so GitHub will prefill the body from the
commit message. This file is the fuller version; use whichever reads better.

---

## The problem

The `v4-sdk-integration` skill tells an agent to quote like this:

```typescript
const quote = await quoterContract.callStatic.quoteExactInputSingle({ ... });
```

and states it as a strict rule:

> - NEVER call Quoter onchain (gas expensive) — ALWAYS use `callStatic` for offchain simulation.

**`callStatic` is ethers v5 only.** It was removed in ethers v6, and viem has no `callStatic` under any name. Verified against `ethers@6.17.0`:

```
typeof c.callStatic                       -> undefined
typeof c.quoteExactInputSingle.staticCall -> function

c.callStatic.quoteExactInputSingle({...})
  -> TypeError: Cannot read properties of undefined (reading 'quoteExactInputSingle')
```

This matters more than a stale method name usually would, because of what the rest of the file sets up. The skill's install line is:

```bash
npm i @uniswap/v4-sdk @uniswap/sdk-core @uniswap/universal-router-sdk
```

— no ethers. And its other snippets are viem: `walletClient.writeContract({ ... })` in both swap sections, and `functionName` / `args` / `value: BigInt(value)` in the PositionManager multicall. So the only library the quoting section assumes is the one the file never installs, and the spelling it mandates exists in neither library the file actually uses. An agent following this skill in the codebase the skill itself describes writes a quote that throws.

The two eval rubrics have the same assumption baked in — `correctness.txt` grades "Uses Quoter contract with callStatic" — so the evals currently reward generating that code.

## The fix

State the rule in library-neutral terms and give all three spellings.

The underlying fact is not about any library: **the quoter is not `view`**, so it has to be simulated through `eth_call` rather than sent. `V4Quoter.sol` says so in its own NatSpec, which this PR now quotes in the skill so the reason travels with the instruction:

```solidity
/// @dev These functions are not marked view because they rely on calling non-view
/// functions and reverting to compute the result. They are also not gas efficient
/// and should not be called on-chain.
```

| Library | Spelling |
| --- | --- |
| viem | `publicClient.readContract({ ... })` |
| ethers v6 | `contract.fn.staticCall(params)` |
| ethers v5 | `contract.callStatic.fn(params)` |

## Verification

Live against mainnet `V4Quoter` at [`0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203`](https://etherscan.io/address/0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203), using the parameters from the docs' own ETH/USDC 0.05% example (`fee: 500`, `tickSpacing: 10`, no hooks, 1 ETH exact-in):

```
viem  readContract         OK   1 ETH -> 2477.420516 USDC   gasEstimate 41697
ethers v6 staticCall       OK   1 ETH -> 2477.420516 USDC
ethers v6 callStatic       TypeError: Cannot read properties of undefined
                                (reading 'quoteExactInputSingle')
```

Both working spellings agree to the last decimal. The documented one throws.

## Scope

Prose only, no code changes:

- `packages/plugins/uniswap-trading/skills/v4-sdk-integration/SKILL.md` — the quoting section, the Core Contracts table row, and the strict rule
- `packages/plugins/uniswap-trading/CLAUDE.md` — the one-line skill summary
- `docs/skills/v4-sdk-integration.md` — the two bullets describing quoting
- `evals/suites/v4-sdk-integration/rubrics/{correctness,completeness}.txt` — so the rubric no longer grades for a method that does not exist in ethers v6 or viem

`markdownlint-cli2` and `prettier@2.8.8` (the pinned version) both pass on every changed file.

## Note on the upstream docs

The same `callStatic`-only guidance is in the v4 SDK quoting guide at `developers.uniswap.org/docs/sdks/v4/guides/swapping/quoting`, where it is additionally self-contradictory: that page imports `{ parseUnits, JsonRpcProvider, formatUnits } from 'ethers'`, which is ethers **v6** top-level export style, and then calls `callStatic`, which v6 removed. Following that page literally cannot work. Happy to open a separate issue on the docs repo if that is the right venue — this PR only covers `uniswap-ai`.

Found while building an MCP server over the Uniswap stack for ETHOnline 2026, where we hit exactly this in a viem codebase.
