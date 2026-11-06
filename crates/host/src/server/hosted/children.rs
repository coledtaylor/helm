//! Children: the sessions an agent starts, lists and stops through the
//! floti-agents tools, and what binds their lifetimes to their parents'.
//!
//! **Everything here works with no client attached.** A child is started by
//! the host for a session that asked, not by a client; nothing is attached to
//! it, it opens no tab, and a client quitting reaches it only through its
//! parent.
//!
//! **A start is judged before anything runs.** In this order: the role, the
//! backend the role allows and the host has, the folder (tracked, on the
//! path it leads to), the profile, the permission mode (never above the
//! parent's), the backend's ability to enforce every rule, then the limits
//! read afresh from the settings. Only a start that passes all of it spawns a
//! process. Starts are taken one at a time, so two calls cannot both pass a
//! limit that only one fits under.
//!
//! **A child's row carries its links** (parent row, parent conversation,
//! name, role, outlive, can_start), written when the session is. Counts and
//! names come from those rows, so they hold across a host restart, and a
//! parent that is resumed in its conversation finds its outliving children
//! again.
//!
//! **Lifetimes follow the parent.** When a session ends, however it ends, the
//! children it did not start to outlive it end, and theirs with them
//! ([`end_children_at_exit`]); a host that starts after parents ended while
//! it was away ends the children they left ([`Hosted::end_orphans`]).

mod folders;
mod rows;

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock, Weak};
use std::time::Duration;

use floti_protocol::BackendId;
use floti_protocol::channels::common::PermissionMode;
use tokio::sync::broadcast::{self, error::RecvError};

use super::{Hosted, Plan, lock};
use crate::agent::{AgentBackend, AgentToolServer};
use crate::roles::{DEFAULT_ROLE, NoRoles, Role, RoleSource, default_role};
use crate::server::floti_agents::FAMILY;
use crate::server::records::{self, ExitNotice};
use crate::session::{ParentLink, SessionId, SessionOrigin, TermSize};
use crate::workspace::settings;

/// How long ending a child waits for it to be reported ended.
const STOP_WAIT: Duration = Duration::from_secs(5);

/// The size a child's terminal starts at: no client is attached to it, and the
/// first one to attach resizes it.
const CHILD_SIZE: (u16, u16) = (120, 32);

/// The variable that carries a session's token for `floti agent`.
const TOKEN_VAR: &str = "FLOTI_AGENT_TOKEN";

/// The variable that carries the address of the agents family.
const URL_VAR: &str = "FLOTI_AGENT_URL";

/// What the host keeps to start children: where roles come from, where the
/// `floti` executable is, and the one lock that takes starts one at a time.
pub(super) struct Children {
    roles: RwLock<Arc<dyn RoleSource>>,
    /// The folder holding the `floti` executable, put first on a session's
    /// PATH so that `floti agent` is found there.
    floti_dir: RwLock<Option<PathBuf>>,
    /// The PATH the host's sessions inherit.
    inherited_path: Option<OsString>,
    starting: Mutex<()>,
}

impl Children {
    pub(super) fn new(inherited_env: &[(OsString, OsString)]) -> Self {
        Self {
            roles: RwLock::new(Arc::new(NoRoles)),
            floti_dir: RwLock::new(
                std::env::current_exe()
                    .ok()
                    .and_then(|exe| exe.parent().map(PathBuf::from)),
            ),
            inherited_path: inherited_env
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case("PATH"))
                .map(|(_, value)| value.clone()),
            starting: Mutex::new(()),
        }
    }

    /// `path` (the PATH the session would have) with the folder of the `floti`
    /// executable first.
    fn path_with_floti(&self, path: Option<&OsString>) -> Option<OsString> {
        let dir = self
            .floti_dir
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()?;
        let rest = path.map(std::env::split_paths).into_iter().flatten();
        std::env::join_paths(std::iter::once(dir).chain(rest)).ok()
    }

    fn roles(&self) -> Arc<dyn RoleSource> {
        Arc::clone(
            &self
                .roles
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }
}

