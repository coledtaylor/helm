//! The config console against real folders, a real floti.db and the fake
//! claude: the same inputs and expectations as the desktop's config tests,
//! answered by the host's console.
//!
//! Every test makes its own folders and its own store, and the agent's CLI
//! is `node test/fake-agents/claude-code.mjs`, never a real agent.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use floti_host::agent::claude_code::{ClaudeCodeBackend, ClaudeCodeSettings};
use floti_host::config_console::{
    ConfigConsole, SnapshotStore, change_sink, hash_content, normalize, sha256_hex,
};
use floti_host::platform::process_tree::Native as NativeTree;
use floti_host::platform::socket::Endpoint;
use floti_host::server::{HostConfig, backends};
use floti_host::session::ClientId;
use floti_host::store::Store;
use floti_host::testkit::{PATIENCE, RunningHost, TestClient, TestDirs};
use floti_protocol::Message;
use floti_protocol::channel::{EventChannel, from_payload};
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::workspace::{
    ConfigChangedOutside, ConfigExternalChange, ConfigFileKind, ConfigPath, ConfigScopeKind,
    ConfigWriteReason, CreatableKind, CreateConfigRequest, DeleteConfigRequest,
    EffectiveViewRequest, McpAddRequest, McpApproveRequest, McpDiffSign, McpRemoveRequest,
    McpScope, ReadConfigFile, RenameConfigRequest, SettingsLayerKind, WatchConfigFile,
    WatchConfigRequest, WriteConfigFile, WriteConfigRequest,
};
use serde_json::{Value, json};

fn fake_claude() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("test")
        .join("fake-agents")
        .join("claude-code.mjs")
}

/// A user, a project with a space in its path, a store, and the console.
struct World {
    /// The agent's config folder, the user scope.
    claude: PathBuf,
    project: PathBuf,
    other: PathBuf,
    store: Arc<Mutex<Store>>,
    console: ConfigConsole,
    changes: Arc<Mutex<Vec<ConfigExternalChange>>>,
    /// Last: fields drop in order, and the folder goes only once nothing in it is open.
    _dirs: TestDirs,
}

