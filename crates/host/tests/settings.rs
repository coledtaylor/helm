//! Settings, app info and setup as a client of the host sees them: the
//! router tests of `server/features/workspace/tests.rs`, with the same inputs
//! and expectations, run against a host through its socket, plus what a
//! `settings:changed` subscriber is told. Claude Code is the fake claude
//! (`node test/fake-agents/claude-code.mjs`), never a real agent, and its
//! sign-in is judged from a fixture artefact that nothing opens.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Instant;

use floti_host::agent::claude_code::ClaudeCodeSettings;
use floti_host::platform::launcher::{self, ProgramLauncher};
use floti_host::platform::socket::Endpoint;
use floti_host::platform::startup;
use floti_host::server::{HostConfig, HostRun, backends};
use floti_host::store::MIGRATIONS;
use floti_host::testkit::{PATIENCE, RunningHost, TestClient, TestDirs};
use floti_protocol::channel::{EventChannel, from_payload};
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::workspace::{
    AppMode, BackendStatus, CompleteSetup, ExecutableSource, HostSettings, HostSettingsPatch,
    LocateBackend, LocateBackendRequest, ReadAppInfo, ReadSettings, ReadSetupStatus,
    SettingsChanged, SetupStatus, WriteSettings,
};
use floti_protocol::{BackendId, Knowable, Message};

const SETTINGS: u64 = 1;

/// The fake claude (`test/fake-agents/claude-code.mjs`), run by Node.
fn fake_claude() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("test")
        .join("fake-agents")
        .join("claude-code.mjs")
}

/// Node, which the fake claude runs under, as this machine finds it.
fn node() -> PathBuf {
    launcher::Native
        .find("node".as_ref())
        .expect("node is on PATH, as the fake claude needs")
}

/// Claude Code's config folder, in the test's home.
fn claude_config_of(dirs: &TestDirs) -> PathBuf {
    dirs.home.join(".claude")
}

/// A host over the test's folders, run for the test's home, with the shell
/// and Claude Code (the fake claude) as its backends and `$SHELL` pinned to
/// `/bin/sh` rather than the user's shell.
fn config(dirs: &TestDirs, endpoint: &Endpoint) -> HostConfig {
    let claude = ClaudeCodeSettings {
        program: "node".into(),
        leading_args: vec![fake_claude().into_os_string()],
        config_dir: claude_config_of(dirs),
        pass_config_dir: true,
        api_key_set: false,
        search_first: Vec::new(),
    };
    HostConfig {
        folders: dirs.folders(),
        endpoint: endpoint.clone(),
        backends: backends(&dirs.user_env(), Some(claude)),
        inherited_env: std::env::vars_os()
            .filter(|(key, _)| key != "SHELL")
            .chain([(OsString::from("SHELL"), OsString::from("/bin/sh"))])
            .collect(),
        run: HostRun {
            mode: AppMode::Dev,
            home: Some(dirs.home.clone()),
            node: None,
        },
    }
}

/// A host over a test's folders, with a client connected to it.
struct World {
    host: Option<RunningHost>,
    client: TestClient,
    endpoint: Endpoint,
    /// Last: fields drop in order.
    dirs: TestDirs,
}

impl World {
    async fn start() -> Self {
        let dirs = TestDirs::new();
        let endpoint = dirs.endpoint();
        let host = RunningHost::start(config(&dirs, &endpoint));
        let client = TestClient::connect(&endpoint, &[]).await;
        Self {
            host: Some(host),
            client,
            endpoint,
            dirs,
        }
    }

    async fn stop(mut self) {
        if let Some(host) = self.host.take() {
            host.stop(HostStopReason::Stop).await;
        }
    }

    async fn write(&mut self, patch: HostSettingsPatch) -> Result<HostSettings, String> {
        self.client
            .request::<WriteSettings>(&patch)
            .await
            .map_err(|error| error.message)
    }

    async fn settings(&mut self) -> HostSettings {
        self.client.request::<ReadSettings>(&()).await.unwrap()
    }

    async fn setup(&mut self) -> SetupStatus {
        self.client.request::<ReadSetupStatus>(&()).await.unwrap()
    }

