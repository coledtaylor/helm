//! The name of the OS store entry a host keeps its plugin-secrets key in.
//!
//! The installed host keeps the names it has always had, so what it sealed
//! still unseals. A host whose data folder was moved (`FLOTI_DATA_DIR`, as a
//! development run does) adds a tag taken from that folder: the first twelve
//! hex characters of the SHA-256 of its path, the rule the desktop's launcher
//! names a socket folder by. Each moved data folder then has one entry of its
//! own, the same at every start, and never reads or makes the installed
//! host's.
//!
//! On Linux the tag goes into an attribute's value, never an attribute of its
//! own: the Secret Service finds every item holding at least the attributes
//! searched for, so an extra attribute would leave a moved folder's key in
//! the installed host's search.
//!
//! Plain logic on every OS; only macOS and Linux store anything under it.

use std::path::Path;

use crate::config_console::sha256_hex;

/// The Keychain item's service, for every host.
const SERVICE: &str = "Floti";
/// The installed host's Keychain account and Secret Service `purpose`.
const PURPOSE: &str = "plugin-secrets-key";
/// The Secret Service `application`, for every host.
const APPLICATION: &str = "floti";
/// The installed host's Secret Service label.
const LABEL: &str = "Floti plugin secrets key";
/// How many hex characters of the folder's hash name it.
const TAG_LEN: usize = 12;

/// Where one host's plugin-secrets key is kept in the OS store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreEntry {
    /// The moved data folder's tag; `None` for the installed host.
    tag: Option<String>,
}

impl StoreEntry {
    /// The installed host's entry.
    pub fn installed() -> Self {
        Self { tag: None }
    }

    /// The entry of a host whose data folder was moved to `data`.
    pub fn for_moved_data_folder(data: &Path) -> Self {
        Self {
            tag: Some(data_folder_tag(data)),
        }
    }

    /// The Keychain item's service.
    pub fn keychain_service(&self) -> &'static str {
        SERVICE
    }

    /// The Keychain item's account.
    pub fn keychain_account(&self) -> String {
        self.purpose()
    }

    /// The attributes the Secret Service item is found by and made with.
    pub fn secret_service_attributes(&self) -> [(&'static str, String); 2] {
        [
            ("application", APPLICATION.to_owned()),
            ("purpose", self.purpose()),
        ]
    }

    /// The Secret Service item's label, as a keyring app shows it.
    pub fn secret_service_label(&self) -> String {
        match &self.tag {
            None => LABEL.to_owned(),
            Some(tag) => format!("{LABEL} (data folder {tag})"),
        }
    }

    fn purpose(&self) -> String {
        match &self.tag {
            None => PURPOSE.to_owned(),
            Some(tag) => format!("{PURPOSE}-{tag}"),
        }
    }
}

/// The first twelve hex characters of the SHA-256 of `data`'s path, as
/// given and not resolved: the desktop's launcher names a socket folder the
/// same way.
pub fn data_folder_tag(data: &Path) -> String {
    let mut tag = sha256_hex(data.to_string_lossy().as_bytes());
    tag.truncate(TAG_LEN);
    tag
}
