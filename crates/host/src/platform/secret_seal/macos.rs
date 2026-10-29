//! One random 256-bit key in a Keychain item Floti owns, made the first time
//! a value is sealed, and [`KeySeal`] under it.
//!
//! The item is a generic password: service `Floti`, account
//! `plugin-secrets-key`. A Keychain that does not answer leaves sealing
//! unavailable until it does.

use std::sync::{Mutex, PoisonError};

use security_framework::passwords::{get_generic_password, set_generic_password};

use super::{KeySeal, SealError, SecretSeal};

const SERVICE: &str = "Floti";
const ACCOUNT: &str = "plugin-secrets-key";

/// `errSecItemNotFound`: the Keychain has no such item.
const ITEM_NOT_FOUND: i32 = -25300;

#[derive(Debug, Default)]
pub struct Native {
    /// The key, once the Keychain has answered.
    key: Mutex<Option<std::sync::Arc<KeySeal>>>,
}

impl Native {
    pub fn new() -> Self {
        Self::default()
    }

    /// The key: read from the Keychain, or made and stored there.
    fn key(&self) -> Result<std::sync::Arc<KeySeal>, SealError> {
        let mut key = self.key.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(found) = key.as_ref() {
            return Ok(std::sync::Arc::clone(found));
        }
        let found = match get_generic_password(SERVICE, ACCOUNT) {
            Ok(stored) => KeySeal::from_stored(&stored).ok_or_else(|| {
                SealError::Failed("Floti's key in the Keychain is not a key".into())
            })?,
            Err(err) if err.code() == ITEM_NOT_FOUND => {
                let made = KeySeal::random_key()?;
                set_generic_password(SERVICE, ACCOUNT, &made)
                    .map_err(|_| SealError::Unavailable)?;
                KeySeal::new(&made)
            }
            Err(_) => return Err(SealError::Unavailable),
        };
        let found = std::sync::Arc::new(found);
        *key = Some(std::sync::Arc::clone(&found));
        Ok(found)
    }
}

impl SecretSeal for Native {
    fn available(&self) -> bool {
        self.key().is_ok()
    }

    fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, SealError> {
        self.key()?.seal(plain)
    }

    fn unseal(&self, sealed: &[u8]) -> Result<Vec<u8>, SealError> {
        self.key()?.unseal(sealed)
    }
}
