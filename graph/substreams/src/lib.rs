//! ERC-8004 agent-registry Substreams: one normalized feed, every EVM chain.
//!
//! The module decodes an ERC-8004 Identity Registry
//! (<https://eips.ethereum.org/EIPS/eip-8004>) into
//! `turnstile.erc8004.v1.AgentRegistrations`. Which registry, which chain and
//! from which block are module params, set per network in substreams.yaml, so
//! the same WASM binary streams Ethereum mainnet, Base, Sepolia and Base
//! Sepolia unchanged.

// `substreams_ethereum::init!()` expands to the extern entrypoint the runtime
// calls; clippy reads its raw-pointer argument as an unsafe deref in safe code.
#![allow(clippy::not_unsafe_ptr_arg_deref)]

mod abi;
mod params;
mod pb;
mod registration;

use substreams::errors::Error;
use substreams::store::{StoreGet, StoreGetString, StoreNew, StoreSet, StoreSetString};
use substreams_ethereum::pb::eth::v2 as eth;
use substreams_ethereum::Event;

use crate::abi::identity_registry::events;
use crate::params::Params;
use crate::pb::turnstile::erc8004::v1 as out;

/// The one reserved metadata key in EIP-8004: the address the agent is paid at.
const AGENT_WALLET_KEY: &str = "agentWallet";

substreams_ethereum::init!();

#[substreams::handlers::map]
fn map_agent_registrations(
    raw_params: String,
    blk: eth::Block,
) -> Result<out::AgentRegistrations, Error> {
    let params = Params::parse(&raw_params)?;

    let block_number = blk.number;
    let block_timestamp = block_timestamp(&blk);

    let wallet_updates = collect_wallet_updates(&params, &blk, block_number, block_timestamp);

    // Latest agentWallet seen for each agent *within this block*, so a
    // Registered/URIUpdated row carries the payout address its own transaction
    // set rather than the owner default. Wallet changes in later blocks reach
    // consumers through `store_agent_wallets`, not by rewriting past rows.
    let mut wallets_in_block: Vec<(&str, &str)> = Vec::new();
    for update in &wallet_updates {
        match wallets_in_block
            .iter_mut()
            .find(|(uid, _)| *uid == update.agent_uid)
        {
            Some(entry) => entry.1 = &update.wallet,
            None => wallets_in_block.push((&update.agent_uid, &update.wallet)),
        }
    }
    let wallet_for = |agent_uid: &str| -> Option<String> {
        wallets_in_block
            .iter()
            .find(|(uid, _)| *uid == agent_uid)
            .map(|(_, w)| w.to_string())
    };

    let mut registrations = Vec::new();
    for view in blk.logs() {
        let log = view.log;
        if log.address != params.registry_bytes {
            continue;
        }

        let (event, agent_id, uri, owner) =
            if let Some(e) = events::Registered::match_and_decode(log) {
                (
                    out::RegistrationEvent::Registered,
                    e.agent_id,
                    e.agent_uri,
                    e.owner,
                )
            } else if let Some(e) = events::UriUpdated::match_and_decode(log) {
                // `updatedBy` is the caller, which the registry requires to be the
                // owner or an approved operator. It is the best owner signal this
                // event carries.
                (
                    out::RegistrationEvent::UriUpdated,
                    e.agent_id,
                    e.new_uri,
                    e.updated_by,
                )
            } else {
                continue;
            };

        let agent_id = agent_id.to_string();
        let agent_uid = agent_uid(&params, &agent_id);
        let owner = to_hex(&owner);

        let (operator, operator_source) = match wallet_for(&agent_uid) {
            Some(wallet) => (wallet, out::OperatorSource::AgentWallet),
            // EIP-8004 initialises agentWallet to the owner's address.
            None => (owner.clone(), out::OperatorSource::OwnerDefault),
        };

        let (uri_scheme, document) = registration::parse_uri(&uri);
        let parsed = document.as_ref().map(registration::parse_document);

        registrations.push(out::AgentRegistration {
            agent_uid,
            namespace: "eip155".to_string(),
            chain_id: params.chain_id,
            network: params.network.clone(),
            registry: params.registry.clone(),
            agent_id,
            owner,
            operator,
            operator_source: operator_source as i32,
            agent_uri: uri,
            uri_scheme: uri_scheme as i32,
            registration_resolved: parsed.is_some(),
            name: parsed.as_ref().map(|r| r.name.clone()).unwrap_or_default(),
            description: parsed
                .as_ref()
                .map(|r| r.description.clone())
                .unwrap_or_default(),
            image: parsed.as_ref().map(|r| r.image.clone()).unwrap_or_default(),
            endpoints: parsed
                .as_ref()
                .map(|r| r.endpoints.clone())
                .unwrap_or_default(),
            x402_support: parsed.as_ref().map(|r| r.x402_support).unwrap_or(false),
            active: parsed.as_ref().map(|r| r.active).unwrap_or(false),
            supported_trust: parsed
                .as_ref()
                .map(|r| r.supported_trust.clone())
                .unwrap_or_default(),
            price: parsed.and_then(|r| r.price),
            event: event as i32,
            block_number,
            block_timestamp,
            transaction_hash: to_hex(&view.receipt.transaction.hash),
            log_index: log.block_index,
            ordinal: log.ordinal,
        });
    }

    Ok(out::AgentRegistrations {
        chain: params.chain,
        chain_id: params.chain_id,
        network: params.network,
        block_number,
        block_hash: to_hex(&blk.hash),
        block_timestamp,
        registrations,
        wallet_updates,
    })
}

