//! The secrets table in `floti.db`, with today's schema
//! (`core/store/secrets.ts`): a key, its sealed value, and the origins
//! (`hosts`) and plugins it may be used for as JSON lists.
//!
//! A value is stored sealed and only sealed: when this computer cannot seal,
//! saving one is refused rather than falling back to plain text. The list a
//! client sees has everything of a secret but its value, and every change
//! sends it to every subscriber of `secrets:changed`.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use floti_protocol::channels::plugins::{PluginSecretState, SecretInfo, SecretInput, SecretsState};
use rusqlite::{Connection, OptionalExtension, params};

use super::{SecretUse, SecretValue, SecretsAccess, check_declared, refusal};
use crate::config_console::time::now_iso;
use crate::platform::secret_seal::SecretSeal;
use crate::plugins::call::PluginCallError;
use crate::plugins::manifest::OriginPattern;
use crate::store::Store;

/// Long enough for a key file; a value past this, in UTF-16 code units as
/// today, was pasted by mistake.
pub const VALUE_MAX: usize = 16 * 1024;

/// What a refused save says when this computer cannot seal.
pub const CANNOT_SEAL: &str =
    "Floti cannot encrypt on this computer, so it will not store a secret. Nothing was saved.";

/// How the store sends every subscriber the whole list.
pub type PublishSecrets = Box<dyn Fn(&SecretsState) + Send + Sync>;

/// The plugin secret store. Values go in sealed and come out only through
/// [`SecretsAccess::reveal`].
pub struct SecretStore {
    store: Arc<Mutex<Store>>,
    seal: Arc<dyn SecretSeal>,
    publish: PublishSecrets,
}

/// One stored secret, as the table holds it.
struct Row {
    sealed: Vec<u8>,
    hosts: Vec<String>,
    plugins: Vec<String>,
}

fn lock(store: &Mutex<Store>) -> MutexGuard<'_, Store> {
    store.lock().unwrap_or_else(PoisonError::into_inner)
}

fn sql(action: &'static str) -> impl FnOnce(rusqlite::Error) -> String {
    move |err| format!("Floti could not {action}: {err}")
}

fn list_of(text: &str) -> Vec<String> {
    serde_json::from_str(text).unwrap_or_default()
}

fn json(list: &[String]) -> String {
    serde_json::to_string(list).unwrap_or_else(|_| "[]".to_owned())
}