/// What `agents_start` asks for.
#[derive(Debug, Clone, Default)]
pub(crate) struct StartChild {
    pub task: String,
    pub role: Option<String>,
    pub backend: Option<String>,
    pub folder: Option<String>,
    pub profile: Option<String>,
    pub name: Option<String>,
    pub outlive: bool,
    pub can_start: Option<bool>,
}

/// What `agents_start` answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChildStarted {
    pub name: String,
    pub backend: String,
    pub folder: String,
    pub branch: Option<String>,
}

/// One running child, as `agents_list` shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChildEntry {
    pub name: String,
    pub role: Option<String>,
    pub backend: String,
    pub state: String,
    pub since: String,
    pub folder: String,
    pub branch: Option<String>,
    pub outlive: bool,
    pub can_start: bool,
}

/// What is left of the limits a session starts children under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LimitsLeft {
    pub children_per_parent: u32,
    pub children_left: u32,
    pub starts_per_parent: u32,
    pub starts_left: u32,
    pub sessions_per_host: u32,
    pub host_left: u32,
    pub depth: u32,
    /// Why the session cannot start children at all, when it cannot.
    pub cannot_start: Option<String>,
}

/// What `agents_list` answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChildrenListed {
    pub children: Vec<ChildEntry>,
    pub limits: LimitsLeft,
}

/// What `agents_stop` answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChildStopped {
    pub name: String,
    /// The names of the agents below it that ended with it.
    pub also: Vec<String>,
}

impl Hosted {
    /// Reads roles from `roles` from now on.
    pub(crate) fn use_roles(&self, roles: Arc<dyn RoleSource>) {
        *self
            .children
            .roles
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = roles;
    }

    /// Puts `exe`'s folder on the PATH of the sessions that start from now
    /// on.
    pub(crate) fn use_floti(&self, exe: &std::path::Path) {
        if let Some(dir) = exe.parent() {
            *self
                .children
                .floti_dir
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(dir.to_path_buf());
        }
    }

    /// Adds to a session's environment what a launch given the agents family
    /// needs for `floti agent`: its token and the family's address, and the
    /// PATH with the `floti` executable's folder first. Nothing for a launch
    /// without the family.
    pub(super) fn give_agent_env(
        &self,
        env: &mut Vec<(OsString, OsString)>,
        servers: &[AgentToolServer],
    ) {
        let Some(server) = servers.iter().find(|server| server.name == FAMILY) else {
            return;
        };
        let path = env
            .iter()
            .rev()
            .find(|(name, _)| name.eq_ignore_ascii_case("PATH"))
            .map(|(_, value)| value.clone())
            .or_else(|| self.children.inherited_path.clone());
        set_env(env, TOKEN_VAR, OsString::from(&server.token));
        set_env(env, URL_VAR, OsString::from(&server.url));
        if let Some(path) = self.children.path_with_floti(path.as_ref()) {
            set_env(env, "PATH", path);
        }
    }

