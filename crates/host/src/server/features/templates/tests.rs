//! `template:*` and `harness:create` as a client's requests reach them:
//! through the router of a host's features, over a store and a config
//! folder of their own, with Claude Code (the fake claude) as the agent whose
//! config console a template imports from. No agent is ever run.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use floti_protocol::channel::{RequestChannel, Router, from_payload, to_payload};
use floti_protocol::channels::workspace::{
    AppMode, CreateHarness, CreateHarnessOutcome, CreateHarnessRequest, CreateTemplate,
    CreateTemplateRequest, DeleteTemplate, HarnessMode, HostSettings, HostSettingsPatch,
    ImportIntoTemplate, ImportIntoTemplateRequest, ListTemplates, ReadTemplateDetail,
    RenameTemplate, RenameTemplateRequest, TemplateDeleteResult, TemplateDetail,
    TemplateImportResult, TemplateListing, TemplateMetadataRequest, TemplateRef,
    TemplateWriteResult, WriteSettings, WriteTemplateMetadata,
};
use floti_protocol::message::Request;
use floti_protocol::{CapabilitySet, Message};
use tokio::sync::broadcast;

use super::super::Features;
use crate::agent::AgentBackend;
use crate::agent::claude_code::{ClaudeCodeBackend, ClaudeCodeSettings};
use crate::platform::process_tree;
use crate::server::events::Publication;
use crate::server::hosted::Hosted;
use crate::server::{CATALOGUE, HostRun};
use crate::session::ClientId;
use crate::store::Store;
use crate::testkit::{FakeAgent, TestDirs, link_folder};
use crate::workspace::templates::seed::SHIPPED_TEMPLATES;

/// A host's features over a store of their own, with the shell-like fake
/// agent first and Claude Code second.
struct World {
    features: Features,
    /// Last: fields drop in order, and the folder goes only once nothing in it is open.
    dirs: TestDirs,
}

impl World {
    fn new() -> Self {
        Self::after(|_| {})
    }

    /// A host started once `prepare` has had the folders.
    fn after(prepare: impl FnOnce(&TestDirs)) -> Self {
        let dirs = TestDirs::new();
        prepare(&dirs);
        let claude = Arc::new(ClaudeCodeBackend::new(
            ClaudeCodeSettings {
                program: "node".into(),
                leading_args: Vec::new(),
                config_dir: dirs.home.join(".claude"),
                pass_config_dir: true,
                api_key_set: false,
                search_first: Vec::new(),
            },
            Arc::new(process_tree::Native),
        ));
        let backends: Vec<Arc<dyn AgentBackend>> = vec![
            Arc::new(FakeAgent::new("fake agent", &dirs).backend(Vec::<String>::new())),
            claude,
        ];
        let store = Arc::new(Mutex::new(Store::open(&dirs.data).unwrap()));
        let hosted = Arc::new(
            Hosted::new(store, dirs.data.clone(), backends, Vec::new(), Vec::new()).unwrap(),
        );
        let features = Features::new(
            hosted,
            dirs.folders(),
            HostRun {
                mode: AppMode::Dev,
                home: Some(dirs.home.clone()),
            },
        )
        .unwrap();
        Self { features, dirs }
    }

    fn ask<C: RequestChannel>(&self, request: &C::Request) -> Result<C::Response, String> {
        let mut router = Router::new(&CATALOGUE, CapabilitySet::default());
        self.features.requests(ClientId(1), &mut router);
        let answer = router.dispatch(&Request {
            id: 7,
            channel: C::NAME.to_owned(),
            payload: to_payload(request).unwrap(),
        });
        match answer {
            Message::Response(response) => Ok(from_payload(&response.payload).unwrap()),
            Message::Error(error) => Err(error.message),
            other => panic!("`{}` answered {other:?}", C::NAME),
        }
    }

    fn templates(&self) -> PathBuf {
        templates_of(&self.dirs)
    }

    fn listed(&self) -> Vec<(String, String, Option<String>)> {
        let listing: TemplateListing = self.ask::<ListTemplates>(&()).unwrap();
        listing
            .templates
            .into_iter()
            .filter(|choice| !choice.built_in)
            .map(|choice| (choice.id, choice.label, choice.description))
            .collect()
    }

