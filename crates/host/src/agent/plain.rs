//! A plain command: any CLI, given as a name and a command line, run as a
//! plain tab. It runs in a pty like any session and outlives its clients, and
//! it declares nothing beyond running: no status, history, resume or agent
//! tools, because Floti cannot know where an unknown CLI keeps them. Of a
//! harness it takes the folder only.

use std::ffi::OsString;

use floti_protocol::BackendId;

use super::{AgentBackend, Launch, LaunchFolder, LaunchRequest, LaunchSpec};
use crate::{Error, Result};

/// A command line run as it is, in the session's folder.
#[derive(Debug, Clone)]
pub struct PlainCommandBackend {
    id: BackendId,
    name: String,
    program: OsString,
    args: Vec<OsString>,
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
        }
    }
}

impl AgentBackend for PlainCommandBackend {
    fn id(&self) -> &BackendId {
        &self.id
    }

    fn name(&self) -> &str {
        &self.name
    }

    fn launch(&self, request: &LaunchRequest, folder: &LaunchFolder) -> Result<Launch> {
        if request.prompt.is_some() {
            return Err(Error::backend(&self.id, "take an opening prompt"));
        }
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

    use floti_protocol::{BackendFeature, HarnessPart, Support};

    use super::*;
    use crate::agent::Composition;
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
}
