//! Roles: what a session that starts a child of its own may ask for by name.
//!
//! A role says which backends may run the child (in order of preference), the
//! model and effort for each, the permission mode, the tools it may use without
//! asking and the ones it may never use, whether it may start children of its
//! own, its resource class, whether it works in a worktree of its own, and the
//! profile it runs under. Its body is instructions, composed into the child's
//! own and never typed. Rules are written once, in the spelling
//! [`ToolRules`] documents, and each backend's adapter translates them or
//! refuses.
//!
//! Roles come from a [`RoleSource`] that is read on every start and every
//! listing, so a change to a role reaches the next child and no running one.
//! The host's source is [`FolderRoles`]: one `<name>.md` file per role in the
//! roles folder of its config folder ([`folder::roles_folder`]), which is the
//! user's to edit. The shipped `reviewer`, `worker` and `lead` are written
//! there at host start only when the folder is absent ([`seed`]). The default
//! role every start without one falls back to ([`default_role`]) is made from
//! the backends the host has, unless a file named `agent.md` replaces it.
//!
//! A file that cannot be a role is never skipped quietly: it is named with its
//! problem in every listing, and a start naming it is refused naming the file
//! and the problem, because a typo must never drop a rule.
//!
//! [`ToolRules`]: crate::agent::ToolRules

pub mod folder;
pub mod parse;
pub mod seed;

use std::collections::BTreeMap;
use std::sync::Arc;

use floti_protocol::BackendId;
use floti_protocol::channels::common::PermissionMode;
use floti_protocol::channels::sessions::EffortLevel;

use crate::agent::{AgentBackend, ToolRules};

pub use folder::{FolderRoles, roles_folder};

/// The name of the role a start without one gets.
pub const DEFAULT_ROLE: &str = "agent";

/// How much of a host a role's children use, for the limit on heavy work.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum RoleClass {
    /// Ordinary work: any number run at once, within the other limits.
    #[default]
    Light,
    /// An Android emulator, an end-to-end stack, a dev build of an app,
    /// packaging or a full test suite: one runs on a host at a time.
    Heavy,
}

impl RoleClass {
    /// The word a role file and the tools use.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Light => "light",
            Self::Heavy => "heavy",
        }
    }

    /// The class a row records, or light for anything else.
    pub fn from_word(word: &str) -> Self {
        if word.eq_ignore_ascii_case("heavy") {
            Self::Heavy
        } else {
            Self::Light
        }
    }
}

/// One role.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Role {
    /// What it is called, and what its children are named by default.
    pub name: String,
    /// What it is for, in a sentence.
    pub description: String,
    /// The backends that may run its children, in the order they are tried.
    /// Empty means every installed agent backend except a plain command line,
    /// in the host's order.
    pub backends: Vec<BackendId>,
    /// The model each backend runs it with, keyed by backend id.
    pub models: BTreeMap<String, String>,
    /// The effort each backend runs it with, keyed by backend id. Only a
    /// backend whose agent has an effort setting can be given one.
    pub efforts: BTreeMap<String, EffortLevel>,
    /// The permission mode its children ask for, before the parent's mode caps
    /// it.
    pub permission: Option<PermissionMode>,
    /// Tools its children use without asking.
    pub allowed_tools: Vec<String>,
    /// Tools its children never use.
    pub disallowed_tools: Vec<String>,
    /// Whether its children may start children of their own.
    pub can_start: bool,
    /// The name of the profile its children run under, when it names one.
    pub profile: Option<String>,
    /// How much of the host it uses.
    pub class: RoleClass,
    /// Whether its children work in a worktree of their own.
    pub worktree: bool,
    /// For a plain command line: the command to run.
    pub command: Option<String>,
    /// For a plain command line: how a task is submitted to it.
    pub submit: Option<String>,
    /// For a plain command line: how it is stopped.
    pub stop: Option<String>,
    /// Instructions composed into its children's own, never typed.
    pub instructions: String,
}

impl Role {
    /// A role `name` that lets `backends` run its children and asks for
    /// nothing else.
    pub fn new(name: impl Into<String>, backends: impl IntoIterator<Item = BackendId>) -> Self {
        Self {
            name: name.into(),
            description: String::new(),
            backends: backends.into_iter().collect(),
            models: BTreeMap::new(),
            efforts: BTreeMap::new(),
            permission: None,
            allowed_tools: Vec::new(),
            disallowed_tools: Vec::new(),
            can_start: false,
            profile: None,
            class: RoleClass::Light,
            worktree: false,
            command: None,
            submit: None,
            stop: None,
            instructions: String::new(),
        }
    }

    /// The model the role gives for `backend`.
    pub fn model_for(&self, backend: &BackendId) -> Option<&str> {
        keyed(&self.models, backend).map(String::as_str)
    }

    /// The effort the role gives for `backend`.
    pub fn effort_for(&self, backend: &BackendId) -> Option<EffortLevel> {
        keyed(&self.efforts, backend).copied()
    }

    /// The role's rules for a launch in `mode`, written once.
    pub fn rules(&self, mode: Option<PermissionMode>) -> ToolRules {
        ToolRules {
            permission_mode: mode,
            allowed_tools: self.allowed_tools.clone(),
            disallowed_tools: self.disallowed_tools.clone(),
        }
    }