    /// Starts a child of `parent` on `request`, or says why it cannot: the
    /// sentence a model reads.
    ///
    /// # Errors
    ///
    /// A sentence naming what was refused. Nothing has started then.
    pub(crate) fn start_child(
        &self,
        parent: SessionId,
        request: StartChild,
    ) -> Result<ChildStarted, String> {
        // One start at a time: the limits are counted and then spent.
        let _starting = lock(&self.children.starting);
        if self.sessions.get(parent).is_none() {
            return Err("Your session has ended, so it starts no more agents.".to_owned());
        }
        let facts =
            rows::parent_facts(&self.ledger.store(), parent).map_err(|err| err.to_string())?;

        let role = self.role_for(request.role.as_deref())?;
        let backend = self.backend_for(&role, request.backend.as_deref())?;
        let base = PathBuf::from(&facts.cwd);
        let folder = folders::child_folder(
            &self.ledger.shared_store(),
            &base,
            request.folder.as_deref(),
        )?;
        let profile = {
            let store = self.ledger.store();
            let profiles = rows::profiles(&store).map_err(|err| err.to_string())?;
            match request.profile.as_deref().or(role.profile.as_deref()) {
                Some(named) => Some(folders::profile_named(&profiles, named)?),
                None => folders::profile_holding(&store, &folder).map_err(|err| err.to_string())?,
            }
        };

        let mode = capped(
            role.permission
                .or_else(|| profile.as_ref().and_then(|profile| profile.permission_mode)),
            facts.permission_mode,
        );
        let mut composition = super::composition_of(profile.as_ref());
        composition.permission_mode = mode;
        composition.allowed_tools.clone_from(&role.allowed_tools);
        composition
            .disallowed_tools
            .clone_from(&role.disallowed_tools);
        backend
            .check_rules(&composition.tool_rules())
            .map_err(|err| format!("{err}, so no agent was started."))?;

        let can_start = request.can_start.unwrap_or(role.can_start);
        let (name, limits_error) = {
            let store = self.ledger.store();
            let settings = settings::read(store.connection()).map_err(|err| err.to_string())?;
            let existing = rows::children_of(&store, parent, facts.conversation_id.as_deref())
                .map_err(|err| err.to_string())?;
            let host_running = self.agent_sessions_running(&store)?;
            let running: Vec<&rows::ChildRow> = existing
                .iter()
                .filter(|child| child.running && self.sessions.get(child.id).is_some())
                .collect();
            let limits_error = judge(
                &settings,
                &facts,
                &running,
                existing.len(),
                &existing,
                &host_running,
            )
            .err();
            let wanted = request.name.as_deref().unwrap_or(&role.name);
            (
                unique_child_name(wanted, existing.iter().map(|child| child.name.as_str())),
                limits_error,
            )
        };
        if let Some(refusal) = limits_error {
            return Err(refusal);
        }

        let folder_text = folder.display().to_string();
        let outlive = request.outlive;
        let backend_id = backend.id().clone();
        let launched = self.run(
            Plan {
                backend,
                folder,
                name: name.clone(),
                prompt: Some(request.task),
                composition,
                resume: None,
                origin: SessionOrigin {
                    project_path: self.known_project(&folder_text),
                    profile_id: profile.as_ref().and_then(|p| i64::try_from(p.id).ok()),
                    permission_mode: mode.map(records::permission_mode_name),
                    branch: None,
                    parent: Some(ParentLink {
                        session: parent,
                        conversation_id: facts.conversation_id.clone(),
                        name: name.clone(),
                        role: Some(role.name.clone()),
                        outlive,
                        can_start,
                    }),
                },
            },
            TermSize::new(CHILD_SIZE.0, CHILD_SIZE.1),
            None,
        )?;

        // The parent may have ended while this started, after the exit
        // notice that would have ended the child had already been handled.
        let child = launched.session.id;
        if !outlive && !self.parent_runs(parent) {
            if let Some(session) = super::session_id(child).and_then(|id| self.sessions.get(id))
                && let Err(err) = session.end_now()
            {
                log_line!("floti host: {err}");
            }
            return Err(
                "Your session ended while the agent was starting, so the agent ended with it."
                    .to_owned(),
            );
        }
        Ok(ChildStarted {
            name,
            backend: backend_id_text(&backend_id),
            folder: launched.session.cwd,
            branch: launched.session.branch,
        })
    }

    /// `parent`'s running children and what is left of its limits.
    ///
    /// # Errors
    ///
    /// A sentence when the host's record cannot be read.
    pub(crate) fn list_children(&self, parent: SessionId) -> Result<ChildrenListed, String> {
        let store = self.ledger.store();
        let facts = rows::parent_facts(&store, parent).map_err(|err| err.to_string())?;
        let settings = settings::read(store.connection()).map_err(|err| err.to_string())?;
        let existing = rows::children_of(&store, parent, facts.conversation_id.as_deref())
            .map_err(|err| err.to_string())?;
        let host_running = self.agent_sessions_running(&store)?;
        let mut children = Vec::new();
        for child in &existing {
            let Some(session) = self.sessions.get(child.id).filter(|_| child.running) else {
                continue;
            };
            let state = session
                .reported_status()
                .map_or_else(|| "running".to_owned(), |status| state_word(&status));
            children.push(ChildEntry {
                name: child.name.clone(),
                role: child.role.clone(),
                backend: child.backend.clone(),
                state,
                since: child.started_at.clone(),
                folder: child.cwd.clone(),
                branch: child.branch.clone(),
                outlive: child.outlive,
                can_start: child.can_start,
            });
        }
        let running = u32::try_from(children.len()).unwrap_or(u32::MAX);
        let made = u32::try_from(existing.len()).unwrap_or(u32::MAX);
        let on_host = u32::try_from(host_running.len()).unwrap_or(u32::MAX);
        Ok(ChildrenListed {
            children,
            limits: LimitsLeft {
                children_per_parent: settings.agent_children_per_parent,
                children_left: settings.agent_children_per_parent.saturating_sub(running),
                starts_per_parent: settings.agent_starts_per_parent,
                starts_left: settings.agent_starts_per_parent.saturating_sub(made),
                sessions_per_host: settings.agent_sessions_per_host,
                host_left: settings.agent_sessions_per_host.saturating_sub(on_host),
                depth: settings.agent_depth,
                cannot_start: depth_refusal(&settings, &facts),
            },
        })
    }

