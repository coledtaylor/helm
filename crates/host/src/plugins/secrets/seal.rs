//! What a host seals plugin secrets with: this OS's store for this user.
//!
//! A test never touches the user's credential store. Only in a build with
//! the testkit (the crate's own tests), a data folder the testkit marked
//! ([`TEST_SEAL_MARKER`], which every `TestDirs` writes) seals with a key file
//! inside that folder instead, or, when the marker says so, has no store at
//! all. A production build has none of this code, so no folder can make it
//! seal anything but the OS's way.

use std::path::Path;
use std::sync::Arc;

use crate::platform::secret_seal::{Native, SecretSeal};

/// The file in a data folder that makes a test build seal inside it.
#[cfg(any(test, feature = "testkit"))]
pub const TEST_SEAL_MARKER: &str = "floti-test-secret-seal";

/// What the marker says to seal with: a key file beside it.
#[cfg(any(test, feature = "testkit"))]
pub const TEST_SEAL_KEY_FILE: &str = "key-file";

/// What the marker says when the test wants a computer with no store.
#[cfg(any(test, feature = "testkit"))]
pub const TEST_SEAL_UNAVAILABLE: &str = "unavailable";

/// The seal a host whose data folder is `data` uses.
pub fn for_data_folder(data: &Path) -> Arc<dyn SecretSeal> {
    #[cfg(any(test, feature = "testkit"))]
    if let Some(seal) = test_seal(data) {
        return seal;
    }
    let _ = data;
    Arc::new(Native::new())
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
