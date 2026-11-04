//! Keeping a WSL distro awake (`wsl:keepAwake`): a Windows host holds one
//! `wsl.exe -d <distro> -- floti keep-awake` per distro while the host inside
//! it runs a session, and lets go once none runs or that host stops.
//!
//! No test starts, stops or changes a real distro or runs the real
//! `wsl.exe`. The "Windows host" is a [`RunningHost`] whose `wsl.exe` is the
//! fake in `test/fake-ssh/wsl.mjs`, run by Node on every OS, which runs the
//! line "in the distro": on this computer, in the test's folders, with
//! `floti` mapped to the binary built here. The "distro's host" is a second
//! [`RunningHost`] on folders of its own, which `floti keep-awake` finds from
//! the variables the fake wsl is run with. Every process a test starts ends
//! with it: a hold is killed when its host stops, and the fake ends with the
//! test.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use floti_host::agent::AgentBackend;
use floti_host::bridge::{decode_output, last_line_of};
use floti_host::fake_agent;
use floti_host::platform::folders::{CONFIG_DIR_VAR, DATA_DIR_VAR, LOG_DIR_VAR, RUNTIME_DIR_VAR};
use floti_host::platform::wsl::{NO_WSL_LINE, WslProgram};
use floti_host::server::{HostConfig, HostRun, Occupancy, local_endpoint};
use floti_host::testkit::{FakeAgent, PATIENCE, RunningHost, TestClient, TestDirs};
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::sessions::{
    CloseSessionRequest, SessionClose, SessionStart, StartSessionRequest,
};
use floti_protocol::channels::wsl::{WslKeepAwake, WslKeepAwakeRequest};
use serde_json::Value;
use tokio::sync::watch;

const DISTRO: &str = "Debian";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

/// The Node running these tests: the first `node` on `PATH`.
fn node_on_path() -> PathBuf {
    let path = std::env::var_os("PATH").expect("PATH is set");
    std::env::split_paths(&path)
        .flat_map(|dir| [dir.join("node.exe"), dir.join("node")])
        .find(|candidate| candidate.is_file())
        .expect("the tests run with Node on PATH")
}

/// The JSON-lines file the fakes record each run in.
fn transport_log(dirs: &TestDirs) -> PathBuf {
    dirs.root().join("transport runs.jsonl")
}

/// Every run of the fake wsl recorded so far.
fn wsl_runs(dirs: &TestDirs) -> Vec<Value> {
    std::fs::read_to_string(transport_log(dirs))
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("a run record"))
        .filter(|run| run["program"] == "wsl")
        .collect()
}

/// The fake `wsl.exe`, run by Node, with the distro `DISTRO` whose folders
/// are `distro`'s: what `floti keep-awake` finds its host by.
fn fake_wsl(windows: &TestDirs, distro: &TestDirs) -> WslProgram {
    let var = |name: &str, value: &Path| (OsString::from(name), value.as_os_str().to_owned());
    WslProgram {
        program: node_on_path().into_os_string(),
        args: vec![
            repo_root()
                .join("test")
                .join("fake-ssh")
                .join("wsl.mjs")
                .into_os_string(),
        ],
        env: vec![
            (OsString::from("FAKE_WSL_DISTROS"), OsString::from(DISTRO)),
            var("FAKE_SSH_FLOTI", Path::new(env!("CARGO_BIN_EXE_floti"))),
            var("FAKE_SSH_LOG", &transport_log(windows)),
            var(DATA_DIR_VAR, &distro.data),
            var(LOG_DIR_VAR, &distro.logs),
            var(CONFIG_DIR_VAR, &distro.config),
            var(RUNTIME_DIR_VAR, &distro.runtime),
            var("HOME", &distro.home),
            var("USERPROFILE", &distro.home),
        ],
    }
}

fn config(dirs: &TestDirs, agent: &FakeAgent, wsl: Option<WslProgram>) -> HostConfig {
    HostConfig {
        run: HostRun {
            wsl,
            ..HostRun::default()
        },
        folders: dirs.folders(),
        endpoint: local_endpoint(&dirs.folders()),
        backends: vec![Arc::new(agent.backend(Vec::<&str>::new())) as Arc<dyn AgentBackend>],
        inherited_env: std::env::vars_os().collect(),
    }
}

