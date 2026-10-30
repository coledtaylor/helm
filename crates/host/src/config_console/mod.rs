//! The config console on the host: an agent's config scopes, their files,
//! the effective view of a launch, and every change to a config file.
//!
//! Reads come through the backend's
//! [`ConfigSource`](crate::agent::ConfigSource), which lists a credential
//! file without opening it, and every read, watch or change that names a
//! credential path is refused before anything opens it. Every
//! change - a write, create, rename, delete, restore, MCP approval, and the
//! file the agent's CLI rewrites for an MCP add or remove - goes through the
//! one snapshot-first writer ([`writer::SnapshotWriter`]): the bytes it
//! replaces go into floti.db first, and a snapshot that cannot be taken
//! aborts the change with a sentence, leaving the file as it was. MCP and the
//! doctor run the agent's own CLI with an argument array and no shell.
//!
//! The agent's config folder is read-only to the host apart from these
//! writes.

mod command;
mod doctor;
mod effective;
mod entries;
mod files;
mod json;
mod mcp;
mod names;
mod sha256;
pub mod snapshots;
pub(crate) mod time;
mod tree;
mod watch;
mod writer;

use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use floti_protocol::channels::workspace::{
    ConfigExternalChange, ConfigFile, ConfigFileContent, ConfigScope, ConfigScopeKind,
    ConfigSnapshotMeta, ConfigTree, ConfigWriteReason, CreateConfigRequest, CreateConfigResult,
    DeleteConfigRequest, DeleteConfigResult, DoctorReport, EffectiveView, EffectiveViewRequest,
    McpAddRequest, McpApproveRequest, McpPreview, McpRemoveRequest, McpResult, McpScope,
    RenameConfigRequest, RenameConfigResult, SnapshotContent, WriteConfigRequest,
    WriteConfigResult,
};
use rusqlite::params;

use crate::agent::AgentBackend;
use crate::session::ClientId;
use crate::store::Store;

pub use command::{AgentCommand, RunOutcome};
pub use doctor::parse_rows as doctor_rows;
pub use effective::{EffectiveInput, effective_view, project_entry};
pub use files::{
    PathGuard, WriteGuard, hash_content, mtime_ms, normalize, read_file, snapshot_key,
};
pub use json::Json;
pub use mcp::diff_lines;
pub use names::{FilePlan, check_name, config_unit, parse_frontmatter, plan_file};
pub use sha256::hex_digest as sha256_hex;
pub use tree::{project_scope, read_tree, user_scope};
pub use watch::ChangeSink;
pub use writer::SnapshotWriter;

use watch::Watches;

/// How long an MCP command may take: `list` health-checks every server.
const MCP_LIMIT: Duration = Duration::from_secs(60);

/// The agent's side of the console: its config folder (the user scope), its
/// global config file (where `local` and `user` MCP servers live), and how
/// to run its CLI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentConfig {
    pub config_dir: PathBuf,
    pub global_config: PathBuf,
    pub command: AgentCommand,
}

/// Where the snapshot history is kept.
pub trait SnapshotStore: Send + Sync {
    fn store(&self) -> MutexGuard<'_, Store>;
}

impl SnapshotStore for Mutex<Store> {
    fn store(&self) -> MutexGuard<'_, Store> {
        self.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Names ordered as a person reads them: case folded first, then exact.
pub(crate) fn compare_names(a: &str, b: &str) -> Ordering {
    a.to_lowercase()
        .cmp(&b.to_lowercase())
        .then_with(|| a.cmp(b))
}

/// One saved profile, as the console needs it.
#[derive(Debug, Clone)]
struct Profile {
    id: u64,
    name: String,
    root: PathBuf,
    overlays: Vec<PathBuf>,
}

/// The config console for one agent backend.
pub struct ConfigConsole {
    backend: Arc<dyn AgentBackend>,
    agent: AgentConfig,
    store: Arc<dyn SnapshotStore>,
    guard: WriteGuard,
    watches: Arc<Watches>,
}

impl ConfigConsole {
    /// The console for `backend`, keeping its history in `store` and telling
    /// `sink` of each outside change to a watched file, once for each client
    /// watching it.
    pub fn new(
        backend: Arc<dyn AgentBackend>,
        agent: AgentConfig,
        store: Arc<dyn SnapshotStore>,
        sink: ChangeSink,
    ) -> Self {
        Self {
            guard: WriteGuard::new(&agent.config_dir),
            backend,
            agent,
            store,
            watches: Watches::start(sink),
        }
    }