    fn set_roots(&self, roots: &[&Path]) {
        let _: HostSettings = self
            .ask::<WriteSettings>(&HostSettingsPatch {
                scan_roots: Some(roots.iter().map(|root| text(root)).collect()),
                ..HostSettingsPatch::default()
            })
            .unwrap();
    }

    fn create_harness(&self, dir: &Path, name: &str) -> CreateHarnessOutcome {
        self.ask::<CreateHarness>(&CreateHarnessRequest {
            mode: HarnessMode::New,
            dir: text(dir),
            name: Some(name.into()),
            template: None,
        })
        .unwrap()
    }
}

fn templates_of(dirs: &TestDirs) -> PathBuf {
    dirs.config.join("templates")
}

fn text(path: &Path) -> String {
    path.display().to_string()
}

/// The scan roots in every `settings:changed` since the last call.
fn roots_heard(listener: &mut broadcast::Receiver<Publication>) -> Vec<Vec<String>> {
    let mut out = Vec::new();
    while let Ok(publication) = listener.try_recv() {
        if publication.channel == "settings:changed" {
            out.push(
                from_payload::<HostSettings>(&publication.payload)
                    .unwrap()
                    .scan_roots,
            );
        }
    }
    out
}

#[tokio::test]
async fn a_host_seeds_the_shipped_readme_and_example_into_a_templates_folder_that_is_absent() {
    let world = World::new();
    let dir = world.templates();
    for (relative, content) in SHIPPED_TEMPLATES {
        let file = relative
            .split('/')
            .fold(dir.clone(), |at, part| at.join(part));
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            *content,
            "{relative}"
        );
    }
    let listing: TemplateListing = world.ask::<ListTemplates>(&()).unwrap();
    let ids: Vec<&str> = listing
        .templates
        .iter()
        .map(|choice| choice.id.as_str())
        .collect();
    assert_eq!(ids, ["minimal", "example"]);
    assert_eq!(listing.dir, text(&dir));
    assert!(listing.problems.is_empty(), "{:?}", listing.problems);
}

#[tokio::test]
async fn a_host_writes_nothing_into_a_templates_folder_that_is_there_however_it_was_left() {
    // Empty, edited, and with the README deleted: the folder being there is
    // the whole test, so none of them is written to.
    let empty = World::after(|dirs| std::fs::create_dir_all(templates_of(dirs)).unwrap());
    assert_eq!(std::fs::read_dir(empty.templates()).unwrap().count(), 0);

    let edited = World::after(|dirs| {
        let dir = templates_of(dirs);
        std::fs::create_dir_all(dir.join("example")).unwrap();
        std::fs::write(dir.join("README.md"), "mine now").unwrap();
        std::fs::write(
            dir.join("example").join("template.yaml"),
            "label: \"Mine\"\n",
        )
        .unwrap();
    });
    let dir = edited.templates();
    assert_eq!(
        std::fs::read_to_string(dir.join("README.md")).unwrap(),
        "mine now"
    );
    assert_eq!(
        std::fs::read_to_string(dir.join("example").join("template.yaml")).unwrap(),
        "label: \"Mine\"\n"
    );
    assert!(!dir.join("example").join("CLAUDE.md.tpl").exists());

    let trimmed = World::after(|dirs| {
        let dir = templates_of(dirs);
        std::fs::create_dir_all(dir.join("example")).unwrap();
        std::fs::write(dir.join("example").join("CLAUDE.md.tpl"), "# {{NAME}}\n").unwrap();
    });
    assert!(!trimmed.templates().join("README.md").exists());
}