/// Waits, up to [`PATIENCE`], until `watched` satisfies `holds`.
async fn until(
    watched: &mut watch::Receiver<Occupancy>,
    what: &str,
    holds: impl Fn(&Occupancy) -> bool,
) {
    let met = tokio::time::timeout(PATIENCE, watched.wait_for(|now| holds(now)))
        .await
        .is_ok_and(|seen| seen.is_ok());
    assert!(
        met,
        "{what} within {PATIENCE:?}; now {:?}",
        *watched.borrow()
    );
}

fn start_request(folder: &Path) -> StartSessionRequest {
    StartSessionRequest {
        cwd: folder.to_string_lossy().into_owned(),
        cols: 80,
        rows: 24,
        ..StartSessionRequest::default()
    }
}

fn keep(distro: &str) -> WslKeepAwakeRequest {
    WslKeepAwakeRequest {
        distro: distro.to_owned(),
        floti: None,
    }
}

/// A Windows host and the host in its distro, each watched.
struct Pair {
    windows: RunningHost,
    windows_now: watch::Receiver<Occupancy>,
    distro: RunningHost,
    distro_now: watch::Receiver<Occupancy>,
    agent: FakeAgent,
    distro_dirs: TestDirs,
    windows_dirs: TestDirs,
}

impl Pair {
    fn start() -> Self {
        let windows_dirs = TestDirs::new();
        let distro_dirs = TestDirs::new();
        let agent = fake_agent!(&distro_dirs);
        let (distro, distro_now) =
            RunningHost::start_with(config(&distro_dirs, &agent, None), |host| host.occupancy());
        let windows_agent = fake_agent!(&windows_dirs);
        let (windows, windows_now) = RunningHost::start_with(
            config(
                &windows_dirs,
                &windows_agent,
                Some(fake_wsl(&windows_dirs, &distro_dirs)),
            ),
            |host| host.occupancy(),
        );
        drop(windows_agent);
        Self {
            windows,
            windows_now,
            distro,
            distro_now,
            agent,
            distro_dirs,
            windows_dirs,
        }
    }

    fn windows_endpoint(&self) -> floti_host::platform::socket::Endpoint {
        local_endpoint(&self.windows_dirs.folders())
    }

