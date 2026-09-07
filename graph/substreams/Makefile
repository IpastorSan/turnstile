# ERC-8004 agent-registry Substreams.
#
# The repo sets CARGO_TARGET_DIR to a shared cache (see the root CLAUDE.md), but
# substreams.yaml resolves its binary relative to this directory. `build` links
# ./target at the real target dir so both are satisfied without hardcoding a
# machine-specific path into the manifest.

WASM      := target/wasm32-unknown-unknown/release/erc8004_agent_registry.wasm
SPKG      := erc8004-agent-registry-v0.1.0.spkg
NETWORK   ?= mainnet
MODULE    ?= map_agent_registrations

.PHONY: all build protogen pack test fmt clean run gui

all: build pack

## Compile the module to WASM.
build:
ifneq ($(CARGO_TARGET_DIR),)
	@[ -L target ] || [ ! -e target ] || { echo "./target exists and is not a symlink; remove it"; exit 1; }
	@ln -sfn "$(CARGO_TARGET_DIR)" target
endif
	cargo build --target wasm32-unknown-unknown --release
	@test -f $(WASM) || { echo "missing $(WASM)"; exit 1; }

## Regenerate src/pb from proto/. Needs the `buf` CLI.
protogen:
	substreams protogen ./substreams.yaml --exclude-paths="sf/ethereum,sf/substreams,sf/firehose,google"

## Package the module for distribution.
pack: build
	substreams pack ./substreams.yaml -o $(SPKG)

test:
	cargo test

fmt:
	cargo fmt

## Stream live. NETWORK=mainnet|base|sepolia|base-sepolia
##   make run NETWORK=base START=-1000
run: build
	substreams run ./substreams.yaml $(MODULE) --network $(NETWORK) $(if $(START),-s $(START),) $(if $(STOP),-t $(STOP),)

gui: build
	substreams gui ./substreams.yaml $(MODULE) --network $(NETWORK) $(if $(START),-s $(START),)

clean:
	cargo clean
	rm -f $(SPKG)
	@[ -L target ] && rm -f target || true
