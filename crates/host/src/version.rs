//! What `floti version` answers: one line a program reads, naming Floti's
//! version, the protocol version it speaks, and the OS and CPU it was built
//! for, such as `floti 2.6.0 protocol 1.0 linux x64`.
//!
//! Floti has one version, the desktop's, read from
//! `packages/desktop/package.json` when the crate is built (`build.rs`). The
//! desktop asks a computer it adds as a host for this line, through the same
//! ssh login or command it reaches the host by, to tell whether floti is
//! there, whether it can talk to it, and which build fits that computer.

use floti_protocol::PROTOCOL_VERSION;

/// Floti's version: the desktop's, as `packages/desktop/package.json` names
/// it.
pub const FLOTI_VERSION: &str = env!("FLOTI_VERSION");

/// The OS this floti was built for, as the version line and the release's
/// file names say it: `windows`, `macos` or `linux`.
pub fn os_name() -> &'static str {
    std::env::consts::OS
}

/// The CPU this floti was built for, as the version line and the release's
/// file names say it: `x64` or `arm64`, and Rust's own name for any other.
pub fn cpu_name() -> &'static str {
    cpu_name_of(std::env::consts::ARCH)
}

fn cpu_name_of(arch: &'static str) -> &'static str {
    match arch {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }
}

/// The line `floti version` prints, without its line ending.
pub fn version_line() -> String {
    format!(
        "floti {FLOTI_VERSION} protocol {PROTOCOL_VERSION} {} {}",
        os_name(),
        cpu_name()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn s3_the_version_line_names_floti_the_protocol_and_this_os_and_cpu_in_six_words() {
        let line = version_line();
        let words: Vec<&str> = line.split(' ').collect();
        assert_eq!(words.len(), 6, "{line}");
        assert_eq!(words[0], "floti");
        assert_eq!(words[1], FLOTI_VERSION);
        assert_eq!(words[2], "protocol");
        assert_eq!(words[3], PROTOCOL_VERSION.to_string());
        assert_eq!(words[4], std::env::consts::OS);
        assert_eq!(words[5], cpu_name());
        assert!(!line.contains('\n'));
    }

    #[test]
    fn floti_s_version_is_the_desktop_s() {
        let manifest = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../packages/desktop/package.json"),
        )
        .unwrap();
        let package: serde_json::Value = serde_json::from_str(&manifest).unwrap();
        assert_eq!(package["version"].as_str(), Some(FLOTI_VERSION));
    }

    #[test]
    fn cpus_are_named_as_the_release_names_them() {
        assert_eq!(cpu_name_of("x86_64"), "x64");
        assert_eq!(cpu_name_of("aarch64"), "arm64");
        assert_eq!(cpu_name_of("riscv64"), "riscv64");
    }
}
