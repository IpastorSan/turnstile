//! Parsing the ERC-8004 `agentURI` and, where it is inline, the
//! registration-v1 document it points at.
//!
//! A Substreams module is a pure function of the block: it cannot fetch
//! `ipfs://` or `https://`. So this resolves exactly what the chain already
//! carries — `data:` URIs and (non-conformant but common) bare JSON literals —
//! and reports `registration_resolved = false` for the rest rather than
//! guessing. See README, "What is and is not resolved on-chain".
//!
//! Field reading is deliberately tolerant. The spec names `services`, but real
//! registrations on mainnet and Base also use `endpoints`, `x402support` for
//! `x402Support`, `supportedTrusts` for `supportedTrust`, and `url` /
//! `serviceEndpoint` / `uri` for an endpoint's `endpoint`.

use base64::Engine;
use serde_json::Value;

use crate::pb::turnstile::erc8004::v1 as pb;

/// Classify the URI and, when the document is inline, decode it.
pub fn parse_uri(uri: &str) -> (pb::UriScheme, Option<Value>) {
    let trimmed = uri.trim();
    if trimmed.is_empty() {
        return (pb::UriScheme::Empty, None);
    }
    if trimmed.starts_with('{') {
        return (
            pb::UriScheme::InlineJson,
            serde_json::from_str(trimmed).ok(),
        );
    }
    if let Some(rest) = strip_ci(trimmed, "data:") {
        return (pb::UriScheme::Data, decode_data_uri(rest));
    }
    if strip_ci(trimmed, "ipfs://").is_some() {
        return (pb::UriScheme::Ipfs, None);
    }
    if strip_ci(trimmed, "https://").is_some() {
        return (pb::UriScheme::Https, None);
    }
    if strip_ci(trimmed, "http://").is_some() {
        return (pb::UriScheme::Http, None);
    }
    (pb::UriScheme::Other, None)
}

/// The payload of a `data:` URI, after the `data:` prefix.
///
/// Handles both `...;base64,<b64>` and `...,<percent-encoded json>`.
fn decode_data_uri(rest: &str) -> Option<Value> {
    let (meta, payload) = rest.split_once(',')?;
    let bytes = if meta.to_ascii_lowercase().contains("base64") {
        // Real registrations are not always padded correctly, so try the
        // lenient decoder before the strict one.
        let cleaned: String = payload.chars().filter(|c| !c.is_whitespace()).collect();
        base64::engine::general_purpose::STANDARD
            .decode(&cleaned)
            .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(&cleaned))
            .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&cleaned))
            .ok()?
    } else {
        percent_decode(payload)
    };
    serde_json::from_slice(&bytes).ok()
}

fn percent_decode(s: &str) -> Vec<u8> {
    let raw = s.as_bytes();
    let mut out = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'%' && i + 2 < raw.len() {
            if let Some(b) = hex_pair(raw[i + 1], raw[i + 2]) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(raw[i]);
        i += 1;
    }
    out
}

fn hex_pair(hi: u8, lo: u8) -> Option<u8> {
    Some((hex_nibble(hi)? << 4) | hex_nibble(lo)?)
}

fn hex_nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

fn strip_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    if s.len() >= prefix.len() && s[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&s[prefix.len()..])
    } else {
        None
    }
}

/// The subset of a registration-v1 document this module normalizes.
#[derive(Default)]
pub struct Registration {
    pub name: String,
    pub description: String,
    pub image: String,
    pub endpoints: Vec<pb::Endpoint>,
    pub x402_support: bool,
    pub active: bool,
    pub supported_trust: Vec<String>,
    pub price: Option<pb::Price>,
}

pub fn parse_document(doc: &Value) -> Registration {
    let mut reg = Registration {
        name: str_field(doc, &["name"]),
        description: str_field(doc, &["description"]),
        image: str_field(doc, &["image"]),
        x402_support: bool_field(doc, &["x402Support", "x402support"]).unwrap_or(false),
        // registration-v1 has no default for `active`; an agent that omits it
        // is treated as live, which is how the registries behave.
        active: bool_field(doc, &["active"]).unwrap_or(true),
        supported_trust: str_list(doc, &["supportedTrust", "supportedTrusts"]),
        ..Default::default()
    };

    for key in ["services", "endpoints"] {
        if let Some(Value::Array(items)) = doc.get(key) {
            for item in items {
                if let Some(ep) = parse_endpoint(item) {
                    if reg.price.is_none() {
                        reg.price = parse_price(item);
                    }
                    reg.endpoints.push(ep);
                }
            }
        }
    }

    reg.price = reg.price.or_else(|| parse_price(doc));
    reg
}