    /// The backends of `host` that may run this role's children, in the order
    /// the role prefers them: the ones it lists that the host has, or every
    /// agent backend but a plain command line when it lists none.
    pub fn backends_on<'a>(
        &self,
        host: &'a [Arc<dyn AgentBackend>],
    ) -> Vec<&'a Arc<dyn AgentBackend>> {
        if self.backends.is_empty() {
            return host
                .iter()
                .filter(|backend| !is_plain_command(backend.as_ref()))
                .collect();
        }
        self.backends
            .iter()
            .filter_map(|id| {
                host.iter()
                    .find(|backend| backend.id().as_str().eq_ignore_ascii_case(id.as_str()))
            })
            .collect()
    }

    /// Why `backend` cannot run this role's children in `mode`, as a
    /// fragment of a sentence, or `None` when it can: its adapter enforces
    /// the role's permission and tool rules, it has an effort setting where
    /// the role gives it an effort, and it takes instructions where the role
    /// has a body. A plain command line takes no task, so none can.
    pub fn refusal_on(
        &self,
        backend: &dyn AgentBackend,
        mode: Option<PermissionMode>,
    ) -> Option<String> {
        if is_plain_command(backend) {
            return Some(format!(
                "{} runs a plain command line, which takes no task",
                backend.id()
            ));
        }
        if let Err(err) = backend.check_rules(&self.rules(mode)) {
            return Some(err.to_string());
        }
        if self.effort_for(backend.id()).is_some() && !backend.takes_effort() {
            return Some(format!(
                "The role {} gives an effort for {}, which has no effort setting",
                self.name,
                backend.id()
            ));
        }
        if !self.instructions.is_empty() && !backend.takes_instructions() {
            return Some(format!(
                "The role {} has instructions, which {} cannot take",
                self.name,
                backend.id()
            ));
        }
        None
    }
}

/// The value keyed by `backend`, whatever the case of the key.
fn keyed<'a, V>(map: &'a BTreeMap<String, V>, backend: &BackendId) -> Option<&'a V> {
    map.iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(backend.as_str()))
        .map(|(_, value)| value)
}

/// A role file that cannot be used, and what is wrong with it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BadRole {
    /// The file's name, such as `reviewer.md`.
    pub file: String,
    /// What is wrong with it, as a sentence fragment.
    pub problem: String,
}

impl BadRole {
    /// The sentence a refused start gives.
    pub fn refusal(&self) -> String {
        format!(
            "The role file {} cannot be used: {}. Fix it and start again; no agent was started.",
            self.file, self.problem
        )
    }

    /// The sentence a refused reopen gives.
    pub fn reopen_refusal(&self) -> String {
        format!(
            "The role file {} cannot be used: {}. Fix it and reopen the session again; it was not reopened.",
            self.file, self.problem
        )
    }
}

/// Every role there is at one moment: the good ones in name order, then the
/// files that are not roles.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RoleListing {
    pub roles: Vec<Role>,
    pub bad: Vec<BadRole>,
}

/// What looking a role up by name found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoleLookup {
    Found(Box<Role>),
    /// The role's file exists and cannot be used.
    Bad(BadRole),
    Missing,
}

/// Where roles come from. Read on every start and every listing.
pub trait RoleSource: Send + Sync {
    /// Every role and every unusable file, as they are now.
    fn listing(&self) -> RoleListing;

    /// The role called `name`, whatever the case, as it is now.
    fn lookup(&self, name: &str) -> RoleLookup {
        let listing = self.listing();
        if let Some(role) = listing
            .roles
            .into_iter()
            .find(|role| role.name.eq_ignore_ascii_case(name))
        {
            return RoleLookup::Found(Box::new(role));
        }
        listing
            .bad
            .into_iter()
            .find(|bad| bad.file.eq_ignore_ascii_case(&format!("{name}.md")))
            .map_or(RoleLookup::Missing, RoleLookup::Bad)
    }
}

/// A source that names no role.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoRoles;

impl RoleSource for NoRoles {
    fn listing(&self) -> RoleListing {
        RoleListing::default()
    }
}

/// A fixed list of roles.
#[derive(Debug, Clone, Default)]
pub struct FixedRoles(pub Vec<Role>);

impl RoleSource for FixedRoles {
    fn listing(&self) -> RoleListing {
        RoleListing {
            roles: self.0.clone(),
            bad: Vec::new(),
        }
    }
}

/// The role a start without one gets: every agent backend the host has except
/// a plain command, in the host's order, with no rules of its own, that may
/// not start children.
pub fn default_role(backends: &[Arc<dyn AgentBackend>]) -> Role {
    let mut role = Role::new(
        DEFAULT_ROLE,
        backends
            .iter()
            .filter(|backend| !is_plain_command(backend.as_ref()))
            .map(|backend| backend.id().clone()),
    );
    role.description =
        "What a start without a role gets: any installed agent, no rules of its own.".to_owned();
    role
}

/// Whether `backend` is a plain command line, which declares nothing beyond
/// running: no resume, no records, no tools, no history. It takes no opening
/// prompt, so it is not an agent a task can be handed to.
pub fn is_plain_command(backend: &dyn AgentBackend) -> bool {
    backend.resumer().is_none()
        && backend.status().is_none()
        && backend.agent_tools().is_none()
        && backend.permissions().is_none()
        && backend.history().is_none()
}

/// Whether `name` can be a role's name: lowercase letters, digits and
/// hyphens.
pub fn is_role_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

#[cfg(test)]
mod tests;
