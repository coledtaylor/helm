//! The host's settings: the keys of `app_settings` that belong to the host
//! rather than to one client's window, typed, as
//! `packages/core/src/store/settings.ts` keeps them.
//!
//! Reads are tolerant and writes are strict. A row this host cannot read is
//! a fact about the past (another build wrote it), so one unreadable key
//! falls back to its default and the rest still load. A write whose value
//! does not fit is a mistake happening now, so a patch is validated whole
//! before anything is written, and one bad value writes nothing at all. A
//! refusal names each key and what was wrong with it, in the validator's
//! sentence.
//!
//! Every accepted write goes to each listener with the whole settings after
//! it, in the order the writes were made: that is what `settings:changed`
//! carries.

use std::collections::BTreeMap;
use std::fmt;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock};

use floti_protocol::BackendId;
use floti_protocol::channels::workspace::{HostSettings, HostSettingsPatch};
use rusqlite::{Connection, params};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::history::archive::{CEILING_RANGE, CEILING_SETTING, DEFAULT_CEILING};
use crate::store::Store;
use crate::{Error, Result};

/// How many projects may be pinned, as today.
pub const PINNED_PROJECTS_MAX: usize = 200;

/// The keys, as today's settings name them.
const SCAN_ROOTS: &str = "scanRoots";
const PINNED_PROJECTS: &str = "pinnedProjects";
const FIRST_RUN_COMPLETED_AT: &str = "firstRunCompletedAt";
const BACKEND_PATHS: &str = "backendPaths";
/// Today's one backend path, read when no `backendPaths` row has been
/// written, as Claude Code's.
const CLAUDE_PATH: &str = "claudePath";
const TERMINAL_SHELL: &str = "terminalShell";
const BROWSER_MCP: &str = "browserMcp";
const BROWSER_MCP_LOCAL_ONLY: &str = "browserMcpLocalOnly";
const SESSION_MCP: &str = "sessionMcp";
const RESTORE_WITHOUT_ASKING: &str = "restoreWithoutAsking";

/// The settings of a host nobody has changed anything on.
pub fn defaults() -> HostSettings {
    HostSettings {
        scan_roots: Vec::new(),
        pinned_projects: Vec::new(),
        first_run_completed_at: None,
        backend_paths: BTreeMap::new(),
        terminal_shell: None,
        transcript_archive_max_bytes: DEFAULT_CEILING,
        browser_mcp: true,
        // Off, because the browser pane defaults to the web: tools confined
        // to loopback beside a pane that is not would be a surprise.
        browser_mcp_local_only: false,
        session_mcp: true,
        restore_without_asking: false,
    }
}

/// The settings `conn` holds, each key it does not hold or cannot read at
/// its default.
pub fn read(conn: &Connection) -> Result<HostSettings> {
    let rows = rows(conn)?;
    let mut settings = defaults();
    let take = |key: &str, apply: &mut dyn FnMut(&str) -> bool| {
        if let Some(value) = rows.get(key) {
            // A value that does not parse keeps the default.
            let _ = apply(value);
        }
    };
    take(SCAN_ROOTS, &mut |text| set(text, &mut settings.scan_roots));
    take(PINNED_PROJECTS, &mut |text| {
        set(text, &mut settings.pinned_projects)
    });
    take(FIRST_RUN_COMPLETED_AT, &mut |text| {
        set(text, &mut settings.first_run_completed_at)
    });
    take(TERMINAL_SHELL, &mut |text| {
        set(text, &mut settings.terminal_shell)
    });
    take(CEILING_SETTING, &mut |text| {
        set(text, &mut settings.transcript_archive_max_bytes)
    });
    take(BROWSER_MCP, &mut |text| {
        set(text, &mut settings.browser_mcp)
    });
    take(BROWSER_MCP_LOCAL_ONLY, &mut |text| {
        set(text, &mut settings.browser_mcp_local_only)
    });
    take(SESSION_MCP, &mut |text| {
        set(text, &mut settings.session_mcp)
    });
    take(RESTORE_WITHOUT_ASKING, &mut |text| {
        set(text, &mut settings.restore_without_asking)
    });
    match rows.get(BACKEND_PATHS) {
        Some(text) => {
            set(text, &mut settings.backend_paths);
        }
        None => {
            if let Some(Some(path)) = rows
                .get(CLAUDE_PATH)
                .and_then(|text| serde_json::from_str::<Option<String>>(text).ok())
                && !path.trim().is_empty()
            {
                settings
                    .backend_paths
                    .insert(BackendId::claude_code(), path);
            }
        }
    }
    Ok(settings)
}

/// Parses `text` into `field`, leaving it as it was when it does not parse.
fn set<T: DeserializeOwned>(text: &str, field: &mut T) -> bool {
    match serde_json::from_str(text) {
        Ok(value) => {
            *field = value;
            true
        }
        Err(_) => false,
    }
}

