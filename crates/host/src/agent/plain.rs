//! A plain command: any CLI, given as a name and a command line, run as a
//! plain tab. It runs in a pty like any session and outlives its clients, and
//! it declares nothing beyond running: no status records, history, resume or
//! agent tools, because Floti cannot know where an unknown CLI keeps them.
//! Its status comes only from its program's own OSC 7501 reports, which the
//! host reads from every session's output. Of a harness it takes the folder
//! only. It moves no tool call to the background, supports no MCP tasks and
//! has no MCP tools, and it enforces no tool rule: asked to, it refuses
//! ([`AgentBackend::check_rules`]). It takes no turns, so it declares no input
//! ([`AgentBackend::input`]), unless it is built from a role that names a
//! submit word and a stop word ([`PlainCommandBackend::with_input_words`]).

use std::ffi::OsString;

use floti_protocol::BackendId;

use super::{AgentBackend, AgentInput, Launch, LaunchFolder, LaunchRequest, LaunchSpec};
use crate::{Error, Result};

/// A command line run as it is, in the session's folder.
#[derive(Debug, Clone)]
pub struct PlainCommandBackend {
    id: BackendId,
    name: String,
    program: OsString,
    args: Vec<OsString>,
    input: Option<AgentInput>,
}

impl PlainCommandBackend {
    /// A backend `id`, shown as `name`, that runs `program` with `args`.
    pub fn new(
        id: BackendId,
        name: impl Into<String>,
        program: impl Into<OsString>,
        args: impl IntoIterator<Item = impl Into<OsString>>,
    ) -> Self {
        Self {
            id,
            name: name.into(),
            program: program.into(),
            args: args.into_iter().map(Into::into).collect(),
            input: None,
        }
    }

    /// The same command line taking turns with the keys a role names: its
    /// `submit` and `stop` words (`enter`, `ctrl-c` and the like). A role
    /// without a submit word leaves it taking none.
    ///
    /// # Errors
    ///
    /// The sentence naming a word that is not a key.
    pub fn with_input_words(
        mut self,
        submit: Option<&str>,
        stop: Option<&str>,
    ) -> std::result::Result<Self, String> {
        self.input = AgentInput::from_words(submit, stop)?;
        Ok(self)
    }
}

impl AgentBackend for PlainCommandBackend {
    fn id(&self) -> &BackendId {
        &self.id
    }

    fn name(&self) -> &str {
        &self.name
    }

    fn input(&self) -> Option<AgentInput> {
        self.input.clone()
    }

