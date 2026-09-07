#!/usr/bin/env bash
#
# Run one GraphQL document against every subgraph in queries/targets.txt and
# write the responses to samples/. The claim this repo makes -- one query, many
# protocols -- is only worth anything if you can re-run it, so this is the
# re-run.
#
#   GRAPH_GATEWAY_API_KEY=... ./scripts/run-query.sh queries/cross-protocol.graphql
#
# Add TURNSTILE_SUBGRAPH_ID=<id> to include our own deployment in the sweep.

set -euo pipefail

QUERY="${1:-queries/cross-protocol.graphql}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

[ -f "$QUERY" ] || { echo "no such query: $QUERY" >&2; exit 1; }
[ -n "${GRAPH_GATEWAY_API_KEY:-}" ] || { echo "GRAPH_GATEWAY_API_KEY is unset" >&2; exit 1; }

mkdir -p samples
BODY="$(mktemp)"
trap 'rm -f "$BODY"' EXIT
python3 -c 'import json,sys; print(json.dumps({"query": open(sys.argv[1]).read()}))' "$QUERY" > "$BODY"

stem="$(basename "$QUERY" .graphql)"

run_one() {
  local label="$1" id="$2"
  local out="samples/${stem}.${label}.json"
  curl -sS -X POST "https://gateway.thegraph.com/api/subgraphs/id/${id}" \
    -H "Authorization: Bearer ${GRAPH_GATEWAY_API_KEY}" \
    -H 'content-type: application/json' \
    --data @"$BODY" > "$out"
  printf '%-24s -> %s\n' "$label" "$out"
  python3 - "$out" <<'PY'
import json, sys, datetime
d = json.load(open(sys.argv[1]))
if "errors" in d:
    for e in d["errors"]:
        print("   error:", e.get("message", e))
    raise SystemExit
data = d.get("data") or {}
protos = data.get("dexAmmProtocols") or []
if protos:
    p = protos[0]
    print(f"   {p['name']} | schema {p['schemaVersion']} | {p['network']}")
meta = (data.get("_meta") or {}).get("block") or {}
if "number" in meta:
    ts = meta.get("timestamp")
    when = datetime.datetime.fromtimestamp(ts, datetime.UTC).isoformat() if ts else ""
    print(f"   head block {meta['number']} {when}")
PY
}

while read -r label id _rest; do
  case "$label" in ''|'#'*) continue ;; esac
  run_one "$label" "$id"
done < queries/targets.txt

if [ -n "${TURNSTILE_SUBGRAPH_ID:-}" ]; then
  run_one "turnstile-uniswap-v3-mainnet" "$TURNSTILE_SUBGRAPH_ID"
fi