    /// Ends `parent`'s running child called `name` and every agent below it.
    /// A name that is not one of `parent`'s running children is not found:
    /// nothing else is looked at.
    ///
    /// # Errors
    ///
    /// A sentence when `name` is not one of `parent`'s running children.
    pub(crate) fn stop_child(&self, parent: SessionId, name: &str) -> Result<ChildStopped, String> {
        let (target, below) = {
            let store = self.ledger.store();
            let facts = rows::parent_facts(&store, parent).map_err(|err| err.to_string())?;
            let existing = rows::children_of(&store, parent, facts.conversation_id.as_deref())
                .map_err(|err| err.to_string())?;
            let running: Vec<&rows::ChildRow> = existing
                .iter()
                .filter(|child| child.running && self.sessions.get(child.id).is_some())
                .collect();
            let Some(target) = running
                .iter()
                .find(|child| child.name.eq_ignore_ascii_case(name.trim()))
            else {
                return Err(not_found(name, &running));
            };
            let below = rows::descendants(&store, target.id).map_err(|err| err.to_string())?;
            (target.id, below)
        };
        let target_name = self.child_name(target).unwrap_or_else(|| name.to_owned());
        let mut ending: Vec<(SessionId, String)> = below
            .into_iter()
            .filter(|child| child.running)
            .map(|child| (child.id, child.name))
            .collect();
        let also: Vec<String> = ending.iter().map(|(_, name)| name.clone()).collect();
        ending.push((target, target_name.clone()));
        let sessions: Vec<_> = ending
            .iter()
            .filter_map(|(id, _)| self.sessions.get(*id))
            .collect();
        for session in &sessions {
            if let Err(err) = session.end_now() {
                log_line!("floti host: {err}");
            }
        }
        for session in &sessions {
            session.wait_exit(STOP_WAIT);
        }
        Ok(ChildStopped {
            name: target_name,
            also,
        })
    }

    /// Ends the children of `parent` that were not started to outlive it.
    pub(crate) fn end_children_of(&self, parent: SessionId) {
        let children = match rows::ending_with(&self.ledger.store(), parent) {
            Ok(children) => children,
            Err(err) => {
                log_line!("floti host: {err}");
                return;
            }
        };
        for session in children.iter().filter_map(|id| self.sessions.get(*id)) {
            if let Err(err) = session.end_now() {
                log_line!("floti host: {err}");
            }
        }
    }

    /// Ends every running child whose parent is not running and which was not
    /// started to outlive it, then the children of those, until none is left:
    /// the children a parent left when it ended while no host was there to end
    /// them.
    pub(crate) fn end_orphans(&self) {
        // A chain is as deep as the depth limit allows, which is bounded.
        for _ in 0..16 {
            let orphans = match rows::orphans(&self.ledger.store()) {
                Ok(orphans) => orphans,
                Err(err) => {
                    log_line!("floti host: {err}");
                    return;
                }
            };
            let sessions: Vec<_> = orphans
                .iter()
                .filter_map(|id| self.sessions.get(*id))
                .collect();
            if sessions.is_empty() {
                return;
            }
            for session in &sessions {
                if let Err(err) = session.end_now() {
                    log_line!("floti host: {err}");
                }
            }
            for session in &sessions {
                session.wait_exit(STOP_WAIT);
            }
        }
    }