    async fn claude_status(&mut self) -> BackendStatus {
        self.setup().await.backends[&BackendId::claude_code()].clone()
    }

    async fn locate(&mut self, path: String) -> BackendStatus {
        self.client
            .request::<LocateBackend>(&LocateBackendRequest {
                backend: BackendId::claude_code(),
                path,
            })
            .await
            .expect("a pick is answered with the backend's status")
    }

    /// Another client, subscribed to `settings:changed`, and the settings it
    /// started with.
    async fn watcher(&self) -> (TestClient, HostSettings) {
        let mut client = TestClient::connect(&self.endpoint, &[]).await;
        match client.subscribe_on(SETTINGS, SettingsChanged::NAME).await {
            Message::Snapshot(snapshot) => {
                let state = from_payload(&snapshot.state).unwrap();
                (client, state)
            }
            other => panic!("settings:changed starts with its state, not {other:?}"),
        }
    }
}

/// The settings the next `settings:changed` event to `watcher` carries.
async fn next_settings(watcher: &mut TestClient) -> HostSettings {
    let deadline = Instant::now() + PATIENCE;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match watcher.next(left).await {
            Some(Message::Event(event)) if event.subscription == SETTINGS => {
                return from_payload(&event.payload).unwrap();
            }
            Some(_) => {}
            None => panic!("no settings:changed event within {PATIENCE:?}"),
        }
    }
}

fn scan_roots(roots: &[String]) -> HostSettingsPatch {
    HostSettingsPatch {
        scan_roots: Some(roots.to_vec()),
        ..HostSettingsPatch::default()
    }
}

