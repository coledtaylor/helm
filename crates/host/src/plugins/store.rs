//! The plugin folders the user registered and what they set on each plugin's
//! settings page, in `floti.db` with today's schema
//! (`core/store/plugins.ts`). What a plugin *is* is never stored: it is read
//! from its folder every time.
//!
//! Two spellings of one Windows path are one folder, so a path is found
//! ignoring case, and kept as it was first given.

use std::collections::BTreeMap;

use rusqlite::{Connection, OptionalExtension, params};

use crate::config_console::time::now_iso;
use crate::{Error, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginFolder {
    pub path: String,
    pub enabled: bool,
    /// Whether the sessions the host starts are offered the tools its
    /// manifest declares.
    pub tools_enabled: bool,
    pub added_at: String,
}

fn sql(action: &'static str) -> impl FnOnce(rusqlite::Error) -> Error {
    move |err| Error::io(action, std::io::Error::other(err))
}

fn folder_of(row: &rusqlite::Row<'_>) -> rusqlite::Result<PluginFolder> {
    Ok(PluginFolder {
        path: row.get(0)?,
        enabled: row.get(1)?,
        tools_enabled: row.get(2)?,
        added_at: row.get(3)?,
    })
}

/// In the order they were added, which is the order the rail and Settings
/// list them: by `rowid`, which two folders added in one millisecond do not
/// share.
pub fn read_folders(conn: &Connection) -> Result<Vec<PluginFolder>> {
    let mut statement = conn
        .prepare("SELECT path, enabled, tools_enabled, added_at FROM plugins ORDER BY rowid")
        .map_err(sql("read the plugin folders"))?;
    statement
        .query_map([], folder_of)
        .and_then(Iterator::collect)
        .map_err(sql("read the plugin folders"))
}

pub fn find_folder(conn: &Connection, path: &str) -> Result<Option<PluginFolder>> {
    conn.query_row(
        "SELECT path, enabled, tools_enabled, added_at FROM plugins WHERE lower(path) = lower(?1)",
        [path],
        folder_of,
    )
    .optional()
    .map_err(sql("find a plugin folder"))
}

/// Registers a folder, enabled and with its tools offered. One already
/// registered is answered as it is.
pub fn add_folder(conn: &Connection, path: &str) -> Result<PluginFolder> {
    if let Some(existing) = find_folder(conn, path)? {
        return Ok(existing);
    }
    let added_at = now_iso();
    conn.execute(
        "INSERT INTO plugins (path, enabled, tools_enabled, added_at) VALUES (?1, 1, 1, ?2)",
        params![path, added_at],
    )
    .map_err(sql("register a plugin folder"))?;
    Ok(PluginFolder {
        path: path.to_owned(),
        enabled: true,
        tools_enabled: true,
        added_at,
    })
}

pub fn set_enabled(conn: &Connection, path: &str, enabled: bool) -> Result<()> {
    conn.execute(
        "UPDATE plugins SET enabled = ?2 WHERE lower(path) = lower(?1)",
        params![path, enabled],
    )
    .map(drop)
    .map_err(sql("switch a plugin"))
}

pub fn set_tools_enabled(conn: &Connection, path: &str, enabled: bool) -> Result<()> {
    conn.execute(
        "UPDATE plugins SET tools_enabled = ?2 WHERE lower(path) = lower(?1)",
        params![path, enabled],
    )
    .map(drop)
    .map_err(sql("switch a plugin's tools"))
}

pub fn remove_folder(conn: &Connection, path: &str) -> Result<()> {
    conn.execute("DELETE FROM plugins WHERE lower(path) = lower(?1)", [path])
        .map(drop)
        .map_err(sql("remove a plugin folder"))
}

/// What the user set for one plugin, as stored. A value the manifest no
/// longer declares, or that no longer fits, is the caller's to ignore.
pub fn read_settings(
    conn: &Connection,
    plugin: &str,
) -> Result<BTreeMap<String, serde_json::Value>> {
    let mut statement = conn
        .prepare("SELECT key, value FROM plugin_settings WHERE plugin = ?1")
        .map_err(sql("read a plugin's settings"))?;
    let rows = statement
        .query_map([plugin], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .and_then(Iterator::collect::<rusqlite::Result<Vec<_>>>)
        .map_err(sql("read a plugin's settings"))?;
    Ok(rows
        .into_iter()
        .filter_map(|(key, text)| serde_json::from_str(&text).ok().map(|value| (key, value)))
        .collect())
}

/// One value, as JSON, or `None` to go back to the manifest's default.
pub fn write_setting(
    conn: &Connection,
    plugin: &str,
    key: &str,
    value: Option<&serde_json::Value>,
) -> Result<()> {
    let Some(value) = value else {
        return conn
            .execute(
                "DELETE FROM plugin_settings WHERE plugin = ?1 AND key = ?2",
                params![plugin, key],
            )
            .map(drop)
            .map_err(sql("reset a plugin setting"));
    };
    conn.execute(
        "INSERT INTO plugin_settings (plugin, key, value, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (plugin, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![plugin, key, value.to_string(), now_iso()],
    )
    .map(drop)
    .map_err(sql("save a plugin setting"))
}

pub fn forget_settings(conn: &Connection, plugin: &str) -> Result<()> {
    conn.execute("DELETE FROM plugin_settings WHERE plugin = ?1", [plugin])
        .map(drop)
        .map_err(sql("forget a plugin's settings"))
}

/// The stored secret keys no plugin but `plugin` may use: the ones removing
/// it offers to delete.
pub fn own_secret_keys(conn: &Connection, plugin: &str) -> Result<Vec<String>> {
    let mut statement = conn
        .prepare("SELECT key, plugins FROM secrets ORDER BY key")
        .map_err(sql("read the secrets"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .and_then(Iterator::collect::<rusqlite::Result<Vec<_>>>)
        .map_err(sql("read the secrets"))?;
    Ok(rows
        .into_iter()
        .filter(|(_, plugins)| {
            serde_json::from_str::<Vec<String>>(plugins).is_ok_and(|ids| ids == [plugin])
        })
        .map(|(key, _)| key)
        .collect())
}

/// Deletes one secret's row, saying whether there was one.
pub fn delete_secret(conn: &Connection, key: &str) -> Result<bool> {
    conn.execute("DELETE FROM secrets WHERE key = ?1", [key])
        .map(|deleted| deleted > 0)
        .map_err(sql("delete a secret"))
}
