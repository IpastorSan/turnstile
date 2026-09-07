use anyhow::Result;
use substreams_ethereum::Abigen;

fn main() -> Result<(), anyhow::Error> {
    println!("cargo:rerun-if-changed=abi/identity_registry.json");
    Abigen::new("IdentityRegistry", "abi/identity_registry.json")?
        .generate()?
        .write_to_file("src/abi/identity_registry.rs")?;
    Ok(())
}
