#!/usr/bin/env bash
#
# Register turnstile.eth on Sepolia (ENSv2 ETHRegistrar, commit/reveal).
#
#   DEPLOYER_PRIVATE_KEY=0x... ./scripts/register-turnstile-eth.sh
#
# Registration is paid in a FREE-MINT MockUSDC, not ETH. You need Sepolia ETH
# only for gas (~4 transactions). The script mints the USDC for you.
#
# Idempotent: re-running after a partial failure is safe. It re-checks
# availability, skips the mint/approve if you already hold enough, and will
# refuse to re-commit while an unexpired commitment exists.
set -euo pipefail

LABEL="${LABEL:-turnstile}"
DURATION="${DURATION:-31536000}"          # 1 year. Minimum allowed is 2419200 (28 days).
RPC="${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}"

REGISTRAR=0xa4449a0dd2b83007553d9b1d28b583a46a805a30
MOCK_USDC=0xd3322b29a7bdee707d1684676f149bf41aa3422f
ZERO=0x0000000000000000000000000000000000000000

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }

command -v cast >/dev/null || die "cast not found — export PATH=\"\$HOME/.config/.foundry/bin:\$PATH\""
[ -n "${DEPLOYER_PRIVATE_KEY:-}" ] || die "DEPLOYER_PRIVATE_KEY is not set"

OWNER=$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")
info "owner: $OWNER"

# --- preconditions ----------------------------------------------------------
GAS=$(cast balance "$OWNER" --rpc-url "$RPC")
info "sepolia ETH (wei): $GAS"
[ "$GAS" != "0" ] || die "no Sepolia ETH for gas. Fund $OWNER from a faucet first."

AVAIL=$(cast call "$REGISTRAR" "isAvailable(string)(bool)" "$LABEL" --rpc-url "$RPC")
[ "$AVAIL" = "true" ] || die "$LABEL.eth is NOT available (isAvailable=false). Someone registered it."
info "$LABEL.eth is available"

# cast prints one value per line, sometimes with a "[8e6]" scientific suffix.
# Strip the suffix and take the first two numbers. NOTE: `read` returns 1 at EOF,
# which under `set -e` would kill the script silently — so parse without it.
PRICE_RAW=$(cast call "$REGISTRAR" \
  "getRegisterPrice(string,uint64,address)(uint256,uint256)" \
  "$LABEL" "$DURATION" "$MOCK_USDC" --rpc-url "$RPC")
BASE=$(echo "$PRICE_RAW" | sed -n '1p' | awk '{print $1}')
PREMIUM=$(echo "$PRICE_RAW" | sed -n '2p' | awk '{print $1}')
: "${BASE:=0}"; : "${PREMIUM:=0}"
[ "$BASE" -gt 0 ] 2>/dev/null || die "could not parse price from: $PRICE_RAW"
TOTAL=$((BASE + PREMIUM))
info "price: base=$BASE premium=$PREMIUM total=$TOTAL (6 decimals, so ~$((TOTAL / 1000000)) USDC)"

# --- 1. mint the mock USDC (permissionless, free) ---------------------------
BAL=$(cast call "$MOCK_USDC" "balanceOf(address)(uint256)" "$OWNER" --rpc-url "$RPC" | awk '{print $1}')
if [ "$BAL" -lt "$TOTAL" ]; then
  info "minting $((TOTAL * 10)) MockUSDC (free, no access control on mint)"
  cast send "$MOCK_USDC" "mint(address,uint256)" "$OWNER" "$((TOTAL * 10))" \
    --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$RPC" >/dev/null
else
  info "already holding enough MockUSDC ($BAL), skipping mint"
fi

# --- 2. approve the registrar ----------------------------------------------
ALLOW=$(cast call "$MOCK_USDC" "allowance(address,address)(uint256)" "$OWNER" "$REGISTRAR" --rpc-url "$RPC" | awk '{print $1}')
if [ "$ALLOW" -lt "$TOTAL" ]; then
  info "approving the registrar"
  cast send "$MOCK_USDC" "approve(address,uint256)" "$REGISTRAR" "$((TOTAL * 10))" \
    --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$RPC" >/dev/null
else
  info "allowance already sufficient, skipping approve"
fi

