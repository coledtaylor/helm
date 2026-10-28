//! What the plugin runtime asks of the secret store: whether a plugin may use
//! a key, and the value for one use of it.
//!
//! The registry and the `floti.*` methods go through [`SecretsAccess`], so the
//! store that encrypts and keeps the values is the only thing that ever holds
//! one in the clear. [`NoSecrets`] stands in until it is built: nothing is
//! stored, so every declared key is missing.

use std::fmt;

use floti_protocol::channels::plugins::PluginSecretState;

/// What a secret is being revealed for: a request to `origin`, which the
/// secret must be bound to, or a program the manifest names.
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

    /// `key`'s value for `use_`, when `declared` (the manifest's `secrets`)
    /// names it, the plugin is permitted it, and a request's origin is one
    /// the secret is bound to. `None` otherwise.
    fn reveal(
        &self,
        plugin: &str,
        declared: &[String],
        key: &str,
        use_: SecretUse<'_>,
    ) -> Option<SecretValue>;

    /// Rows of the secrets table were deleted outside the store (a plugin
    /// was removed with the keys only it could use), so whatever the store
    /// shows has moved.
    fn removed(&self, keys: &[String]) {
        let _ = keys;
    }
}

/// The stand-in until the secret store is built: nothing is stored.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoSecrets;

impl SecretsAccess for NoSecrets {
    fn state(&self, _plugin: &str, _key: &str) -> PluginSecretState {
        PluginSecretState::Missing
    }

    fn reveal(
        &self,
        _plugin: &str,
        _declared: &[String],
        _key: &str,
        _use: SecretUse<'_>,
    ) -> Option<SecretValue> {
        None
    }
}
