//! Launch and live sessions, and plain terminals, as a client of the host
//! sees them: every launch path through the agent backends, closing with a
//! confirmation, renaming, plain terminals, and the activity and overview
//! read from each backend's own records. Driven against the fake `claude`
//! (`test/fake-agents/claude-code.mjs`) and the fake agent, never a real
//! agent.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use floti_host::agent::AgentBackend;
use floti_host::agent::claude_code::ClaudeCodeSettings;
use floti_host::fake_agent;
use floti_host::platform::process_tree::{Native as NativeTree, ProcessTree};
use floti_host::platform::socket::Endpoint;
use floti_host::server::HostConfig;
use floti_host::testkit::{
    FakeAgent, FakeAgentRecord, PATIENCE, RunningHost, TestClient, TestDirs,
};
use floti_protocol::channel::EventChannel;
use floti_protocol::channel::from_payload;
use floti_protocol::channels::common::{PermissionMode, SessionRecord, SessionStatus};
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::sessions::{
    CloseSessionRequest, EffortLevel, HistoryResume, LaunchProfileRequest, LaunchSessionRequest,
    LiveSession, ProfileLaunch, PtermClose, PtermCloseRequest, PtermOpen, PtermOpenRequest,
    PtermResize, PtermResizeRequest, PtermShells, PtermStreamOpen, RenameSessionRequest,
    ResumeSessionRequest, SessionActivity, SessionActivityState, SessionClose,
    SessionConfirmAnswer, SessionConfirmKind, SessionConfirmRequest, SessionConfirmed, SessionExit,
    SessionFocus, SessionFocusRequest, SessionLaunch, SessionList, SessionNotify, SessionRename,
    SessionStart, SessionsOverview, StartSessionRequest,
};
use floti_protocol::{BackendId, Knowable, Message};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