    /// `session` is in `conversation_id`, which an earlier session was in when
    /// it started children that still run: they are `session`'s again.
    pub(super) fn readopt_children(&self, session: SessionId, conversation_id: &str) {
        match rows::readopt(&self.ledger.store(), session, conversation_id) {
            Ok(adopted) if !adopted.is_empty() => {
                log_line!(
                    "floti host: session {session} was given back {} agent(s) it had started",
                    adopted.len()
                );
            }
            Ok(_) => {}
            Err(err) => log_line!("floti host: {err}"),
        }
    }

    /// The profile that turns the agents family off for a launch, when its
    /// profile does: the families to leave out of its grant.
    pub(super) fn families_off_for(&self, profile_id: Option<i64>) -> Vec<&'static str> {
        let off = profile_id
            .and_then(|id| u64::try_from(id).ok())
            .and_then(|id| {
                records::read_profile(&self.ledger.store(), id)
                    .ok()
                    .flatten()
            })
            .is_some_and(|profile| profile.session_agents == Some(false));
        if off { vec![FAMILY] } else { Vec::new() }
    }

    fn parent_runs(&self, parent: SessionId) -> bool {
        self.sessions.get(parent).is_some()
            && rows::is_running(&self.ledger.store(), parent).unwrap_or(false)
    }

    fn child_name(&self, id: SessionId) -> Option<String> {
        self.ledger
            .store()
            .connection()
            .query_row(
                "SELECT child_name FROM sessions WHERE id = ?1",
                [id.0],
                |row| row.get(0),
            )
            .ok()
    }

    /// The agent-started sessions running on this host now.
    fn agent_sessions_running(
        &self,
        store: &crate::store::Store,
    ) -> Result<Vec<SessionId>, String> {
        Ok(rows::agent_sessions_running(store)
            .map_err(|err| err.to_string())?
            .into_iter()
            .filter(|id| self.sessions.get(*id).is_some())
            .collect())
    }

    /// The role a start asks for, read now: the default role when it names
    /// none.
    fn role_for(&self, asked: Option<&str>) -> Result<Role, String> {
        let roles = self.children.roles();
        match asked {
            None => Ok(roles
                .role(DEFAULT_ROLE)
                .unwrap_or_else(|| default_role(&self.backends))),
            Some(name) => roles
                .role(name)
                .or_else(|| {
                    name.eq_ignore_ascii_case(DEFAULT_ROLE)
                        .then(|| default_role(&self.backends))
                })
                .ok_or_else(|| {
                    let mut names = vec![DEFAULT_ROLE.to_owned()];
                    names.extend(
                        roles
                            .names()
                            .into_iter()
                            .filter(|known| !known.eq_ignore_ascii_case(DEFAULT_ROLE)),
                    );
                    format!(
                        "There is no role named {name}. The roles are: {}.",
                        names.join(", ")
                    )
                }),
        }
    }

    /// The backend a child runs on: the one asked for when the role lists it
    /// and the host has it, else the first the role lists that the host has.
    fn backend_for(
        &self,
        role: &Role,
        asked: Option<&str>,
    ) -> Result<Arc<dyn AgentBackend>, String> {
        let allowed: Vec<&Arc<dyn AgentBackend>> = role
            .backends
            .iter()
            .filter_map(|id| self.find_backend(id))
            .collect();
        let installed: Vec<String> = allowed
            .iter()
            .map(|backend| backend_id_text(backend.id()))
            .collect();
        match asked {
            Some(asked) => allowed
                .iter()
                .find(|backend| backend.id().as_str().eq_ignore_ascii_case(asked))
                .map(|backend| Arc::clone(backend))
                .ok_or_else(|| {
                    format!(
                        "The role {} does not allow the backend {asked} on this host. The installed backends it allows: {}.",
                        role.name,
                        or_none(&installed)
                    )
                }),
            None => allowed
                .first()
                .map(|backend| Arc::clone(backend))
                .ok_or_else(|| {
                    let listed: Vec<String> =
                        role.backends.iter().map(backend_id_text).collect();
                    format!(
                        "None of the backends the role {} lists is installed on this host (it lists: {}).",
                        role.name,
                        or_none(&listed)
                    )
                }),
        }
    }
}

