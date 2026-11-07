//! What a role adds to a child's launch: its model and effort for the backend
//! the child runs on, its permission, its tool rules and its body.
//!
//! The role's profile has already been chosen (or the folder's); what the
//! profile gives is the base, and the role's own choices replace it.

use floti_protocol::channels::common::PermissionMode;
use floti_protocol::channels::sessions::Profile;

use crate::agent::{AgentBackend, Composition, RoleInstructions};
use crate::roles::Role;

/// The composition of a child of `role` on `backend`, in `mode` (the role's
/// permission or the profile's, already lowered to the parent's), or the
/// reason the backend cannot run it, as a fragment of a sentence.
///
/// # Errors
///
/// Why `backend` cannot run the role: its adapter cannot enforce a rule,
/// there is an effort and no effort setting, or there is a body and no way to
/// take it.
pub(super) fn role_composition(
    role: &Role,
    backend: &dyn AgentBackend,
    profile: Option<&Profile>,
    mode: Option<PermissionMode>,
) -> Result<Composition, String> {
    if let Some(reason) = role.refusal_on(backend, mode) {
        return Err(reason);
    }
    let mut composition = super::super::composition_of(profile);
    composition.permission_mode = mode;
    if let Some(model) = role.model_for(backend.id()) {
        composition.model = Some(model.to_owned());
    }
    if let Some(effort) = role.effort_for(backend.id()) {
        composition.effort = Some(effort);
    }
    composition.allowed_tools.clone_from(&role.allowed_tools);
    composition
        .disallowed_tools
        .clone_from(&role.disallowed_tools);
    let body = role.instructions.trim();
    if !body.is_empty() {
        composition.instructions = Some(RoleInstructions {
            role: role.name.clone(),
            body: body.to_owned(),
        });
    }
    Ok(composition)
}

/// The separator between the names in a Remote Control line.
const LINE_SEPARATOR: &str = " \u{203a} ";

/// What a child gets of its parent's Remote Control.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct InheritedRemoteControl {
    /// The name the child runs Remote Control under: its parent's line and
    /// its own name. `None` when its parent has none, or its backend has no
    /// Remote Control.
    pub name: Option<String>,
    /// The parent has Remote Control and the child's backend has none, so the
    /// child runs without and the start's answer says so.
    pub backend_has_none: bool,
}