fn rows(conn: &Connection) -> Result<BTreeMap<String, String>> {
    let mut select = conn
        .prepare("SELECT key, value FROM app_settings")
        .map_err(sql("read the settings"))?;
    let rows = select
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(sql("read the settings"))?;
    rows.collect::<rusqlite::Result<BTreeMap<String, String>>>()
        .map_err(sql("read the settings"))
}

/// What is wrong with each value `patch` carries, as `key: sentence`, in the
/// order of the settings. Empty when every value fits.
pub fn problems(patch: &HostSettingsPatch) -> Vec<String> {
    let mut out = Vec::new();
    let mut check = |key: &str, problem: Option<String>| {
        if let Some(problem) = problem {
            out.push(format!("{key}: {problem}"));
        }
    };
    if let Some(roots) = &patch.scan_roots {
        check(SCAN_ROOTS, scan_roots_problem(roots));
    }
    if let Some(pins) = &patch.pinned_projects {
        check(PINNED_PROJECTS, pinned_projects_problem(pins));
    }
    if let Some(Some(at)) = &patch.first_run_completed_at {
        check(FIRST_RUN_COMPLETED_AT, timestamp_problem(at));
    }
    if let Some(paths) = &patch.backend_paths {
        check(BACKEND_PATHS, backend_paths_problem(paths));
    }
    if let Some(Some(shell)) = &patch.terminal_shell {
        check(TERMINAL_SHELL, executable_path_problem(shell));
    }
    if let Some(bytes) = patch.transcript_archive_max_bytes
        && !CEILING_RANGE.contains(&bytes)
    {
        check(
            CEILING_SETTING,
            Some(format!(
                "expected {} to {}, got {bytes}",
                CEILING_RANGE.start(),
                CEILING_RANGE.end()
            )),
        );
    }
    out
}

/// A string as the sentences quote it.
fn quoted(text: &str) -> String {
    serde_json::to_string(text).expect("a string is JSON")
}

/// Absolute only: a relative root would be read against whatever folder the
/// host happened to start in, so one setting would scan two folders.
fn scan_roots_problem(roots: &[String]) -> Option<String> {
    roots.iter().find_map(|root| {
        if root.trim().is_empty() {
            Some(format!(
                "expected every root to be a path, got {}",
                quoted(root)
            ))
        } else if !Path::new(root).is_absolute() {
            Some(format!("expected an absolute path, got {}", quoted(root)))
        } else {
            None
        }
    })
}

/// A set of absolute paths, each once ignoring case: two spellings of one
/// folder would be two pins only one of which could be taken out.
fn pinned_projects_problem(pins: &[String]) -> Option<String> {
    if pins.len() > PINNED_PROJECTS_MAX {
        return Some(format!(
            "expected at most {PINNED_PROJECTS_MAX} projects, got {}",
            pins.len()
        ));
    }
    let mut seen = std::collections::HashSet::new();
    pins.iter().find_map(|pin| {
        if pin.trim().is_empty() {
            Some(format!(
                "expected every pin to be a path, got {}",
                quoted(pin)
            ))
        } else if !Path::new(pin).is_absolute() {
            Some(format!("expected an absolute path, got {}", quoted(pin)))
        } else if !seen.insert(pin.to_lowercase()) {
            Some(format!(
                "expected each project once, got {} twice",
                quoted(pin)
            ))
        } else {
            None
        }
    })
}

/// Parsed, not pattern-matched.
fn timestamp_problem(at: &str) -> Option<String> {
    at.parse::<jiff::Timestamp>()
        .is_err()
        .then(|| format!("expected an ISO timestamp or null, got {}", quoted(at)))
}

/// Absolute, for the reason a scan root is: a bare name would be found on
/// the `PATH` of whatever started the host, so the setting would name
/// different programs on different starts.
fn executable_path_problem(path: &str) -> Option<String> {
    if path.trim().is_empty() {
        Some(format!(
            "expected an absolute path or null, got {}",
            quoted(path)
        ))
    } else if !Path::new(path).is_absolute() {
        Some(format!("expected an absolute path, got {}", quoted(path)))
    } else {
        None
    }
}

fn backend_paths_problem(paths: &BTreeMap<BackendId, String>) -> Option<String> {
    paths.iter().find_map(|(backend, path)| {
        executable_path_problem(path).map(|problem| format!("{problem} for {backend}"))
    })
}

/// A write refused or failed.
#[derive(Debug)]
pub enum SettingsWriteError {
    /// A value did not fit; nothing was written.
    Rejected(Vec<String>),
    /// The store could not be written.
    Store(Error),
}

impl fmt::Display for SettingsWriteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Rejected(problems) => write!(f, "settings rejected: {}", problems.join("; ")),
            Self::Store(err) => err.fmt(f),
        }
    }
}