/// Sets `name` to `value` in `env`, replacing a variable of that name however
/// it is cased.
fn set_env(env: &mut Vec<(OsString, OsString)>, name: &str, value: OsString) {
    env.retain(|(existing, _)| !existing.eq_ignore_ascii_case(name));
    env.push((OsString::from(name), value));
}

fn backend_id_text(id: &BackendId) -> String {
    id.as_str().to_owned()
}

fn or_none(list: &[String]) -> String {
    if list.is_empty() {
        "none".to_owned()
    } else {
        list.join(", ")
    }
}

/// The word for what a program last reported about itself.
fn state_word(status: &crate::session::ReportedStatus) -> String {
    format!("{:?}", status.report.state).to_lowercase()
}

/// `requested`, lowered to what `parent` runs in where that is stricter. From
/// the strictest: plan, don't ask, manual, accept edits, auto, bypass
/// permissions. A session with no mode runs in manual; a child asking for no
/// mode gets the agent's own default, which is manual, unless the parent is
/// stricter than that.
pub(super) fn capped(
    requested: Option<PermissionMode>,
    parent: Option<PermissionMode>,
) -> Option<PermissionMode> {
    let ceiling = parent.unwrap_or(PermissionMode::Manual);
    match requested {
        Some(requested) if strictness(requested) <= strictness(ceiling) => Some(requested),
        Some(_) => Some(ceiling),
        None if strictness(ceiling) < strictness(PermissionMode::Manual) => Some(ceiling),
        None => None,
    }
}

fn strictness(mode: PermissionMode) -> u8 {
    match mode {
        PermissionMode::Plan => 0,
        PermissionMode::DontAsk => 1,
        PermissionMode::Manual => 2,
        PermissionMode::AcceptEdits => 3,
        PermissionMode::Auto => 4,
        PermissionMode::BypassPermissions => 5,
    }
}

/// A child's name: `wanted` made into one word, and made unique among the
/// names `taken` by a number after it (`agent`, `agent-2`).
fn unique_child_name<'a>(wanted: &str, taken: impl IntoIterator<Item = &'a str>) -> String {
    let taken: Vec<String> = taken.into_iter().map(str::to_lowercase).collect();
    let word: String = wanted
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
        .chars()
        .filter(|c| !c.is_control())
        .take(40)
        .collect();
    let base = if word.is_empty() {
        DEFAULT_ROLE.to_owned()
    } else {
        word
    };
    if !taken.contains(&base.to_lowercase()) {
        return base;
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|candidate| !taken.contains(&candidate.to_lowercase()))
        .unwrap_or(base)
}

/// What a name that is none of the caller's running children is answered.
fn not_found(name: &str, running: &[&rows::ChildRow]) -> String {
    let names: Vec<&str> = running.iter().map(|child| child.name.as_str()).collect();
    if names.is_empty() {
        format!("No agent of yours is named {name}: you have no running agents.")
    } else {
        format!(
            "No agent of yours is named {name}. Your running agents are: {}.",
            names.join(", ")
        )
    }
}

/// Why a session at this depth cannot start children, when it cannot.
fn depth_refusal(
    settings: &floti_protocol::channels::workspace::HostSettings,
    facts: &rows::ParentFacts,
) -> Option<String> {
    let limit = settings.agent_depth;
    if facts.depth >= limit {
        return Some(format!(
            "The depth limit of {limit} holds: you are {} (depth {}), and agents nest no deeper than {limit}. Do the work yourself.",
            facts.child_name.as_deref().map_or_else(
                || "a session".to_owned(),
                |name| format!("the agent {name}")
            ),
            facts.depth
        ));
    }
    if facts.depth >= 1 && !facts.can_start {
        return Some(format!(
            "The depth limit of {limit} holds: you are an agent that was started without can_start, so you cannot start agents of your own. Do the work yourself."
        ));
    }
    None
}