#[tokio::test]
async fn creates_describes_renames_and_deletes_a_template_in_the_folder_the_picker_reads() {
    let world = World::new();
    let created: TemplateWriteResult = world
        .ask::<CreateTemplate>(&CreateTemplateRequest {
            name: "draft".into(),
            label: None,
            description: None,
        })
        .unwrap();
    assert_eq!(
        created,
        TemplateWriteResult {
            ok: true,
            template: Some("draft".into()),
            problems: Vec::new()
        }
    );
    let files: Vec<String> = std::fs::read_dir(world.templates().join("draft"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(files, ["template.yaml"]);

    let described: TemplateWriteResult = world
        .ask::<WriteTemplateMetadata>(&TemplateMetadataRequest {
            template: "draft".into(),
            label: "Draft kit".into(),
            description: "For drafts.".into(),
        })
        .unwrap();
    assert!(described.ok, "{:?}", described.problems);
    let wanted = |id: &str| {
        (
            id.to_owned(),
            "Draft kit".to_owned(),
            Some("For drafts.".to_owned()),
        )
    };
    assert!(world.listed().contains(&wanted("draft")));

    let renamed: TemplateWriteResult = world
        .ask::<RenameTemplate>(&RenameTemplateRequest {
            template: "draft".into(),
            name: "final".into(),
        })
        .unwrap();
    assert_eq!(
        renamed,
        TemplateWriteResult {
            ok: true,
            template: Some("final".into()),
            problems: Vec::new()
        }
    );
    let after_rename = world.listed();
    assert!(after_rename.contains(&wanted("final")));
    assert!(!after_rename.iter().any(|(id, _, _)| id == "draft"));

    let detail: TemplateDetail = world
        .ask::<ReadTemplateDetail>(&TemplateRef {
            template: "final".into(),
        })
        .unwrap();
    assert_eq!(detail.label, "Draft kit");
    assert!(detail.has_manifest);

    let deleted: TemplateDeleteResult = world
        .ask::<DeleteTemplate>(&TemplateRef {
            template: "final".into(),
        })
        .unwrap();
    assert!(deleted.ok, "{:?}", deleted.problems);
    assert!(!world.templates().join("final").exists());
    assert!(!world.listed().iter().any(|(id, _, _)| id == "final"));
}

#[tokio::test]
async fn a_template_delete_unlinks_a_link_and_what_it_points_at_survives() {
    let world = World::new();
    let canary = world.dirs.folder("canary");
    std::fs::write(canary.join("do-not-touch.txt"), "untouched").unwrap();
    let _: TemplateWriteResult = world
        .ask::<CreateTemplate>(&CreateTemplateRequest {
            name: "hostile".into(),
            label: None,
            description: None,
        })
        .unwrap();
    link_folder(&canary, &world.templates().join("hostile").join("escape"));

    let deleted: TemplateDeleteResult = world
        .ask::<DeleteTemplate>(&TemplateRef {
            template: "hostile".into(),
        })
        .unwrap();

    assert!(deleted.ok, "{:?}", deleted.problems);
    assert!(!world.templates().join("hostile").exists());
    assert_eq!(
        std::fs::read_to_string(canary.join("do-not-touch.txt")).unwrap(),
        "untouched"
    );
}

#[tokio::test]
async fn offers_the_user_scope_to_copy_from_and_copies_a_skill_as_its_whole_folder() {
    let world = World::after(|dirs| {
        // A skill of the user's own, with a file bundled beside its SKILL.md.
        let skill = dirs.home.join(".claude").join("skills").join("think");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(
            skill.join("SKILL.md"),
            "---\nname: think\ndescription: Think it through.\n---\nUse {{NAME}} as written.\n",
        )
        .unwrap();
        std::fs::write(skill.join("reference.md"), "# reference\n").unwrap();
    });
    let claude = world.dirs.home.join(".claude");
    let skill = claude.join("skills").join("think");
    let _: TemplateWriteResult = world
        .ask::<CreateTemplate>(&CreateTemplateRequest {
            name: "kit".into(),
            label: None,
            description: None,
        })
        .unwrap();

    let result: TemplateImportResult = world
        .ask::<ImportIntoTemplate>(&ImportIntoTemplateRequest {
            template: "kit".into(),
            scope_path: text(&claude),
            paths: vec![text(&skill.join("SKILL.md"))],
        })
        .unwrap();

    assert!(result.problems.is_empty(), "{:?}", result.problems);
    let mut created = result.created.clone();
    created.sort();
    assert_eq!(
        created,
        [
            ".claude/skills/think/SKILL.md",
            ".claude/skills/think/reference.md"
        ]
    );
    let copied = world
        .templates()
        .join("kit")
        .join(".claude")
        .join("skills")
        .join("think");
    assert_eq!(
        std::fs::read(copied.join("SKILL.md")).unwrap(),
        std::fs::read(skill.join("SKILL.md")).unwrap()
    );
    assert_eq!(
        std::fs::read_to_string(copied.join("reference.md")).unwrap(),
        "# reference\n"
    );
}

#[tokio::test]
async fn an_import_of_a_file_the_scope_no_longer_lists_says_so_and_copies_nothing() {
    let world = World::new();
    let claude = world.dirs.home.join(".claude");
    let _: TemplateWriteResult = world
        .ask::<CreateTemplate>(&CreateTemplateRequest {
            name: "kit".into(),
            label: None,
            description: None,
        })
        .unwrap();

    let gone = claude.join("skills").join("gone").join("SKILL.md");
    let result: TemplateImportResult = world
        .ask::<ImportIntoTemplate>(&ImportIntoTemplateRequest {
            template: "kit".into(),
            scope_path: text(&claude),
            paths: vec![text(&gone)],
        })
        .unwrap();

    assert!(!result.ok);
    assert!(result.created.is_empty());
    assert_eq!(
        result.problems,
        [format!(
            "{} is not in User any more. Re-read the scope and try again.",
            text(&gone)
        )]
    );
}

#[tokio::test]
async fn a_new_harness_joins_the_scan_roots_and_every_settings_subscriber_hears_it() {
    let world = World::new();
    let elsewhere = world.dirs.folder("projects");
    world.set_roots(&[&elsewhere]);
    let parent = world.dirs.folder("harnesses");
    let mut listener = world.features.events().listen(ClientId(2));

    let outcome = world.create_harness(&parent, "work");

    let harness = text(&parent.join("work"));
    assert_eq!(outcome.path.as_deref(), Some(harness.as_str()));
    assert!(outcome.problems.is_empty(), "{:?}", outcome.problems);
    assert_eq!(outcome.roots, [text(&elsewhere), harness.clone()]);
    assert_eq!(
        roots_heard(&mut listener),
        [vec![text(&elsewhere), harness]]
    );
}

#[tokio::test]
async fn a_new_harness_under_a_scan_root_is_not_added_a_second_time() {
    let world = World::new();
    let parent = world.dirs.folder("harnesses");
    world.set_roots(&[&parent]);
    let mut listener = world.features.events().listen(ClientId(2));

    let outcome = world.create_harness(&parent, "work");

    assert!(outcome.path.is_some(), "{:?}", outcome.problems);
    assert_eq!(outcome.roots, [text(&parent)]);
    assert!(roots_heard(&mut listener).is_empty());
}

#[tokio::test]
async fn a_refused_harness_changes_no_roots_and_answers_the_roots_as_they_are() {
    let world = World::new();
    let parent = world.dirs.folder("harnesses");
    std::fs::create_dir(parent.join("work")).unwrap();
    let elsewhere = world.dirs.folder("projects");
    world.set_roots(&[&elsewhere]);
    let mut listener = world.features.events().listen(ClientId(2));

    let outcome = world.create_harness(&parent, "work");

    assert_eq!(outcome.path, None);
    assert_eq!(
        outcome.problems,
        [format!("{} already exists.", text(&parent.join("work")))]
    );
    assert_eq!(outcome.roots, [text(&elsewhere)]);
    assert!(roots_heard(&mut listener).is_empty());
}

#[tokio::test]
async fn a_harness_made_from_a_template_in_the_hosts_folder_carries_its_tree() {
    let world = World::new();
    let parent = world.dirs.folder("harnesses");

    let outcome: CreateHarnessOutcome = world
        .ask::<CreateHarness>(&CreateHarnessRequest {
            mode: HarnessMode::New,
            dir: text(&parent),
            name: Some("work".into()),
            template: Some("example".into()),
        })
        .unwrap();

    assert!(outcome.problems.is_empty(), "{:?}", outcome.problems);
    let claude_md = std::fs::read_to_string(parent.join("work").join("CLAUDE.md")).unwrap();
    assert!(claude_md.starts_with("# work\n"), "{claude_md}");
    assert!(parent.join("work").join(".claude").join("skills").is_dir());
}
