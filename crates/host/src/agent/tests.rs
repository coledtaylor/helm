//! The trait's own rules: what a backend declares follows from the parts it
//! has, an undeclared part answers Unknown, versions are checked without
//! blocking, and a launch names the parts of a harness it could not take.

use std::path::PathBuf;

use floti_protocol::{BackendFeature, BackendId, HarnessPart, HarnessSupport, Knowable, Support};

use super::*;
use crate::testkit::TestDirs;

/// The smallest backend there is: it runs a program and declares nothing
/// else.
struct RunOnly {
    id: BackendId,
}

impl RunOnly {
    fn new() -> Self {
        Self {
            id: BackendId::new("run-only"),
        }
    }
}

impl AgentBackend for RunOnly {
    fn id(&self) -> &BackendId {
        &self.id
    }

    fn name(&self) -> &str {
        "Run only"
    }

    fn launch(&self, request: &LaunchRequest, folder: &LaunchFolder) -> Result<Launch> {
        Ok(Launch::plain(LaunchSpec {
            program: "run-only".into(),
            args: Vec::new(),
            cwd: request.folder.clone(),
            env: Vec::new(),
            conversation_id: None,
            launch_folder: Some(folder.path().to_path_buf()),
        }))
    }
}

/// A backend with instructions and skills but no equivalent for commands,
/// subagents or workflows, as an agent without slash commands is.
struct SkillsOnly {
    id: BackendId,
}

impl AgentBackend for SkillsOnly {
    fn id(&self) -> &BackendId {
        &self.id
    }

    fn name(&self) -> &str {
        "Skills only"
    }

    fn harness(&self) -> HarnessSupport {
        HarnessSupport::taking(
            ["AGENTS.md"],
            [HarnessPart::Instructions, HarnessPart::Skills],
        )
    }

    fn launch(&self, request: &LaunchRequest, folder: &LaunchFolder) -> Result<Launch> {
        let mut launch = RunOnly::new().launch(request, folder)?;
        launch.not_taken = parts_not_taken(&self.harness(), &request.composition.overlays);
        Ok(launch)
    }
}

#[test]
fn a_backend_that_only_runs_answers_unknown_to_every_other_question() {
    let backend = RunOnly::new();
    let session = SessionRef {
        pid: std::process::id(),
        conversation_id: None,
    };
    assert_eq!(backend.read_status(&session), Knowable::Unknown);
    assert_eq!(backend.read_conversations(), Knowable::Unknown);
    assert_eq!(backend.read_usage(1, 0), Knowable::Unknown);
    assert_eq!(backend.read_config_files(None), Knowable::Unknown);
    assert_eq!(backend.read_sign_in(), Knowable::Unknown);
    assert!(backend.resumer().is_none());
    assert!(backend.agent_tools().is_none());
    assert!(backend.permissions().is_none());
    assert!(backend.tested_range().is_none());
    assert!(backend.credential_paths().is_empty());
}

#[test]
fn a_backend_declares_exactly_the_parts_it_has() {
    let descriptor = RunOnly::new().capabilities();
    assert_eq!(descriptor.features, vec![BackendFeature::Run]);
    for feature in BackendFeature::ALL {
        let expected = if feature == BackendFeature::Run {
            Support::Declared
        } else {
            Support::Unknown
        };
        assert_eq!(descriptor.support(feature), expected, "{feature:?}");
    }
    // A plain tab takes the folder of a harness and nothing in it.
    assert_eq!(descriptor.harness, HarnessSupport::default());
    assert_eq!(descriptor.harness.cannot_take, HarnessPart::ALL.to_vec());
}

#[test]
fn a_backend_without_commands_or_subagents_names_them_and_its_launch_lists_what_it_could_not_take()
{
    let dirs = TestDirs::new();
    let harness = dirs.folder("harness");
    std::fs::write(harness.join("AGENTS.md"), "rules").unwrap();
    for part in ["skills/think", "commands", "agents"] {
        std::fs::create_dir_all(harness.join(".claude").join(part)).unwrap();
    }
    let backend = SkillsOnly {
        id: BackendId::new("skills-only"),
    };

    let descriptor = backend.capabilities();
    assert_eq!(descriptor.harness.instruction_files, vec!["AGENTS.md"]);
    assert_eq!(
        descriptor.harness.cannot_take,
        vec![
            HarnessPart::Commands,
            HarnessPart::Subagents,
            HarnessPart::Workflows
        ]
    );

    let launch = backend
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
    // The harness holds no workflows, so only what it holds is named.
    assert_eq!(
        launch.not_taken,
        vec![HarnessPart::Commands, HarnessPart::Subagents]
    );
}

#[test]
fn a_version_inside_the_range_passes_quietly_and_one_outside_warns_naming_it() {
    let range = TestedVersions {
        min: Version(2, 1, 277),
        below: Version(2, 2, 0),
    };
    assert_eq!(
        range.check("2.1.277 (Claude Code)\n"),
        VersionCheck::Tested(Version(2, 1, 277))
    );
    assert_eq!(
        range.check("2.1.999 (Claude Code)"),
        VersionCheck::Tested(Version(2, 1, 999))
    );
    for (output, version) in [
        ("2.1.276 (Claude Code)", Version(2, 1, 276)),
        ("2.2.0 (Claude Code)", Version(2, 2, 0)),
    ] {
        let VersionCheck::Untested {
            version: seen,
            warning,
        } = range.check(output)
        else {
            panic!("{output} is outside the range");
        };
        assert_eq!(seen, version);
        assert!(
            warning.contains("from 2.1.277 up to but not including 2.2.0")
                && warning.contains("still launch"),
            "{warning}"
        );
    }
}

#[test]
fn a_version_that_cannot_be_read_is_unknown() {
    let range = TestedVersions {
        min: Version(2, 1, 277),
        below: Version(2, 2, 0),
    };
    for output in ["", "Claude Code", "version 2.1", "v2..1.3"] {
        assert_eq!(range.check(output), VersionCheck::Unknown, "{output:?}");
    }
    assert_eq!(
        Version::find_in("build 12 of 2.1.300-beta"),
        Some(Version(2, 1, 300))
    );
}

#[test]
fn a_new_conversation_id_is_a_fresh_version_four_uuid() {
    let one = new_conversation_id();
    let two = new_conversation_id();
    assert_ne!(one, two);
    let groups: Vec<&str> = one.split('-').collect();
    assert_eq!(
        groups.iter().map(|group| group.len()).collect::<Vec<_>>(),
        vec![8, 4, 4, 4, 12]
    );
    assert!(groups[2].starts_with('4'));
    assert!(matches!(groups[3].as_bytes()[0], b'8' | b'9' | b'a' | b'b'));
}

#[test]
fn parts_not_taken_reads_every_overlay_and_names_each_part_once() {
    let dirs = TestDirs::new();
    let one = dirs.folder("one");
    let two = dirs.folder("two");
    std::fs::create_dir_all(one.join(".claude").join("commands")).unwrap();
    std::fs::create_dir_all(two.join(".claude").join("commands")).unwrap();
    std::fs::create_dir_all(two.join(".claude").join("workflows")).unwrap();
    let support = HarnessSupport::taking(["AGENTS.md"], [HarnessPart::Instructions]);
    assert_eq!(
        parts_not_taken(&support, &[one, two, PathBuf::from("not there")]),
        vec![HarnessPart::Commands, HarnessPart::Workflows]
    );
}