/// Whether a start is within every limit; a sentence naming the limit and
/// what holds it when it is not.
fn judge(
    settings: &floti_protocol::channels::workspace::HostSettings,
    facts: &rows::ParentFacts,
    running: &[&rows::ChildRow],
    starts_made: usize,
    made: &[rows::ChildRow],
    host_running: &[SessionId],
) -> Result<(), String> {
    if let Some(refusal) = depth_refusal(settings, facts) {
        return Err(refusal);
    }
    let per_parent = settings.agent_children_per_parent as usize;
    if running.len() >= per_parent {
        let names: Vec<&str> = running.iter().map(|child| child.name.as_str()).collect();
        return Err(format!(
            "The limit of {per_parent} running agents per parent holds: you have {} running ({}). Wait for news from them and start again.",
            running.len(),
            names.join(", ")
        ));
    }
    let per_host = settings.agent_sessions_per_host as usize;
    if host_running.len() >= per_host {
        let mine: Vec<&str> = running.iter().map(|child| child.name.as_str()).collect();
        let yours = if mine.is_empty() {
            "none of them yours".to_owned()
        } else {
            format!("{} of them yours ({})", mine.len(), mine.join(", "))
        };
        return Err(format!(
            "The limit of {per_host} agent sessions running on this host holds: {} are running, {yours}. Wait for news and start again.",
            host_running.len()
        ));
    }
    let per_life = settings.agent_starts_per_parent as usize;
    if starts_made >= per_life {
        let names: Vec<&str> = made.iter().map(|child| child.name.as_str()).collect();
        return Err(format!(
            "The limit of {per_life} starts per parent holds: you have made {starts_made} starts ({}). Wait for news and start again.",
            names.join(", ")
        ));
    }
    Ok(())
}

/// Ends the children of each session as it ends, from the records' exit
/// notices, until the host's sessions are gone. Holds the host weakly.
pub(crate) async fn end_children_at_exit(
    mut exits: broadcast::Receiver<ExitNotice>,
    hosted: Weak<Hosted>,
) {
    loop {
        let received = exits.recv().await;
        let Some(hosted) = hosted.upgrade() else {
            return;
        };
        match received {
            Ok(notice) => {
                let _ = tokio::task::spawn_blocking(move || {
                    hosted.end_children_of(notice.session);
                })
                .await;
            }
            // Missed notices: every child whose parent is gone ends.
            Err(RecvError::Lagged(_)) => {
                let _ = tokio::task::spawn_blocking(move || hosted.end_orphans()).await;
            }
            Err(RecvError::Closed) => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use PermissionMode::*;

    #[test]
    fn a_child_never_runs_above_its_parents_mode() {
        // The order, strictest first.
        let order = [Plan, DontAsk, Manual, AcceptEdits, Auto, BypassPermissions];
        for (at, parent) in order.iter().enumerate() {
            for (asked_at, asked) in order.iter().enumerate() {
                let got = capped(Some(*asked), Some(*parent));
                assert_eq!(
                    got,
                    Some(order[at.min(asked_at)]),
                    "{asked:?} under {parent:?}"
                );
            }
        }
    }

    #[test]
    fn no_mode_counts_as_manual_on_both_sides() {
        assert_eq!(capped(Some(Auto), None), Some(Manual));
        assert_eq!(capped(Some(Plan), None), Some(Plan));
        // The agent's own default is manual, which only a stricter parent lowers.
        assert_eq!(capped(None, None), None);
        assert_eq!(capped(None, Some(Manual)), None);
        assert_eq!(capped(None, Some(Auto)), None);
        assert_eq!(capped(None, Some(Plan)), Some(Plan));
        assert_eq!(capped(None, Some(DontAsk)), Some(DontAsk));
    }

    #[test]
    fn names_are_one_word_and_unique_among_the_callers_children() {
        assert_eq!(unique_child_name("agent", []), "agent");
        assert_eq!(unique_child_name("agent", ["agent"]), "agent-2");
        assert_eq!(unique_child_name("agent", ["Agent", "agent-2"]), "agent-3");
        assert_eq!(unique_child_name("code reviewer", []), "code-reviewer");
        assert_eq!(unique_child_name("   ", []), "agent");
    }
}