    fn launch(&self, request: &LaunchRequest, folder: &LaunchFolder) -> Result<Launch> {
        if request.prompt.is_some() {
            return Err(Error::backend(&self.id, "take an opening prompt"));
        }
        // Nor can it be given a role's body, which it would run without.
        if request.composition.instructions.is_some() {
            return Err(Error::backend(&self.id, "take instructions"));
        }
        // It has no way to enforce a tool rule, so a launch that carries one
        // is refused rather than started without it.
        self.check_rules(&request.composition.tool_lists())?;
        let mut launch = Launch::plain(LaunchSpec {
            program: self.program.clone(),
            args: self.args.clone(),
            cwd: request.folder.clone(),
            env: Vec::new(),
            conversation_id: None,
            launch_folder: Some(folder.path().to_path_buf()),
        });
        // A plain tab gets the folder and nothing else: every part of a
        // harness its overlays hold is one it could not take.
        launch.not_taken = super::parts_not_taken(&self.harness(), &request.composition.overlays);
        Ok(launch)
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use floti_protocol::channels::common::PermissionMode;
    use floti_protocol::{BackendFeature, HarnessPart, Support};

    use super::*;
    use crate::agent::{Composition, ToolRules, ToolSupport};
    use crate::testkit::TestDirs;

    fn backend() -> PlainCommandBackend {
        PlainCommandBackend::new(
            BackendId::new("my-cli"),
            "My CLI",
            "my cli.exe",
            ["--flag", "two words"],
        )
    }

    #[test]
    fn declares_running_and_nothing_else() {
        let descriptor = backend().capabilities();
        assert_eq!(descriptor.id, BackendId::new("my-cli"));
        assert_eq!(descriptor.name, "My CLI");
        for feature in BackendFeature::ALL {
            let expected = if feature == BackendFeature::Run {
                Support::Declared
            } else {
                Support::Unknown
            };
            assert_eq!(descriptor.support(feature), expected, "{feature:?}");
        }
        assert!(descriptor.harness.takes.is_empty());
        assert_eq!(descriptor.harness.cannot_take, HarnessPart::ALL.to_vec());
    }

    #[test]
    fn launches_the_command_line_as_given_in_the_session_folder() {
        let dirs = TestDirs::new();
        let launch_folder = LaunchFolder::create(&dirs.data).unwrap();
        let folder = PathBuf::from("C:/work/a project");
        let launch = backend()
            .launch(
                &LaunchRequest {
                    folder: folder.clone(),
                    ..LaunchRequest::default()
                },
                &launch_folder,
            )
            .unwrap();
        assert_eq!(
            launch.spec,
            LaunchSpec {
                program: "my cli.exe".into(),
                args: vec!["--flag".into(), "two words".into()],
                cwd: folder,
                env: vec![],
                conversation_id: None,
                launch_folder: Some(launch_folder.path().to_path_buf()),
            }
        );
        assert!(launch.not_taken.is_empty());
    }

    #[test]
    fn a_harness_reaches_it_as_its_folder_only_and_the_launch_names_the_rest() {
        let dirs = TestDirs::new();
        let harness = dirs.folder("harness");
        std::fs::write(harness.join("AGENTS.md"), "x").unwrap();
        std::fs::create_dir_all(harness.join(".claude").join("commands")).unwrap();
        let launch = backend()
            .launch(
                &LaunchRequest {
                    folder: harness.clone(),
                    composition: Composition {
                        overlays: vec![harness],
                        ..Composition::default()
                    },
                    ..LaunchRequest::default()
                },
                &LaunchFolder::create(&dirs.data).unwrap(),
            )
            .unwrap();
        assert_eq!(
            launch.not_taken,
            vec![HarnessPart::Instructions, HarnessPart::Commands]
        );
    }

    #[test]
    fn it_takes_no_turns_until_its_role_names_the_keys() {
        assert_eq!(backend().input(), None);

        let taking = backend()
            .with_input_words(Some("enter"), Some("ctrl-c"))
            .unwrap();
        let input = taking.input().expect("its role names the keys");
        assert_eq!(input.submit, b"\r");
        assert_eq!(input.stop.as_deref(), Some(&b"\x03"[..]));

        let no_submit = backend().with_input_words(None, Some("ctrl-c")).unwrap();
        assert_eq!(no_submit.input(), None, "no submit word, no turns");

        let refused = backend()
            .with_input_words(Some("hit it"), None)
            .expect_err("not a key");
        assert!(refused.contains("hit it is not a key"), "{refused}");
    }

    #[test]
    fn it_moves_no_call_to_the_background_supports_no_mcp_tasks_and_has_no_mcp_tools() {
        assert_eq!(
            backend().tool_support(),
            ToolSupport {
                backgrounds_long_calls: false,
                background_command_wakes: false,
                mcp_tasks: false,
                mcp_tools: false,
            }
        );
    }

    #[test]
    fn it_enforces_no_rule_and_refuses_each_naming_the_rule_and_the_backend() {
        let backend = backend();
        let refused = |rules: ToolRules| {
            backend
                .check_rules(&rules)
                .expect_err("the rule is refused")
                .to_string()
        };
        assert_eq!(
            refused(ToolRules {
                permission_mode: Some(PermissionMode::Plan),
                ..ToolRules::default()
            }),
            "my-cli cannot enforce the permission mode plan"
        );
        assert_eq!(
            refused(ToolRules {
                allowed_tools: vec!["Read".into()],
                ..ToolRules::default()
            }),
            "my-cli cannot enforce the allowed_tools rule Read"
        );
        assert_eq!(
            refused(ToolRules {
                disallowed_tools: vec!["Bash(rm:*)".into()],
                ..ToolRules::default()
            }),
            "my-cli cannot enforce the disallowed_tools rule Bash(rm:*)"
        );
        // No rule at all is nothing to enforce.
        backend.check_rules(&ToolRules::default()).unwrap();

        // A launch carrying a tool list is refused, not started without it;
        // a permission mode alone is not a reason to stop an ordinary tab.
        let dirs = TestDirs::new();
        let launch_folder = LaunchFolder::create(&dirs.data).unwrap();
        let request = |composition: Composition| LaunchRequest {
            folder: "C:/work".into(),
            composition,
            ..LaunchRequest::default()
        };
        let err = backend
            .launch(
                &request(Composition {
                    disallowed_tools: vec!["Edit".into()],
                    ..Composition::default()
                }),
                &launch_folder,
            )
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            "my-cli cannot enforce the disallowed_tools rule Edit"
        );
        backend
            .launch(
                &request(Composition {
                    permission_mode: Some(PermissionMode::Plan),
                    ..Composition::default()
                }),
                &launch_folder,
            )
            .unwrap();
    }

    #[test]
    fn refuses_an_opening_prompt() {
        let dirs = TestDirs::new();
        let err = backend()
            .launch(
                &LaunchRequest {
                    folder: "C:/work".into(),
                    prompt: Some("hello".into()),
                    ..LaunchRequest::default()
                },
                &LaunchFolder::create(&dirs.data).unwrap(),
            )
            .unwrap_err();
        assert_eq!(err.to_string(), "my-cli cannot take an opening prompt");
        assert!(backend().resumer().is_none());
    }

    #[test]
    fn refuses_a_roles_body_naming_the_backend_and_takes_neither_instructions_nor_an_effort() {
        let dirs = TestDirs::new();
        let err = backend()
            .launch(
                &LaunchRequest {
                    folder: "C:/work".into(),
                    composition: Composition {
                        instructions: Some(crate::agent::RoleInstructions {
                            role: "reviewer".into(),
                            body: "Read first.".into(),
                        }),
                        ..Composition::default()
                    },
                    ..LaunchRequest::default()
                },
                &LaunchFolder::create(&dirs.data).unwrap(),
            )
            .unwrap_err();
        assert_eq!(err.to_string(), "my-cli cannot take instructions");
        assert!(!backend().takes_instructions());
        assert!(!backend().takes_effort());
    }
}