    fn distro_endpoint(&self) -> floti_host::platform::socket::Endpoint {
        local_endpoint(&self.distro_dirs.folders())
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn s7_s8_a_windows_host_holds_one_wsl_per_distro_while_its_host_runs_a_session_and_lets_go_when_the_last_one_ends()
 {
    let mut pair = Pair::start();
    let mut in_distro = TestClient::connect(&pair.distro_endpoint(), &["terminal"]).await;
    let session = in_distro
        .request::<SessionStart>(&start_request(&pair.distro_dirs.folder("project")))
        .await
        .expect("start a session in the distro");
    let mut desktop = TestClient::connect(&pair.windows_endpoint(), &[]).await;

    // S7: the ask holds the distro: one wsl.exe, whose `floti keep-awake`
    // attaches to the distro's host and stays while the session runs.
    desktop
        .request::<WslKeepAwake>(&keep(DISTRO))
        .await
        .expect("keep the distro awake");
    until(
        &mut pair.windows_now,
        "the Windows host holds the distro",
        |now| now.distros == 1,
    )
    .await;
    until(&mut pair.distro_now, "floti keep-awake attached", |now| {
        now.clients == 2
    })
    .await;
    let runs = wsl_runs(&pair.windows_dirs);
    assert_eq!(runs.len(), 1, "{runs:?}");
    assert_eq!(runs[0]["distro"], DISTRO);
    assert_eq!(runs[0]["line"], "floti keep-awake");

    // A second ask for the same distro opens no second wsl.exe.
    desktop
        .request::<WslKeepAwake>(&keep(DISTRO))
        .await
        .expect("ask again");
    assert_eq!(pair.windows_now.borrow().distros, 1);

    // S8: the last session ends, so the held wsl.exe exits and the Windows
    // host lets go of the distro.
    in_distro
        .request::<SessionClose>(&CloseSessionRequest {
            id: session.id,
            force: true,
        })
        .await
        .expect("end the session");
    until(&mut pair.windows_now, "the Windows host let go", |now| {
        now.distros == 0
    })
    .await;
    until(&mut pair.distro_now, "floti keep-awake left", |now| {
        now.clients == 1
    })
    .await;

    // An ask while the distro's host runs no session holds nothing: the
    // wsl.exe it opens exits at once.
    desktop
        .request::<WslKeepAwake>(&keep(DISTRO))
        .await
        .expect("ask with no session");
    until(&mut pair.windows_now, "nothing held", |now| {
        now.distros == 0
    })
    .await;
    let deadline = std::time::Instant::now() + PATIENCE;
    while wsl_runs(&pair.windows_dirs).len() < 2 {
        assert!(
            std::time::Instant::now() < deadline,
            "the third ask ran no wsl.exe"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    // Every hold has ended, so every run is recorded: the second ask ran
    // none.
    assert_eq!(wsl_runs(&pair.windows_dirs).len(), 2);

    drop(desktop);
    drop(in_distro);
    pair.windows.stop(HostStopReason::Stop).await;
    pair.distro.stop(HostStopReason::Stop).await;
    drop(pair.agent);
}

#[tokio::test(flavor = "multi_thread")]
async fn s8_the_held_wsl_exits_when_the_distros_host_stops() {
    let mut pair = Pair::start();
    let mut in_distro = TestClient::connect(&pair.distro_endpoint(), &["terminal"]).await;
    in_distro
        .request::<SessionStart>(&start_request(&pair.distro_dirs.folder("project")))
        .await
        .expect("start a session in the distro");
    let mut desktop = TestClient::connect(&pair.windows_endpoint(), &[]).await;
    desktop
        .request::<WslKeepAwake>(&keep(DISTRO))
        .await
        .expect("keep the distro awake");
    until(&mut pair.distro_now, "floti keep-awake attached", |now| {
        now.clients == 2
    })
    .await;
    assert_eq!(pair.windows_now.borrow().distros, 1);
    drop(in_distro);
    pair.distro.stop(HostStopReason::Stop).await;
    until(&mut pair.windows_now, "the Windows host let go", |now| {
        now.distros == 0
    })
    .await;
    drop(desktop);
    pair.windows.stop(HostStopReason::Stop).await;
    drop(pair.agent);
}

#[tokio::test(flavor = "multi_thread")]
async fn s8_a_host_with_no_wsl_answers_that_there_is_none_and_a_bad_name_is_refused() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let (host, now) = RunningHost::start_with(config(&dirs, &agent, None), |host| host.occupancy());
    let mut desktop = TestClient::connect(&local_endpoint(&dirs.folders()), &[]).await;
    let refused = desktop
        .request::<WslKeepAwake>(&keep(DISTRO))
        .await
        .expect_err("no WSL here");
    assert_eq!(refused.message, NO_WSL_LINE);
    let bad = desktop
        .request::<WslKeepAwake>(&keep("two words"))
        .await
        .expect_err("not a distro name");
    assert!(bad.message.contains("is not a WSL distro name"), "{bad:?}");
    let floti = desktop
        .request::<WslKeepAwake>(&WslKeepAwakeRequest {
            distro: DISTRO.to_owned(),
            floti: Some("floti".to_owned()),
        })
        .await
        .expect_err("not a full path");
    assert!(floti.message.contains("is not a full path"), "{floti:?}");
    assert_eq!(now.borrow().distros, 0);
    drop(desktop);
    host.stop(HostStopReason::Stop).await;
}

#[test]
fn s10_what_wsl_writes_is_read_as_utf16le_when_it_is_and_as_utf8_otherwise() {
    let said = "There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n";
    let utf16: Vec<u8> = said.encode_utf16().flat_map(u16::to_le_bytes).collect();
    assert_eq!(decode_output(&utf16), said);
    assert_eq!(
        last_line_of(&utf16).as_deref(),
        Some("Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND")
    );
    let with_bom: Vec<u8> = [0xff, 0xfe]
        .into_iter()
        .chain(utf16.iter().copied())
        .collect();
    assert_eq!(decode_output(&with_bom), said);
    assert_eq!(
        last_line_of(said.as_bytes()).as_deref(),
        Some("Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND")
    );
    assert_eq!(
        last_line_of("ssh: connect to host win-box port 22: Connection refused\n".as_bytes())
            .as_deref(),
        Some("ssh: connect to host win-box port 22: Connection refused")
    );
}
