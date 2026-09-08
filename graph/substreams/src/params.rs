//! Per-network module parameters.
//!
//! The chain-specific facts — which registry, which chain id — are params
//! rather than constants, so one WASM binary serves every chain the manifest
//! declares. See the `networks:` block in substreams.yaml.

use substreams::errors::Error;

pub struct Params {
    /// Identity Registry address, lowercase 0x-hex.
    pub registry: String,
    /// Raw 20 bytes of `registry`, for comparing against log addresses.
    pub registry_bytes: Vec<u8>,
    pub chain_id: u64,
    /// Human label echoed into the output, e.g. "base".
    pub network: String,
    /// CAIP-2 chain id, e.g. "eip155:8453".
    pub chain: String,
}

impl Params {
    pub fn parse(raw: &str) -> Result<Self, Error> {
        let mut registry = None;
        let mut chain_id = None;
        let mut network = None;

        for pair in raw.split('&').filter(|p| !p.is_empty()) {
            let (key, value) = pair.split_once('=').ok_or_else(|| {
                Error::msg(format!("malformed param {pair:?}, expected key=value"))
            })?;
            match key {
                "registry" => registry = Some(value.to_string()),
                "chain_id" => {
                    chain_id =
                        Some(value.parse::<u64>().map_err(|_| {
                            Error::msg(format!("chain_id {value:?} is not a number"))
                        })?)
                }
                "network" => network = Some(value.to_string()),
                other => return Err(Error::msg(format!("unknown param {other:?}"))),
            }
        }

        let registry = registry.ok_or_else(|| Error::msg("missing required param `registry`"))?;
        let chain_id = chain_id.ok_or_else(|| Error::msg("missing required param `chain_id`"))?;

        let registry = registry.to_lowercase();
        let registry_bytes = hex::decode(registry.strip_prefix("0x").unwrap_or(&registry))
            .map_err(|_| Error::msg(format!("registry {registry:?} is not 0x-hex")))?;
        if registry_bytes.len() != 20 {
            return Err(Error::msg(format!(
                "registry {registry:?} is {} bytes, expected 20",
                registry_bytes.len()
            )));
        }

        let chain = format!("eip155:{chain_id}");
        let network = network.unwrap_or_else(|| chain.clone());

        Ok(Params {
            registry,
            registry_bytes,
            chain_id,
            network,
            chain,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::Params;

    #[test]
    fn parses_a_full_param_string() {
        let p = Params::parse(
            "registry=0x8004A169FB4a3325136EB29fA0ceB6D2e539a432&chain_id=8453&network=base",
        )
        .unwrap();
        assert_eq!(p.registry, "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432");
        assert_eq!(p.registry_bytes.len(), 20);
        assert_eq!(p.chain_id, 8453);
        assert_eq!(p.network, "base");
        assert_eq!(p.chain, "eip155:8453");
    }

    #[test]
    fn network_defaults_to_the_caip2_id() {
        let p = Params::parse("registry=0x8004a818bfb912233c491871b3d84c89a494bd9e&chain_id=1")
            .unwrap();
        assert_eq!(p.network, "eip155:1");
    }

    #[test]
    fn rejects_a_short_address() {
        assert!(Params::parse("registry=0xdeadbeef&chain_id=1").is_err());
    }

    #[test]
    fn rejects_an_unknown_key() {
        assert!(Params::parse(
            "registry=0x8004a818bfb912233c491871b3d84c89a494bd9e&chain_id=1&oops=1"
        )
        .is_err());
    }
}