    pub fn agent(&self) -> &AgentConfig {
        &self.agent
    }

    fn profiles(&self) -> Result<Vec<Profile>, String> {
        let store = self.store.store();
        let mut statement = store
            .connection()
            .prepare("SELECT id, name, root, overlays FROM profiles ORDER BY id")
            .map_err(|err| format!("Floti could not read the saved profiles: {err}"))?;
        let rows = statement
            .query_map([], |row| {
                let overlays: String = row.get(3)?;
                Ok(Profile {
                    id: row.get::<_, i64>(0)?.max(0) as u64,
                    name: row.get(1)?,
                    root: PathBuf::from(row.get::<_, String>(2)?),
                    overlays: Json::parse(&overlays)
                        .map(|value| value.strings().into_iter().map(PathBuf::from).collect())
                        .unwrap_or_default(),
                })
            })
            .and_then(Iterator::collect)
            .map_err(|err| format!("Floti could not read the saved profiles: {err}"))?;
        Ok(rows)
    }

    fn profile(&self, id: u64) -> Result<Option<Profile>, String> {
        let store = self.store.store();
        let Ok(id) = i64::try_from(id) else {
            return Ok(None);
        };
        let found = store.connection().query_row(
            "SELECT id, name, root, overlays FROM profiles WHERE id = ?1",
            params![id],
            |row| {
                let overlays: String = row.get(3)?;
                Ok(Profile {
                    id: row.get::<_, i64>(0)?.max(0) as u64,
                    name: row.get(1)?,
                    root: PathBuf::from(row.get::<_, String>(2)?),
                    overlays: Json::parse(&overlays)
                        .map(|value| value.strings().into_iter().map(PathBuf::from).collect())
                        .unwrap_or_default(),
                })
            },
        );
        match found {
            Ok(profile) => Ok(Some(profile)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(err) => Err(format!("Floti could not read the saved profile: {err}")),
        }
    }

    /// The scopes a client can switch between: the user's, then every folder
    /// a saved profile runs in or composes, each once. A profile's folders
    /// decide what its sessions see whether or not they are anywhere else.
    pub fn scopes(&self) -> Result<Vec<ConfigScope>, String> {
        let user = user_scope(&self.agent.config_dir);
        let mut seen = vec![user.path.to_lowercase()];
        let mut out = vec![user];
        for profile in self.profiles()? {
            for path in std::iter::once(&profile.root).chain(&profile.overlays) {
                let scope = project_scope(path, ConfigScopeKind::Project, None);
                let key = scope.path.to_lowercase();
                if !seen.contains(&key) {
                    seen.push(key);
                    out.push(scope);
                }
            }
        }
        Ok(out)
    }

    /// The scope at `scope_path`: a listed one, or a project scope for a
    /// folder no profile names.
    fn scope_for(&self, scope_path: &str) -> Result<ConfigScope, String> {
        let wanted = normalize(Path::new(scope_path))
            .display()
            .to_string()
            .to_lowercase();
        Ok(self
            .scopes()?
            .into_iter()
            .find(|scope| scope.path.to_lowercase() == wanted)
            .unwrap_or_else(|| {
                project_scope(Path::new(scope_path), ConfigScopeKind::Project, None)
            }))
    }

    pub fn tree(&self, scope_path: &str) -> Result<ConfigTree, String> {
        Ok(read_tree(
            self.backend.as_ref(),
            &self.scope_for(scope_path)?,
        ))
    }

    /// A file's bytes and hash. A credential file is never opened.
    pub fn read(&self, path: &str) -> Result<ConfigFileContent, String> {
        let target = normalize(Path::new(path));
        self.refuse_credential(&target)?;
        Ok(read_file(&target))
    }

    /// A sentence refusing `target` when it is one of the backend's
    /// credential files, which nothing in the host opens.
    fn refuse_credential(&self, target: &Path) -> Result<(), String> {
        let is_credential = self.backend.credential_paths().iter().any(|credential| {
            normalize(credential)
                .as_os_str()
                .eq_ignore_ascii_case(target.as_os_str())
        });
        if is_credential {
            return Err(format!(
                "Floti never opens {}: it holds a credential.",
                target.display()
            ));
        }
        Ok(())
    }

    /// Runs `change` with a writer, holding the watches so the change the
    /// host makes is never told as an outside one; `touched` says which
    /// files it changed.
    fn change<R>(
        &self,
        change: impl FnOnce(&SnapshotWriter<'_>) -> Result<R, String>,
        touched: impl FnOnce(&R) -> Vec<PathBuf>,
    ) -> Result<R, String> {
        let mut watches = self.watches.changing();
        let store = self.store.store();
        let writer = SnapshotWriter::new(store.connection(), &self.guard);
        let result = change(&writer)?;
        let paths = touched(&result);
        watches.changed(paths.iter().map(PathBuf::as_path));
        Ok(result)
    }

    fn written(result: &WriteConfigResult) -> Vec<PathBuf> {
        if result.ok && !result.unchanged {
            vec![PathBuf::from(&result.file.path)]
        } else {
            Vec::new()
        }
    }

    /// Every change snapshots the bytes it replaces, which means reading
    /// them, so a credential file is refused before any change, as a read is.
    pub fn write(&self, request: &WriteConfigRequest) -> Result<WriteConfigResult, String> {
        self.refuse_credential(&normalize(Path::new(&request.path)))?;
        self.change(|writer| writer.write(request), Self::written)
    }

    pub fn snapshots(
        &self,
        scope_path: &str,
        path: &str,
    ) -> Result<Vec<ConfigSnapshotMeta>, String> {
        let scope = normalize(Path::new(scope_path));
        let store = self.store.store();
        snapshots::list(
            store.connection(),
            &scope.display().to_string(),
            &snapshot_key(&scope, Path::new(path)),
        )
    }

    pub fn snapshot(&self, id: u64) -> Result<Option<SnapshotContent>, String> {
        let store = self.store.store();
        Ok(
            snapshots::read(store.connection(), id)?.map(|row| SnapshotContent {
                content: row.content,
            }),
        )
    }

    pub fn restore(&self, id: u64, path: &str) -> Result<WriteConfigResult, String> {
        self.refuse_credential(&normalize(Path::new(path)))?;
        self.change(|writer| writer.restore(id, Path::new(path)), Self::written)
    }

    pub fn create(&self, request: &CreateConfigRequest) -> Result<CreateConfigResult, String> {
        let scope = self.scope_for(&request.scope_path)?;
        self.change(
            |writer| entries::create(writer, &scope, request.kind, &request.name),
            |result| result.path.iter().map(PathBuf::from).collect(),
        )
    }

    /// The entry a request names, resolved from the scope's tree rather than
    /// taken from the request: what a path is decides what a rename moves
    /// and a delete removes, and that is a fact about the disk.
    fn entry_in(
        &self,
        scope_path: &str,
        path: &str,
    ) -> Result<(ConfigScope, Vec<ConfigFile>, ConfigFile), String> {
        self.refuse_credential(&normalize(Path::new(path)))?;
        let scope = self.scope_for(scope_path)?;
        let files = tree::scope_files(self.backend.as_ref(), &scope)?;
        let target = normalize(Path::new(path));
        let file = files
            .iter()
            .find(|candidate| normalize(Path::new(&candidate.path)) == target)
            .cloned()
            .ok_or_else(|| {
                format!(
                    "{} is not a configuration file in {}. Re-read the scope and try again.",
                    target.display(),
                    scope.label
                )
            })?;
        Ok((scope, files, file))
    }

    pub fn rename(&self, request: &RenameConfigRequest) -> Result<RenameConfigResult, String> {
        let (scope, files, file) = self.entry_in(&request.scope_path, &request.path)?;
        self.change(
            |writer| entries::rename(writer, &scope, &files, &file, &request.name),
            |result| {
                result
                    .moved
                    .iter()
                    .flat_map(|moved| [PathBuf::from(&moved.from), PathBuf::from(&moved.to)])
                    .collect()
            },
        )
    }

    pub fn delete(&self, request: &DeleteConfigRequest) -> Result<DeleteConfigResult, String> {
        let (scope, files, file) = self.entry_in(&request.scope_path, &request.path)?;
        self.change(
            |writer| entries::delete(writer, &scope, &files, &file),
            |result| {
                result
                    .removed
                    .iter()
                    .map(|row| PathBuf::from(&row.path))
                    .collect()
            },
        )
    }

    /// `client`'s editor has `path` open, or nothing. Watching reads the
    /// file's bytes, so a credential file is refused as a read is.
    pub fn watch(&self, client: ClientId, path: Option<&str>) -> Result<(), String> {
        if let Some(path) = path {
            self.refuse_credential(&normalize(Path::new(path)))?;
        }
        self.watches.watch(client, path.map(Path::new));
        Ok(())
    }

    /// The effective view for a saved profile, read from the store so it is
    /// that composition's and no other, or for a folder and overlays.
    pub fn effective(&self, request: &EffectiveViewRequest) -> Result<EffectiveView, String> {
        let input = match request.profile_id {
            Some(id) => {
                let profile = self
                    .profile(id)?
                    .ok_or_else(|| "That profile no longer exists.".to_owned())?;
                EffectiveInput {
                    cwd: profile.root,
                    overlays: profile.overlays,
                    profile_id: Some(profile.id),
                    profile_name: Some(profile.name),
                }
            }
            None => {
                let cwd = request.cwd.as_deref().map(str::trim).unwrap_or_default();
                if cwd.is_empty() {
                    return Err(
                        "An effective view needs either a profile or a working directory."
                            .to_owned(),
                    );
                }
                EffectiveInput {
                    cwd: PathBuf::from(cwd),
                    overlays: request.overlays.iter().map(PathBuf::from).collect(),
                    profile_id: None,
                    profile_name: None,
                }
            }
        };
        Ok(effective_view(self.backend.as_ref(), &self.agent, &input))
    }

    pub fn mcp_preview(&self, request: &McpAddRequest) -> McpPreview {
        mcp::preview(&self.agent, request)
    }

    /// Runs one MCP command that rewrites `scope`'s file, snapshotting the
    /// file first. The CLI writes it, not the host, and the rule that every
    /// change has a version behind it holds for the changes the host hands
    /// to the CLI too: no snapshot, no command.
    fn mcp_change(
        &self,
        scope: McpScope,
        cwd: &str,
        args: &[&str],
        snapshot_absent: bool,
    ) -> Result<McpResult, String> {
        let cwd_path = normalize(Path::new(cwd));
        let file = mcp::target_file(&self.agent, scope, &cwd_path);
        // The watches are held across the command, so the CLI's rewrite is
        // not told as an outside change; the store only while the snapshot
        // is taken, so sessions are not kept waiting on the CLI.
        let mut watches = self.watches.changing();
        let snapshot_id = {
            let store = self.store.store();
            let writer = SnapshotWriter::new(store.connection(), &self.guard);
            let before = read_file(&file);
            if before.binary {
                return Err(format!(
                    "{} is not text, so Floti cannot record it before the CLI rewrites it, and runs nothing.",
                    file.display()
                ));
            }
            // The global config is under no scope, so it is recorded against
            // its own folder, under its file name.
            let scope_path = match scope {
                McpScope::Project => cwd_path.clone(),
                McpScope::Local | McpScope::User => {
                    file.parent().map(Path::to_path_buf).unwrap_or_default()
                }
            };
            if before.exists {
                Some(writer.snapshot(
                    &scope_path,
                    &file,
                    &before.content,
                    &before.hash,
                    ConfigWriteReason::Mcp,
                )?)
            } else if snapshot_absent {
                Some(writer.snapshot(
                    &scope_path,
                    &file,
                    "",
                    &hash_content(""),
                    ConfigWriteReason::Mcp,
                )?)
            } else {
                None
            }
        };
        let mut all = vec!["mcp"];
        all.extend_from_slice(args);
        let outcome = command::run(&self.agent.command, &all, Some(&cwd_path), MCP_LIMIT);
        watches.changed([file.as_path()]);
        let after = read_file(&file);
        Ok(mcp_result(
            outcome,
            after.exists.then_some(after.content),
            snapshot_id,
        ))
    }

    pub fn mcp_add(&self, request: &McpAddRequest) -> Result<McpResult, String> {
        let scope = mcp::scope_flag(request.scope);
        self.mcp_change(
            request.scope,
            &request.cwd,
            &["add-json", &request.name, &request.json, "-s", scope],
            true,
        )
    }

    pub fn mcp_remove(&self, request: &McpRemoveRequest) -> Result<McpResult, String> {
        let scope = mcp::scope_flag(request.scope);
        self.mcp_change(
            request.scope,
            &request.cwd,
            &["remove", &request.name, "-s", scope],
            false,
        )
    }

    /// `claude mcp list`, verbatim: it health-checks each server, and the
    /// wording of what it finds is the CLI's.
    pub fn mcp_list(&self, cwd: &str) -> McpResult {
        let cwd = normalize(Path::new(cwd));
        let outcome = command::run(&self.agent.command, &["mcp", "list"], Some(&cwd), MCP_LIMIT);
        mcp_result(outcome, Some(String::new()), None)
    }

    /// Approves or revokes a project's `.mcp.json` server in its
    /// `settings.local.json`, through the snapshot-first writer.
    pub fn mcp_approve(&self, request: &McpApproveRequest) -> Result<WriteConfigResult, String> {
        let scope = normalize(Path::new(&request.cwd));
        let file = scope.join(".claude").join("settings.local.json");
        self.change(
            |writer| {
                let current = read_file(&file);
                let content =
                    match mcp::approval(&current.content, &file, &request.name, request.approved) {
                        Ok(content) => content,
                        Err(error) => {
                            return Ok(WriteConfigResult {
                                ok: false,
                                file: current,
                                snapshot_id: None,
                                unchanged: false,
                                conflict: None,
                                error: Some(error),
                            });
                        }
                    };
                writer.write(&WriteConfigRequest {
                    scope_path: scope.display().to_string(),
                    path: file.display().to_string(),
                    content,
                    expected_hash: current.exists.then_some(current.hash),
                    reason: ConfigWriteReason::Approve,
                })
            },
            Self::written,
        )
    }

    pub fn doctor(&self) -> DoctorReport {
        doctor::run_doctor(&self.agent.command)
    }
}

fn mcp_result(outcome: RunOutcome, after: Option<String>, snapshot_id: Option<u64>) -> McpResult {
    let ok = outcome.succeeded();
    let output = if !ok && outcome.output.is_empty() {
        outcome
            .failure
            .clone()
            .unwrap_or_else(|| "The CLI failed.".to_owned())
    } else {
        outcome.output.clone()
    };
    McpResult {
        ok,
        output,
        exit_code: if ok { Some(0) } else { outcome.exit_code },
        after: after.unwrap_or_default(),
        snapshot_id,
    }
}

/// Who is told of an outside change to a watched file: the client watching
/// it, and the change.
pub fn change_sink(
    sink: impl Fn(ClientId, &ConfigExternalChange) + Send + Sync + 'static,
) -> ChangeSink {
    Box::new(sink)
}
