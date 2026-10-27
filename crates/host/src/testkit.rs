//! Test support for the host's tests, on in its own unit tests and, through
//! the `testkit` feature, in its integration tests.
//!
//! - [`TestDirs`]: a temporary root whose path has spaces in it, holding a
//!   home, data, log, config and runtime folder. Tests point every folder and
//!   the socket here and never at the real `%LOCALAPPDATA%`, Application
//!   Support, XDG data folder or `~/.config/floti`.
//! - [`unique_name`]: a pipe or socket name no other test is using.
//! - [`FakeAgent`] and [`FakeAgentBackend`]: the fake agent CLI
//!   (`floti-fake-agent`, in `testkit/fake_agent.rs`), its records and a
//!   backend that runs it. Integration tests get one with
//!   [`fake_agent!`](crate::fake_agent).

mod client;

pub use client::{PATIENCE, TestClient, names_unserved_channel};

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use floti_protocol::BackendId;
use serde::Deserialize;
use tempfile::TempDir;

use crate::Result;
use crate::agent::{
    AgentBackend, Launch, LaunchFolder, LaunchRequest, LaunchSpec, ResumeRequest, Resumer,
};
use crate::platform::folders::{Folders, UserEnv};
use crate::platform::socket::{Endpoint, LocalSocket, Native as NativeSocket};

/// The variable naming the folder the fake agent records each run in.
pub const FAKE_AGENT_LOG_VAR: &str = "FLOTI_FAKE_AGENT_LOG";

/// A temporary folder tree for one test, removed when it is dropped.
///
/// Every path has a space in it, as a Windows user folder often does.
/// `runtime` is kept short because a Unix socket path has a length limit of
/// about a hundred bytes.
#[derive(Debug)]
pub struct TestDirs {
    root: TempDir,
    pub home: PathBuf,
    pub data: PathBuf,
    pub logs: PathBuf,
    pub config: PathBuf,
    pub runtime: PathBuf,
}

impl TestDirs {
    pub fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("floti test ")
            .tempdir()
            .expect("create a temporary folder for the test");
        let make = |name: &str| {
            let path = root.path().join(name);
            std::fs::create_dir_all(&path).expect("create a test folder");
            path
        };
        Self {
            home: make("home dir"),
            data: make("data dir"),
            logs: make("state dir"),
            config: make("config dir"),
            runtime: make("run"),
            root,
        }
    }

    /// The temporary root everything else is in.
    pub fn root(&self) -> &Path {
        self.root.path()
    }

    /// A new folder under the root, such as a project for a session to run
    /// in. `name` may contain spaces.
    pub fn folder(&self, name: &str) -> PathBuf {
        let path = self.root.path().join(name);
        std::fs::create_dir_all(&path).expect("create a test folder");
        path
    }

    /// Every host folder, inside this tree.
    pub fn folders(&self) -> Folders {
        Folders {
            data: self.data.clone(),
            logs: self.logs.clone(),
            config: self.config.clone(),
            runtime: self.runtime.clone(),
        }
    }

    /// A user whose home is this tree's home and whose environment is empty,
    /// so resolving folders from it can never reach the real ones.
    pub fn user_env(&self) -> UserEnv {
        UserEnv {
            home: Some(self.home.clone()),
            vars: BTreeMap::new(),
        }
    }

    /// A socket endpoint no other test is using: a uniquely named pipe on
    /// Windows, a socket in this tree's runtime folder elsewhere.
    pub fn endpoint(&self) -> Endpoint {
        NativeSocket.endpoint(&self.runtime, &unique_name())
    }
}

impl Default for TestDirs {
    fn default() -> Self {
        Self::new()
    }
}

/// A short name for a pipe or socket that no other test, in this process or
/// another, is using: the pid, a counter, and the clock against a reused pid.
pub fn unique_name() -> String {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let clock = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.subsec_micros())
        .unwrap_or(0);
    format!("ft-{}-{n}-{clock}", std::process::id())
}

