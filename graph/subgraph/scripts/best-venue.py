#!/usr/bin/env python3
"""Answer one question across every AMM in queries/targets.txt at once.

    GRAPH_GATEWAY_API_KEY=... ./scripts/best-venue.py WETH USDC

"Which venue should this trade go to?" is the question Turnstile actually sells
an answer to, and it is the shape of question a standardized schema makes
cheap. There is one query here, not one per protocol -- no adapter, no field
mapping, no per-protocol decimal handling -- because every target answers to
the same Messari DEX AMM field names.

Add a venue by adding a line to queries/targets.txt. Nothing in this file
changes.
"""

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

GATEWAY = "https://gateway.thegraph.com/api/subgraphs/id/{}"

# The one query. `liquidityPools` and its fields mean the same thing on a
# constant-product AMM, a concentrated-liquidity AMM and a StableSwap AMM.
QUERY = """
query DeepestPools {
  dexAmmProtocols(first: 1) { name network schemaVersion }
  liquidityPools(first: 100, orderBy: totalValueLockedUSD, orderDirection: desc) {
    id
    name
    inputTokens { symbol }
    totalValueLockedUSD
    cumulativeVolumeUSD
    fees { feeType feePercentage }
  }
  _meta { block { number } }
}
"""


def post(subgraph_id: str, api_key: str) -> dict:
    request = urllib.request.Request(
        GATEWAY.format(subgraph_id),
        data=json.dumps({"query": QUERY}).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            # The gateway sits behind a CDN that 403s urllib's default agent.
            "User-Agent": "turnstile-subgraph/1.0",
        },
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        return json.loads(response.read())


def trading_fee(pool: dict) -> str:
    for fee in pool.get("fees") or []:
        if fee["feeType"] == "FIXED_TRADING_FEE":
            return f"{fee['feePercentage']}%"
    return "?"


def load_targets(path: Path) -> list[tuple[str, str]]:
    targets = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        targets.append((parts[0], parts[1]))
    if os.environ.get("TURNSTILE_SUBGRAPH_ID"):
        targets.append(("turnstile-uniswap-v3-mainnet", os.environ["TURNSTILE_SUBGRAPH_ID"]))
    return targets


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__.strip().splitlines()[2].strip(), file=sys.stderr)
        return 2
    want = {sys.argv[1].upper(), sys.argv[2].upper()}

    api_key = os.environ.get("GRAPH_GATEWAY_API_KEY")
    if not api_key:
        print("GRAPH_GATEWAY_API_KEY is unset", file=sys.stderr)
        return 1

    here = Path(__file__).resolve().parent.parent
    rows = []
    for label, subgraph_id in load_targets(here / "queries" / "targets.txt"):
        try:
            body = post(subgraph_id, api_key)
        except (urllib.error.URLError, TimeoutError) as exc:
            print(f"  {label}: unreachable ({exc})", file=sys.stderr)
            continue
        if "errors" in body:
            print(f"  {label}: {body['errors'][0]['message']}", file=sys.stderr)
            continue

        data = body["data"]
        protocol = (data.get("dexAmmProtocols") or [{}])[0]
        for pool in data.get("liquidityPools") or []:
            symbols = {token["symbol"].upper() for token in pool["inputTokens"]}
            if want <= symbols:
                rows.append(
                    {
                        "venue": f"{protocol.get('name', label)} ({protocol.get('network', '?')})",
                        "pool": pool["name"],
                        "tvl": float(pool["totalValueLockedUSD"]),
                        "volume": float(pool["cumulativeVolumeUSD"]),
                        "fee": trading_fee(pool),
                        "block": data["_meta"]["block"]["number"],
                    }
                )

    if not rows:
        print(f"No pool holding both {' and '.join(sorted(want))} in any target.")
        return 0

    rows.sort(key=lambda row: row["tvl"], reverse=True)
    print(f"{'venue':<34} {'pool':<44} {'fee':>6} {'TVL USD':>18} {'block':>12}")
    for row in rows[:15]:
        print(
            f"{row['venue'][:34]:<34} {row['pool'][:44]:<44} {row['fee']:>6} "
            f"{row['tvl']:>18,.0f} {row['block']:>12}"
        )
    best = rows[0]
    print(f"\nDeepest venue for {'/'.join(sorted(want))}: {best['pool']} "
          f"on {best['venue']} at {best['fee']}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
