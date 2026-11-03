//! What a host seals plugin secrets with: this OS's store for this user.
//!
//! The installed host keeps its key in the entry it has always used; a host
//! whose data folder was moved (`FLOTI_DATA_DIR`) keeps one in an entry named
//! from that folder ([`StoreEntry`]), so a development run never reads or
//! makes the installed host's key.
//!
//! A test never touches the user's credential store. Only in a build with
//! the testkit (the crate's own tests, and the `floti` `pnpm test:e2e`
//! builds), a data folder a test marked ([`TEST_SEAL_MARKER`], which every
//! `TestDirs` writes, as does the desktop's test world for its local host)
//! seals with a key file inside that folder instead, or, when the marker says
//! so, has no store at all. A production build has none of this code, so no folder can make it
//! seal anything but the OS's way.

use std::path::Path;
use std::sync::Arc;

use floti_protocol::channels::workspace::AppMode;

use crate::platform::secret_seal::{Native, SecretSeal, StoreEntry};
use crate::server::HostRun;

/// The file in a data folder that makes a test build seal inside it.
#[cfg(any(test, feature = "testkit"))]
pub const TEST_SEAL_MARKER: &str = "floti-test-secret-seal";

/// What the marker says to seal with: a key file beside it.
#[cfg(any(test, feature = "testkit"))]
pub const TEST_SEAL_KEY_FILE: &str = "key-file";

/// What the marker says when the test wants a computer with no store.
#[cfg(any(test, feature = "testkit"))]
pub const TEST_SEAL_UNAVAILABLE: &str = "unavailable";

/// The seal a host started as `run`, whose data folder is `data`, uses.
pub fn for_host(run: &HostRun, data: &Path) -> Arc<dyn SecretSeal> {
    #[cfg(any(test, feature = "testkit"))]
    if let Some(seal) = test_seal(data) {
        return seal;
    }
    Arc::new(Native::new(store_entry(run, data)))
}

/// The OS store entry the host's key is kept in: today's for the installed
/// host, and its data folder's own for any other.
pub fn store_entry(run: &HostRun, data: &Path) -> StoreEntry {
    match run.mode {
        AppMode::Installed => StoreEntry::installed(),
        AppMode::Dev | AppMode::DevLive | AppMode::Portable => {
            StoreEntry::for_moved_data_folder(data)
        }
    }
}

#[cfg(any(test, feature = "testkit"))]
fn test_seal(data: &Path) -> Option<Arc<dyn SecretSeal>> {
    use crate::platform::secret_seal::{KEY_LEN, KeySeal, Unavailable};

    let marker = std::fs::read_to_string(data.join(TEST_SEAL_MARKER)).ok()?;
    match marker.trim() {
        TEST_SEAL_UNAVAILABLE => Some(Arc::new(Unavailable)),
        TEST_SEAL_KEY_FILE => {
            let file = data.join(format!("{TEST_SEAL_MARKER}.key"));
            let key = match std::fs::read(&file) {
                Ok(stored) if stored.len() == KEY_LEN => stored,
                _ => {
                    let made = KeySeal::random_key().expect("the OS gives random bytes");
                    std::fs::write(&file, made).expect("write the test seal's key file");
                    made.to_vec()
                }
            };
            Some(Arc::new(
                KeySeal::from_stored(&key).expect("a key file holds a key"),
            ))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_installed_host_uses_todays_entry_and_a_moved_data_folder_its_own() {
        let data = Path::new("/somewhere/helm-data");
        let installed = HostRun {
            mode: AppMode::Installed,
            ..HostRun::default()
        };
        assert_eq!(store_entry(&installed, data), StoreEntry::installed());
        let moved = HostRun::default();
        assert_eq!(
            store_entry(&moved, data),
            StoreEntry::for_moved_data_folder(data)
        );
        assert_ne!(store_entry(&moved, data), StoreEntry::installed());
    }
}
