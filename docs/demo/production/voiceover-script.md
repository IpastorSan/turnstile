# Voiceover — nine takes, your own voice

Record each take as its own file in `~/Work/moveseventyeight/ethglobal-hackathon/voiceover/`.
One file per take means a fluffed line costs one retake, not the whole video.

```bash
cd ~/Work/moveseventyeight/ethglobal-hackathon/voiceover
pw-record 0a.wav      # read the take, then press Ctrl+C
pw-record 0b.wav      # ...and so on through 6.wav
```

To redo a take, run the same command again; it overwrites. Leave about half a
second of silence before and after each line. No music. Speak at a normal pace;
the video waits for you, so there is no need to rush.

Each take plays over the picture described in brackets. You don't need to watch
it while recording.

---

**0a.wav** · *[slide: Turnstile title, your photo]*

> Hi, I'm Ignacio, and this is Turnstile: a paid lane for onchain data agents.

**0b.wav** · *[slide: the problem]*

> Agents can find each other onchain, but they can't buy anything. In the ERC-8004 registry there are 197 agents, and just one publishes a price. Letting an agent spend usually means handing it a key. And a seller who publishes their method gives away their edge.

**0c.wav** · *[slide: discover, price, pay, answer]*

> Turnstile fixes that. Discover a seller with The Graph, read its price from ENS, and pay per call over x402 on Hedera, or in USDC on Arc, inside a spending mandate the agent can never raise.

**1.wav** · *[the live market page, scrolling to our listing]*

> This is the live market: 197 real registrations from Base, Ethereum and Sepolia. Exactly one posts a readable price, and it's ours.

**2.wav** · *[the seller page, reloaded, then its ENS records]*

> Discovery runs on The Graph: a Substreams module in Rust normalizes agent registrations across four networks. The seller's analysis reads a Messari-schema Uniswap subgraph through Subgraph MCP. And the offer lives in ENS. Price, rails and endpoint are read from Sepolia on every request, so when I reload, the block number moves.

**3.wav** · *[terminal: the 402, then the Hedera payment run, then HashScan]*

> Ask without paying, and the service answers HTTP 402, payment required. Pay on Hedera, and one run shows the whole flow: the signed payment, settlement through Blocky402, a receipt written to an HCS topic, and a replayed payment refused. On HashScan it's a real transaction, and the buyer paid no gas.

**4.wav** · *[mandate page, the one-signature cap raise refused, ArcScan, the nonce]*

> On the buyer side, the agent spends under a mandate held in a Privy wallet. Try to raise the spending cap with one signature, and Privy refuses: it takes two. On Arc, sub-cent payments settle in batches through Circle Gateway. And the spending agent has never sent a transaction. Its nonce is still zero, so it has paid exactly zero gas.

**5.wav** · *[terminal: the fork test passing]*

> Authority is split on chain. The hot key can only touch two records, so when it tries to move the payout address, Sepolia reverts it. That's this fork test, against the live chain.

**6.wav** · *[EVIDENCE.md on GitHub]*

> The payment code never names a chain, and it all ships as an MCP server and a skill, so it works without us. Built from scratch this week. Every claim is linked to a transaction in EVIDENCE.md, including what isn't live yet. The repo is public.

---

Rough length at a normal pace: about 3 minutes 20 seconds. The assembler checks
the total stays between 2 and 4 minutes before exporting.
