//! One random 256-bit key in a Secret Service entry Floti owns, made the
//! first time a value is sealed, and [`KeySeal`] under it.
//!
//! The entry is in the default collection, with the attributes
//! `application = floti` and `purpose = plugin-secrets-key`. With no session
//! bus, or no Secret Service on it (WSL, CI, a server with no desktop),
//! sealing is unavailable, and asked again next time: a keyring that starts
//! later is found then.
//!
//! The Secret Service is spoken to over D-Bus on a thread and runtime of its
//! own, so a caller on any runtime, or none, can wait for it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use secret_service::{EncryptionType, SecretService};

use super::{KeySeal, SealError, SecretSeal};

const LABEL: &str = "Floti plugin secrets key";
const ATTRIBUTES: [(&str, &str); 2] = [("application", "floti"), ("purpose", "plugin-secrets-key")];

/// How long the Secret Service has to answer, an unlock prompt included:
/// D-Bus's own limit for a call.
const PATIENCE: Duration = Duration::from_secs(25);

#[derive(Debug, Default)]
pub struct Native {
    /// The key, once the Secret Service has answered.
    key: Mutex<Option<Arc<KeySeal>>>,
}

impl Native {
    pub fn new() -> Self {
        Self::default()
    }

    fn key(&self) -> Result<Arc<KeySeal>, SealError> {
        let mut key = self.key.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(found) = key.as_ref() {
            return Ok(Arc::clone(found));
        }
        let stored = std::thread::Builder::new()
            .name("floti secret service".into())
            .spawn(read_or_make_key)
            .map_err(|_| SealError::Unavailable)?
            .join()
            .map_err(|_| SealError::Unavailable)??;
        let found = Arc::new(KeySeal::from_stored(&stored).ok_or_else(|| {
            SealError::Failed("Floti's key in the Secret Service is not a key".into())
        })?);
        *key = Some(Arc::clone(&found));
        Ok(found)
    }
}

/// Floti's key from the Secret Service, made and stored there first if it
/// has none.
fn read_or_make_key() -> Result<Vec<u8>, SealError> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| SealError::Unavailable)?;
    runtime
        .block_on(async {
            tokio::time::timeout(PATIENCE, async {
                let service = SecretService::connect(EncryptionType::Dh).await?;
                let collection = match service.get_default_collection().await {
                    Ok(collection) => collection,
                    Err(_) => service.get_any_collection().await?,
                };
                collection.ensure_unlocked().await?;
                let attributes: HashMap<&str, &str> = ATTRIBUTES.into_iter().collect();
                if let Some(item) = collection
                    .search_items(attributes.clone())
                    .await?
                    .into_iter()
                    .next()
                {
                    item.ensure_unlocked().await?;
                    return Ok(Some(item.get_secret().await?));
                }
                let made = KeySeal::random_key().ok();
                let Some(made) = made else {
                    return Ok(None);
                };
                collection
                    .create_item(LABEL, attributes, &made, false, "application/octet-stream")
                    .await?;
                Ok::<_, secret_service::Error>(Some(made.to_vec()))
            })
            .await
        })
        .map_err(|_| SealError::Unavailable)?
        .map_err(|_| SealError::Unavailable)?
        .ok_or_else(|| SealError::Failed("the OS gave no random bytes".into()))
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Whether this test process could reach a session bus at all.
    fn session_bus() -> bool {
        std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some()
            || std::env::var_os("XDG_RUNTIME_DIR")
                .is_some_and(|dir| std::path::Path::new(&dir).join("bus").exists())
    }

    #[test]
    fn with_no_secret_service_sealing_is_unavailable_and_refused() {
        // A desktop with a keyring is not touched: this is about the
        // computers that have none.
        if session_bus() {
            eprintln!("a session bus is here; the user's keyring is left alone");
            return;
        }
        let native = Native::new();
        assert!(!native.available());
        assert_eq!(native.seal(b"value"), Err(SealError::Unavailable));
        assert_eq!(native.unseal(b"anything"), Err(SealError::Unavailable));
    }
}