/// Latest payout address per agent, keyed by `agent_uid`.
///
/// Downstream modules read this instead of re-decoding the registry, and it is
/// the piece that makes "which address does this agent get paid at, right now"
/// a store lookup rather than a scan.
#[substreams::handlers::store]
fn store_agent_wallets(registrations: out::AgentRegistrations, store: StoreSetString) {
    for update in registrations.wallet_updates {
        store.set(update.ordinal, &update.agent_uid, &update.wallet);
    }
}

/// The same feed, with `operator` resolved against every `agentWallet` ever
/// seen — not just those in the current block.
///
/// `map_agent_registrations` is a pure per-block function, so an agent that
/// repointed its payout address in an earlier block still shows the block-local
/// answer there. This module joins the store back in, and is the one to consume
/// if you want "who gets paid" to be right. It is also the worked example of
/// composing on top of the map: your own module can do the same join.
#[substreams::handlers::map]
fn map_agent_directory(
    registrations: out::AgentRegistrations,
    wallets: StoreGetString,
) -> Result<out::AgentRegistrations, Error> {
    let mut registrations = registrations;
    for agent in &mut registrations.registrations {
        if let Some(wallet) = wallets.get_at(agent.ordinal, &agent.agent_uid) {
            agent.operator = wallet;
            agent.operator_source = out::OperatorSource::AgentWallet as i32;
        }
    }
    Ok(registrations)
}

fn collect_wallet_updates(
    params: &Params,
    blk: &eth::Block,
    block_number: u64,
    block_timestamp: i64,
) -> Vec<out::AgentWalletUpdate> {
    let mut updates = Vec::new();
    for view in blk.logs() {
        let log = view.log;
        if log.address != params.registry_bytes {
            continue;
        }
        let Some(event) = events::MetadataSet::match_and_decode(log) else {
            continue;
        };
        if event.metadata_key != AGENT_WALLET_KEY {
            continue;
        }
        // The reserved key always carries a bare 20-byte address. Anything else
        // is not something we can honestly call a payout address.
        if event.metadata_value.len() != 20 {
            continue;
        }

        let agent_id = event.agent_id.to_string();
        updates.push(out::AgentWalletUpdate {
            agent_uid: agent_uid(params, &agent_id),
            chain_id: params.chain_id,
            network: params.network.clone(),
            registry: params.registry.clone(),
            agent_id,
            wallet: to_hex(&event.metadata_value),
            block_number,
            block_timestamp,
            transaction_hash: to_hex(&view.receipt.transaction.hash),
            log_index: log.block_index,
            ordinal: log.ordinal,
        });
    }
    updates
}

/// CAIP-10-shaped identifier extended with the ERC-721 token id, unique across
/// every chain that runs a registry: `eip155:<chain_id>:<registry>/<agent_id>`.
fn agent_uid(params: &Params, agent_id: &str) -> String {
    format!(
        "eip155:{}:{}/{}",
        params.chain_id, params.registry, agent_id
    )
}

fn block_timestamp(blk: &eth::Block) -> i64 {
    blk.header
        .as_ref()
        .and_then(|h| h.timestamp.as_ref())
        .map(|t| t.seconds)
        .unwrap_or_default()
}

fn to_hex(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}
