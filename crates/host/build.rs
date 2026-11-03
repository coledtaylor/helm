//! Floti has one version, the desktop's: `packages/desktop/package.json`
//! names it, and every build of `floti` carries it as `FLOTI_VERSION`. The
//! crate's own version in its manifest is not Floti's and is never shown.

use std::path::Path;

fn main() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("packages")
        .join("desktop")
        .join("package.json");
    println!("cargo:rerun-if-changed={}", manifest.display());
    let text = std::fs::read_to_string(&manifest).unwrap_or_else(|err| {
        panic!(
            "floti takes its version from {}, which could not be read: {err}",
            manifest.display()
        )
    });
    let package: serde_json::Value = serde_json::from_str(&text)
        .unwrap_or_else(|err| panic!("{} is not JSON: {err}", manifest.display()));
    let version = package["version"]
        .as_str()
        .filter(|version| {
            !version.is_empty()
                && version
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
        })
        .unwrap_or_else(|| panic!("{} names no version floti can carry", manifest.display()));
    println!("cargo:rustc-env=FLOTI_VERSION={version}");
}
