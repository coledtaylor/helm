//! `app:info`, `settings:*` and `setup:*` as a client's requests reach them:
//! through the router and the event channels of a host's features, with the
//! fake claude (`node test/fake-agents/claude-code.mjs`) as Claude Code and
//! never a real agent.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use floti_protocol::channel::{RequestChannel, Router, from_payload, to_payload};
use floti_protocol::channels::workspace::{
    AppInfo, AppMode, BackendStatus, CompleteSetup, ExecutableSource, HostSettings,
    HostSettingsPatch, LocateBackend, LocateBackendRequest, ReadAppInfo, ReadSettings,
    ReadSetupStatus, SetupStatus, WriteSettings,
};
use floti_protocol::message::Request;
use floti_protocol::{BackendId, CapabilitySet, Knowable, Message};
use tokio::sync::broadcast;

use super::super::Features;
use crate::agent::claude_code::{ClaudeCodeBackend, ClaudeCodeSettings};
use crate::agent::{AgentBackend, VersionCheck};
use crate::platform::launcher::{self, ProgramLauncher};
use crate::platform::process_tree;
use crate::server::events::{Publication, Start};
use crate::server::hosted::Hosted;
use crate::server::{CATALOGUE, HostRun};
use crate::session::ClientId;
use crate::store::{MIGRATIONS, Store};
use crate::testkit::{FakeAgent, TestDirs};

fn fake_claude() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("test")
        .join("fake-agents")
        .join("claude-code.mjs")
}

/// A host's features over a store of their own, with the shell-like fake
/// agent first and Claude Code (the fake claude through node) second.
struct World {
    features: Features,
    claude: Arc<ClaudeCodeBackend>,
    /// Last: fields drop in order, and the folder goes only once nothing in it is open.
    dirs: TestDirs,
}

