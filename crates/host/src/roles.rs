//! Roles: what a session that starts a child of its own may ask for by name.
//!
//! A role says which backends may run the child (in order of preference), the
//! permission mode, the tools it may use without asking and the ones it may
//! never use, whether it may start children of its own, and the profile it
//! runs under. Rules are written once, in the spelling [`ToolRules`] documents,
//! and each backend's adapter translates them or refuses.
//!
//! Roles come from a [`RoleSource`] that is read on every start, so a change
//! to a role reaches the next child and no running one. The host has no named
//! roles of its own: the source it is built with names none, and the default
//! role every start falls back to ([`default_role`]) is made from the backends
//! the host has.
//!
//! [`ToolRules`]: crate::agent::ToolRules

use std::sync::Arc;

use floti_protocol::BackendId;
use floti_protocol::channels::common::PermissionMode;

use crate::agent::AgentBackend;

/// The name of the role a start without one gets.
pub const DEFAULT_ROLE: &str = "agent";

/// One role.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Role {
    /// What it is called, and what its children are named by default.
    pub name: String,
    /// The backends that may run its children, in the order they are tried.
    pub backends: Vec<BackendId>,
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
}

impl Role {
    /// A role `name` that lets `backends` run its children and asks for
    /// nothing else.
    pub fn new(name: impl Into<String>, backends: impl IntoIterator<Item = BackendId>) -> Self {
        Self {
            name: name.into(),
            backends: backends.into_iter().collect(),
            permission: None,
            allowed_tools: Vec::new(),
            disallowed_tools: Vec::new(),
            can_start: false,
            profile: None,
        }
    }
}

/// Where roles come from. Read on every start.
pub trait RoleSource: Send + Sync {
    /// The role called `name`, or `None` when there is none.
    fn role(&self, name: &str) -> Option<Role>;

    /// The names of every role, for a refusal that says what there is.
    fn names(&self) -> Vec<String>;
}

/// The host's source until roles can be written: it names none.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoRoles;

impl RoleSource for NoRoles {
    fn role(&self, _name: &str) -> Option<Role> {
        None
    }

    fn names(&self) -> Vec<String> {
        Vec::new()
    }
}

/// A fixed list of roles.
#[derive(Debug, Clone, Default)]
pub struct FixedRoles(pub Vec<Role>);

impl RoleSource for FixedRoles {
    fn role(&self, name: &str) -> Option<Role> {
        self.0
            .iter()
            .find(|role| role.name.eq_ignore_ascii_case(name))
            .cloned()
    }

    fn names(&self) -> Vec<String> {
        self.0.iter().map(|role| role.name.clone()).collect()
    }
}

/// The role a start without one gets: every agent backend the host has except
/// a plain command, in the host's order, with no rules of its own, that may
/// not start children.
pub fn default_role(backends: &[Arc<dyn AgentBackend>]) -> Role {
    Role::new(
        DEFAULT_ROLE,
        backends
            .iter()
            .filter(|backend| !is_plain_command(backend.as_ref()))
            .map(|backend| backend.id().clone()),
    )
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::PlainCommandBackend;
    use crate::testkit::{OtherAgent, TestDirs};

    #[test]
    fn the_default_role_lists_every_agent_backend_but_a_plain_command_in_host_order() {
        let dirs = TestDirs::new();
        let other = OtherAgent::new(&dirs);
        let backends: Vec<Arc<dyn AgentBackend>> = vec![
            Arc::new(PlainCommandBackend::new(
                BackendId::new("shell"),
                "Shell",
                "sh",
                ["-c", "true"],
            )),
            Arc::new(other.backend()),
        ];
        let role = default_role(&backends);
        assert_eq!(role.name, "agent");
        assert_eq!(role.backends, [BackendId::new("other-agent")]);
        assert_eq!(role.permission, None);
        assert!(role.allowed_tools.is_empty() && role.disallowed_tools.is_empty());
        assert!(!role.can_start);
    }

    #[test]
    fn a_fixed_source_finds_a_role_by_name_whatever_the_case() {
        let source = FixedRoles(vec![Role::new("Reviewer", [BackendId::new("a")])]);
        assert!(source.role("reviewer").is_some());
        assert!(source.role("tester").is_none());
        assert_eq!(source.names(), ["Reviewer"]);
        assert!(NoRoles.role("reviewer").is_none());
    }
}
