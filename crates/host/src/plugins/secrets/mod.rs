//! Plugin secrets: values the user stores so plugins can use them without
//! ever holding them.
//!
//! A secret is a key, a value, and two lists the user controls: the origins
//! the value may be sent to and the plugins that may use it. A plugin writes
//! `{{key}}` where the value goes; the host puts it there at the last moment,
//! after checking that the plugin declared the key, that the user allowed
//! this plugin, and, for a request, that the user allowed the request's
//! origin. The value never goes back to a client or to any plugin once it is
//! saved.
//!
//! - [`store`]: the secrets table in `floti.db`, today's schema, with every
//!   value sealed ([`SecretStore`]).
//! - [`seal`]: what seals the values: this OS's store for this user
//!   ([`crate::platform::secret_seal`]), or in a test build, a key file in a
//!   data folder the testkit marked.
//!
//! The registry and the `floti.*` methods reach secrets through
//! [`SecretsAccess`], so the store is the only thing that ever holds a value
//! in the clear. [`NoSecrets`] holds nothing: every declared key is missing.

pub mod seal;
pub mod store;

use std::fmt;
use std::sync::Arc;

use floti_protocol::channels::plugins::{
    PluginErrorCode, PluginPageSecretState, PluginSecretState,
};

use super::call::{Methods, PluginCallError, answer};
pub use store::SecretStore;

/// What a secret is being revealed for: a request to `origin` (the request's
/// URL, or its origin), which the secret must be bound to, or a program the
/// manifest names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretUse<'a> {
    Request { origin: &'a str },
    Program,
}

/// A secret's value, for the one use it was revealed for. Its `Debug` never
/// prints it.
#[derive(Clone, PartialEq, Eq)]
pub struct SecretValue(String);

impl SecretValue {
    pub fn new(value: String) -> Self {
        Self(value)
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SecretValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretValue(..)")
    }
}

pub trait SecretsAccess: Send + Sync {
    /// Whether `plugin` can use `key`: stored and permitted, stored and not,
    /// or not stored.
    fn state(&self, plugin: &str, key: &str) -> PluginSecretState;

    /// `key`'s value for `use_`. Every refusal is a `secret` error saying
    /// why, which is what the plugin's call fails with: `declared` (the
    /// manifest's `secrets`) does not name it, it is not stored, the plugin
    /// is not permitted it, a request's origin is not one the secret is
    /// bound to, or the stored value cannot be unsealed on this computer.
    fn reveal(
        &self,
        plugin: &str,
        declared: &[String],
        key: &str,
        use_: SecretUse<'_>,
    ) -> Result<SecretValue, PluginCallError>;

    /// Rows of the secrets table were deleted outside the store (a plugin
    /// was removed with the keys only it could use), so whatever the store
    /// shows has moved.
    fn removed(&self, keys: &[String]) {
        let _ = keys;
    }
}

/// A `secret` refusal saying `message`.
pub(crate) fn refusal(message: String) -> PluginCallError {
    PluginCallError::new(PluginErrorCode::Secret, message)
}

/// The refusal for a key `declared` does not name, when it does not.
pub(crate) fn check_declared(declared: &[String], key: &str) -> Result<(), PluginCallError> {
    if declared.iter().any(|name| name == key) {
        Ok(())
    } else {
        Err(refusal(format!(
            "{{{{{key}}}}} is not one of the secrets the manifest declares"
        )))
    }
}

/// Nothing is stored: every declared key is missing.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoSecrets;

impl SecretsAccess for NoSecrets {
    fn state(&self, _plugin: &str, _key: &str) -> PluginSecretState {
        PluginSecretState::Missing
    }

    fn reveal(
        &self,
        _plugin: &str,
        declared: &[String],
        key: &str,
        _use: SecretUse<'_>,
    ) -> Result<SecretValue, PluginCallError> {
        check_declared(declared, key)?;
        Err(store::not_stored(key))
    }
}

/// Serves `floti.secrets.state`: `ready` when a key the manifest declares is
/// stored and permitted for the plugin, `missing` otherwise. A key it does
/// not declare is refused as `not-declared`.
pub fn register_methods(methods: &Methods, secrets: Arc<dyn SecretsAccess>) {
    methods.register_sync("secrets.state", move |context, args| {
        let named = args
            .first()
            .and_then(|key| key.deserialized::<String>().ok());
        let key = named
            .clone()
            .filter(|key| context.manifest.secrets.contains(key))
            .ok_or_else(|| {
                let named = named.map_or_else(|| "That".to_owned(), |key| format!("\"{key}\""));
                PluginCallError::not_declared(format!(
                    "{named} is not one of the secrets the manifest declares"
                ))
            })?;
        let state = if secrets.state(&context.plugin, &key) == PluginSecretState::Ready {
            PluginPageSecretState::Ready
        } else {
            PluginPageSecretState::Missing
        };
        answer(&state)
    });
}