impl std::error::Error for SettingsWriteError {}

impl From<Error> for SettingsWriteError {
    fn from(err: Error) -> Self {
        Self::Store(err)
    }
}

/// Applies `patch` as one edit, validated first, and answers the settings
/// after it.
pub fn write(
    conn: &mut Connection,
    patch: &HostSettingsPatch,
) -> std::result::Result<HostSettings, SettingsWriteError> {
    let refused = problems(patch);
    if !refused.is_empty() {
        return Err(SettingsWriteError::Rejected(refused));
    }
    let mut values: Vec<(&str, String)> = Vec::new();
    let mut put = |key: &'static str, value: &dyn ErasedJson| values.push((key, value.json()));
    if let Some(value) = &patch.scan_roots {
        put(SCAN_ROOTS, value);
    }
    if let Some(value) = &patch.pinned_projects {
        put(PINNED_PROJECTS, value);
    }
    if let Some(value) = &patch.first_run_completed_at {
        put(FIRST_RUN_COMPLETED_AT, value);
    }
    if let Some(value) = &patch.backend_paths {
        put(BACKEND_PATHS, value);
    }
    if let Some(value) = &patch.terminal_shell {
        put(TERMINAL_SHELL, value);
    }
    if let Some(value) = &patch.transcript_archive_max_bytes {
        put(CEILING_SETTING, value);
    }
    if let Some(value) = &patch.browser_mcp {
        put(BROWSER_MCP, value);
    }
    if let Some(value) = &patch.browser_mcp_local_only {
        put(BROWSER_MCP_LOCAL_ONLY, value);
    }
    if let Some(value) = &patch.session_mcp {
        put(SESSION_MCP, value);
    }
    if let Some(value) = &patch.restore_without_asking {
        put(RESTORE_WITHOUT_ASKING, value);
    }
    let edit = conn.transaction().map_err(sql("write the settings"))?;
    for (key, value) in &values {
        edit.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, \
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
            params![key, value],
        )
        .map_err(sql("write the settings"))?;
    }
    edit.commit().map_err(sql("write the settings"))?;
    Ok(read(conn)?)
}

/// A value written as its JSON.
trait ErasedJson {
    fn json(&self) -> String;
}

impl<T: Serialize> ErasedJson for T {
    fn json(&self) -> String {
        serde_json::to_string(self).expect("a setting is JSON")
    }
}

fn sql(action: &'static str) -> impl FnOnce(rusqlite::Error) -> Error {
    move |err| Error::io(action, std::io::Error::other(err))
}

type Listener = Box<dyn Fn(&HostSettings) + Send + Sync>;

/// The settings as the host serves them: read from and written to the store,
/// with every accepted write told to each listener.
pub struct SettingsService {
    store: Arc<Mutex<Store>>,
    /// Held from a write until its listeners have been told, so they hear
    /// the writes in the order they were made.
    writing: Mutex<()>,
    listeners: RwLock<Vec<Listener>>,
}

impl SettingsService {
    pub fn new(store: Arc<Mutex<Store>>) -> Self {
        Self {
            store,
            writing: Mutex::new(()),
            listeners: RwLock::new(Vec::new()),
        }
    }

    /// The settings now.
    pub fn read(&self) -> Result<HostSettings> {
        read(self.store().connection())
    }

    /// Applies `patch` and tells every listener the settings after it. A
    /// refused patch changes nothing and tells nobody.
    pub fn write(
        &self,
        patch: &HostSettingsPatch,
    ) -> std::result::Result<HostSettings, SettingsWriteError> {
        let _order = lock(&self.writing);
        let settings = write(self.store().connection_mut(), patch)?;
        for listener in self
            .listeners
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
        {
            listener(&settings);
        }
        Ok(settings)
    }

    /// Applies the patch `edit` makes of the settings as they are now, with
    /// no other write between the read and the write, so two edits of one
    /// list never lose each other's change. `edit` answering `None` writes
    /// nothing, tells nobody and answers the settings as they are.
    pub fn update(
        &self,
        edit: impl FnOnce(&HostSettings) -> Option<HostSettingsPatch>,
    ) -> std::result::Result<HostSettings, SettingsWriteError> {
        let _order = lock(&self.writing);
        let current = self.read()?;
        let Some(patch) = edit(&current) else {
            return Ok(current);
        };
        let settings = write(self.store().connection_mut(), &patch)?;
        for listener in self
            .listeners
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
        {
            listener(&settings);
        }
        Ok(settings)
    }

    /// Calls `listener` with the whole settings after every accepted write.
    pub fn on_change(&self, listener: impl Fn(&HostSettings) + Send + Sync + 'static) {
        self.listeners
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .push(Box::new(listener));
    }

    fn store(&self) -> MutexGuard<'_, Store> {
        lock(&self.store)
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests;