/// `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`: the SDK's `SECRET_KEY_PATTERN`.
pub fn is_secret_key(key: &str) -> bool {
    let mut chars = key.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && key.len() <= 64
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

/// `^[a-z0-9][a-z0-9-]{0,62}$`: the SDK's `ID_PATTERN`.
pub fn is_plugin_id(id: &str) -> bool {
    let lower_or_digit = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit();
    let mut chars = id.chars();
    chars.next().is_some_and(lower_or_digit)
        && id.len() <= 63
        && chars.all(|c| lower_or_digit(c) || c == '-')
}

/// The refusal for a key that is not stored.
pub(crate) fn not_stored(key: &str) -> PluginCallError {
    refusal(format!(
        "the secret \"{key}\" is not stored - add it in Settings > Secrets"
    ))
}

fn read_list(conn: &Connection) -> Result<Vec<SecretInfo>, String> {
    let mut statement = conn
        .prepare("SELECT key, hosts, plugins, updated_at FROM secrets ORDER BY key")
        .map_err(sql("read the secrets"))?;
    statement
        .query_map([], |row| {
            Ok(SecretInfo {
                key: row.get(0)?,
                hosts: list_of(&row.get::<_, String>(1)?),
                plugins: list_of(&row.get::<_, String>(2)?),
                updated_at: row.get(3)?,
            })
        })
        .and_then(Iterator::collect)
        .map_err(sql("read the secrets"))
}

fn read_row(conn: &Connection, key: &str) -> Result<Option<Row>, String> {
    conn.query_row(
        "SELECT value, hosts, plugins FROM secrets WHERE key = ?1",
        [key],
        |row| {
            Ok(Row {
                sealed: row.get(0)?,
                hosts: list_of(&row.get::<_, String>(1)?),
                plugins: list_of(&row.get::<_, String>(2)?),
            })
        },
    )
    .optional()
    .map_err(sql("read a secret"))
}

/// Who may use `key`, when it is stored.
fn read_plugins(conn: &Connection, key: &str) -> Option<Vec<String>> {
    conn.query_row("SELECT plugins FROM secrets WHERE key = ?1", [key], |row| {
        row.get::<_, String>(0)
    })
    .optional()
    .ok()
    .flatten()
    .map(|plugins| list_of(&plugins))
}

impl SecretStore {
    pub fn new(
        store: Arc<Mutex<Store>>,
        seal: Arc<dyn SecretSeal>,
        publish: PublishSecrets,
    ) -> Self {
        Self {
            store,
            seal,
            publish,
        }
    }

    /// Whether this computer can seal: when it cannot, nothing can be
    /// stored.
    pub fn available(&self) -> bool {
        self.seal.available()
    }

    /// Every stored secret, without its value, by key.
    pub fn list(&self) -> Result<Vec<SecretInfo>, String> {
        read_list(lock(&self.store).connection())
    }

    /// What `secrets:list` answers and `secrets:changed` carries.
    pub fn snapshot(&self) -> Result<SecretsState, String> {
        Ok(SecretsState {
            available: self.available(),
            secrets: self.list()?,
        })
    }

    /// Stores a secret, or changes who may use one. A refusal is the
    /// sentence the form shows, and saves nothing.
    pub fn save(&self, input: &SecretInput) -> Result<SecretsState, String> {
        let key = input.key.trim();
        if !is_secret_key(key) {
            return Err(
                "A key is letters, digits, dots, dashes and underscores, starting with a letter or digit."
                    .into(),
            );
        }
        let mut hosts: Vec<String> = Vec::new();
        for host in &input.hosts {
            let pattern = OriginPattern::parse(host).ok_or_else(|| {
                format!(
                    "\"{host}\" is not an origin. Write it as https://api.example.com or https://*.example.com."
                )
            })?;
            if !hosts.contains(&pattern.origin) {
                hosts.push(pattern.origin);
            }
        }
        let mut plugins: Vec<String> = Vec::new();
        for plugin in &input.plugins {
            if !plugins.contains(plugin) {
                plugins.push(plugin.clone());
            }
        }
        if let Some(plugin) = plugins.iter().find(|plugin| !is_plugin_id(plugin)) {
            return Err(format!("\"{plugin}\" is not a plugin id."));
        }
        let sealed = match &input.value {
            None => None,
            Some(value) => {
                if value.is_empty() {
                    return Err("A secret needs a value.".into());
                }
                if value.encode_utf16().count() > VALUE_MAX {
                    return Err("That value is longer than a secret can be.".into());
                }
                if !self.seal.available() {
                    return Err(CANNOT_SEAL.into());
                }
                Some(
                    self.seal
                        .seal(value.as_bytes())
                        .map_err(|_| CANNOT_SEAL.to_owned())?,
                )
            }
        };
        {
            let store = lock(&self.store);
            let conn = store.connection();
            let now = now_iso();
            let exists = read_plugins(conn, key).is_some();
            match (exists, sealed) {
                (false, None) => return Err("A secret needs a value.".into()),
                (false, Some(sealed)) => conn
                    .execute(
                        "INSERT INTO secrets (key, value, hosts, plugins, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                        params![key, sealed, json(&hosts), json(&plugins), now],
                    )
                    .map(drop)
                    .map_err(sql("save the secret"))?,
                (true, Some(sealed)) => conn
                    .execute(
                        "UPDATE secrets SET value = ?2, hosts = ?3, plugins = ?4, updated_at = ?5
                         WHERE key = ?1",
                        params![key, sealed, json(&hosts), json(&plugins), now],
                    )
                    .map(drop)
                    .map_err(sql("save the secret"))?,
                (true, None) => conn
                    .execute(
                        "UPDATE secrets SET hosts = ?2, plugins = ?3, updated_at = ?4 WHERE key = ?1",
                        params![key, json(&hosts), json(&plugins), now],
                    )
                    .map(drop)
                    .map_err(sql("save the secret"))?,
            }
        }
        let state = self.snapshot()?;
        (self.publish)(&state);
        Ok(state)
    }

    /// Takes a secret away from every plugin. Answers the list and whether
    /// there was one to take; only then is the list sent again.
    pub fn remove(&self, key: &str) -> Result<(SecretsState, bool), String> {
        let removed = lock(&self.store)
            .connection()
            .execute("DELETE FROM secrets WHERE key = ?1", [key])
            .map_err(sql("remove the secret"))?
            > 0;
        let state = self.snapshot()?;
        if removed {
            (self.publish)(&state);
        }
        Ok((state, removed))
    }
}

impl SecretsAccess for SecretStore {
    fn state(&self, plugin: &str, key: &str) -> PluginSecretState {
        match read_plugins(lock(&self.store).connection(), key) {
            None => PluginSecretState::Missing,
            Some(plugins) if plugins.iter().any(|id| id == plugin) => PluginSecretState::Ready,
            Some(_) => PluginSecretState::NotAllowed,
        }
    }

    fn reveal(
        &self,
        plugin: &str,
        declared: &[String],
        key: &str,
        use_: SecretUse<'_>,
    ) -> Result<SecretValue, PluginCallError> {
        check_declared(declared, key)?;
        let row = read_row(lock(&self.store).connection(), key)
            .ok()
            .flatten()
            .ok_or_else(|| not_stored(key))?;
        if !row.plugins.iter().any(|id| id == plugin) {
            return Err(refusal(format!(
                "the secret \"{key}\" is not allowed for this plugin"
            )));
        }
        if let SecretUse::Request { origin } = use_ {
            let url = url::Url::parse(origin).ok();
            let allowed = url.as_ref().is_some_and(|url| {
                row.hosts.iter().any(|host| {
                    OriginPattern::parse(host).is_some_and(|pattern| pattern.matches(url))
                })
            });
            if !allowed {
                let to = url.map_or_else(
                    || origin.to_owned(),
                    |url| url.origin().ascii_serialization(),
                );
                return Err(refusal(format!(
                    "the secret \"{key}\" may not be sent to {to}"
                )));
            }
        }
        let cannot = || {
            refusal(format!(
                "the secret \"{key}\" could not be decrypted on this computer"
            ))
        };
        let plain = self.seal.unseal(&row.sealed).map_err(|_| cannot())?;
        String::from_utf8(plain)
            .map(SecretValue::new)
            .map_err(|_| cannot())
    }

    fn removed(&self, _keys: &[String]) {
        if let Ok(state) = self.snapshot() {
            (self.publish)(&state);
        }
    }
}
