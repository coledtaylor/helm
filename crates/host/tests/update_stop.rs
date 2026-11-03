//! `floti update-stop`, end to end: the `floti` executable an installer runs
//! before it replaces the binary, connecting with a client folder's keys to a
//! real host on a real local socket, with the fake agent behind its sessions.
//!
//! Every folder and socket is in a temporary tree whose paths have spaces.
//! Each run of the executable is waited for, and killed past [`PATIENCE`];
//! a host is a [`RunningHost`] the test stops or sees stopped.

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use floti_host::agent::AgentBackend;
use floti_host::client::ClientKeys;
use floti_host::fake_agent;
use floti_host::platform::folders::{CONFIG_DIR_VAR, DATA_DIR_VAR, LOG_DIR_VAR, RUNTIME_DIR_VAR};
use floti_host::server::{HostConfig, host_public_key, local_endpoint};
use floti_host::testkit::{FakeAgent, PATIENCE, RunningHost, TestClient, TestDirs};
use floti_protocol::channels::common::{SessionRecord, SessionStatus};
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::sessions::{SessionList, SessionStart, StartSessionRequest};
use floti_protocol::noise::KeyPair;

const TERMINAL: &[&str] = &["terminal"];

/// The status `--ask` ends with when the host runs no session.
const NOTHING_TO_END: i32 = 7;
/// The status every client of the host ends with when no host answered.
const NO_HOST: i32 = 3;
/// The status when the client folder holds no client that has connected to a host.
const NOT_PAIRED: i32 = 4;

/// A host on `dirs`' folders, at the endpoint `floti` finds from them, whose
/// one backend is the fake agent.
fn config(dirs: &TestDirs, agent: &FakeAgent) -> HostConfig {
    HostConfig {
        run: Default::default(),
        folders: dirs.folders(),
        endpoint: local_endpoint(&dirs.folders()),
        backends: vec![Arc::new(agent.backend(Vec::<&str>::new())) as Arc<dyn AgentBackend>],
        inherited_env: std::env::vars_os().collect(),
    }
}

/// Helm's client folder, with a device key of its own. The host key is
/// pinned once the host has made one ([`pin_host`]).
fn helm_client(dirs: &TestDirs) -> PathBuf {
    let folder = dirs.root().join("Helm data").join("host-client");
    ClientKeys::open(&folder).expect("set up Helm's client keys");
    folder
}

fn pin_host(dirs: &TestDirs, folder: &Path) {
    let host = host_public_key(&dirs.data)
        .expect("read the host's key")
        .expect("the host has a key");
    ClientKeys::open(folder)
        .expect("open Helm's client keys")
        .pin_host(host)
        .expect("pin the host key");
}

/// Runs `floti update-stop <folder> <step>` against the host on `dirs`'
/// folders, and waits for it to end.
async fn update_stop(dirs: &TestDirs, folder: &Path, step: &str) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_floti"));
    command
        .arg("update-stop")
        .arg(folder)
        .arg(step)
        .env(DATA_DIR_VAR, &dirs.data)
        .env(LOG_DIR_VAR, &dirs.logs)
        .env(CONFIG_DIR_VAR, &dirs.config)
        .env(RUNTIME_DIR_VAR, &dirs.runtime)
        .env("HOME", &dirs.home)
        .env("USERPROFILE", &dirs.home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().expect("run floti update-stop");
    let deadline = Instant::now() + PATIENCE;
    loop {
        if child.try_wait().expect("poll floti update-stop").is_some() {
            return child.wait_with_output().expect("read floti update-stop");
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("floti update-stop did not end within {PATIENCE:?}");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn printed(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn said(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

async fn running(client: &mut TestClient) -> Vec<SessionRecord> {
    client
        .request::<SessionList>(&())
        .await
        .expect("list the sessions")
        .into_iter()
        .filter(|session| session.status == SessionStatus::Running)
        .collect()
}

// ---------------------------------------------------------------------------
// S20: with sessions running, it says how many end; agreeing stops the host
// for an update, and declining leaves every session running
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn with_sessions_running_it_says_how_many_end_and_its_stop_ends_them_for_an_update() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let folder = helm_client(&dirs);
    let host = RunningHost::start(config(&dirs, &agent));
    pin_host(&dirs, &folder);
    let endpoint = local_endpoint(&dirs.folders());
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    for name in ["project one", "project two"] {
        client
            .request::<SessionStart>(&StartSessionRequest {
                cwd: dirs.folder(name).to_string_lossy().into_owned(),
                cols: 80,
                rows: 24,
                ..StartSessionRequest::default()
            })
            .await
            .expect("start a session");
    }

    let asked = update_stop(&dirs, &folder, "--ask").await;
    assert_eq!(asked.status.code(), Some(0), "{}", said(&asked));
    assert_eq!(
        printed(&asked),
        "Installing this update stops the local host on this PC, ending 2 sessions. \
         Helm offers them back when it next starts."
    );
    // Asking ends nothing: an installer that is declined leaves every session
    // running.
    assert_eq!(running(&mut client).await.len(), 2);

    let stopped = update_stop(&dirs, &folder, "--stop").await;
    assert_eq!(stopped.status.code(), Some(0), "{}", said(&stopped));
    assert_eq!(printed(&stopped), "");
    // Stopped for an update: the sessions end with their rows left for the
    // next start to offer back once.
    assert_eq!(host.stopped().await, HostStopReason::Update);
    drop(client);
}

// ---------------------------------------------------------------------------
// S21: with no session running, or no host, it asks nothing
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn with_no_session_running_it_asks_nothing() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let folder = helm_client(&dirs);
    let host = RunningHost::start(config(&dirs, &agent));
    pin_host(&dirs, &folder);

    let asked = update_stop(&dirs, &folder, "--ask").await;
    assert_eq!(
        asked.status.code(),
        Some(NOTHING_TO_END),
        "{}",
        said(&asked)
    );
    assert_eq!(printed(&asked), "");

    let stopped = update_stop(&dirs, &folder, "--stop").await;
    assert_eq!(stopped.status.code(), Some(0), "{}", said(&stopped));
    assert_eq!(host.stopped().await, HostStopReason::Update);
}

#[tokio::test(flavor = "multi_thread")]
async fn with_no_host_running_it_asks_nothing_and_says_none_answered() {
    let dirs = TestDirs::new();
    let folder = dirs.root().join("Helm data").join("host-client");
    ClientKeys::open(&folder)
        .expect("set up Helm's client keys")
        .pin_host(KeyPair::generate().unwrap().public())
        .expect("pin a host key");

    for step in ["--ask", "--stop"] {
        let ended = update_stop(&dirs, &folder, step).await;
        assert_eq!(
            ended.status.code(),
            Some(NO_HOST),
            "{step}: {}",
            said(&ended)
        );
        assert_eq!(printed(&ended), "", "{step}");
        assert!(
            said(&ended).starts_with("floti update-stop: "),
            "{step}: {}",
            said(&ended)
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn with_no_client_folder_it_asks_nothing_and_makes_no_client_folder() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let host = RunningHost::start(config(&dirs, &agent));
    let folder = dirs.root().join("Helm data").join("host-client");

    let asked = update_stop(&dirs, &folder, "--ask").await;
    assert_eq!(asked.status.code(), Some(NOT_PAIRED), "{}", said(&asked));
    assert_eq!(printed(&asked), "");
    assert!(!folder.exists(), "the installer made a client folder");

    host.stop(HostStopReason::Stop).await;
}