# --- 3. commit --------------------------------------------------------------
# subregistry and resolver are deliberately address(0): we do not own the name
# yet, so TurnstileRegistry cannot be wired here. Deploy.s.sol calls
# setSubregistry afterwards. The secret must be identical in commit and
# register, so it is written to disk.
SECRET_FILE=".turnstile-eth-secret"
if [ -f "$SECRET_FILE" ]; then
  SECRET=$(cat "$SECRET_FILE")
  info "reusing secret from $SECRET_FILE"
else
  # SECURITY: this must be unpredictable. A guessable secret lets an observer
  # front-run the reveal and take the name. `xxd` is not installed everywhere
  # (it was missing here), and the old one-liner silently degraded to
  # `cast keccak ""` — a fixed constant — when it was absent. Fall back
  # explicitly and fail loudly rather than quietly producing a weak secret.
  if command -v openssl >/dev/null; then
    RAND=$(openssl rand -hex 32)
  elif command -v od >/dev/null; then
    RAND=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  else
    die "no openssl or od available to generate a random secret"
  fi
  [ ${#RAND} -eq 64 ] || die "random source produced ${#RAND} chars, expected 64"
  SECRET=$(cast keccak "0x$RAND")
  echo "$SECRET" > "$SECRET_FILE"
  info "generated secret, saved to $SECRET_FILE (gitignored — do not lose it mid-flow)"
fi

COMMITMENT=$(cast call "$REGISTRAR" \
  "makeCommitment(string,address,bytes32,address,address,uint64,bytes32)(bytes32)" \
  "$LABEL" "$OWNER" "$SECRET" "$ZERO" "$ZERO" "$DURATION" \
  "0x0000000000000000000000000000000000000000000000000000000000000000" \
  --rpc-url "$RPC")
info "commitment: $COMMITMENT"

COMMITTED_AT=$(cast call "$REGISTRAR" "commitmentAt(bytes32)(uint64)" "$COMMITMENT" --rpc-url "$RPC" | awk '{print $1}')
if [ "$COMMITTED_AT" = "0" ]; then
  info "committing (tx 3 of 4)"
  cast send "$REGISTRAR" "commit(bytes32)" "$COMMITMENT" \
    --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$RPC" >/dev/null
  COMMITTED_AT=$(cast call "$REGISTRAR" "commitmentAt(bytes32)(uint64)" "$COMMITMENT" --rpc-url "$RPC" | awk '{print $1}')
else
  info "commitment already exists at t=$COMMITTED_AT, reusing it"
fi

# --- 4. wait out MIN_COMMITMENT_AGE, then register --------------------------
NOW=$(date +%s)
READY=$((COMMITTED_AT + 60))     # MIN_COMMITMENT_AGE = 60s (read from the live contract)
EXPIRES=$((COMMITTED_AT + 86400)) # MAX_COMMITMENT_AGE = 24h
if [ "$NOW" -lt "$READY" ]; then
  WAIT=$((READY - NOW + 5))
  info "waiting ${WAIT}s for MIN_COMMITMENT_AGE (60s) to elapse"
  sleep "$WAIT"
fi
[ "$(date +%s)" -lt "$EXPIRES" ] || die "commitment expired (>24h old). Delete $SECRET_FILE and re-run."

info "registering (tx 4 of 4)"
cast send "$REGISTRAR" \
  "register(string,address,bytes32,address,address,uint64,address,bytes32)" \
  "$LABEL" "$OWNER" "$SECRET" "$ZERO" "$ZERO" "$DURATION" "$MOCK_USDC" \
  "0x0000000000000000000000000000000000000000000000000000000000000000" \
  --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$RPC" >/dev/null

# --- verify -----------------------------------------------------------------
STILL=$(cast call "$REGISTRAR" "isAvailable(string)(bool)" "$LABEL" --rpc-url "$RPC")
if [ "$STILL" = "false" ]; then
  rm -f "$SECRET_FILE"
  info "✅ $LABEL.eth is registered to $OWNER for $((DURATION / 86400)) days"
  info "next: DEPLOYER_PRIVATE_KEY=... forge script script/Deploy.s.sol:Deploy --rpc-url \"$RPC\" --broadcast --verify"
else
  die "register appeared to succeed but $LABEL.eth still reads available — investigate"
fi