fn archive_max(bytes: u64) -> HostSettingsPatch {
    HostSettingsPatch {
        transcript_archive_max_bytes: Some(bytes),
        ..HostSettingsPatch::default()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn app_info_names_the_hosts_version_mode_data_folder_database_migrations_and_home() {
    let mut world = World::start().await;

    let info = world.client.request::<ReadAppInfo>(&()).await.unwrap();
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
        startup::windows_build().is_some()
    );

    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn every_settings_subscriber_gets_the_whole_settings_after_each_write() {
    let mut world = World::start().await;
    let (mut first, first_start) = world.watcher().await;
    let (mut second, second_start) = world.watcher().await;
    assert_eq!(first_start, floti_host::workspace::settings::defaults());
    assert_eq!(second_start, first_start);

    let roots = vec![world.dirs.folder("projects").display().to_string()];
    let rooted = world.write(scan_roots(&roots)).await.unwrap();
    assert_eq!(rooted.scan_roots, roots);
    let capped = world.write(archive_max(4096)).await.unwrap();
    assert_eq!(capped.transcript_archive_max_bytes, 4096);
    assert_eq!(
        capped.scan_roots, roots,
        "the whole settings, not the change"
    );

    for watcher in [&mut first, &mut second] {
        assert_eq!(next_settings(watcher).await, rooted);
        assert_eq!(next_settings(watcher).await, capped);
    }
    let (_later, later_start) = world.watcher().await;
    assert_eq!(
        later_start, capped,
        "a later subscription starts with the latest"
    );
    assert_eq!(world.settings().await, capped);

    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_malformed_setting_is_refused_with_the_validators_sentence_and_the_stored_value_kept() {
    let mut world = World::start().await;
    world.write(archive_max(4096)).await.unwrap();
    let (mut watcher, _) = world.watcher().await;

    let refused = world.write(archive_max(999)).await.unwrap_err();
    assert_eq!(
        refused,
        "settings rejected: transcriptArchiveMaxBytes: expected 1024 to 68719476736, got 999"
    );
    assert_eq!(world.settings().await.transcript_archive_max_bytes, 4096);

    // The refused write told nobody: the next change is the first heard.
    world.write(archive_max(8192)).await.unwrap();
    assert_eq!(
        next_settings(&mut watcher)
            .await
            .transcript_archive_max_bytes,
        8192
    );

    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn setup_reports_each_backends_executable_source_version_range_and_sign_in_without_opening_a_credential()
 {
    let mut world = World::start().await;

    let status = world.setup().await;
    assert_eq!(
        status.backends.keys().cloned().collect::<Vec<_>>(),
        vec![BackendId::claude_code()],
        "the shell has no executable to find, so no setup"
    );

    let claude = world.claude_status().await;
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
    let config_dir = claude_config_of(&world.dirs);
    assert_eq!(claude.config_dir, Some(config_dir.display().to_string()));
    assert!(!claude.config_dir_exists);
    assert_eq!(claude.signed_in, Knowable::Known(false));
    assert_eq!(
        claude.sign_in_signal,
        "Claude Code is not signed in. Run claude in a terminal and sign in."
    );

    // A sign-in artefact existing is a sign-in; nothing opens it.
    let secret = "not read";
    std::fs::create_dir_all(&config_dir).unwrap();
    std::fs::write(config_dir.join(".credentials.json"), secret).unwrap();
    let status = world.setup().await;
    let claude = &status.backends[&BackendId::claude_code()];
    assert!(claude.config_dir_exists);
    assert_eq!(claude.signed_in, Knowable::Known(true));
    assert_eq!(claude.sign_in_signal, ".credentials.json is present");
    let answer = serde_json::to_string(&status).unwrap();
    assert!(
        !answer.contains(secret),
        "no part of the credential reaches the answer: {answer}"
    );

    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_located_executable_is_stored_and_reports_its_own_version_and_a_pick_that_is_not_a_program_keeps_nothing()
 {
    let mut world = World::start().await;
    let (mut watcher, _) = world.watcher().await;

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
        let answer = world.locate(path).await;
        assert_eq!(answer.error.as_deref(), Some(why));
        assert_eq!(answer.source, Some(ExecutableSource::Discovered));
    }
    let unknown = world
        .client
        .request::<LocateBackend>(&LocateBackendRequest {
            backend: BackendId::new("nobody"),
            path: text.display().to_string(),
        })
        .await
        .unwrap_err();
    assert_eq!(
        unknown.message,
        "This Floti host has no agent backend `nobody`."
    );
    assert!(
        world.settings().await.backend_paths.is_empty(),
        "a refused pick keeps nothing"
    );

    let picked = node().display().to_string();
    let located = world.locate(picked.clone()).await;
    assert_eq!(located.source, Some(ExecutableSource::Setting));
    assert_eq!(located.path.as_deref(), Some(picked.as_str()));
    let own = located
        .version
        .clone()
        .expect("the picked program's own version");
    assert_ne!(own, "2.1.999 (Claude Code)");
    assert_eq!(located.error, None);
    let stored = world.settings().await;
    assert_eq!(stored.backend_paths[&BackendId::claude_code()], picked);
    // The refused picks told nobody: the first change heard is the pick.
    assert_eq!(
        next_settings(&mut watcher).await.backend_paths,
        stored.backend_paths
    );
    assert_eq!(
        world.claude_status().await.source,
        Some(ExecutableSource::Setting)
    );

    world
        .write(HostSettingsPatch {
            backend_paths: Some(Default::default()),
            ..HostSettingsPatch::default()
        })
        .await
        .unwrap();
    let cleared = world.claude_status().await;
    assert_eq!(cleared.source, Some(ExecutableSource::Discovered));
    assert_eq!(cleared.version.as_deref(), Some("2.1.999 (Claude Code)"));

    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn completing_setup_answers_the_settings_with_setup_done_and_a_subscriber_hears_it() {
    let mut world = World::start().await;
    let roots = vec![world.dirs.folder("projects").display().to_string()];
    world.write(scan_roots(&roots)).await.unwrap();
    let (mut watcher, start) = world.watcher().await;
    assert_eq!(start.first_run_completed_at, None, "setup is not done yet");

    let completed = world.client.request::<CompleteSetup>(&()).await.unwrap();
    let stamp = completed
        .first_run_completed_at
        .clone()
        .expect("setup:complete stamps the time");
    assert!(stamp.parse::<jiff::Timestamp>().is_ok(), "{stamp}");
    assert_eq!(
        completed.scan_roots, roots,
        "the whole settings, not the change"
    );
    assert_eq!(next_settings(&mut watcher).await, completed);
    assert_eq!(world.settings().await, completed);

    world.stop().await;
}