fn parse_endpoint(item: &Value) -> Option<pb::Endpoint> {
    // Some documents list endpoints as plain strings.
    if let Value::String(s) = item {
        return Some(pb::Endpoint {
            uri: s.clone(),
            ..Default::default()
        });
    }
    let obj = item.as_object()?;
    let uri = str_field(
        item,
        &["endpoint", "url", "serviceEndpoint", "uri", "value"],
    );
    let name = str_field(item, &["name", "type", "protocol"]);
    if uri.is_empty() && name.is_empty() && obj.is_empty() {
        return None;
    }
    Some(pb::Endpoint {
        name,
        uri,
        version: str_field(item, &["version"]),
        skills: str_list(item, &["skills", "oasf_skills", "a2aSkills"]),
        domains: str_list(item, &["domains", "oasf_domains"]),
    })
}

/// Pull an advertised price, if the document carries one.
///
/// EIP-8004 registration-v1 does not define a price field — under x402 the
/// quote comes back dynamically in an HTTP 402 response — so this only fires
/// for the non-standard `price` / `pricing` objects some agents publish, and is
/// shaped like an x402 payment requirement so the two line up.
fn parse_price(v: &Value) -> Option<pb::Price> {
    let node = ["price", "pricing", "x402Price"]
        .iter()
        .find_map(|k| v.get(*k))?;
    let price = match node {
        Value::String(s) => pb::Price {
            amount: s.clone(),
            ..Default::default()
        },
        Value::Number(n) => pb::Price {
            amount: n.to_string(),
            ..Default::default()
        },
        Value::Object(_) => pb::Price {
            amount: scalar_field(node, &["amount", "maxAmountRequired", "value", "price"]),
            currency: str_field(node, &["currency", "unit", "denom"]),
            asset: str_field(node, &["asset", "token", "tokenAddress"]),
            network: str_field(node, &["network", "chain"]),
            scheme: str_field(node, &["scheme"]),
        },
        _ => return None,
    };
    if price == pb::Price::default() {
        return None;
    }
    Some(price)
}

fn str_field(v: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|k| v.get(*k).and_then(Value::as_str))
        .unwrap_or_default()
        .to_string()
}

/// Like `str_field`, but also accepts a JSON number (prices come as both).
fn scalar_field(v: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|k| match v.get(*k) {
            Some(Value::String(s)) => Some(s.clone()),
            Some(Value::Number(n)) => Some(n.to_string()),
            _ => None,
        })
        .unwrap_or_default()
}

fn bool_field(v: &Value, keys: &[&str]) -> Option<bool> {
    keys.iter().find_map(|k| match v.get(*k) {
        Some(Value::Bool(b)) => Some(*b),
        Some(Value::String(s)) => match s.to_ascii_lowercase().as_str() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        },
        _ => None,
    })
}