/// The Remote Control a child called `child` gets on `backend`, when its
/// parent runs it under `parent` (`None` when Floti did not launch the parent
/// with it). A grandchild's line is its whole line of parents.
pub(super) fn inherited_remote_control(
    parent: Option<&str>,
    child: &str,
    backend: &dyn AgentBackend,
) -> InheritedRemoteControl {
    let Some(parent) = parent else {
        return InheritedRemoteControl::default();
    };
    if backend.remote_control() {
        InheritedRemoteControl {
            name: Some(format!("{parent}{LINE_SEPARATOR}{child}")),
            backend_has_none: false,
        }
    } else {
        InheritedRemoteControl {
            name: None,
            backend_has_none: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use floti_protocol::BackendId;
    use floti_protocol::channels::sessions::EffortLevel;

    use super::*;
    use crate::agent::PlainCommandBackend;
    use crate::agent::claude_code::{ClaudeCodeBackend, ClaudeCodeSettings};
    use crate::platform::process_tree;
    use crate::roles::parse::parse_role;
    use crate::testkit::{OtherAgent, TestDirs};

    fn claude(dirs: &TestDirs) -> ClaudeCodeBackend {
        ClaudeCodeBackend::new(
            ClaudeCodeSettings {
                program: "node".into(),
                leading_args: Vec::new(),
                config_dir: dirs.home.join(".claude"),
                pass_config_dir: true,
                api_key_set: false,
                search_first: Vec::new(),
            },
            Arc::new(process_tree::Native),
        )
    }

    fn role(source: &str) -> Role {
        parse_role("tuned", source).expect("a good role")
    }

    fn profile(model: &str, effort: EffortLevel, mode: PermissionMode) -> Profile {
        Profile {
            id: 4,
            name: "Acme".into(),
            root: "C:/work".into(),
            overlays: vec!["C:/work/harness".into()],
            access: vec!["C:/work/shared".into()],
            model: Some(model.to_owned()),
            effort: Some(effort),
            permission_mode: Some(mode),
            agent: None,
            mcp: Vec::new(),
            opening_prompt: None,
            pinned_order: None,
            session_agents: None,
            remote_control: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    const TUNED: &str = "---\n\
        model:\n  claude-code: opus\n  other-agent: small\n\
        effort:\n  claude-code: max\n\
        allowed_tools: Read\n\
        disallowed_tools: Edit\n\
        ---\n\
        Work carefully.\n";

    #[test]
    fn the_roles_choices_for_the_backend_replace_the_profiles_and_the_rest_of_the_profile_stays() {
        let dirs = TestDirs::new();
        let profile = profile(
            "profile-model",
            EffortLevel::Low,
            PermissionMode::AcceptEdits,
        );
        let composition = role_composition(
            &role(TUNED),
            &claude(&dirs),
            Some(&profile),
            Some(PermissionMode::Plan),
        )
        .expect("claude-code can run it");
        assert_eq!(composition.model.as_deref(), Some("opus"));
        assert_eq!(composition.effort, Some(EffortLevel::Max));
        assert_eq!(composition.permission_mode, Some(PermissionMode::Plan));
        assert_eq!(composition.allowed_tools, ["Read"]);
        assert_eq!(composition.disallowed_tools, ["Edit"]);
        let body = composition.instructions.expect("the body");
        assert_eq!(
            (body.role.as_str(), body.body.as_str()),
            ("tuned", "Work carefully.")
        );
        // What the profile gave and the role did not stays.
        assert_eq!(
            composition.overlays,
            [std::path::PathBuf::from("C:/work/harness")]
        );
        assert_eq!(
            composition.extra_folders,
            [std::path::PathBuf::from("C:/work/shared")]
        );
    }

    #[test]
    fn a_role_that_gives_nothing_leaves_the_profile_as_it_is_and_the_mode_is_the_one_passed() {
        let dirs = TestDirs::new();
        let profile = profile(
            "profile-model",
            EffortLevel::Low,
            PermissionMode::AcceptEdits,
        );
        let composition = role_composition(
            &role("---\n---\n"),
            &claude(&dirs),
            Some(&profile),
            Some(PermissionMode::AcceptEdits),
        )
        .unwrap();
        assert_eq!(composition.model.as_deref(), Some("profile-model"));
        assert_eq!(composition.effort, Some(EffortLevel::Low));
        assert_eq!(
            composition.permission_mode,
            Some(PermissionMode::AcceptEdits)
        );
        assert!(composition.allowed_tools.is_empty() && composition.disallowed_tools.is_empty());
        // No body: no instructions of the role's.
        assert_eq!(composition.instructions, None);

        let none = role_composition(&role("---\n---\n"), &claude(&dirs), None, None).unwrap();
        assert_eq!(none.model, None);
        assert_eq!(none.permission_mode, None);
    }

    #[test]
    fn a_body_of_only_whitespace_adds_no_instructions() {
        let dirs = TestDirs::new();
        let composition =
            role_composition(&role("---\n---\n  \n\n"), &claude(&dirs), None, None).unwrap();
        assert_eq!(composition.instructions, None);
    }

    #[test]
    fn the_other_agent_gets_its_own_model_and_cannot_be_given_the_effort_or_a_disallow_rule() {
        let dirs = TestDirs::new();
        let other = OtherAgent::new(&dirs).backend();
        assert_eq!(other.id(), &BackendId::new("other-agent"));
        let small = role("---\nmodel:\n  other-agent: small\n---\nBody.\n");
        let composition = role_composition(&small, &other, None, None).unwrap();
        assert_eq!(composition.model.as_deref(), Some("small"));
        assert!(composition.instructions.is_some());

        let refused =
            role_composition(&role(TUNED), &other, None, None).expect_err("it cannot run it");
        assert!(refused.contains("disallowed_tools rule Edit"), "{refused}");
        assert!(refused.contains("other-agent"), "{refused}");
        let efforty = role("---\neffort:\n  other-agent: high\n---\n");
        let refused = role_composition(&efforty, &other, None, None).expect_err("no effort");
        assert!(
            refused.contains("effort") && refused.contains("other-agent"),
            "{refused}"
        );
    }

    #[test]
    fn a_child_runs_remote_control_under_its_parents_line_and_its_own_name() {
        let dirs = TestDirs::new();
        let claude = claude(&dirs);
        let top = inherited_remote_control(Some("api-refactor"), "worker", &claude);
        assert_eq!(top.name.as_deref(), Some("api-refactor \u{203a} worker"));
        assert!(!top.backend_has_none);
        // Its own child gets the whole line.
        let deeper = inherited_remote_control(top.name.as_deref(), "helper", &claude);
        assert_eq!(
            deeper.name.as_deref(),
            Some("api-refactor \u{203a} worker \u{203a} helper")
        );
    }

    #[test]
    fn a_parent_without_remote_control_gives_none_and_says_nothing_of_it() {
        let dirs = TestDirs::new();
        let inherited = inherited_remote_control(None, "worker", &claude(&dirs));
        assert_eq!(inherited, InheritedRemoteControl::default());
        let other = OtherAgent::new(&dirs).backend();
        assert_eq!(
            inherited_remote_control(None, "worker", &other),
            InheritedRemoteControl::default()
        );
    }

    #[test]
    fn a_backend_without_remote_control_starts_the_child_without_it_and_says_so() {
        let dirs = TestDirs::new();
        let other = OtherAgent::new(&dirs).backend();
        assert!(!other.remote_control());
        let inherited = inherited_remote_control(Some("api-refactor"), "worker", &other);
        assert_eq!(inherited.name, None);
        assert!(inherited.backend_has_none);
    }

    #[test]
    fn a_plain_command_line_cannot_run_a_role_at_all() {
        let plain = PlainCommandBackend::new(
            BackendId::new("my-cli"),
            "My CLI",
            "my-cli",
            Vec::<String>::new(),
        );
        let refused = role_composition(&role("---\n---\n"), &plain, None, None)
            .expect_err("a plain command takes no task");
        assert!(refused.contains("my-cli"), "{refused}");
    }
}