/// What one run of the fake agent recorded.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FakeAgentRecord {
    pub pid: u32,
    /// Its arguments, without the program.
    pub argv: Vec<String>,
    /// The folder it ran in.
    pub cwd: String,
    /// Values of `TERM`, `COLORTERM`, `FORCE_HYPERLINK` and `NO_COLOR`, when
    /// set.
    pub env: BTreeMap<String, String>,
    /// The name of every variable it was given, sorted.
    pub env_names: Vec<String>,
    /// The pids of the children it started.
    pub children: Vec<u32>,
    /// Every line it read, in order.
    pub input: Vec<String>,
}

/// The fake agent CLI, recording into a folder of its own.
#[derive(Debug, Clone)]
pub struct FakeAgent {
    exe: PathBuf,
    log_dir: PathBuf,
}

/// A [`FakeAgent`] for an integration test, recording into `dirs`.
///
/// A macro because the binary's path is known only to integration tests, as
/// `CARGO_BIN_EXE_floti-fake-agent`.
#[macro_export]
macro_rules! fake_agent {
    ($dirs:expr) => {
        $crate::testkit::FakeAgent::new(env!("CARGO_BIN_EXE_floti-fake-agent"), $dirs)
    };
}

impl FakeAgent {
    /// The fake agent at `exe`, recording into a new folder in `dirs`.
    pub fn new(exe: impl Into<PathBuf>, dirs: &TestDirs) -> Self {
        Self {
            exe: exe.into(),
            log_dir: dirs.folder("agent log"),
        }
    }

    /// The executable.
    pub fn exe(&self) -> &Path {
        &self.exe
    }

    /// The variable that makes a run record itself here; set it on any
    /// process that runs the agent.
    pub fn log_env(&self) -> (OsString, OsString) {
        (
            FAKE_AGENT_LOG_VAR.into(),
            self.log_dir.clone().into_os_string(),
        )
    }

    /// A backend that runs this agent, adding `args` to every launch.
    pub fn backend(&self, args: impl IntoIterator<Item = impl Into<OsString>>) -> FakeAgentBackend {
        FakeAgentBackend {
            id: BackendId::new(FakeAgentBackend::ID),
            agent: self.clone(),
            args: args.into_iter().map(Into::into).collect(),
        }
    }

    /// Every run recorded so far, in pid order.
    pub fn records(&self) -> Vec<FakeAgentRecord> {
        let Ok(entries) = std::fs::read_dir(&self.log_dir) else {
            return Vec::new();
        };
        let mut records: Vec<FakeAgentRecord> = entries
            .filter_map(|entry| {
                let path = entry.ok()?.path();
                if path.extension()? != "json" {
                    return None;
                }
                serde_json::from_slice(&std::fs::read(path).ok()?).ok()
            })
            .collect();
        records.sort_by_key(|record| record.pid);
        records
    }

    /// The record of run `pid`, if it has written one.
    pub fn record(&self, pid: u32) -> Option<FakeAgentRecord> {
        let path = self.log_dir.join(format!("{pid}.json"));
        serde_json::from_slice(&std::fs::read(path).ok()?).ok()
    }