fn str_list(v: &Value, keys: &[&str]) -> Vec<String> {
    for k in keys {
        if let Some(Value::Array(items)) = v.get(*k) {
            return items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
        }
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pb::turnstile::erc8004::v1 as pb;

    // Verbatim from Base Sepolia agent 0, tx in block 36321136.
    const BASE_SEPOLIA_AGENT_0: &str = "data:application/json;base64,eyJ0eXBlIjoiaHR0cHM6Ly9laXBzLmV0aGVyZXVtLm9yZy9FSVBTL2VpcC04MDA0I3JlZ2lzdHJhdGlvbi12MSIsIm5hbWUiOiJUZXN0IEFnZW50IDAwMyAoQmFzZSkiLCJlbmRwb2ludHMiOlt7Im5hbWUiOiJ4NDAyIiwiZW5kcG9pbnQiOiJodHRwczovL2V4YW1wbGUuY29tL2FwaSIsInZlcnNpb24iOiIyLjAiLCJza2lsbHMiOlsidGVzdC1za2lsbCJdfV0sIngQ";

    #[test]
    fn classifies_uri_schemes() {
        assert_eq!(parse_uri("").0, pb::UriScheme::Empty);
        assert_eq!(parse_uri("ipfs://QmPxKi").0, pb::UriScheme::Ipfs);
        assert_eq!(
            parse_uri("https://api.freaks.one/api/freak/3652").0,
            pb::UriScheme::Https
        );
        assert_eq!(parse_uri("http://x.example").0, pb::UriScheme::Http);
        assert_eq!(parse_uri("{\"name\":\"a\"}").0, pb::UriScheme::InlineJson);
        assert_eq!(parse_uri("did:web:example.com").0, pb::UriScheme::Other);
    }

    #[test]
    fn decodes_a_base64_data_uri() {
        // The real mainnet agent 32055 document.
        let (scheme, doc) =
            parse_uri("data:application/json;base64,eyJuYW1lIjoidHJ1c3RydXN0LmV0aCJ9");
        assert_eq!(scheme, pb::UriScheme::Data);
        assert_eq!(parse_document(&doc.unwrap()).name, "trustrust.eth");
    }

    #[test]
    fn decodes_a_percent_encoded_data_uri() {
        let (scheme, doc) = parse_uri("data:application/json,%7B%22name%22%3A%22plain%22%7D");
        assert_eq!(scheme, pb::UriScheme::Data);
        assert_eq!(parse_document(&doc.unwrap()).name, "plain");
    }

    #[test]
    fn unfetchable_schemes_yield_no_document() {
        assert!(parse_uri("ipfs://QmPxKi").1.is_none());
        assert!(parse_uri("https://api.example/card").1.is_none());
    }

    #[test]
    fn reads_the_registration_v1_shape() {
        let doc: Value = serde_json::from_str(
            r#"{"type":"https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
                "name":"Test Agent 003 (Base)","description":"d","image":"i",
                "services":[{"name":"web","endpoint":"https://example.com/test"},
                            {"name":"x402","endpoint":"https://example.com/api","version":"2.0",
                             "skills":["test-skill"],"domains":["testing"]}],
                "x402Support":true,"active":true,"supportedTrust":["reputation"]}"#,
        )
        .unwrap();
        let reg = parse_document(&doc);
        assert_eq!(reg.name, "Test Agent 003 (Base)");
        assert!(reg.x402_support);
        assert!(reg.active);
        assert_eq!(reg.supported_trust, vec!["reputation"]);
        assert_eq!(reg.endpoints.len(), 2);
        assert_eq!(reg.endpoints[1].name, "x402");
        assert_eq!(reg.endpoints[1].uri, "https://example.com/api");
        assert_eq!(reg.endpoints[1].version, "2.0");
        assert_eq!(reg.endpoints[1].skills, vec!["test-skill"]);
        assert!(reg.price.is_none(), "registration-v1 carries no price");
    }

    #[test]
    fn tolerates_the_spelling_variants_seen_on_chain() {
        let doc: Value = serde_json::from_str(
            r#"{"name":"v","endpoints":[{"name":"a2a","url":"https://a","a2aSkills":["s"]}],
                "x402support":"true","supportedTrusts":["tee-attestation"]}"#,
        )
        .unwrap();
        let reg = parse_document(&doc);
        assert!(reg.x402_support);
        assert_eq!(reg.supported_trust, vec!["tee-attestation"]);
        assert_eq!(reg.endpoints[0].uri, "https://a");
        assert_eq!(reg.endpoints[0].skills, vec!["s"]);
    }

    #[test]
    fn extracts_a_non_standard_price_object() {
        let doc: Value = serde_json::from_str(
            r#"{"name":"p","services":[{"name":"x402","endpoint":"https://a",
                "price":{"amount":"10000","currency":"USDC","network":"base","scheme":"exact",
                         "asset":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"}}]}"#,
        )
        .unwrap();
        let price = parse_document(&doc).price.expect("price");
        assert_eq!(price.amount, "10000");
        assert_eq!(price.currency, "USDC");
        assert_eq!(price.network, "base");
        assert_eq!(price.scheme, "exact");
    }

    #[test]
    fn survives_a_truncated_base64_document() {
        // Truncation must not panic; it just yields no document.
        let (scheme, doc) = parse_uri(BASE_SEPOLIA_AGENT_0);
        assert_eq!(scheme, pb::UriScheme::Data);
        assert!(doc.is_none());
    }

    #[test]
    fn active_defaults_to_true_when_omitted() {
        let doc: Value = serde_json::from_str(r#"{"name":"x"}"#).unwrap();
        assert!(parse_document(&doc).active);
    }
}