const TERMINAL: &[&str] = &["terminal"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// A host whose one backend is the fake agent.
fn fake_config(
    dirs: &TestDirs,
    endpoint: &Endpoint,
    agent: &FakeAgent,
    args: &[&str],
) -> HostConfig {
    HostConfig {
        folders: dirs.folders(),
        endpoint: endpoint.clone(),
        backends: vec![Arc::new(agent.backend(args.iter().copied())) as Arc<dyn AgentBackend>],
        inherited_env: std::env::vars_os().collect(),
    }
}

/// The fake `claude`, run by Node.
fn fake_claude() -> PathBuf {
    resolved(
        &Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("test")
            .join("fake-agents")
            .join("claude-code.mjs"),
    )
}

/// `path` with links resolved, in the form a process reports its own folder
/// in (no `\\?\` on Windows).
fn resolved(path: &Path) -> PathBuf {
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let text = canonical.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(plain) => PathBuf::from(plain),
        None => canonical,
    }
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Today's backends, the shell first and then Claude Code, whose `claude`
/// is the fake keeping its records in `claude_config`.
fn todays_backends(dirs: &TestDirs, endpoint: &Endpoint, claude_config: &Path) -> HostConfig {
    let claude = ClaudeCodeSettings {
        program: "node".into(),
        leading_args: vec![fake_claude().into_os_string()],
        config_dir: claude_config.to_path_buf(),
        pass_config_dir: true,
        api_key_set: false,
    };
    HostConfig {
        folders: dirs.folders(),
        endpoint: endpoint.clone(),
        backends: floti_host::server::backends(&dirs.user_env(), Some(claude)),
        inherited_env: std::env::vars_os().collect(),
    }
}

/// A Claude Code world: a host on today's backends over a fake `claude`.
struct ClaudeWorld {
    dirs: TestDirs,
    endpoint: Endpoint,
    config: PathBuf,
}

impl ClaudeWorld {
    fn new() -> Self {
        let dirs = TestDirs::new();
        let endpoint = dirs.endpoint();
        let config = resolved(&dirs.folder("claude config"));
        Self {
            dirs,
            endpoint,
            config,
        }
    }

    fn host(&self) -> RunningHost {
        RunningHost::start(todays_backends(&self.dirs, &self.endpoint, &self.config))
    }

    async fn client(&self) -> TestClient {
        TestClient::connect(&self.endpoint, TERMINAL).await
    }

    fn folder(&self, name: &str) -> PathBuf {
        resolved(&self.dirs.folder(name))
    }

    /// The host's database, as a test writes fixtures into it.
    fn db(&self) -> rusqlite::Connection {
        let db =
            rusqlite::Connection::open(self.dirs.data.join("floti.db")).expect("open floti.db");
        db.busy_timeout(PATIENCE)
            .expect("wait for the host's writes");
        db
    }

    /// A saved profile, as the profiles editor writes one.
    fn profile(&self, profile: &ProfileRow<'_>) -> u64 {
        let db = self.db();
        db.execute(
            "INSERT INTO profiles (name, root, overlays, access, model, effort, permission_mode, agent, opening_prompt) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                profile.name,
                text(profile.root),
                json!(profile.overlays.iter().map(|p| text(p)).collect::<Vec<_>>()).to_string(),
                json!(profile.access.iter().map(|p| text(p)).collect::<Vec<_>>()).to_string(),
                profile.model,
                profile.effort,
                profile.permission_mode,
                profile.agent,
                profile.opening_prompt,
            ],
        )
        .expect("insert a profile");
        u64::try_from(db.last_insert_rowid()).unwrap()
    }

    /// Where the CLI keeps `conversation`'s transcript.
    fn transcript(&self, conversation: &str) -> PathBuf {
        self.config
            .join("projects")
            .join("indexed")
            .join(format!("{conversation}.jsonl"))
    }

    /// A conversation the CLI had in `project`, as its prompt in the prompt
    /// record and its transcript, for the history index to take in, as the
    /// CLI leaves them. Rows written straight into the index would be
    /// dropped by its next pass, which builds them from what the CLI keeps.
    fn history(&self, conversation: &str, project: &Path) {
        let file = self.transcript(conversation);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let row = json!({
            "type": "user",
            "uuid": format!("{conversation}-1"),
            "sessionId": conversation,
            "cwd": text(project),
            "timestamp": "2026-10-01T10:00:00.000Z",
            "message": { "role": "user", "content": "fix the export" },
        });
        std::fs::write(&file, format!("{row}\n")).unwrap();
        let prompt = json!({
            "display": "fix the export",
            "pastedContents": {},
            "timestamp": 1_790_848_800_000_u64,
            "project": text(project),
            "sessionId": conversation,
        });
        let record = self.config.join("history.jsonl");
        let mut prompts = std::fs::read_to_string(&record).unwrap_or_default();
        prompts.push_str(&format!("{prompt}\n"));
        std::fs::write(&record, prompts).unwrap();
    }

    /// Waits until the history index holds `conversation`.
    async fn indexed(&self, conversation: &str) {
        let deadline = Instant::now() + PATIENCE;
        loop {
            let found: Option<String> = self
                .db()
                .query_row(
                    "SELECT session_id FROM history_sessions WHERE session_id = ?1",
                    [conversation],
                    |row| row.get(0),
                )
                .ok();
            if found.is_some() {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "{conversation} was never indexed"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// Every run the fake `claude` logged.
    fn runs(&self) -> Vec<Value> {
        let Ok(entries) = std::fs::read_dir(self.config.join("fake-agent")) else {
            return Vec::new();
        };
        entries
            .filter_map(|entry| {
                let path = entry.ok()?.path();
                if path.extension()? != "json" {
                    return None;
                }
                serde_json::from_slice(&std::fs::read(path).ok()?).ok()
            })
            .collect()
    }

    /// The fake `claude`'s run whose arguments `matches`, waiting for it.
    fn run(&self, matches: impl Fn(&[String]) -> bool) -> Value {
        let deadline = Instant::now() + PATIENCE;
        loop {
            if let Some(run) = self.runs().into_iter().find(|run| matches(&argv_of(run))) {
                return run;
            }
            assert!(
                Instant::now() < deadline,
                "the fake claude logged no such run: {:?}",
                self.runs()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// The run in `folder`, waiting for it.
    fn run_in(&self, folder: &Path) -> Value {
        let deadline = Instant::now() + PATIENCE;
        loop {
            if let Some(run) = self
                .runs()
                .into_iter()
                .find(|run| run_folder(run) == folder)
            {
                return run;
            }
            assert!(Instant::now() < deadline, "no run in {}", folder.display());
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

struct ProfileRow<'a> {
    name: &'a str,
    root: &'a Path,
    overlays: &'a [PathBuf],
    access: &'a [PathBuf],
    model: Option<&'a str>,
    effort: Option<&'a str>,
    permission_mode: Option<&'a str>,
    agent: Option<&'a str>,
    opening_prompt: Option<&'a str>,
}

impl<'a> ProfileRow<'a> {
    fn at(name: &'a str, root: &'a Path) -> Self {
        Self {
            name,
            root,
            overlays: &[],
            access: &[],
            model: None,
            effort: None,
            permission_mode: None,
            agent: None,
            opening_prompt: None,
        }
    }
}

fn argv_of(run: &Value) -> Vec<String> {
    run["argv"]
        .as_array()
        .map(|args| {
            args.iter()
                .filter_map(|arg| arg.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn run_folder(run: &Value) -> PathBuf {
    resolved(Path::new(run["cwd"].as_str().unwrap_or_default()))
}

/// The value after `flag` in `argv`.
fn flag<'a>(argv: &'a [String], flag: &str) -> Option<&'a str> {
    argv.windows(2)
        .find(|pair| pair[0] == flag)
        .map(|pair| pair[1].as_str())
}

fn has(argv: &[String], arg: &str) -> bool {
    argv.iter().any(|a| a == arg)
}

/// A harness in Claude's shape, with a skill to compose.
fn claude_shaped_harness(root: &Path) {
    let skill = root.join(".claude").join("skills").join("think");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(
        skill.join("SKILL.md"),
        "---\ndescription: think it through\n---\nthink",
    )
    .unwrap();
}

fn launch_request(folder: &Path) -> LaunchSessionRequest {
    LaunchSessionRequest {
        cwd: text(folder),
        project_path: None,
        name: None,
        profile_id: None,
        permission_mode: None,
        resume: None,
        backend: Some(BackendId::claude_code()),
        cols: 80,
        rows: 24,
    }
}

fn start_request(folder: &Path) -> StartSessionRequest {
    StartSessionRequest {
        cwd: text(folder),
        cols: 80,
        rows: 24,
        ..StartSessionRequest::default()
    }
}

/// The next event or snapshot on `subscription` that `wanted` accepts.
async fn next_on<T: DeserializeOwned + std::fmt::Debug>(
    client: &mut TestClient,
    subscription: u64,
    wanted: impl Fn(&T) -> bool,
) -> T {
    let deadline = Instant::now() + PATIENCE;
    let mut seen = Vec::new();
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let payload = match client.next(left).await {
            Some(Message::Event(event)) if event.subscription == subscription => event.payload,
            Some(Message::Snapshot(snapshot)) if snapshot.subscription == subscription => {
                snapshot.state
            }
            Some(_) => continue,
            None => panic!("nothing wanted on subscription {subscription}; saw {seen:#?}"),
        };
        let value: T = from_payload(&payload).expect("decode a publication");
        if wanted(&value) {
            return value;
        }
        seen.push(value);
    }
}

/// Waits until every process in `pids` has ended.
async fn assert_all_end(pids: &[u32]) {
    let deadline = Instant::now() + PATIENCE;
    loop {
        let alive: Vec<u32> = pids
            .iter()
            .copied()
            .filter(|pid| NativeTree.is_alive(*pid) != Knowable::Known(false))
            .collect();
        if alive.is_empty() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "processes still running after {PATIENCE:?}: {alive:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// The fake agent's run in `folder` and every child it started.
fn tree_in(agent: &FakeAgent, folder: &Path) -> Vec<u32> {
    let deadline = Instant::now() + PATIENCE;
    let real = resolved(folder);
    let run: FakeAgentRecord = loop {
        if let Some(run) = agent
            .records()
            .into_iter()
            .find(|record| Path::new(&record.cwd) == folder || Path::new(&record.cwd) == real)
        {
            break run;
        }
        assert!(Instant::now() < deadline, "no run in {}", folder.display());
        std::thread::sleep(Duration::from_millis(20));
    };
    let run = agent.wait_for_record(run.pid, PATIENCE, |record| !record.children.is_empty());
    std::iter::once(run.pid).chain(run.children).collect()
}

fn listed_ids(sessions: &[SessionRecord]) -> Vec<u64> {
    sessions.iter().map(|session| session.id).collect()
}

// ---------------------------------------------------------------------------
// Starting a session
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_start_carries_the_whole_composition_to_the_agent_in_the_requested_folder() {
    let world = ClaudeWorld::new();
    let host = world.host();
    let mut client = world.client().await;
    let project = world.folder("work/cloud sync");
    let harness = world.folder("harness");
    claude_shaped_harness(&harness);
    let access = world.folder("repos/a");
    let profile_access = world.folder("repos/b");
    let elsewhere = world.folder("the profile's root");
    let profile = world.profile(&ProfileRow {
        model: Some("sonnet"),
        agent: Some("planner"),
        access: std::slice::from_ref(&profile_access),
        opening_prompt: Some("the profile's prompt"),
        ..ProfileRow::at("Cloud", &elsewhere)
    });

    let started = client
        .request::<SessionStart>(&StartSessionRequest {
            backend: Some(BackendId::claude_code()),
            name: Some("cloud".into()),
            project_path: Some(text(&project)),
            profile_id: Some(profile),
            overlays: Some(vec![text(&harness)]),
            extra_folders: Some(vec![text(&access)]),
            model: Some("opus".into()),
            effort: Some(EffortLevel::High),
            permission_mode: Some(PermissionMode::Plan),
            opening_prompt: Some("review this".into()),
            ..start_request(&project)
        })
        .await
        .expect("start a composed session");
    assert_eq!(started.backend, BackendId::claude_code());
    assert_eq!(Path::new(&started.cwd), project);

    let run = world.run_in(&project);
    let argv = argv_of(&run);
    // Each choice the request makes replaces the profile's; one it leaves
    // keeps the profile's. The folder is the request's, never the root.
    assert_eq!(flag(&argv, "--model"), Some("opus"), "{argv:?}");
    assert_eq!(flag(&argv, "--effort"), Some("high"), "{argv:?}");
    assert_eq!(flag(&argv, "--agent"), Some("planner"), "{argv:?}");
    assert_eq!(flag(&argv, "--permission-mode"), Some("plan"), "{argv:?}");
    assert_eq!(flag(&argv, "-n"), Some("cloud"), "{argv:?}");
    assert!(has(&argv, &text(&access)), "{argv:?}");
    assert!(!has(&argv, &text(&profile_access)), "{argv:?}");
    assert!(
        has(&argv, "--plugin-dir"),
        "the overlay is composed: {argv:?}"
    );
    assert_eq!(run["openingPrompt"], "review this", "{run}");
    assert_eq!(
        run["sessionId"].as_str(),
        started.conversation_id.as_deref()
    );

    // The row records where it came from.
    let (profile_id, mode, project_path): (Option<i64>, Option<String>, Option<String>) = world
        .db()
        .query_row(
            "SELECT profile_id, permission_mode, project_path FROM sessions WHERE id = ?1",
            [i64::try_from(started.id).unwrap()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(profile_id, Some(i64::try_from(profile).unwrap()));
    assert_eq!(mode.as_deref(), Some("plan"));
    assert_eq!(project_path, Some(text(&project)));
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_start_in_a_folder_that_is_not_there_is_refused_in_a_sentence() {
    let world = ClaudeWorld::new();
    let host = world.host();
    let mut client = world.client().await;
    let gone = world.folder("somewhere").join("not here");
    let refused = client
        .request::<SessionStart>(&start_request(&gone))
        .await
        .expect_err("no folder, no session");
    assert!(refused.message.contains("is not a folder"), "{refused:?}");
    assert_eq!(client.request::<SessionList>(&()).await.unwrap(), vec![]);
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_profile_launch_runs_at_its_root_named_after_it_in_its_own_permission_mode() {
    let world = ClaudeWorld::new();
    let host = world.host();
    let mut client = world.client().await;
    let root = world.folder("reviewer root");
    let profile = world.profile(&ProfileRow {
        permission_mode: Some("acceptEdits"),
        effort: Some("max"),
        opening_prompt: Some("look at the diff"),
        ..ProfileRow::at("Reviewer", &root)
    });

    let launched = client
        .request::<ProfileLaunch>(&LaunchProfileRequest {
            profile_id: profile,
            cols: 100,
            rows: 30,
        })
        .await
        .expect("launch the profile");
    assert_eq!(launched.profile.id, profile);
    assert_eq!(launched.profile.name, "Reviewer");
    assert_eq!(launched.session.backend, BackendId::claude_code());
    assert_eq!(launched.session.name, "Reviewer");
    assert_eq!(Path::new(&launched.session.cwd), root);

    let run = world.run_in(&root);
    let argv = argv_of(&run);
    assert_eq!(
        flag(&argv, "--permission-mode"),
        Some("acceptEdits"),
        "{argv:?}"
    );
    assert_eq!(flag(&argv, "--effort"), Some("max"), "{argv:?}");
    assert_eq!(flag(&argv, "-n"), Some("Reviewer"), "{argv:?}");
    assert_eq!(run["openingPrompt"], "look at the diff", "{run}");

    let gone = client
        .request::<ProfileLaunch>(&LaunchProfileRequest {
            profile_id: profile + 100,
            cols: 80,
            rows: 24,
        })
        .await
        .expect_err("a deleted profile does not launch");
    assert!(gone.message.contains("no longer exists"), "{gone:?}");
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_launchers_permission_none_passes_no_flag_whatever_the_profile_says() {
    let world = ClaudeWorld::new();
    let host = world.host();
    let mut client = world.client().await;
    let root = world.folder("profile root");
    let profile = world.profile(&ProfileRow {
        permission_mode: Some("plan"),
        model: Some("opus"),
        ..ProfileRow::at("Planner", &root)
    });

    let quiet = world.folder("no flag");
    let launched = client
        .request::<SessionLaunch>(&LaunchSessionRequest {
            profile_id: Some(profile),
            permission_mode: None,
            ..launch_request(&quiet)
        })
        .await
        .expect("launch with the profile and no permission mode");
    assert_eq!(Path::new(&launched.session.cwd), quiet);
    let argv = argv_of(&world.run_in(&quiet));
    assert!(!has(&argv, "--permission-mode"), "{argv:?}");
    assert_eq!(
        flag(&argv, "--model"),
        Some("opus"),
        "the profile composes: {argv:?}"
    );

    let chosen = world.folder("a flag");
    client
        .request::<SessionLaunch>(&LaunchSessionRequest {
            profile_id: Some(profile),
            permission_mode: Some(PermissionMode::AcceptEdits),
            ..launch_request(&chosen)
        })
        .await
        .expect("launch with the launcher's own permission mode");
    let argv = argv_of(&world.run_in(&chosen));
    assert_eq!(
        flag(&argv, "--permission-mode"),
        Some("acceptEdits"),
        "{argv:?}"
    );
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// Resuming from history
// ---------------------------------------------------------------------------

const CONVERSATION: &str = "0b5f2c1e-8d1a-4c3e-9f00-1a2b3c4d5e6f";

fn assert_resumed(run: &Value, folder: &Path) {
    assert_eq!(run["exitCode"], Value::Null, "the resume failed: {run}");
    assert_eq!(run["resumed"], true, "{run}");
    assert_eq!(run["sessionId"], CONVERSATION, "{run}");
    assert_eq!(run_folder(run), folder);
    assert_eq!(run["openingPrompt"], Value::Null, "{run}");
    let argv = argv_of(run);
    for new_only in ["-n", "--session-id"] {
        assert!(!has(&argv, new_only), "{argv:?}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_conversation_from_history_resumes_in_its_recorded_folder_on_its_backend() {
    let world = ClaudeWorld::new();
    let project = world.folder("the export");
    world.history(CONVERSATION, &project);
    let host = world.host();
    let mut client = world.client().await;
    world.indexed(CONVERSATION).await;

    // The host's default backend is the shell; the conversation is Claude
    // Code's and runs there.
    let resumed = client
        .request::<HistoryResume>(&ResumeSessionRequest {
            session_id: CONVERSATION.into(),
            cols: 80,
            rows: 24,
        })
        .await
        .expect("resume from history");
    assert_eq!(resumed.session.backend, BackendId::claude_code());
    assert_eq!(Path::new(&resumed.session.cwd), project);
    assert_eq!(resumed.history.session_id, CONVERSATION);
    assert_eq!(
        resumed.session.conversation_id.as_deref(),
        Some(CONVERSATION)
    );
    let run = world.run(|argv| flag(argv, "--resume") == Some(CONVERSATION));
    assert_resumed(&run, &project);
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_launchers_resume_runs_in_the_folder_history_recorded_not_the_one_picked() {
    let world = ClaudeWorld::new();
    let project = world.folder("the export");
    let picked = world.folder("somewhere else");
    world.history(CONVERSATION, &project);
    let host = world.host();
    let mut client = world.client().await;
    world.indexed(CONVERSATION).await;

    let launched = client
        .request::<SessionLaunch>(&LaunchSessionRequest {
            resume: Some(CONVERSATION.into()),
            backend: None,
            ..launch_request(&picked)
        })
        .await
        .expect("resume from the launcher");
    assert_eq!(launched.session.backend, BackendId::claude_code());
    assert_eq!(Path::new(&launched.session.cwd), project);
    let run = world.run(|argv| flag(argv, "--resume") == Some(CONVERSATION));
    assert_resumed(&run, &project);
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_conversation_whose_folder_or_transcript_is_gone_is_refused_in_a_sentence() {
    let world = ClaudeWorld::new();
    let removed = world.folder("removed project");
    world.history("aaaaaaaa-0000-4000-8000-000000000001", &removed);
    std::fs::remove_dir_all(&removed).unwrap();
    let kept = world.folder("kept project");
    world.history("aaaaaaaa-0000-4000-8000-000000000002", &kept);
    let host = world.host();
    let mut client = world.client().await;
    world.indexed("aaaaaaaa-0000-4000-8000-000000000001").await;
    world.indexed("aaaaaaaa-0000-4000-8000-000000000002").await;
    // The CLI has since cleaned the second one's transcript away.
    std::fs::remove_file(world.transcript("aaaaaaaa-0000-4000-8000-000000000002")).unwrap();

    let resume = |id: &str| ResumeSessionRequest {
        session_id: id.into(),
        cols: 80,
        rows: 24,
    };
    let folder_gone = client
        .request::<HistoryResume>(&resume("aaaaaaaa-0000-4000-8000-000000000001"))
        .await
        .expect_err("its folder is gone");
    assert!(
        folder_gone.message.contains("is no longer on disk")
            && folder_gone.message.contains(&text(&removed)),
        "{folder_gone:?}"
    );
    let transcript_gone = client
        .request::<HistoryResume>(&resume("aaaaaaaa-0000-4000-8000-000000000002"))
        .await
        .expect_err("its transcript is gone");
    assert!(
        transcript_gone
            .message
            .contains("has removed this conversation's transcript"),
        "{transcript_gone:?}"
    );
    let unknown = client
        .request::<SessionLaunch>(&LaunchSessionRequest {
            resume: Some("not-in-the-index".into()),
            ..launch_request(&kept)
        })
        .await
        .expect_err("not in the index");
    assert!(
        unknown.message.contains("not in the history index"),
        "{unknown:?}"
    );
    assert_eq!(client.request::<SessionList>(&()).await.unwrap(), vec![]);
    assert!(world.runs().is_empty(), "no agent ran: {:?}", world.runs());
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// Closing and renaming
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn closing_a_running_session_asks_first_and_ends_its_tree_only_on_yes() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = RunningHost::start(fake_config(&dirs, &endpoint, &agent, &["--fake-child"]));
    let folder = dirs.folder("a project");
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    let mut other = TestClient::connect(&endpoint, TERMINAL).await;
    client.subscribe_quietly(3, "session:confirm").await;
    client.subscribe_quietly(4, "session:exit").await;
    other.subscribe_quietly(4, "session:exit").await;

    let session = client
        .request::<SessionStart>(&StartSessionRequest {
            name: Some("export fix".into()),
            ..start_request(&folder)
        })
        .await
        .unwrap();
    let tree = tree_in(&agent, &folder);

    // Not forced: the host asks, and the session runs on.
    let answer = client
        .request::<SessionClose>(&CloseSessionRequest {
            id: session.id,
            force: false,
        })
        .await
        .unwrap();
    assert!(!answer.closed);
    let question: SessionConfirmRequest =
        next_on(&mut client, 3, |_: &SessionConfirmRequest| true).await;
    assert_eq!(question.kind, SessionConfirmKind::CloseSession);
    assert_eq!(
        question.message,
        "\u{201c}export fix\u{201d} is still running."
    );
    assert!(question.detail.contains(&session.cwd), "{question:?}");
    assert_eq!(question.confirm_label, "End session");
    assert_eq!(question.session_names, ["export fix"]);

    // No ends nothing, and a question is answered once.
    client
        .request::<SessionConfirmed>(&SessionConfirmAnswer {
            id: question.id,
            agreed: false,
        })
        .await
        .unwrap();
    client
        .request::<SessionConfirmed>(&SessionConfirmAnswer {
            id: question.id,
            agreed: true,
        })
        .await
        .expect_err("a question is answered once");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        listed_ids(&client.request::<SessionList>(&()).await.unwrap()),
        [session.id]
    );
    assert!(
        tree.iter()
            .all(|pid| NativeTree.is_alive(*pid) == Knowable::Known(true))
    );

    // Yes ends the tree, records the exit and tells every client.
    client
        .request::<SessionClose>(&CloseSessionRequest {
            id: session.id,
            force: false,
        })
        .await
        .unwrap();
    let again: SessionConfirmRequest = next_on(&mut client, 3, |next: &SessionConfirmRequest| {
        next.id != question.id
    })
    .await;
    client
        .request::<SessionConfirmed>(&SessionConfirmAnswer {
            id: again.id,
            agreed: true,
        })
        .await
        .unwrap();
    assert_all_end(&tree).await;
    for client in [&mut client, &mut other] {
        let ended: SessionRecord = next_on(client, 4, |_: &SessionRecord| true).await;
        assert_eq!(ended.id, session.id);
        assert_eq!(ended.status, SessionStatus::Exited);
        assert!(ended.ended_at.is_some(), "{ended:?}");
    }
    assert_eq!(client.request::<SessionList>(&()).await.unwrap(), vec![]);
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_forced_close_ends_the_tree_at_once_and_a_closed_session_closes_again_quietly() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = RunningHost::start(fake_config(&dirs, &endpoint, &agent, &["--fake-child"]));
    let folder = dirs.folder("a project");
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    client.subscribe_quietly(3, "session:confirm").await;
    client.subscribe_quietly(4, "session:exit").await;
    let session = client
        .request::<SessionStart>(&start_request(&folder))
        .await
        .unwrap();
    let tree = tree_in(&agent, &folder);

    let force = CloseSessionRequest {
        id: session.id,
        force: true,
    };
    assert!(client.request::<SessionClose>(&force).await.unwrap().closed);
    assert_all_end(&tree).await;
    let ended: SessionRecord = next_on(&mut client, 4, |_: &SessionRecord| true).await;
    assert_eq!(ended.id, session.id);
    assert!(ended.exit_code.is_some(), "{ended:?}");
    // It has ended: closing it again is done, without a question.
    assert!(
        client
            .request::<SessionClose>(&CloseSessionRequest {
                id: session.id,
                force: false,
            })
            .await
            .unwrap()
            .closed
    );
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_name_is_made_unique_against_the_running_sessions_on_launch_and_rename() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = RunningHost::start(fake_config(&dirs, &endpoint, &agent, &[]));
    let folder = dirs.folder("helm");
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;

    let first = client
        .request::<SessionStart>(&start_request(&folder))
        .await
        .unwrap();
    let second = client
        .request::<SessionStart>(&start_request(&folder))
        .await
        .unwrap();
    assert_eq!(first.name, "helm");
    assert_eq!(second.name, "helm 2");

    // Against the other sessions, never itself, and ignoring case.
    let renamed = client
        .request::<SessionRename>(&RenameSessionRequest {
            id: second.id,
            label: Some("HELM".into()),
        })
        .await
        .unwrap();
    assert_eq!(renamed.label.as_deref(), Some("HELM 2"));
    let same = client
        .request::<SessionRename>(&RenameSessionRequest {
            id: first.id,
            label: Some("helm".into()),
        })
        .await
        .unwrap();
    assert_eq!(same.label.as_deref(), Some("helm"));
    let cleared = client
        .request::<SessionRename>(&RenameSessionRequest {
            id: second.id,
            label: Some("   ".into()),
        })
        .await
        .unwrap();
    assert_eq!(cleared.label, None);
    assert_eq!(cleared.name, second.name);

    // The list holds the row as renamed.
    let listed = client.request::<SessionList>(&()).await.unwrap();
    assert!(
        listed
            .iter()
            .any(|row| row.id == second.id && row.label.is_none())
    );

    // Which sessions a client can see is taken.
    client
        .request::<SessionFocus>(&SessionFocusRequest {
            ids: vec![first.id],
        })
        .await
        .unwrap();
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// Exit notifications
// ---------------------------------------------------------------------------

/// Where a client hears of exits.
const EXITS: u64 = 4;
/// Where a client is sent the exits worth an OS notification to it.
const NOTIFY: u64 = 5;

/// One event a client was sent, with its number.
#[derive(Debug)]
struct Heard {
    subscription: u64,
    seq: u64,
    session: SessionRecord,
}

/// Every event `client` is sent on [`EXITS`] and [`NOTIFY`] up to and
/// including session `id`'s exit. A notification goes out before its exit,
/// so whatever a client is sent for that exit is in what this returns.
async fn heard_until_exit_of(client: &mut TestClient, id: u64) -> Vec<Heard> {
    let deadline = Instant::now() + PATIENCE;
    let mut heard = Vec::new();
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let Some(message) = client.next(left).await else {
            panic!("no exit of session {id}; heard {heard:#?}");
        };
        let Message::Event(event) = message else {
            continue;
        };
        if event.subscription != EXITS && event.subscription != NOTIFY {
            continue;
        }
        let session: SessionRecord = from_payload(&event.payload).expect("a finished row");
        let done = event.subscription == EXITS && session.id == id;
        heard.push(Heard {
            subscription: event.subscription,
            seq: event.seq,
            session,
        });
        if done {
            return heard;
        }
    }
}

/// The sessions `heard` names on `subscription`, in the order sent.
fn sessions_on(heard: &[Heard], subscription: u64) -> Vec<u64> {
    heard
        .iter()
        .filter(|heard| heard.subscription == subscription)
        .map(|heard| heard.session.id)
        .collect()
}

/// The numbers of what `heard` holds on `subscription`, in the order sent.
fn numbers_on(heard: &[Heard], subscription: u64) -> Vec<u64> {
    heard
        .iter()
        .filter(|heard| heard.subscription == subscription)
        .map(|heard| heard.seq)
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn an_exit_is_sent_for_a_notification_only_to_the_clients_whose_user_cannot_see_the_session()
{
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = RunningHost::start(fake_config(&dirs, &endpoint, &agent, &[]));
    let folder = dirs.folder("a project");
    // One client whose user can see both sessions, one that sees only the
    // second, and one that never says what it sees.
    let mut watching = TestClient::connect(&endpoint, TERMINAL).await;
    let mut elsewhere = TestClient::connect(&endpoint, TERMINAL).await;
    let mut silent = TestClient::connect(&endpoint, TERMINAL).await;
    for client in [&mut watching, &mut elsewhere, &mut silent] {
        client.subscribe_quietly(EXITS, SessionExit::NAME).await;
        client.subscribe_quietly(NOTIFY, SessionNotify::NAME).await;
    }
    let first = watching
        .request::<SessionStart>(&start_request(&folder))
        .await
        .unwrap();
    let second = watching
        .request::<SessionStart>(&start_request(&folder))
        .await
        .unwrap();
    watching
        .request::<SessionFocus>(&SessionFocusRequest {
            ids: vec![first.id, second.id],
        })
        .await
        .unwrap();
    elsewhere
        .request::<SessionFocus>(&SessionFocusRequest {
            ids: vec![second.id],
        })
        .await
        .unwrap();

    // The first ends on its own: the two clients that cannot see it are
    // sent its finished row to notify with, and every client the exit.
    watching.attach(1, first.id).await;
    watching.type_into(1, b"/exit 3\r").await;
    let watching_first = heard_until_exit_of(&mut watching, first.id).await;
    let elsewhere_first = heard_until_exit_of(&mut elsewhere, first.id).await;
    let silent_first = heard_until_exit_of(&mut silent, first.id).await;
    assert_eq!(sessions_on(&watching_first, NOTIFY), Vec::<u64>::new());
    assert_eq!(sessions_on(&elsewhere_first, NOTIFY), [first.id]);
    assert_eq!(sessions_on(&silent_first, NOTIFY), [first.id]);
    let notified = elsewhere_first
        .iter()
        .find(|heard| heard.subscription == NOTIFY)
        .unwrap();
    assert_eq!(notified.session.status, SessionStatus::Exited);
    assert_eq!(notified.session.exit_code, Some(3));
    assert!(notified.session.ended_at.is_some(), "{notified:?}");
    for heard in [&watching_first, &elsewhere_first, &silent_first] {
        assert_eq!(sessions_on(heard, EXITS), [first.id]);
    }

    // The second ends where only the silent client's user cannot see it.
    watching.attach(2, second.id).await;
    watching.type_into(2, b"/exit 0\r").await;
    let watching_second = heard_until_exit_of(&mut watching, second.id).await;
    let elsewhere_second = heard_until_exit_of(&mut elsewhere, second.id).await;
    let silent_second = heard_until_exit_of(&mut silent, second.id).await;
    assert_eq!(sessions_on(&watching_second, NOTIFY), Vec::<u64>::new());
    assert_eq!(sessions_on(&elsewhere_second, NOTIFY), Vec::<u64>::new());
    assert_eq!(sessions_on(&silent_second, NOTIFY), [second.id]);

    // A session a client closed was meant to end: nobody is notified, and
    // every client still hears the exit.
    let third = elsewhere
        .request::<SessionStart>(&start_request(&folder))
        .await
        .unwrap();
    elsewhere
        .request::<SessionClose>(&CloseSessionRequest {
            id: third.id,
            force: true,
        })
        .await
        .unwrap();
    let watching_third = heard_until_exit_of(&mut watching, third.id).await;
    let elsewhere_third = heard_until_exit_of(&mut elsewhere, third.id).await;
    let silent_third = heard_until_exit_of(&mut silent, third.id).await;
    for heard in [&watching_third, &elsewhere_third, &silent_third] {
        assert_eq!(sessions_on(heard, NOTIFY), Vec::<u64>::new());
        assert_eq!(sessions_on(heard, EXITS), [third.id]);
    }

    // Each client's numbers run on without a gap: notifications are
    // numbered for each client alone, and the exits they all share.
    let all = |heard: [Vec<Heard>; 3]| heard.into_iter().flatten().collect::<Vec<_>>();
    let watching = all([watching_first, watching_second, watching_third]);
    let elsewhere = all([elsewhere_first, elsewhere_second, elsewhere_third]);
    let silent = all([silent_first, silent_second, silent_third]);
    assert_eq!(numbers_on(&watching, NOTIFY), Vec::<u64>::new());
    assert_eq!(numbers_on(&elsewhere, NOTIFY), [1]);
    assert_eq!(numbers_on(&silent, NOTIFY), [1, 2]);
    for heard in [&watching, &elsewhere, &silent] {
        assert_eq!(numbers_on(heard, EXITS), [1, 2, 3]);
    }
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// Plain terminals
// ---------------------------------------------------------------------------

/// Polls until `file` holds `wanted`.
async fn wait_for_file(file: &Path, wanted: &str) {
    let deadline = Instant::now() + PATIENCE;
    loop {
        if std::fs::read_to_string(file).is_ok_and(|text| text.contains(wanted)) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "{} never held {wanted:?}",
            file.display()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_plain_terminal_runs_a_shell_in_its_folder_on_the_stream_and_says_when_it_ends() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = RunningHost::start(fake_config(&dirs, &endpoint, &agent, &[]));
    let folder = resolved(&dirs.folder("a project"));
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    client.subscribe_quietly(6, "pterm:exit").await;

    let shells = client.request::<PtermShells>(&()).await.unwrap();
    assert!(!shells.is_empty(), "the host found no shell");
    assert!(
        shells
            .iter()
            .all(|shell| Path::new(&shell.path).is_absolute())
    );

    let open = PtermOpenRequest {
        path: text(&folder),
        cols: 80,
        rows: 24,
        shell: None,
        separate: false,
    };
    let opened = client.request::<PtermOpen>(&open).await.unwrap();
    assert_eq!(opened.problem, None, "{opened:?}");
    // The folder's shell is shared; a separate one is its own.
    let reopened = client.request::<PtermOpen>(&open).await.unwrap();
    assert_eq!(reopened.id, opened.id);
    let separate = client
        .request::<PtermOpen>(&PtermOpenRequest {
            separate: true,
            ..open.clone()
        })
        .await
        .unwrap();
    assert_ne!(separate.id, opened.id);

    // Typed input reaches the shell, which runs in the folder.
    client
        .open_on(
            11,
            "pterm:data",
            floti_protocol::channel::to_payload(&PtermStreamOpen { id: opened.id }).unwrap(),
        )
        .await;
    client
        .request::<PtermResize>(&PtermResizeRequest {
            id: opened.id,
            cols: 120,
            rows: 40,
        })
        .await
        .expect("the resize lands");
    client
        .type_into(11, b"echo floti-was-here > marker.txt\r")
        .await;
    wait_for_file(&folder.join("marker.txt"), "floti-was-here").await;
    let bytes = client
        .read_stream_until(11, |bytes| {
            String::from_utf8_lossy(bytes).contains("floti-was-here")
        })
        .await;
    assert!(!bytes.is_empty());

    // Its shell exiting is told, and its stream ends.
    client.type_into(11, b"exit\r").await;
    let exited: floti_protocol::channels::sessions::PtermExited = next_on(
        &mut client,
        6,
        |exit: &floti_protocol::channels::sessions::PtermExited| exit.id == opened.id,
    )
    .await;
    assert_eq!(exited.id, opened.id);
    client.wait_stream_closed(11).await;

    // Closing one ends it and tells the client too.
    client
        .request::<PtermClose>(&PtermCloseRequest { id: separate.id })
        .await
        .unwrap();
    let closed: floti_protocol::channels::sessions::PtermExited = next_on(
        &mut client,
        6,
        |exit: &floti_protocol::channels::sessions::PtermExited| exit.id == separate.id,
    )
    .await;
    assert_eq!(closed.id, separate.id);

    // A plain terminal is not a session.
    assert_eq!(client.request::<SessionList>(&()).await.unwrap(), vec![]);
    let missing = client
        .request::<PtermOpen>(&PtermOpenRequest {
            path: text(&folder.join("not here")),
            ..open
        })
        .await
        .expect_err("no folder, no shell");
    assert!(missing.message.contains("is not a folder"), "{missing:?}");
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// Activity and the overview
// ---------------------------------------------------------------------------

fn activity_of(states: &[SessionActivityState], id: u64) -> Option<&SessionActivityState> {
    states.iter().find(|state| state.id == id)
}

#[tokio::test(flavor = "multi_thread")]
async fn activity_comes_from_the_agents_own_records_and_the_whole_set_is_sent_on_each_change() {
    let world = ClaudeWorld::new();
    let host = world.host();
    let mut client = world.client().await;
    let first: Vec<SessionActivityState> = match client.subscribe_on(8, "session:activity").await {
        Message::Snapshot(snapshot) => from_payload(&snapshot.state).unwrap(),
        other => panic!("no snapshot: {other:?}"),
    };
    assert_eq!(first, vec![]);

    let project = world.folder("a project");
    let session = client
        .request::<SessionStart>(&StartSessionRequest {
            backend: Some(BackendId::claude_code()),
            ..start_request(&project)
        })
        .await
        .unwrap();
    let other_project = world.folder("another project");
    let other = client
        .request::<SessionStart>(&StartSessionRequest {
            backend: Some(BackendId::claude_code()),
            ..start_request(&other_project)
        })
        .await
        .unwrap();

    // Both are listed in every publication, whatever each is doing.
    let listed: Vec<SessionActivityState> =
        next_on(&mut client, 8, |states: &Vec<SessionActivityState>| {
            activity_of(states, session.id).is_some() && activity_of(states, other.id).is_some()
        })
        .await;
    assert_eq!(listed.len(), 2, "{listed:?}");

    client.attach(1, session.id).await;
    client.type_into(1, b"/wait\r").await;
    let waiting: Vec<SessionActivityState> =
        next_on(&mut client, 8, |states: &Vec<SessionActivityState>| {
            activity_of(states, session.id)
                .is_some_and(|state| state.activity == Some(SessionActivity::Waiting))
        })
        .await;
    let state = activity_of(&waiting, session.id).unwrap();
    assert_eq!(state.waiting_for.as_deref(), Some("permission prompt"));
    assert_eq!(state.conversation_id, session.conversation_id);
    assert!(
        activity_of(&waiting, other.id).is_some(),
        "the whole set: {waiting:?}"
    );

    // A cleared conversation is a new id in the same process, and the row
    // learns it.
    client.type_into(1, b"y\r/clear\r").await;
    let cleared: Vec<SessionActivityState> =
        next_on(&mut client, 8, |states: &Vec<SessionActivityState>| {
            activity_of(states, session.id).is_some_and(|state| {
                state.conversation_id.is_some() && state.conversation_id != session.conversation_id
            })
        })
        .await;
    let now = activity_of(&cleared, session.id)
        .and_then(|state| state.conversation_id.clone())
        .unwrap();
    let deadline = Instant::now() + PATIENCE;
    loop {
        let recorded: Option<String> = world
            .db()
            .query_row(
                "SELECT last_claude_session_id FROM sessions WHERE id = ?1",
                [i64::try_from(session.id).unwrap()],
                |row| row.get(0),
            )
            .unwrap();
        if recorded.as_deref() == Some(now.as_str()) {
            break;
        }
        assert!(Instant::now() < deadline, "the row never learned {now}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // An ended session leaves the set.
    client.type_into(1, b"/exit\r").await;
    let _: Vec<SessionActivityState> =
        next_on(&mut client, 8, |states: &Vec<SessionActivityState>| {
            activity_of(states, session.id).is_none() && activity_of(states, other.id).is_some()
        })
        .await;

    // Only the records were read: the credential beside each is never
    // opened, which the record reader's own tests show; here, it is there.
    assert!(
        std::fs::read_dir(world.config.join("sessions"))
            .unwrap()
            .filter_map(|entry| entry.ok())
            .any(|entry| entry.path().extension().is_some_and(|ext| ext == "key"))
    );
    host.stop(HostStopReason::Stop).await;
}

fn record(dir: &Path, pid: u32, conversation: &str, cwd: &Path, name: &str) {
    std::fs::create_dir_all(dir).unwrap();
    let record = json!({
        "pid": pid,
        "sessionId": conversation,
        "cwd": text(cwd),
        "startedAt": 1_759_312_800_000_u64,
        "version": "2.1.300",
        "entrypoint": "cli",
        "name": name,
        "status": "busy",
        "statusUpdatedAt": 1_759_312_900_000_u64,
    });
    std::fs::write(dir.join(format!("{pid}.json")), record.to_string()).unwrap();
}

/// A pid no process has: one that ran and has ended.
fn ended_pid() -> u32 {
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .arg("--list")
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let pid = child.id();
    child.wait().unwrap();
    pid
}

#[tokio::test(flavor = "multi_thread")]
async fn the_overview_is_every_live_agent_session_on_the_machine_with_the_hosts_marked() {
    let world = ClaudeWorld::new();
    let sessions = world.config.join("sessions");
    let outside = world.folder("started elsewhere");
    // A session this host does not run, alive; one whose process is gone;
    // and a file that is not a record.
    record(
        &sessions,
        std::process::id(),
        "outside-conversation",
        &outside,
        "elsewhere",
    );
    record(
        &sessions,
        ended_pid(),
        "stale-conversation",
        &outside,
        "stale",
    );
    std::fs::write(sessions.join("garbage.json"), "{ not json").unwrap();

    let host = world.host();
    let mut client = world.client().await;
    let first: SessionsOverview = match client.subscribe_on(9, "sessions:overview").await {
        Message::Snapshot(snapshot) => from_payload(&snapshot.state).unwrap(),
        other => panic!("no snapshot: {other:?}"),
    };
    let names = |overview: &SessionsOverview| -> Vec<Option<String>> {
        overview.sessions.iter().map(|s| s.name.clone()).collect()
    };
    assert_eq!(names(&first), [Some("elsewhere".to_owned())], "{first:?}");
    let elsewhere: &LiveSession = &first.sessions[0];
    assert_eq!(elsewhere.host_session_id, None);
    assert_eq!(elsewhere.pid, std::process::id());
    assert!(elsewhere.registered);
    assert_eq!(elsewhere.activity, Some(SessionActivity::Busy));
    assert_eq!(elsewhere.backend, BackendId::claude_code());
    assert_eq!(elsewhere.version.as_deref(), Some("2.1.300"));

    let project = world.folder("a project");
    let session = client
        .request::<SessionStart>(&StartSessionRequest {
            backend: Some(BackendId::claude_code()),
            name: Some("hosted".into()),
            ..start_request(&project)
        })
        .await
        .unwrap();
    let both: SessionsOverview = next_on(&mut client, 9, |overview: &SessionsOverview| {
        overview
            .sessions
            .iter()
            .any(|s| s.host_session_id == Some(session.id) && s.registered)
    })
    .await;
    // Hosted first, then the rest.
    assert_eq!(both.sessions.len(), 2, "{both:?}");
    assert_eq!(both.sessions[0].host_session_id, Some(session.id));
    assert_eq!(
        both.sessions[0].conversation_id.as_deref(),
        session.conversation_id.as_deref()
    );
    assert_eq!(both.sessions[1].host_session_id, None);
    assert!(both.read_at_ms > 0);

    // An ended session is gone from the next one.
    client
        .request::<SessionClose>(&CloseSessionRequest {
            id: session.id,
            force: true,
        })
        .await
        .unwrap();
    let after: SessionsOverview = next_on(&mut client, 9, |overview: &SessionsOverview| {
        overview
            .sessions
            .iter()
            .all(|s| s.host_session_id.is_none())
    })
    .await;
    assert_eq!(names(&after), [Some("elsewhere".to_owned())]);
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_whose_agent_keeps_no_records_is_listed_with_its_activity_unknown() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = RunningHost::start(fake_config(&dirs, &endpoint, &agent, &[]));
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    client.subscribe_on(8, "session:activity").await;
    let session = client
        .request::<SessionStart>(&start_request(&dirs.folder("a project")))
        .await
        .unwrap();
    let states: Vec<SessionActivityState> =
        next_on(&mut client, 8, |states: &Vec<SessionActivityState>| {
            activity_of(states, session.id).is_some()
        })
        .await;
    let state = activity_of(&states, session.id).unwrap();
    assert_eq!(state.activity, None);
    assert_eq!(state.waiting_for, None);
    host.stop(HostStopReason::Stop).await;
}