impl World {
    fn new() -> Self {
        let dirs = TestDirs::new();
        let claude = Arc::new(ClaudeCodeBackend::new(
            ClaudeCodeSettings {
                program: "node".into(),
                leading_args: vec![fake_claude().into_os_string()],
                config_dir: dirs.home.join(".claude"),
                pass_config_dir: true,
                api_key_set: false,
                search_first: Vec::new(),
            },
            Arc::new(process_tree::Native),
        ));
        let backends: Vec<Arc<dyn AgentBackend>> = vec![
            Arc::new(FakeAgent::new("fake agent", &dirs).backend(Vec::<String>::new())),
            Arc::clone(&claude) as Arc<dyn AgentBackend>,
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
        Self {
            features,
            claude,
            dirs,
        }
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

    fn snapshot(&self) -> HostSettings {
        match self.features.events().start("settings:changed") {
            Some(Start::Snapshot { state, .. }) => from_payload(&state).unwrap(),
            other => panic!("settings:changed starts with its state, not {other:?}"),
        }
    }

    fn listen(&self, client: u64) -> broadcast::Receiver<Publication> {
        self.features.events().listen(ClientId(client))
    }

    fn claude_status(&self) -> BackendStatus {
        let status: SetupStatus = self.ask::<ReadSetupStatus>(&()).unwrap();
        status.backends[&BackendId::claude_code()].clone()
    }
}

/// Every settings published on `settings:changed` since the last call.
fn heard(listener: &mut broadcast::Receiver<Publication>) -> Vec<HostSettings> {
    let mut out = Vec::new();
    while let Ok(publication) = listener.try_recv() {
        if publication.channel == "settings:changed" {
            out.push(from_payload(&publication.payload).unwrap());
        }
    }
    out
}

fn node() -> PathBuf {
    launcher::Native
        .find("node".as_ref())
        .expect("node is on PATH, as the fake claude needs")
}

#[tokio::test]
async fn app_info_names_the_hosts_version_mode_data_folder_database_migrations_and_home() {
    let world = World::new();
    let info: AppInfo = world.ask::<ReadAppInfo>(&()).unwrap();
    assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
    assert_eq!(info.mode, AppMode::Dev);
    assert_eq!(info.data_dir, world.dirs.data.display().to_string());
    assert_eq!(
        info.db_file,
        world.dirs.data.join("floti.db").display().to_string()
    );
    assert_eq!(
        info.migrations,
        MIGRATIONS
            .iter()
            .map(|m| m.tag.to_owned())
            .collect::<Vec<_>>(),
        "a new store has every migration, in order"
    );
    assert_eq!(info.home, world.dirs.home.display().to_string());
    assert!(info.releases_url.starts_with("https://"));
    assert_eq!(
        info.windows_build.is_some(),
        crate::platform::startup::windows_build().is_some()
    );
}

#[tokio::test]
async fn every_settings_subscriber_gets_the_whole_settings_after_each_change() {
    let world = World::new();
    let mut first = world.listen(1);
    let mut second = world.listen(2);
    assert_eq!(world.snapshot(), crate::workspace::settings::defaults());

    let roots = vec![world.dirs.folder("projects").display().to_string()];
    let written: HostSettings = world
        .ask::<WriteSettings>(&HostSettingsPatch {
            scan_roots: Some(roots.clone()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(written.scan_roots, roots);
    let completed: HostSettings = world.ask::<CompleteSetup>(&()).unwrap();
    let stamp = completed
        .first_run_completed_at
        .clone()
        .expect("setup:complete stamps the time");
    assert!(stamp.parse::<jiff::Timestamp>().is_ok(), "{stamp}");
    assert_eq!(
        completed.scan_roots, roots,
        "the whole settings, not the change"
    );

    for listener in [&mut first, &mut second] {
        assert_eq!(heard(listener), vec![written.clone(), completed.clone()]);
    }
    assert_eq!(
        world.snapshot(),
        completed,
        "a later subscription starts with the latest"
    );
    assert_eq!(world.ask::<ReadSettings>(&()).unwrap(), completed);
}

#[tokio::test]
async fn a_malformed_setting_is_refused_with_the_validators_sentence_and_the_stored_value_kept() {
    let world = World::new();
    world
        .ask::<WriteSettings>(&HostSettingsPatch {
            transcript_archive_max_bytes: Some(4096),
            ..Default::default()
        })
        .unwrap();
    let mut listener = world.listen(1);

    let refused = world
        .ask::<WriteSettings>(&HostSettingsPatch {
            transcript_archive_max_bytes: Some(999),
            ..Default::default()
        })
        .unwrap_err();
    assert_eq!(
        refused,
        "settings rejected: transcriptArchiveMaxBytes: expected 1024 to 68719476736, got 999"
    );
    assert_eq!(
        world
            .ask::<ReadSettings>(&())
            .unwrap()
            .transcript_archive_max_bytes,
        4096
    );
    assert!(
        heard(&mut listener).is_empty(),
        "a refused write sends nothing"
    );
}

#[tokio::test]
async fn setup_reports_each_backends_executable_source_version_range_and_sign_in() {
    let world = World::new();
    let status: SetupStatus = world.ask::<ReadSetupStatus>(&()).unwrap();
    assert_eq!(
        status.backends.keys().cloned().collect::<Vec<_>>(),
        vec![BackendId::claude_code()],
        "a backend with no executable to find has no setup"
    );

    let claude = world.claude_status();
    assert!(claude.installed, "{claude:?}");
    assert_eq!(claude.source, Some(ExecutableSource::Discovered));
    assert_eq!(
        claude.path.as_deref().map(str::to_lowercase),
        Some(node().display().to_string().to_lowercase())
    );
    assert_eq!(claude.version.as_deref(), Some("2.1.999 (Claude Code)"));
    assert_eq!(claude.semver.as_deref(), Some("2.1.999"));
    assert!(claude.tested);
    assert_eq!(claude.tested_range.min, "2.1.277");
    assert_eq!(claude.tested_range.max, "2.2.0");
    assert_eq!(claude.error, None);
    let config_dir = world.dirs.home.join(".claude");
    assert_eq!(claude.config_dir, Some(config_dir.display().to_string()));
    assert!(!claude.config_dir_exists);
    assert_eq!(claude.signed_in, Knowable::Known(false));
    assert_eq!(
        claude.sign_in_signal,
        "Claude Code is not signed in. Run claude in a terminal and sign in."
    );

    // A sign-in artefact existing is a sign-in; nothing opens it.
    std::fs::create_dir_all(&config_dir).unwrap();
    std::fs::write(config_dir.join(".credentials.json"), "not read").unwrap();
    let claude = world.claude_status();
    assert!(claude.config_dir_exists);
    assert_eq!(claude.signed_in, Knowable::Known(true));
    assert_eq!(claude.sign_in_signal, ".credentials.json is present");
}

#[tokio::test(flavor = "multi_thread")]
async fn locates_a_cli_by_the_picker_stores_it_and_reports_its_own_version_until_it_is_cleared() {
    let world = World::new();
    let mut listener = world.listen(1);
    let picked = node().display().to_string();

    let located: BackendStatus = world
        .ask::<LocateBackend>(&LocateBackendRequest {
            backend: BackendId::claude_code(),
            path: picked.clone(),
        })
        .unwrap();
    assert_eq!(located.source, Some(ExecutableSource::Setting));
    assert_eq!(located.path.as_deref(), Some(picked.as_str()));
    let own = located
        .version
        .clone()
        .expect("the picked program's own version");
    assert_ne!(own, "2.1.999 (Claude Code)");
    assert_eq!(located.error, None);
    let stored = world.ask::<ReadSettings>(&()).unwrap();
    assert_eq!(stored.backend_paths[&BackendId::claude_code()], picked);
    assert_eq!(
        heard(&mut listener).last().map(|s| s.backend_paths.clone()),
        Some(stored.backend_paths.clone())
    );
    assert_eq!(
        world.claude_status().source,
        Some(ExecutableSource::Setting)
    );
    assert!(
        !matches!(world.claude.version_check(), VersionCheck::Tested(_)),
        "launches run the chosen executable"
    );

    world
        .ask::<WriteSettings>(&HostSettingsPatch {
            backend_paths: Some(Default::default()),
            ..Default::default()
        })
        .unwrap();
    let cleared = world.claude_status();
    assert_eq!(cleared.source, Some(ExecutableSource::Discovered));
    assert_eq!(cleared.version.as_deref(), Some("2.1.999 (Claude Code)"));
    assert!(matches!(
        world.claude.version_check(),
        VersionCheck::Tested(_)
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pick_that_is_not_a_program_is_a_sentence_and_nothing_is_kept() {
    let world = World::new();
    let folder = world.dirs.folder("not a program");
    let text = folder.join("notes.txt");
    std::fs::write(&text, "hello").unwrap();
    for (path, why) in [
        (folder.display().to_string(), "That is not a file."),
        (
            folder.join("gone").display().to_string(),
            "That file could not be read.",
        ),
        ("claude".to_owned(), "That is not a full path to a file."),
    ] {
        let answer: BackendStatus = world
            .ask::<LocateBackend>(&LocateBackendRequest {
                backend: BackendId::claude_code(),
                path,
            })
            .unwrap();
        assert_eq!(answer.error.as_deref(), Some(why));
        assert_eq!(answer.source, Some(ExecutableSource::Discovered));
    }
    assert!(
        world
            .ask::<ReadSettings>(&())
            .unwrap()
            .backend_paths
            .is_empty()
    );
    let unknown = world
        .ask::<LocateBackend>(&LocateBackendRequest {
            backend: BackendId::new("nobody"),
            path: text.display().to_string(),
        })
        .unwrap_err();
    assert_eq!(unknown, "This Floti host has no agent backend `nobody`.");
}

#[tokio::test]
async fn a_chosen_executable_that_has_gone_is_reported_and_the_found_one_answers() {
    let world = World::new();
    let gone = world.dirs.root().join("moved away").join("claude");
    // Written straight to the store, as a choice made before the file went.
    world
        .ask::<WriteSettings>(&HostSettingsPatch {
            backend_paths: Some([(BackendId::claude_code(), gone.display().to_string())].into()),
            ..Default::default()
        })
        .unwrap();
    let status = world.claude_status();
    assert_eq!(
        status.error,
        Some(format!("The chosen {} is no longer there.", gone.display()))
    );
    assert_eq!(status.source, Some(ExecutableSource::Discovered));
    assert_eq!(status.version.as_deref(), Some("2.1.999 (Claude Code)"));
}