    /// Waits up to `timeout` for a record of run `pid` that `done` accepts,
    /// and panics naming the last one seen when none does.
    pub fn wait_for_record(
        &self,
        pid: u32,
        timeout: Duration,
        done: impl Fn(&FakeAgentRecord) -> bool,
    ) -> FakeAgentRecord {
        let deadline = Instant::now() + timeout;
        loop {
            let record = self.record(pid);
            if let Some(record) = &record
                && done(record)
            {
                return record.clone();
            }
            assert!(
                Instant::now() < deadline,
                "the fake agent's run {pid} did not record what was expected within {timeout:?}; last record: {record:?}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

/// A backend that runs the fake agent: it launches with the arguments it was
/// made with and the opening prompt last, and resumes with
/// `--resume <conversation>` in the folder history recorded.
#[derive(Debug, Clone)]
pub struct FakeAgentBackend {
    id: BackendId,
    agent: FakeAgent,
    args: Vec<OsString>,
}

impl FakeAgentBackend {
    pub const ID: &'static str = "fake-agent";

    fn spec(
        &self,
        cwd: &Path,
        extra: impl IntoIterator<Item = OsString>,
        conversation_id: String,
        folder: &LaunchFolder,
    ) -> Launch {
        Launch::plain(LaunchSpec {
            program: self.agent.exe.clone().into_os_string(),
            args: self.args.iter().cloned().chain(extra).collect(),
            cwd: cwd.to_path_buf(),
            env: vec![self.agent.log_env()],
            conversation_id: Some(conversation_id),
            launch_folder: Some(folder.path().to_path_buf()),
        })
    }
}

impl AgentBackend for FakeAgentBackend {
    fn id(&self) -> &BackendId {
        &self.id
    }

    fn name(&self) -> &str {
        "Fake agent"
    }

    /// A new launch is given a conversation id of its own, as Claude Code's
    /// `--session-id` gives one, so its session can be restored.
    fn launch(&self, request: &LaunchRequest, folder: &LaunchFolder) -> Result<Launch> {
        Ok(self.spec(
            &request.folder,
            request.prompt.iter().map(OsString::from),
            format!("fake-conversation-{}", unique_name()),
            folder,
        ))
    }

    fn resumer(&self) -> Option<&dyn Resumer> {
        Some(self)
    }
}

impl Resumer for FakeAgentBackend {
    fn resume(&self, request: &ResumeRequest, folder: &LaunchFolder) -> Result<Launch> {
        Ok(self.spec(
            &request.folder,
            ["--resume".into(), request.conversation_id.clone().into()],
            request.conversation_id.clone(),
            folder,
        ))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn test_folders_are_temporary_have_spaces_and_are_removed() {
        let dirs = TestDirs::new();
        let root = dirs.root().to_path_buf();
        assert!(root.starts_with(std::env::temp_dir()), "{}", root.display());
        let folders = dirs.folders();
        for path in [&folders.data, &folders.logs, &folders.config, &dirs.home] {
            assert!(path.starts_with(&root), "{}", path.display());
            assert!(path.to_string_lossy().contains(' '), "{}", path.display());
            assert!(path.is_dir(), "{}", path.display());
        }
        assert!(folders.runtime.starts_with(&root));
        assert_eq!(dirs.user_env().home.as_deref(), Some(dirs.home.as_path()));
        assert!(dirs.user_env().vars.is_empty());
        drop(dirs);
        assert!(!root.exists());
    }

    #[test]
    fn socket_names_are_unique() {
        let names: HashSet<String> = (0..1000).map(|_| unique_name()).collect();
        assert_eq!(names.len(), 1000);

        let a = TestDirs::new();
        let b = TestDirs::new();
        assert_ne!(a.endpoint(), b.endpoint());
    }

    #[test]
    fn fake_agent_backend_resumes_in_the_recorded_folder() {
        let dirs = TestDirs::new();
        let agent = FakeAgent::new("fake agent.exe", &dirs);
        let backend = agent.backend(["--fake-child"]);
        assert_eq!(backend.id().as_str(), FakeAgentBackend::ID);
        assert_eq!(
            backend
                .capabilities()
                .support(floti_protocol::BackendFeature::Resume),
            floti_protocol::Support::Declared
        );

        let folder = dirs.folder("a project");
        let launch_folder = LaunchFolder::create(&dirs.data).unwrap();
        let spec = backend
            .resumer()
            .unwrap()
            .resume(
                &ResumeRequest {
                    conversation_id: "conv 1".into(),
                    folder: folder.clone(),
                    composition: Default::default(),
                },
                &launch_folder,
            )
            .unwrap()
            .spec;
        assert_eq!(spec.program, OsString::from("fake agent.exe"));
        assert_eq!(
            spec.args,
            ["--fake-child", "--resume", "conv 1"].map(OsString::from)
        );
        assert_eq!(spec.cwd, folder);
        assert_eq!(spec.env, vec![agent.log_env()]);

        let spec = backend
            .launch(
                &LaunchRequest {
                    folder: folder.clone(),
                    prompt: Some("hello there".into()),
                    ..LaunchRequest::default()
                },
                &launch_folder,
            )
            .unwrap()
            .spec;
        assert_eq!(
            spec.args,
            ["--fake-child", "hello there"].map(OsString::from)
        );
    }
}