impl World {
    fn new() -> Self {
        let dirs = TestDirs::new();
        let claude = dirs.home.join(".claude");
        std::fs::create_dir_all(&claude).unwrap();
        let project = dirs.folder("my project");
        let other = dirs.folder("someone else");
        let backend = Arc::new(ClaudeCodeBackend::new(
            ClaudeCodeSettings {
                search_first: Vec::new(),
                program: "node".into(),
                leading_args: vec![fake_claude().into_os_string()],
                config_dir: claude.clone(),
                pass_config_dir: true,
                api_key_set: false,
            },
            Arc::new(NativeTree),
        ));
        let agent = backend.console_agent();
        let store = Arc::new(Mutex::new(Store::open(&dirs.data).unwrap()));
        let changes = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&changes);
        let console = ConfigConsole::new(
            backend,
            agent,
            Arc::clone(&store) as Arc<dyn SnapshotStore>,
            change_sink(move |_, change| seen.lock().unwrap().push(change.clone())),
        );
        Self {
            _dirs: dirs,
            claude,
            project,
            other,
            store,
            console,
            changes,
        }
    }

    fn put(&self, path: &Path, content: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    fn text(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap()
    }

    fn scope(path: &Path) -> String {
        normalize(path).display().to_string()
    }

    fn snapshot_count(&self) -> i64 {
        self.store
            .lock()
            .unwrap()
            .connection()
            .query_row("SELECT count(*) FROM config_snapshots", [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    /// From here on, the store refuses every snapshot.
    fn break_snapshots(&self) {
        self.store
            .lock()
            .unwrap()
            .connection()
            .execute_batch(
                "CREATE TRIGGER no_snapshots BEFORE INSERT ON config_snapshots \
                 BEGIN SELECT RAISE(ABORT, 'the disk is full'); END;",
            )
            .unwrap();
    }

    fn add_profile(&self, name: &str, root: &Path, overlays: &[&Path]) -> u64 {
        let overlays: Vec<String> = overlays
            .iter()
            .map(|path| path.display().to_string())
            .collect();
        let store = self.store.lock().unwrap();
        store
            .connection()
            .execute(
                "INSERT INTO profiles (name, root, overlays) VALUES (?1, ?2, ?3)",
                rusqlite::params![
                    name,
                    root.display().to_string(),
                    json!(overlays).to_string()
                ],
            )
            .unwrap();
        u64::try_from(store.connection().last_insert_rowid()).unwrap()
    }

    fn write(
        &self,
        scope: &Path,
        path: &Path,
        content: &str,
        expected: Option<String>,
    ) -> floti_protocol::channels::workspace::WriteConfigResult {
        self.console
            .write(&WriteConfigRequest {
                scope_path: Self::scope(scope),
                path: path.display().to_string(),
                content: content.to_owned(),
                expected_hash: expected,
                reason: ConfigWriteReason::Edit,
            })
            .unwrap()
    }
}

fn same(a: &str, b: &Path) -> bool {
    normalize(Path::new(a)) == normalize(b)
}

fn json_of(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

// --- Scopes, trees, reads and the effective view ---------------------------

#[test]
fn scopes_are_the_user_scope_then_each_profile_folder_once() {
    let world = World::new();
    world.add_profile("Work", &world.project, &[&world.other, &world.project]);
    world.add_profile("Again", &world.other, &[]);

    let scopes = world.console.scopes().unwrap();
    let kinds: Vec<ConfigScopeKind> = scopes.iter().map(|scope| scope.kind).collect();
    assert_eq!(
        kinds,
        [
            ConfigScopeKind::User,
            ConfigScopeKind::Project,
            ConfigScopeKind::Project
        ]
    );
    assert_eq!(scopes[0].label, "User");
    assert!(same(&scopes[0].path, &world.claude));
    assert!(scopes[0].exists);
    assert!(same(&scopes[1].path, &world.project));
    assert_eq!(scopes[1].label, "my project");
    assert!(same(&scopes[1].claude_dir, &world.project.join(".claude")));
    assert!(same(&scopes[2].path, &world.other));
}

#[test]
fn a_scope_tree_lists_its_config_files_and_never_a_credential_file() {
    let world = World::new();
    world.put(&world.claude.join("CLAUDE.md"), "# me\n");
    world.put(&world.claude.join("settings.json"), "{}\n");
    world.put(
        &world.claude.join("skills/review/SKILL.md"),
        "---\nname: review\ndescription: Reviews.\n---\n",
    );
    world.put(&world.claude.join(".credentials.json"), "{\"secret\":true}");
    world.put(&world.claude.join("sessions/123.json"), "{}");
    world.put(&world.claude.join("sessions/123.abcdef.key"), "secret");
    world.put(&world.project.join("CLAUDE.md"), "# project\n");
    world.put(&world.project.join(".mcp.json"), "{\"mcpServers\":{}}\n");
    world.put(&world.project.join(".claude/settings.local.json"), "{}\n");
    world.put(
        &world.project.join(".claude/agents/helper.md"),
        "---\nname: helper\n---\n",
    );

    let user = world.console.tree(&World::scope(&world.claude)).unwrap();
    assert!(user.errors.is_empty(), "{:?}", user.errors);
    let rel: Vec<&str> = user
        .files
        .iter()
        .map(|file| file.rel_path.as_str())
        .collect();
    assert!(rel.contains(&"CLAUDE.md"), "{rel:?}");
    assert!(rel.contains(&"settings.json"), "{rel:?}");
    assert!(rel.contains(&"skills/review/SKILL.md"), "{rel:?}");
    for file in &user.files {
        assert!(!file.rel_path.contains("credentials"), "{rel:?}");
        assert!(!file.rel_path.ends_with(".key"), "{rel:?}");
    }
    let skill = user
        .files
        .iter()
        .find(|file| file.kind == ConfigFileKind::Skill)
        .unwrap();
    assert_eq!(skill.description.as_deref(), Some("Reviews."));

    let project = world.console.tree(&World::scope(&world.project)).unwrap();
    let kinds: Vec<ConfigFileKind> = project.files.iter().map(|file| file.kind).collect();
    for kind in [
        ConfigFileKind::ClaudeMd,
        ConfigFileKind::Mcp,
        ConfigFileKind::SettingsLocal,
        ConfigFileKind::Agent,
    ] {
        assert!(kinds.contains(&kind), "{kinds:?}");
    }
    assert_eq!(project.scope.kind, ConfigScopeKind::Project);
}

#[test]
fn a_file_is_read_with_its_hash_and_a_credential_file_is_never_opened() {
    let world = World::new();
    let notes = world.claude.join("CLAUDE.md");
    world.put(&notes, "line one\r\nline two\r\n");
    world.put(&world.claude.join(".credentials.json"), "{\"secret\":true}");
    world.put(&world.claude.join("sessions/9.abcdef.key"), "secret");

    let read = world.console.read(&notes.display().to_string()).unwrap();
    assert!(read.exists);
    assert_eq!(read.content, "line one\r\nline two\r\n");
    assert_eq!(read.hash, sha256_hex(b"line one\r\nline two\r\n"));
    assert_eq!(read.hash, hash_content("line one\r\nline two\r\n"));
    assert_eq!(read.size, 20);

    for credential in [
        world.claude.join(".credentials.json"),
        world.claude.join("sessions/9.abcdef.key"),
    ] {
        let refused = world
            .console
            .read(&credential.display().to_string())
            .unwrap_err();
        assert!(refused.contains("credential"), "{refused}");
    }

    let missing = world
        .console
        .read(&world.claude.join("nope.md").display().to_string())
        .unwrap();
    assert!(!missing.exists);
    assert_eq!(missing.content, "");
}

#[test]
fn the_effective_view_takes_each_setting_from_the_nearest_layer() {
    let world = World::new();
    world.put(
        &world.claude.join("settings.json"),
        "{\"model\":\"user\",\"theme\":\"dark\"}\n",
    );
    world.put(
        &world.project.join(".claude/settings.json"),
        "{\"model\":\"project\"}\n",
    );
    world.put(
        &world.project.join(".claude/settings.local.json"),
        "{\"model\":\"local\",\"enabledMcpjsonServers\":[\"docs\"]}\n",
    );
    world.put(
        &world.project.join(".mcp.json"),
        "{\"mcpServers\":{\"docs\":{\"command\":\"node\",\"args\":[\"docs.js\"]}}}\n",
    );
    world.put(&world.project.join("CLAUDE.md"), "# project\n");
    world.put(&world.claude.join("CLAUDE.md"), "# me\n");

    let view = world
        .console
        .effective(&EffectiveViewRequest {
            profile_id: None,
            cwd: Some(world.project.display().to_string()),
            overlays: Vec::new(),
        })
        .unwrap();
    let model = view
        .settings
        .iter()
        .find(|setting| setting.key == "model")
        .unwrap();
    assert_eq!(model.winner, SettingsLayerKind::Local);
    assert_eq!(model.value, "\"local\"");
    assert!(model.overridden);
    assert_eq!(model.candidates.len(), 3);
    let theme = view
        .settings
        .iter()
        .find(|setting| setting.key == "theme")
        .unwrap();
    assert_eq!(theme.winner, SettingsLayerKind::User);
    assert!(!theme.overridden);

    let docs = view
        .mcp_servers
        .iter()
        .find(|server| server.name == "docs")
        .unwrap();
    assert_eq!(docs.scope, McpScope::Project);
    assert_eq!(docs.approved, Some(true));
    assert_eq!(view.instructions.len(), 2);

    let id = world.add_profile("Work", &world.project, &[]);
    let by_profile = world
        .console
        .effective(&EffectiveViewRequest {
            profile_id: Some(id),
            cwd: None,
            overlays: Vec::new(),
        })
        .unwrap();
    assert_eq!(by_profile.profile_id, Some(id));
    assert_eq!(by_profile.profile_name.as_deref(), Some("Work"));
    assert!(same(&by_profile.cwd, &world.project));

    let gone = world.console.effective(&EffectiveViewRequest {
        profile_id: Some(id + 1),
        cwd: None,
        overlays: Vec::new(),
    });
    assert_eq!(gone.unwrap_err(), "That profile no longer exists.");
    let neither = world.console.effective(&EffectiveViewRequest {
        profile_id: None,
        cwd: Some("  ".to_owned()),
        overlays: Vec::new(),
    });
    assert!(
        neither
            .unwrap_err()
            .contains("profile or a working directory")
    );
}

// --- Writes, conflicts, snapshots and restore -------------------------------

#[test]
fn a_write_snapshots_the_file_as_it_was_first_and_answers_with_the_new_hash() {
    let world = World::new();
    let file = world.project.join(".claude/settings.json");
    world.put(&file, "{\r\n  \"model\": \"a\"\r\n}\r\n");
    let read = world.console.read(&file.display().to_string()).unwrap();

    let written = world.write(
        &world.project,
        &file,
        "{\n  \"model\": \"b\"\n}\n",
        Some(read.hash.clone()),
    );
    assert!(written.ok, "{written:?}");
    assert!(!written.unchanged);
    assert_eq!(World::text(&file), "{\n  \"model\": \"b\"\n}\n");
    assert_eq!(
        written.file.hash,
        hash_content("{\n  \"model\": \"b\"\n}\n")
    );

    let history = world
        .console
        .snapshots(&World::scope(&world.project), &file.display().to_string())
        .unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(Some(history[0].id), written.snapshot_id);
    assert_eq!(history[0].reason, ConfigWriteReason::Edit);
    assert_eq!(history[0].content_hash, read.hash);
    assert_eq!(history[0].file_path, ".claude/settings.json");
    let kept = world.console.snapshot(history[0].id).unwrap().unwrap();
    assert_eq!(kept.content, "{\r\n  \"model\": \"a\"\r\n}\r\n");

    // The same bytes again write nothing and take no snapshot.
    let again = world.write(
        &world.project,
        &file,
        "{\n  \"model\": \"b\"\n}\n",
        Some(written.file.hash.clone()),
    );
    assert!(again.ok && again.unchanged);
    assert_eq!(again.snapshot_id, None);
    assert_eq!(world.snapshot_count(), 1);
}

#[test]
fn a_new_file_is_written_after_a_create_snapshot_of_nothing() {
    let world = World::new();
    let file = world.project.join(".claude/rules/style.md");
    let written = world.write(&world.project, &file, "# Style\n", None);
    assert!(written.ok);
    assert_eq!(World::text(&file), "# Style\n");
    let history = world
        .console
        .snapshots(&World::scope(&world.project), &file.display().to_string())
        .unwrap();
    assert_eq!(history[0].reason, ConfigWriteReason::Create);
    assert_eq!(history[0].bytes, 0);

    // Restoring that version removes the file again, after recording it.
    let restored = world
        .console
        .restore(history[0].id, &file.display().to_string())
        .unwrap();
    assert!(restored.ok);
    assert!(!file.exists());
    let after = world
        .console
        .snapshots(&World::scope(&world.project), &file.display().to_string())
        .unwrap();
    assert_eq!(after[0].reason, ConfigWriteReason::Restore);
    assert_eq!(
        world
            .console
            .snapshot(after[0].id)
            .unwrap()
            .unwrap()
            .content,
        "# Style\n"
    );
}

#[test]
fn a_write_with_a_stale_hash_is_refused_as_a_conflict_and_changes_nothing() {
    let world = World::new();
    let file = world.claude.join("CLAUDE.md");
    world.put(&file, "mine\n");
    let read = world.console.read(&file.display().to_string()).unwrap();
    world.put(&file, "edited elsewhere\n");

    let written = world.write(&world.claude, &file, "replacement\n", Some(read.hash));
    assert!(!written.ok);
    let conflict = written.conflict.unwrap();
    assert_eq!(conflict.on_disk_content, "edited elsewhere\n");
    assert_eq!(conflict.on_disk_hash, hash_content("edited elsewhere\n"));
    assert_eq!(World::text(&file), "edited elsewhere\n");
    assert_eq!(world.snapshot_count(), 0);

    // "I believe it does not exist" about a file that does is a conflict too.
    let blind = world.write(&world.claude, &file, "replacement\n", None);
    assert!(blind.conflict.is_some());
    assert_eq!(World::text(&file), "edited elsewhere\n");
}

#[test]
fn restoring_a_snapshot_puts_its_exact_bytes_back_after_snapshotting_the_current_content() {
    let world = World::new();
    let file = world.claude.join("CLAUDE.md");
    world.put(&file, "first\r\nversion\r\n");
    let read = world.console.read(&file.display().to_string()).unwrap();
    let written = world.write(&world.claude, &file, "second\n", Some(read.hash));
    let first = written.snapshot_id.unwrap();

    let restored = world
        .console
        .restore(first, &file.display().to_string())
        .unwrap();
    assert!(restored.ok, "{restored:?}");
    assert_eq!(std::fs::read(&file).unwrap(), b"first\r\nversion\r\n");
    let history = world
        .console
        .snapshots(&World::scope(&world.claude), &file.display().to_string())
        .unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].reason, ConfigWriteReason::Restore);
    assert_eq!(
        world
            .console
            .snapshot(history[0].id)
            .unwrap()
            .unwrap()
            .content,
        "second\n"
    );

    let gone = world
        .console
        .restore(first + 100, &file.display().to_string())
        .unwrap();
    assert!(!gone.ok);
    assert_eq!(
        gone.error.as_deref(),
        Some("That version is no longer in the snapshot history.")
    );
}

#[test]
fn a_write_outside_the_scope_or_outside_configuration_is_refused() {
    let world = World::new();
    let elsewhere = world.other.join(".claude/settings.json");
    let source = world.project.join("src/main.rs");
    world.put(&source, "fn main() {}\n");

    for (scope, path) in [
        (&world.project, elsewhere.clone()),
        (&world.project, source.clone()),
        (&world.project, PathBuf::from("relative/settings.json")),
        (
            &world.project,
            world
                .project
                .join(".claude/../../someone else/.claude/x.md"),
        ),
    ] {
        let refused = world.console.write(&WriteConfigRequest {
            scope_path: World::scope(scope),
            path: path.display().to_string(),
            content: "x".to_owned(),
            expected_hash: None,
            reason: ConfigWriteReason::Edit,
        });
        assert!(refused.is_err(), "{} was written", path.display());
    }
    assert!(!elsewhere.exists());
    assert_eq!(World::text(&source), "fn main() {}\n");
    assert_eq!(world.snapshot_count(), 0);
}

// --- No snapshot, no change -------------------------------------------------

#[test]
fn when_no_snapshot_can_be_taken_a_write_create_rename_delete_or_restore_aborts_and_leaves_the_file()
 {
    let world = World::new();
    let file = world.project.join(".claude/settings.json");
    world.put(&file, "{\"model\":\"a\"}\n");
    let skill = world.project.join(".claude/skills/review/SKILL.md");
    world.put(&skill, "---\nname: review\n---\nbody\n");
    let read = world.console.read(&file.display().to_string()).unwrap();
    let first = world
        .write(
            &world.project,
            &file,
            "{\"model\":\"b\"}\n",
            Some(read.hash),
        )
        .snapshot_id
        .unwrap();
    world.break_snapshots();
    let scope = World::scope(&world.project);

    let write = world.console.write(&WriteConfigRequest {
        scope_path: scope.clone(),
        path: file.display().to_string(),
        content: "{\"model\":\"c\"}\n".to_owned(),
        expected_hash: Some(hash_content("{\"model\":\"b\"}\n")),
        reason: ConfigWriteReason::Edit,
    });
    let create = world.console.create(&CreateConfigRequest {
        scope_path: scope.clone(),
        kind: CreatableKind::Command,
        name: "deploy".to_owned(),
    });
    let rename = world.console.rename(&RenameConfigRequest {
        scope_path: scope.clone(),
        path: skill.display().to_string(),
        name: "audit".to_owned(),
    });
    let delete = world.console.delete(&DeleteConfigRequest {
        scope_path: scope.clone(),
        path: skill.display().to_string(),
    });
    let restore = world.console.restore(first, &file.display().to_string());

    for (what, outcome) in [
        ("write", write.map(|_| ())),
        ("create", create.map(|_| ())),
        ("rename", rename.map(|_| ())),
        ("delete", delete.map(|_| ())),
        ("restore", restore.map(|_| ())),
    ] {
        let sentence = outcome.expect_err(what);
        assert!(sentence.contains("snapshot"), "{what}: {sentence}");
        assert!(
            sentence.ends_with('.') || sentence.contains("disk is full"),
            "{what}: {sentence}"
        );
    }
    assert_eq!(World::text(&file), "{\"model\":\"b\"}\n");
    assert_eq!(World::text(&skill), "---\nname: review\n---\nbody\n");
    assert!(!world.project.join(".claude/commands/deploy.md").exists());
    assert!(!world.project.join(".claude/skills/audit").exists());
}

// --- Watching the open file -------------------------------------------------

fn wait_for(world: &World, wanted: impl Fn(&[ConfigExternalChange]) -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if wanted(&world.changes.lock().unwrap()) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

#[test]
fn a_watched_file_changed_outside_the_host_is_told_and_a_write_through_the_host_is_not() {
    let world = World::new();
    let file = world.claude.join("CLAUDE.md");
    world.put(&file, "one\n");
    world
        .console
        .watch(ClientId(1), Some(&file.display().to_string()))
        .unwrap();

    // A write through the host sends nothing.
    let read = world.console.read(&file.display().to_string()).unwrap();
    assert!(
        world
            .write(&world.claude, &file, "two\n", Some(read.hash))
            .ok
    );
    std::thread::sleep(Duration::from_millis(800));
    assert!(
        world.changes.lock().unwrap().is_empty(),
        "{:?}",
        world.changes.lock().unwrap()
    );

    // An edit from elsewhere is told, once, with the bytes' new hash.
    std::fs::write(&file, "three\n").unwrap();
    assert!(wait_for(&world, |changes| !changes.is_empty()));
    std::thread::sleep(Duration::from_millis(500));
    let changes = world.changes.lock().unwrap().clone();
    assert_eq!(changes.len(), 1, "{changes:?}");
    assert!(same(&changes[0].path, &file));
    assert_eq!(changes[0].hash, hash_content("three\n"));
    assert!(changes[0].exists);

    // Removing it is an outside change too; no watch, no news.
    std::fs::remove_file(&file).unwrap();
    assert!(wait_for(&world, |changes| changes.len() == 2));
    assert!(!world.changes.lock().unwrap()[1].exists);
    world.console.watch(ClientId(1), None).unwrap();
    world.put(&file, "four\n");
    std::thread::sleep(Duration::from_millis(600));
    assert_eq!(world.changes.lock().unwrap().len(), 2);
}

// --- Watching through the host, one client at a time -----------------------

/// Where each client hears of outside changes.
const CHANGES: u64 = 9;

/// A host whose agents are today's, its Claude Code the fake keeping its
/// config in `claude`.
async fn host_over(dirs: &TestDirs, endpoint: &Endpoint, claude: &Path) -> RunningHost {
    let settings = ClaudeCodeSettings {
        search_first: Vec::new(),
        program: "node".into(),
        leading_args: vec![fake_claude().into_os_string()],
        config_dir: claude.to_path_buf(),
        pass_config_dir: true,
        api_key_set: false,
    };
    RunningHost::start(HostConfig {
        run: Default::default(),
        folders: dirs.folders(),
        endpoint: endpoint.clone(),
        backends: backends(&dirs.user_env(), Some(settings)),
        inherited_env: std::env::vars_os().collect(),
    })
}

/// Every outside change `client` is sent within `wait`, with its number.
async fn changes_within(
    client: &mut TestClient,
    wait: Duration,
) -> Vec<(u64, ConfigExternalChange)> {
    let deadline = tokio::time::Instant::now() + wait;
    let mut changes = Vec::new();
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        match client.next(left).await {
            Some(Message::Event(event)) if event.subscription == CHANGES => {
                changes.push((event.seq, from_payload(&event.payload).expect("a change")));
            }
            Some(_) => {}
            None => return changes,
        }
    }
}

/// The next outside change `client` is sent, with its number.
async fn next_change(client: &mut TestClient) -> (u64, ConfigExternalChange) {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        match client.next(left).await {
            Some(Message::Event(event)) if event.subscription == CHANGES => {
                return (event.seq, from_payload(&event.payload).expect("a change"));
            }
            Some(_) => {}
            None => panic!("no outside change within {PATIENCE:?}"),
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_outside_change_is_told_only_to_the_clients_watching_that_file() {
    let dirs = TestDirs::new();
    let claude = dirs.home.join(".claude");
    std::fs::create_dir_all(&claude).unwrap();
    let memory = claude.join("CLAUDE.md");
    let settings = claude.join("settings.json");
    std::fs::write(&memory, "one\n").unwrap();
    std::fs::write(&settings, "{}\n").unwrap();
    let endpoint = dirs.endpoint();
    let host = host_over(&dirs, &endpoint, &claude).await;

    // Two clients with the memory file open, one with the settings, and one
    // with no file open.
    let mut memory_a = TestClient::connect(&endpoint, &[]).await;
    let mut memory_b = TestClient::connect(&endpoint, &[]).await;
    let mut on_settings = TestClient::connect(&endpoint, &[]).await;
    let mut no_file = TestClient::connect(&endpoint, &[]).await;
    for (client, open) in [
        (&mut memory_a, Some(&memory)),
        (&mut memory_b, Some(&memory)),
        (&mut on_settings, Some(&settings)),
        (&mut no_file, None),
    ] {
        client
            .subscribe_quietly(CHANGES, ConfigChangedOutside::NAME)
            .await;
        if let Some(open) = open {
            client
                .request::<WatchConfigFile>(&WatchConfigRequest {
                    path: Some(open.display().to_string()),
                })
                .await
                .unwrap();
        }
    }

    // A write through the host is no outside change: nobody is told.
    let read = memory_a
        .request::<ReadConfigFile>(&ConfigPath {
            path: memory.display().to_string(),
        })
        .await
        .unwrap();
    let written = memory_a
        .request::<WriteConfigFile>(&WriteConfigRequest {
            scope_path: World::scope(&claude),
            path: memory.display().to_string(),
            content: "two\n".to_owned(),
            expected_hash: Some(read.hash),
            reason: ConfigWriteReason::Edit,
        })
        .await
        .unwrap();
    assert!(written.ok, "{written:?}");
    tokio::time::sleep(Duration::from_millis(800)).await;
    for client in [&mut memory_a, &mut memory_b, &mut on_settings, &mut no_file] {
        let heard = changes_within(client, Duration::from_millis(50)).await;
        assert!(heard.is_empty(), "{heard:?}");
    }

    // An outside edit of the memory file is told to each client that has it
    // open, once, numbered for that client alone.
    std::fs::write(&memory, "three\n").unwrap();
    for client in [&mut memory_a, &mut memory_b] {
        let (seq, change) = next_change(client).await;
        assert_eq!(seq, 1);
        assert!(same(&change.path, &memory), "{change:?}");
        assert_eq!(change.hash, hash_content("three\n"));
        assert!(change.exists);
    }

    // An outside edit of the settings is the settings client's alone, and
    // its numbers start at one too.
    std::fs::write(&settings, "{\"model\":\"b\"}\n").unwrap();
    let (seq, change) = next_change(&mut on_settings).await;
    assert_eq!(seq, 1);
    assert!(same(&change.path, &settings), "{change:?}");

    // Nobody heard anything else: not the other file's change, not twice,
    // and nothing at all with no file open.
    tokio::time::sleep(Duration::from_millis(800)).await;
    for client in [&mut memory_a, &mut memory_b, &mut on_settings, &mut no_file] {
        let heard = changes_within(client, Duration::from_millis(50)).await;
        assert!(heard.is_empty(), "{heard:?}");
    }

    host.stop(HostStopReason::Stop).await;
}

// --- MCP and the doctor, through the agent's CLI ----------------------------

fn add_request(world: &World, scope: McpScope, name: &str, json: &str) -> McpAddRequest {
    McpAddRequest {
        scope,
        name: name.to_owned(),
        json: json.to_owned(),
        cwd: world.project.display().to_string(),
    }
}

#[test]
fn an_mcp_preview_shows_the_file_the_cli_would_write_as_a_diff() {
    let world = World::new();
    world.put(
        &world.project.join(".mcp.json"),
        "{\n  \"mcpServers\": {\n    \"old\": {\n      \"command\": \"x\"\n    }\n  }\n}\n",
    );
    let preview = world.console.mcp_preview(&add_request(
        &world,
        McpScope::Project,
        "docs",
        "{\"command\":\"node\",\"args\":[\"docs.js\"]}",
    ));
    assert_eq!(preview.error, None);
    assert!(same(&preview.file, &world.project.join(".mcp.json")));
    let after: Value = serde_json::from_str(&preview.after).unwrap();
    assert_eq!(
        after["mcpServers"]["docs"],
        json!({"command": "node", "args": ["docs.js"]})
    );
    assert_eq!(after["mcpServers"]["old"], json!({"command": "x"}));
    assert!(
        preview
            .diff
            .iter()
            .any(|line| line.sign == McpDiffSign::Added && line.text.contains("\"docs\""))
    );
    assert!(
        preview
            .diff
            .iter()
            .all(|line| line.sign != McpDiffSign::Removed || line.text.trim() == "}")
    );
    assert_eq!(preview.replaces, None);

    let bad = world
        .console
        .mcp_preview(&add_request(&world, McpScope::Project, "docs", "[1]"));
    assert!(bad.error.unwrap().contains("JSON object"));
    let unnamed = world
        .console
        .mcp_preview(&add_request(&world, McpScope::Project, " ", "{}"));
    assert_eq!(unnamed.error.as_deref(), Some("A server needs a name."));
}

#[test]
fn an_mcp_add_snapshots_the_file_then_the_agents_cli_writes_it_with_every_argument_intact() {
    let world = World::new();
    let file = world.project.join(".mcp.json");
    let server =
        r#"{"command":"node","args":["a b","quote \" inside","C:\\back\\slash","%PATH%","$HOME"]}"#;
    let added = world
        .console
        .mcp_add(&add_request(&world, McpScope::Project, "tricky", server))
        .unwrap();
    assert!(added.ok, "{added:?}");
    assert_eq!(added.exit_code, Some(0));
    assert!(
        added
            .output
            .contains("Added stdio MCP server tricky to project config"),
        "{}",
        added.output
    );
    let expected: Value = serde_json::from_str(server).unwrap();
    assert_eq!(json_of(&file)["mcpServers"]["tricky"], expected);
    assert_eq!(
        serde_json::from_str::<Value>(&added.after).unwrap()["mcpServers"]["tricky"],
        expected
    );

    // The file did not exist, and the snapshot says so.
    let snapshot = world
        .console
        .snapshot(added.snapshot_id.unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.content, "");
    let history = world
        .console
        .snapshots(&World::scope(&world.project), &file.display().to_string())
        .unwrap();
    assert_eq!(history[0].reason, ConfigWriteReason::Mcp);

    // A user server lands in the agent's global config, recorded first.
    let user = world
        .console
        .mcp_add(&add_request(
            &world,
            McpScope::User,
            "everywhere",
            "{\"command\":\"y\"}",
        ))
        .unwrap();
    assert!(user.ok, "{user:?}");
    assert_eq!(
        json_of(&world.claude.join(".claude.json"))["mcpServers"]["everywhere"],
        json!({"command": "y"})
    );

    let listed = world.console.mcp_list(&world.project.display().to_string());
    assert!(listed.ok);
    assert!(
        listed.output.contains("tricky: node a b"),
        "{}",
        listed.output
    );
    assert!(listed.output.contains("everywhere: y"), "{}", listed.output);

    let before = World::text(&file);
    let removed = world
        .console
        .mcp_remove(&McpRemoveRequest {
            name: "tricky".to_owned(),
            scope: McpScope::Project,
            cwd: world.project.display().to_string(),
        })
        .unwrap();
    assert!(removed.ok, "{removed:?}");
    assert!(json_of(&file)["mcpServers"].get("tricky").is_none());
    assert_eq!(
        world
            .console
            .snapshot(removed.snapshot_id.unwrap())
            .unwrap()
            .unwrap()
            .content,
        before
    );

    // The CLI's own refusal comes back as it said it.
    let again = world
        .console
        .mcp_remove(&McpRemoveRequest {
            name: "tricky".to_owned(),
            scope: McpScope::Project,
            cwd: world.project.display().to_string(),
        })
        .unwrap();
    assert!(!again.ok);
    assert_eq!(again.exit_code, Some(1));
    assert!(
        again.output.contains("No MCP server named tricky"),
        "{}",
        again.output
    );
}

#[test]
fn an_mcp_add_that_cannot_be_snapshotted_runs_nothing() {
    let world = World::new();
    world.break_snapshots();
    let refused = world.console.mcp_add(&add_request(
        &world,
        McpScope::Project,
        "docs",
        "{\"command\":\"node\"}",
    ));
    assert!(refused.unwrap_err().contains("snapshot"));
    assert!(!world.project.join(".mcp.json").exists());
}

#[test]
fn approving_an_mcp_server_writes_settings_local_json_through_the_snapshot_first_writer() {
    let world = World::new();
    let local = world.project.join(".claude/settings.local.json");
    let approve = |name: &str, approved: bool| {
        world
            .console
            .mcp_approve(&McpApproveRequest {
                cwd: world.project.display().to_string(),
                name: name.to_owned(),
                approved,
            })
            .unwrap()
    };

    let created = approve("docs", true);
    assert!(created.ok, "{created:?}");
    assert_eq!(json_of(&local), json!({"enabledMcpjsonServers": ["docs"]}));
    let history = world
        .console
        .snapshots(&World::scope(&world.project), &local.display().to_string())
        .unwrap();
    assert_eq!(history[0].reason, ConfigWriteReason::Create);

    world.put(
        &local,
        "{\n  \"model\": \"keep\",\n  \"enabledMcpjsonServers\": [\"docs\", \"Alpha\"]\n}\n",
    );
    let revoked = approve("docs", false);
    assert!(revoked.ok);
    let now = json_of(&local);
    assert_eq!(now["model"], "keep");
    assert_eq!(now["enabledMcpjsonServers"], json!(["Alpha"]));
    assert_eq!(now["disabledMcpjsonServers"], json!(["docs"]));
    let history = world
        .console
        .snapshots(&World::scope(&world.project), &local.display().to_string())
        .unwrap();
    assert_eq!(history[0].reason, ConfigWriteReason::Approve);
    assert!(
        world
            .console
            .snapshot(history[0].id)
            .unwrap()
            .unwrap()
            .content
            .contains("\"keep\"")
    );

    world.put(&local, "[1, 2]\n");
    let refused = approve("docs", true);
    assert!(!refused.ok);
    assert!(refused.error.unwrap().contains("not a JSON object"));
    assert_eq!(World::text(&local), "[1, 2]\n");
}

#[test]
fn the_doctor_runs_the_agents_own_command_and_reads_its_rows() {
    let world = World::new();
    let report = world.console.doctor();
    assert_eq!(report.error, None);
    assert_eq!(report.exit_code, Some(0));
    assert!(
        report.output.starts_with("Diagnostics"),
        "{}",
        report.output
    );
    let channel = report
        .rows
        .iter()
        .find(|row| row.label == "Auto-update channel")
        .unwrap();
    assert_eq!(channel.value, "latest");
    assert!(report.rows.iter().any(|row| row.label == "Install path"));
    assert!(
        !report
            .rows
            .iter()
            .any(|row| row.label.contains("Currently running"))
    );

    world.put(
        &world.claude.join("fake-doctor.json"),
        &json!({"output": "Something is wrong\nSearch: ripgrep missing", "exitCode": 2})
            .to_string(),
    );
    let failing = world.console.doctor();
    assert_eq!(failing.exit_code, Some(2));
    assert_eq!(failing.error, None);
    assert!(failing.output.contains("ripgrep missing"));
    assert_eq!(failing.rows.len(), 1);
    assert_eq!(failing.rows[0].label, "Search");
}

// --- Create, rename and delete in a scope -----------------------------------

#[test]
fn a_skill_command_or_agent_is_created_renamed_and_deleted_in_its_scope() {
    let world = World::new();
    let scope = World::scope(&world.project);
    let create = |kind, name: &str| {
        world
            .console
            .create(&CreateConfigRequest {
                scope_path: scope.clone(),
                kind,
                name: name.to_owned(),
            })
            .unwrap()
    };

    let skill = create(CreatableKind::Skill, "review");
    assert!(skill.ok, "{skill:?}");
    assert_eq!(
        skill.rel_path.as_deref(),
        Some(".claude/skills/review/SKILL.md")
    );
    let skill_path = PathBuf::from(skill.path.unwrap());
    assert!(World::text(&skill_path).contains("name: review"));
    let command = create(CreatableKind::Command, "ops/deploy");
    assert_eq!(
        command.rel_path.as_deref(),
        Some(".claude/commands/ops/deploy.md")
    );
    let agent = create(CreatableKind::Agent, "helper");
    assert_eq!(agent.rel_path.as_deref(), Some(".claude/agents/helper.md"));
    let agent_path = PathBuf::from(agent.path.unwrap());

    let taken = create(CreatableKind::Skill, "review");
    assert!(!taken.ok);
    assert!(taken.error.unwrap().contains("already has a skill called"));
    let bad = create(CreatableKind::Command, "../escape");
    assert!(!bad.ok);
    assert!(!world.project.join("escape.md").exists());

    // A skill's folder moves whole, and its name follows.
    world.put(
        &world.project.join(".claude/skills/review/notes.md"),
        "notes\n",
    );
    let renamed = world
        .console
        .rename(&RenameConfigRequest {
            scope_path: scope.clone(),
            path: skill_path.display().to_string(),
            name: "audit".to_owned(),
        })
        .unwrap();
    assert!(renamed.ok, "{renamed:?}");
    assert!(renamed.frontmatter_renamed);
    assert_eq!(renamed.moved.len(), 2, "{:?}", renamed.moved);
    // One for each file written at its new path, one for each removed.
    assert_eq!(renamed.snapshot_ids.len(), 4);
    assert!(!world.project.join(".claude/skills/review").exists());
    let moved = world.project.join(".claude/skills/audit/SKILL.md");
    assert!(World::text(&moved).contains("name: audit"));
    assert_eq!(
        World::text(&world.project.join(".claude/skills/audit/notes.md")),
        "notes\n"
    );

    let deleted = world
        .console
        .delete(&DeleteConfigRequest {
            scope_path: scope.clone(),
            path: agent_path.display().to_string(),
        })
        .unwrap();
    assert!(deleted.ok);
    assert_eq!(deleted.removed.len(), 1);
    assert!(!agent_path.exists());
    let kept = world
        .console
        .snapshot(deleted.removed[0].snapshot_id)
        .unwrap()
        .unwrap();
    assert!(kept.content.contains("name: helper"));
    assert!(world.project.join(".claude").is_dir());
}

#[test]
fn a_rename_or_delete_of_a_path_outside_the_scope_is_refused() {
    let world = World::new();
    let scope = World::scope(&world.project);
    let outside = world.other.join(".claude/agents/theirs.md");
    world.put(&outside, "---\nname: theirs\n---\n");
    let source = world.project.join("README.md");
    world.put(&source, "# readme\n");

    for path in [&outside, &source] {
        let rename = world.console.rename(&RenameConfigRequest {
            scope_path: scope.clone(),
            path: path.display().to_string(),
            name: "mine".to_owned(),
        });
        assert!(
            rename
                .unwrap_err()
                .contains("is not a configuration file in my project")
        );
        let delete = world.console.delete(&DeleteConfigRequest {
            scope_path: scope.clone(),
            path: path.display().to_string(),
        });
        assert!(
            delete
                .unwrap_err()
                .contains("is not a configuration file in my project")
        );
        assert!(path.exists());
    }
    assert_eq!(world.snapshot_count(), 0);
}

// --- Over the protocol ------------------------------------------------------

/// The config console as a client of the host sees it: a host on today's
/// backends (the shell, then Claude Code over the fake `claude`), driven
/// through `config:*` on the local socket.
mod over_the_protocol {
    use std::time::Instant;

    use floti_host::agent::AgentBackend;
    use floti_host::platform::socket::Endpoint;
    use floti_host::server::{HostConfig, backends, shell_backend};
    use floti_host::testkit::{PATIENCE, RunningHost, TestClient};
    use floti_protocol::Message;
    use floti_protocol::channel::{EventChannel, from_payload};
    use floti_protocol::channels::workspace::{
        AddMcpServer, ApproveMcpServer, ConfigChangedOutside, ConfigPath, ConfigScopeRef,
        CreateConfigFile, DeleteConfigFile, ListConfigScopes, ListConfigSnapshots, ListMcpServers,
        McpListRequest, PreviewMcpServer, ReadConfigFile, ReadConfigSnapshot, ReadConfigTree,
        ReadEffectiveView, RemoveMcpServer, RenameConfigFile, RestoreConfigSnapshot,
        RestoreSnapshotRequest, RunDoctor, ScopedFile, SnapshotRef, WatchConfigFile,
        WatchConfigRequest, WriteConfigFile,
    };

    use super::*;

    /// A host on today's backends, a user whose agent config folder is
    /// `claude`, and two project folders with spaces in their paths.
    struct Served {
        claude: PathBuf,
        project: PathBuf,
        other: PathBuf,
        endpoint: Endpoint,
        host: RunningHost,
        /// Last: fields drop in order, and the folder goes only once nothing in it is open.
        dirs: TestDirs,
    }

    impl Served {
        fn start() -> Self {
            Self::start_on(|dirs, claude| {
                backends(
                    &dirs.user_env(),
                    Some(ClaudeCodeSettings {
                        search_first: Vec::new(),
                        program: "node".into(),
                        leading_args: vec![fake_claude().into_os_string()],
                        config_dir: claude.to_path_buf(),
                        pass_config_dir: true,
                        api_key_set: false,
                    }),
                )
            })
        }

        fn start_on(backends: impl FnOnce(&TestDirs, &Path) -> Vec<Arc<dyn AgentBackend>>) -> Self {
            let dirs = TestDirs::new();
            let claude = dirs.home.join(".claude");
            std::fs::create_dir_all(&claude).unwrap();
            let project = dirs.folder("my project");
            let other = dirs.folder("someone else");
            let endpoint = dirs.endpoint();
            let host = RunningHost::start(HostConfig {
                run: Default::default(),
                folders: dirs.folders(),
                endpoint: endpoint.clone(),
                backends: backends(&dirs, &claude),
                inherited_env: std::env::vars_os().collect(),
            });
            Self {
                claude,
                project,
                other,
                endpoint,
                host,
                dirs,
            }
        }

        async fn stop(self) {
            self.host.stop(HostStopReason::Stop).await;
        }

        async fn client(&self) -> TestClient {
            TestClient::connect(&self.endpoint, &[]).await
        }

        /// The host's database, as a test writes fixtures into it.
        fn db(&self) -> rusqlite::Connection {
            let db = rusqlite::Connection::open(self.dirs.data.join("floti.db")).unwrap();
            db.busy_timeout(PATIENCE).unwrap();
            db
        }

        fn add_profile(&self, name: &str, root: &Path, overlays: &[&Path]) -> u64 {
            let overlays: Vec<String> = overlays
                .iter()
                .map(|path| path.display().to_string())
                .collect();
            let db = self.db();
            db.execute(
                "INSERT INTO profiles (name, root, overlays) VALUES (?1, ?2, ?3)",
                rusqlite::params![
                    name,
                    root.display().to_string(),
                    json!(overlays).to_string()
                ],
            )
            .unwrap();
            u64::try_from(db.last_insert_rowid()).unwrap()
        }

        fn snapshot_count(&self) -> i64 {
            self.db()
                .query_row("SELECT count(*) FROM config_snapshots", [], |row| {
                    row.get(0)
                })
                .unwrap()
        }

        /// From here on, floti.db refuses every snapshot.
        fn break_snapshots(&self) {
            self.db()
                .execute_batch(
                    "CREATE TRIGGER no_snapshots BEFORE INSERT ON config_snapshots \
                     BEGIN SELECT RAISE(ABORT, 'the disk is full'); END;",
                )
                .unwrap();
        }
    }

    fn put(path: &Path, content: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    fn text(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap()
    }

    fn scope(path: &Path) -> String {
        normalize(path).display().to_string()
    }

    fn file(path: &Path) -> String {
        path.display().to_string()
    }

    fn write_request(
        scope_dir: &Path,
        path: &Path,
        content: &str,
        expected: Option<String>,
    ) -> WriteConfigRequest {
        WriteConfigRequest {
            scope_path: scope(scope_dir),
            path: file(path),
            content: content.to_owned(),
            expected_hash: expected,
            reason: ConfigWriteReason::Edit,
        }
    }

    /// The next outside change on `subscription` within `within`, or `None`.
    async fn next_change(
        client: &mut TestClient,
        subscription: u64,
        within: Duration,
    ) -> Option<ConfigExternalChange> {
        let deadline = Instant::now() + within;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match client.next(left).await {
                Some(Message::Event(event)) if event.subscription == subscription => {
                    return Some(from_payload(&event.payload).unwrap());
                }
                Some(_) => {}
                None => return None,
            }
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_client_reads_scopes_trees_files_and_the_effective_view_and_never_a_credential() {
        let served = Served::start();
        served.add_profile("Work", &served.project, &[&served.other]);
        put(&served.claude.join("CLAUDE.md"), "# me\n");
        put(
            &served.claude.join("settings.json"),
            "{\"model\":\"user\"}\n",
        );
        put(
            &served.claude.join(".credentials.json"),
            "{\"secret\":true}",
        );
        put(&served.claude.join("sessions/123.json"), "{}");
        put(&served.claude.join("sessions/123.abcdef.key"), "secret");
        put(
            &served.project.join(".claude/settings.json"),
            "{\"model\":\"project\"}\n",
        );
        put(
            &served.project.join(".claude/agents/helper.md"),
            "---\nname: helper\n---\n",
        );
        let mut client = served.client().await;

        let scopes = client.request::<ListConfigScopes>(&()).await.unwrap();
        let kinds: Vec<ConfigScopeKind> = scopes.iter().map(|scope| scope.kind).collect();
        assert_eq!(
            kinds,
            [
                ConfigScopeKind::User,
                ConfigScopeKind::Project,
                ConfigScopeKind::Project
            ]
        );
        assert!(same(&scopes[0].path, &served.claude));
        assert!(same(&scopes[1].path, &served.project));
        assert!(same(&scopes[2].path, &served.other));

        let user = client
            .request::<ReadConfigTree>(&ConfigScopeRef {
                scope_path: scope(&served.claude),
            })
            .await
            .unwrap();
        let rel: Vec<&str> = user.files.iter().map(|f| f.rel_path.as_str()).collect();
        assert!(rel.contains(&"CLAUDE.md"), "{rel:?}");
        assert!(rel.contains(&"settings.json"), "{rel:?}");
        for listed in &user.files {
            assert!(!listed.rel_path.contains("credentials"), "{rel:?}");
            assert!(!listed.rel_path.ends_with(".key"), "{rel:?}");
        }
        let project = client
            .request::<ReadConfigTree>(&ConfigScopeRef {
                scope_path: scope(&served.project),
            })
            .await
            .unwrap();
        assert!(
            project
                .files
                .iter()
                .any(|f| f.kind == ConfigFileKind::Agent)
        );

        let notes = served.claude.join("CLAUDE.md");
        let read = client
            .request::<ReadConfigFile>(&ConfigPath { path: file(&notes) })
            .await
            .unwrap();
        assert_eq!(read.content, "# me\n");
        assert_eq!(read.hash, hash_content("# me\n"));
        for credential in [
            served.claude.join(".credentials.json"),
            served.claude.join("sessions/123.abcdef.key"),
        ] {
            let refused = client
                .request::<ReadConfigFile>(&ConfigPath {
                    path: file(&credential),
                })
                .await
                .unwrap_err();
            assert!(refused.message.contains("credential"), "{refused:?}");
            let watched = client
                .request::<WatchConfigFile>(&WatchConfigRequest {
                    path: Some(file(&credential)),
                })
                .await
                .unwrap_err();
            assert!(watched.message.contains("credential"), "{watched:?}");
        }

        let view = client
            .request::<ReadEffectiveView>(&EffectiveViewRequest {
                profile_id: None,
                cwd: Some(file(&served.project)),
                overlays: Vec::new(),
            })
            .await
            .unwrap();
        let model = view.settings.iter().find(|s| s.key == "model").unwrap();
        assert_eq!(model.winner, SettingsLayerKind::Project);
        assert_eq!(model.value, "\"project\"");
        assert!(model.overridden);
        served.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_write_snapshots_first_a_stale_hash_is_a_conflict_and_a_restore_snapshots_the_current_content()
     {
        let served = Served::start();
        let settings = served.project.join(".claude/settings.json");
        put(&settings, "{\"model\":\"a\"}\n");
        let mut client = served.client().await;
        let read = client
            .request::<ReadConfigFile>(&ConfigPath {
                path: file(&settings),
            })
            .await
            .unwrap();

        let written = client
            .request::<WriteConfigFile>(&write_request(
                &served.project,
                &settings,
                "{\"model\":\"b\"}\n",
                Some(read.hash.clone()),
            ))
            .await
            .unwrap();
        assert!(written.ok, "{written:?}");
        assert_eq!(written.file.hash, hash_content("{\"model\":\"b\"}\n"));
        assert_eq!(text(&settings), "{\"model\":\"b\"}\n");
        let first = written.snapshot_id.unwrap();
        let kept = client
            .request::<ReadConfigSnapshot>(&SnapshotRef { id: first })
            .await
            .unwrap()
            .unwrap();
        assert_eq!(kept.content, "{\"model\":\"a\"}\n");

        // The hash the client read is stale now: a conflict, and nothing
        // changes.
        let stale = client
            .request::<WriteConfigFile>(&write_request(
                &served.project,
                &settings,
                "{\"model\":\"c\"}\n",
                Some(read.hash),
            ))
            .await
            .unwrap();
        assert!(!stale.ok);
        assert_eq!(
            stale.conflict.unwrap().on_disk_content,
            "{\"model\":\"b\"}\n"
        );
        assert_eq!(text(&settings), "{\"model\":\"b\"}\n");
        assert_eq!(served.snapshot_count(), 1);

        let restored = client
            .request::<RestoreConfigSnapshot>(&RestoreSnapshotRequest {
                id: first,
                path: file(&settings),
            })
            .await
            .unwrap();
        assert!(restored.ok, "{restored:?}");
        assert_eq!(text(&settings), "{\"model\":\"a\"}\n");
        let history = client
            .request::<ListConfigSnapshots>(&ScopedFile {
                scope_path: scope(&served.project),
                path: file(&settings),
            })
            .await
            .unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].reason, ConfigWriteReason::Restore);
        let before_restore = client
            .request::<ReadConfigSnapshot>(&SnapshotRef { id: history[0].id })
            .await
            .unwrap()
            .unwrap();
        assert_eq!(before_restore.content, "{\"model\":\"b\"}\n");
        served.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn when_no_snapshot_can_be_taken_every_change_aborts_with_a_sentence_and_the_files_stay()
    {
        let served = Served::start();
        let settings = served.project.join(".claude/settings.json");
        put(&settings, "{\"model\":\"a\"}\n");
        let skill = served.project.join(".claude/skills/review/SKILL.md");
        put(&skill, "---\nname: review\n---\nbody\n");
        let mut client = served.client().await;
        let first = client
            .request::<WriteConfigFile>(&write_request(
                &served.project,
                &settings,
                "{\"model\":\"b\"}\n",
                Some(hash_content("{\"model\":\"a\"}\n")),
            ))
            .await
            .unwrap()
            .snapshot_id
            .unwrap();
        served.break_snapshots();
        let scope_path = scope(&served.project);

        let write = client
            .request::<WriteConfigFile>(&write_request(
                &served.project,
                &settings,
                "{\"model\":\"c\"}\n",
                Some(hash_content("{\"model\":\"b\"}\n")),
            ))
            .await
            .map(drop);
        let create = client
            .request::<CreateConfigFile>(&CreateConfigRequest {
                scope_path: scope_path.clone(),
                kind: CreatableKind::Command,
                name: "deploy".to_owned(),
            })
            .await
            .map(drop);
        let rename = client
            .request::<RenameConfigFile>(&RenameConfigRequest {
                scope_path: scope_path.clone(),
                path: file(&skill),
                name: "audit".to_owned(),
            })
            .await
            .map(drop);
        let delete = client
            .request::<DeleteConfigFile>(&DeleteConfigRequest {
                scope_path: scope_path.clone(),
                path: file(&skill),
            })
            .await
            .map(drop);
        let restore = client
            .request::<RestoreConfigSnapshot>(&RestoreSnapshotRequest {
                id: first,
                path: file(&settings),
            })
            .await
            .map(drop);
        let add = client
            .request::<AddMcpServer>(&McpAddRequest {
                scope: McpScope::Project,
                name: "docs".to_owned(),
                json: "{\"command\":\"node\"}".to_owned(),
                cwd: file(&served.project),
            })
            .await
            .map(drop);

        for (what, outcome) in [
            ("write", write),
            ("create", create),
            ("rename", rename),
            ("delete", delete),
            ("restore", restore),
            ("mcp add", add),
        ] {
            let refused = outcome.expect_err(what);
            assert!(refused.message.contains("snapshot"), "{what}: {refused:?}");
        }
        assert_eq!(text(&settings), "{\"model\":\"b\"}\n");
        assert_eq!(text(&skill), "---\nname: review\n---\nbody\n");
        assert!(!served.project.join(".claude/commands/deploy.md").exists());
        assert!(!served.project.join(".claude/skills/audit").exists());
        assert!(!served.project.join(".mcp.json").exists());

        // The client is served on.
        assert!(client.request::<ListConfigScopes>(&()).await.is_ok());
        served.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_watching_client_is_told_of_an_outside_change_and_not_of_a_write_through_the_host() {
        let served = Served::start();
        let notes = served.claude.join("CLAUDE.md");
        put(&notes, "one\n");
        let mut editor = served.client().await;
        editor
            .subscribe_quietly(7, ConfigChangedOutside::NAME)
            .await;
        editor
            .request::<WatchConfigFile>(&WatchConfigRequest {
                path: Some(file(&notes)),
            })
            .await
            .unwrap();

        // A write through the host sends nothing.
        let written = editor
            .request::<WriteConfigFile>(&write_request(
                &served.claude,
                &notes,
                "two\n",
                Some(hash_content("one\n")),
            ))
            .await
            .unwrap();
        assert!(written.ok, "{written:?}");
        assert_eq!(
            next_change(&mut editor, 7, Duration::from_millis(900)).await,
            None
        );

        // An edit from elsewhere is told, with the path and the new hash.
        std::fs::write(&notes, "three\n").unwrap();
        let change = next_change(&mut editor, 7, PATIENCE)
            .await
            .expect("the outside change is told");
        assert!(same(&change.path, &notes), "{change:?}");
        assert_eq!(change.hash, hash_content("three\n"));
        assert!(change.exists);

        // The editor goes: its watch goes with it, so nobody is told of the
        // next change.
        drop(editor);
        let mut other = served.client().await;
        other.subscribe_quietly(8, ConfigChangedOutside::NAME).await;
        assert!(other.request::<ListConfigScopes>(&()).await.is_ok());
        tokio::time::sleep(Duration::from_millis(300)).await;
        std::fs::write(&notes, "four\n").unwrap();
        assert_eq!(
            next_change(&mut other, 8, Duration::from_millis(900)).await,
            None
        );
        served.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn mcp_servers_and_the_doctor_run_the_agents_own_commands_and_changes_are_snapshotted_first()
     {
        let served = Served::start();
        let mut client = served.client().await;
        let mcp = served.project.join(".mcp.json");
        let add = McpAddRequest {
            scope: McpScope::Project,
            name: "docs".to_owned(),
            json: "{\"command\":\"node\",\"args\":[\"docs.js\"]}".to_owned(),
            cwd: file(&served.project),
        };

        let preview = client.request::<PreviewMcpServer>(&add).await.unwrap();
        assert_eq!(preview.error, None);
        assert!(same(&preview.file, &mcp));
        assert!(
            preview
                .diff
                .iter()
                .any(|line| line.sign == McpDiffSign::Added && line.text.contains("\"docs\""))
        );
        assert!(!mcp.exists(), "a preview runs nothing");

        let added = client.request::<AddMcpServer>(&add).await.unwrap();
        assert!(added.ok, "{added:?}");
        assert!(
            added
                .output
                .contains("Added stdio MCP server docs to project config"),
            "{}",
            added.output
        );
        assert_eq!(
            json_of(&mcp)["mcpServers"]["docs"],
            json!({"command": "node", "args": ["docs.js"]})
        );
        let history = client
            .request::<ListConfigSnapshots>(&ScopedFile {
                scope_path: scope(&served.project),
                path: file(&mcp),
            })
            .await
            .unwrap();
        assert_eq!(history[0].reason, ConfigWriteReason::Mcp);
        assert_eq!(Some(history[0].id), added.snapshot_id);

        let listed = client
            .request::<ListMcpServers>(&McpListRequest {
                cwd: file(&served.project),
            })
            .await
            .unwrap();
        assert!(listed.ok);
        assert!(
            listed.output.contains("docs: node docs.js"),
            "{}",
            listed.output
        );

        let local = served.project.join(".claude/settings.local.json");
        let approved = client
            .request::<ApproveMcpServer>(&McpApproveRequest {
                cwd: file(&served.project),
                name: "docs".to_owned(),
                approved: true,
            })
            .await
            .unwrap();
        assert!(approved.ok, "{approved:?}");
        assert_eq!(json_of(&local), json!({"enabledMcpjsonServers": ["docs"]}));
        assert!(approved.snapshot_id.is_some());

        let before = text(&mcp);
        let removed = client
            .request::<RemoveMcpServer>(&McpRemoveRequest {
                name: "docs".to_owned(),
                scope: McpScope::Project,
                cwd: file(&served.project),
            })
            .await
            .unwrap();
        assert!(removed.ok, "{removed:?}");
        assert!(json_of(&mcp)["mcpServers"].get("docs").is_none());
        let kept = client
            .request::<ReadConfigSnapshot>(&SnapshotRef {
                id: removed.snapshot_id.unwrap(),
            })
            .await
            .unwrap()
            .unwrap();
        assert_eq!(kept.content, before);

        let report = client.request::<RunDoctor>(&()).await.unwrap();
        assert_eq!(report.exit_code, Some(0));
        assert!(
            report.output.starts_with("Diagnostics"),
            "{}",
            report.output
        );
        assert!(
            report
                .rows
                .iter()
                .any(|row| row.label == "Auto-update channel" && row.value == "latest")
        );
        served.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_slow_doctor_keeps_no_other_client_waiting() {
        let served = Served::start();
        put(
            &served.claude.join("fake-doctor.json"),
            &json!({"output": "Diagnostics\nSearch: ok", "exitCode": 0, "delayMs": 3000})
                .to_string(),
        );
        let mut slow = served.client().await;
        let mut quick = served.client().await;

        let doctor = async {
            let report = slow.request::<RunDoctor>(&()).await.unwrap();
            (report, Instant::now())
        };
        let scopes = async {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let started = Instant::now();
            let scopes = quick.request::<ListConfigScopes>(&()).await.unwrap();
            (scopes, started, Instant::now())
        };
        let ((report, doctor_done), (scopes, asked, answered)) = tokio::join!(doctor, scopes);
        assert_eq!(report.exit_code, Some(0));
        assert!(!scopes.is_empty());
        assert!(
            answered < doctor_done,
            "the other client was answered only after the doctor finished"
        );
        assert!(
            answered - asked < Duration::from_secs(2),
            "the other client waited {:?}",
            answered - asked
        );
        served.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_skill_command_or_agent_is_created_renamed_and_deleted_and_a_path_outside_the_scope_is_refused()
     {
        let served = Served::start();
        let scope_path = scope(&served.project);
        let mut client = served.client().await;

        let mut created = Vec::new();
        for (kind, name) in [
            (CreatableKind::Skill, "review"),
            (CreatableKind::Command, "ops/deploy"),
            (CreatableKind::Agent, "helper"),
        ] {
            let made = client
                .request::<CreateConfigFile>(&CreateConfigRequest {
                    scope_path: scope_path.clone(),
                    kind,
                    name: name.to_owned(),
                })
                .await
                .unwrap();
            assert!(made.ok, "{made:?}");
            created.push(made);
        }
        assert_eq!(
            created[0].rel_path.as_deref(),
            Some(".claude/skills/review/SKILL.md")
        );
        assert_eq!(
            created[1].rel_path.as_deref(),
            Some(".claude/commands/ops/deploy.md")
        );
        assert_eq!(
            created[2].rel_path.as_deref(),
            Some(".claude/agents/helper.md")
        );
        let escape = client
            .request::<CreateConfigFile>(&CreateConfigRequest {
                scope_path: scope_path.clone(),
                kind: CreatableKind::Command,
                name: "../escape".to_owned(),
            })
            .await
            .unwrap();
        assert!(!escape.ok);
        assert!(!served.project.join("escape.md").exists());

        let skill = PathBuf::from(created[0].path.clone().unwrap());
        let renamed = client
            .request::<RenameConfigFile>(&RenameConfigRequest {
                scope_path: scope_path.clone(),
                path: file(&skill),
                name: "audit".to_owned(),
            })
            .await
            .unwrap();
        assert!(renamed.ok, "{renamed:?}");
        assert!(!served.project.join(".claude/skills/review").exists());
        assert!(
            text(&served.project.join(".claude/skills/audit/SKILL.md")).contains("name: audit")
        );

        let agent = PathBuf::from(created[2].path.clone().unwrap());
        let deleted = client
            .request::<DeleteConfigFile>(&DeleteConfigRequest {
                scope_path: scope_path.clone(),
                path: file(&agent),
            })
            .await
            .unwrap();
        assert!(deleted.ok);
        assert!(!agent.exists());

        let outside = served.other.join(".claude/agents/theirs.md");
        put(&outside, "---\nname: theirs\n---\n");
        let snapshots = served.snapshot_count();
        let rename = client
            .request::<RenameConfigFile>(&RenameConfigRequest {
                scope_path: scope_path.clone(),
                path: file(&outside),
                name: "mine".to_owned(),
            })
            .await
            .unwrap_err();
        assert!(
            rename
                .message
                .contains("is not a configuration file in my project"),
            "{rename:?}"
        );
        let delete = client
            .request::<DeleteConfigFile>(&DeleteConfigRequest {
                scope_path,
                path: file(&outside),
            })
            .await
            .unwrap_err();
        assert!(
            delete
                .message
                .contains("is not a configuration file in my project"),
            "{delete:?}"
        );
        assert!(outside.exists());
        assert_eq!(served.snapshot_count(), snapshots);
        served.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_host_whose_agents_have_no_config_console_says_so_on_every_config_channel() {
        let served = Served::start_on(|dirs, _| {
            vec![Arc::new(shell_backend(&dirs.user_env())) as Arc<dyn AgentBackend>]
        });
        let mut client = served.client().await;
        let scopes = client.request::<ListConfigScopes>(&()).await.unwrap_err();
        let doctor = client.request::<RunDoctor>(&()).await.unwrap_err();
        let read = client
            .request::<ReadConfigFile>(&ConfigPath {
                path: file(&served.project),
            })
            .await
            .unwrap_err();
        for refused in [scopes, doctor, read] {
            assert_eq!(
                refused.message, "No agent on this host has a config console.",
                "{refused:?}"
            );
        }
        served.stop().await;
    }
}
