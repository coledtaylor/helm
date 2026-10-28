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
//! - [`RunningHost`]: a host serving on a thread and runtime of its own,
//!   which the test stops.
//!
//! A test leaves nothing behind: [`TestDirs`] fails the test that leaves a
//! file in its tree open, and a dropped [`RunningHost`] stops its host before
//! the test's folders go, a panicking test's included, then fails the test
//! that never stopped it.

mod client;

pub use client::{PATIENCE, TestClient, names_unserved_channel};

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use floti_protocol::BackendId;
use floti_protocol::channels::host::HostStopReason;
use serde::Deserialize;
use tempfile::TempDir;

use crate::Result;
use crate::agent::{
    AgentBackend, Launch, LaunchFolder, LaunchRequest, LaunchSpec, ResumeRequest, Resumer,
};
use crate::platform::folders::{Folders, UserEnv};
use crate::platform::socket::{Endpoint, LocalSocket, Native as NativeSocket};
use crate::server::{Host, HostConfig, Stopper};

/// The variable naming the folder the fake agent records each run in.
pub const FAKE_AGENT_LOG_VAR: &str = "FLOTI_FAKE_AGENT_LOG";

/// How long a dropped [`TestDirs`] keeps trying to remove its tree: an OS can
/// let go of an exited process's files a moment after the exit.
const REMOVE_WAIT: Duration = Duration::from_secs(3);

/// A temporary folder tree for one test, removed when it is dropped.
///
/// A test leaves nothing behind. When the tree cannot be removed because
/// something the test started still has a file in it open (a store, a host,
/// a process), dropping it fails the test, naming the folder. Drop whatever
/// holds it first; in a struct, declare the `TestDirs` last, since fields
/// drop in order. Windows refuses to remove an open file, so that is where
/// such a test fails.
///
/// Every path has a space in it, as a Windows user folder often does.
/// `runtime` is kept short because a Unix socket path has a length limit of
/// about a hundred bytes.
#[derive(Debug)]
pub struct TestDirs {
    /// `None` only while it is being dropped.
    root: Option<TempDir>,
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
            root: Some(root),
        }
    }

    /// The temporary root everything else is in.
    pub fn root(&self) -> &Path {
        self.root
            .as_ref()
            .expect("a TestDirs has its root until it is dropped")
            .path()
    }

    /// A new folder under the root, such as a project for a session to run
    /// in. `name` may contain spaces.
    pub fn folder(&self, name: &str) -> PathBuf {
        let path = self.root().join(name);
        std::fs::create_dir_all(&path).expect("create a test folder");
        path
    }

    /// A plugin folder named `name` under the root: `manifest` as its
    /// `helm-plugin.json`, written as given so a test can write a broken
    /// one, and each of `files` at its path relative to the folder.
    pub fn plugin_folder(&self, name: &str, manifest: &str, files: &[(&str, &str)]) -> PathBuf {
        let folder = self.folder(name);
        std::fs::write(
            folder.join(crate::plugins::manifest::MANIFEST_FILE),
            manifest,
        )
        .expect("write a plugin manifest");
        for (relative, content) in files {
            let path = folder.join(relative);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("create a plugin's folder");
            }
            std::fs::write(&path, content).expect("write a plugin file");
        }
        folder
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

impl Drop for TestDirs {
    fn drop(&mut self) {
        let Some(root) = self.root.take() else {
            return;
        };
        let path = root.path().to_path_buf();
        let mut removed = root.close();
        let deadline = Instant::now() + REMOVE_WAIT;
        while removed.is_err() && path.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
            removed = std::fs::remove_dir_all(&path);
        }
        // A test that is already failing says why itself.
        if let Err(err) = removed
            && path.exists()
            && !std::thread::panicking()
        {
            panic!(
                "the test left {} behind: something it started still has a file in it open ({err}). \
                 Stop or drop it before the TestDirs goes.",
                path.display()
            );
        }
    }
}

/// A host serving on a thread and a multi-thread Tokio runtime of its own,
/// so that it can be stopped from anywhere, a panicking test's unwind
/// included, whatever runtime the test runs on.
///
/// The test stops it with [`Self::stop`], or waits with [`Self::stopped`]
/// for a stop a client asked for: stopping is what ends its sessions and
/// lets go of its store and data folder, which dropping a [`Host`] does not.
///
/// Dropping one unstopped stops it too, and waits until it has let go of its
/// store and its thread has ended, so a [`TestDirs`] declared after it can
/// remove its tree. A test that panicked fails with its own message alone;
/// one that ended without stopping its host fails, once the host is stopped,
/// saying so.
pub struct RunningHost {
    stopper: Stopper,
    /// `None` once the host has been waited for.
    running: Option<HostThread>,
}

/// The thread a [`RunningHost`] serves on.
struct HostThread {
    /// How the host's run ended, sent once its runtime has gone, so nothing
    /// it ran still holds the store.
    done: mpsc::Receiver<Result<HostStopReason>>,
    thread: std::thread::JoinHandle<()>,
}

impl HostThread {
    /// Waits, blocking the calling thread for at most [`PATIENCE`], until
    /// the host has stopped and its thread has ended. It uses std's blocking
    /// alone, so it is safe inside a Tokio runtime and during an unwind.
    fn wait(self) -> std::result::Result<HostStopReason, String> {
        match self.done.recv_timeout(PATIENCE) {
            Ok(ended) => {
                let joined = self.thread.join();
                match (ended, joined) {
                    (Ok(reason), Ok(())) => Ok(reason),
                    (Err(err), _) => Err(format!("the host did not stop cleanly: {err}")),
                    (Ok(_), Err(_)) => Err("the host's thread panicked".to_owned()),
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                Err(format!("the host did not stop within {PATIENCE:?}"))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = self.thread.join();
                Err("the host's thread panicked before the host stopped".to_owned())
            }
        }
    }
}

impl RunningHost {
    /// Starts a host on `config` and serves.
    pub fn start(config: HostConfig) -> Self {
        Self::start_with(config, |_| ()).0
    }

    /// Starts a host on `config`, hands it to `look` before it serves, and
    /// serves: for a test that looks at the host itself, such as at the
    /// channels it serves. `look` runs on the host's thread.
    pub fn start_with<T: Send + 'static>(
        config: HostConfig,
        look: impl FnOnce(&Host) -> T + Send + 'static,
    ) -> (Self, T) {
        let (started_tx, started) = mpsc::channel::<Result<(Stopper, T)>>();
        let (done_tx, done) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("floti test host".to_owned())
            .spawn(move || {
                // Multi-thread: the host moves blocking work off its workers
                // with `block_in_place`, which a current-thread runtime refuses.
                let runtime = match tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(err) => {
                        let _ =
                            started_tx.send(Err(crate::Error::io("build the host's runtime", err)));
                        return;
                    }
                };
                // The host binds its socket and starts accepting on the
                // runtime it starts in.
                let started_host = {
                    let _entered = runtime.enter();
                    Host::start(config)
                };
                let host = match started_host {
                    Ok(host) => host,
                    Err(err) => {
                        let _ = started_tx.send(Err(err));
                        return;
                    }
                };
                let looked = look(&host);
                let _ = started_tx.send(Ok((host.stopper(), looked)));
                let ended = runtime.block_on(host.run_until_stopped());
                runtime.shutdown_timeout(PATIENCE);
                let _ = done_tx.send(ended);
            })
            .expect("start the host's thread");
        match started.recv() {
            Ok(Ok((stopper, looked))) => (
                Self {
                    stopper,
                    running: Some(HostThread { done, thread }),
                },
                looked,
            ),
            Ok(Err(err)) => {
                let _ = thread.join();
                panic!("start the host: {err:?}");
            }
            Err(_) => {
                let _ = thread.join();
                panic!("the host's thread ended before the host started");
            }
        }
    }

    /// Asks the host to stop for `reason` and waits until it has.
    pub async fn stop(self, reason: HostStopReason) -> HostStopReason {
        self.stopper.stop(reason);
        self.stopped().await
    }

    /// Waits for the host to finish stopping, however it was asked, without
    /// blocking the test's runtime.
    pub async fn stopped(mut self) -> HostStopReason {
        let running = self.running.take().expect("a host is waited for once");
        tokio::task::spawn_blocking(move || running.wait())
            .await
            .expect("wait for the host")
            .unwrap_or_else(|problem| panic!("{problem}"))
    }
}

impl Drop for RunningHost {
    fn drop(&mut self) {
        let Some(running) = self.running.take() else {
            return;
        };
        // Stopped before anything is said, so the test's folders can go
        // however it ended. Nothing here may panic during an unwind: a panic
        // inside a drop while panicking aborts the whole test binary.
        self.stopper.stop(HostStopReason::Stop);
        let stopped = running.wait();
        if std::thread::panicking() {
            // A test that is already failing says why itself.
            if let Err(problem) = stopped {
                eprintln!("floti testkit: stopping a failed test's host: {problem}");
            }
            return;
        }
        let problem = stopped
            .err()
            .map(|problem| format!(" ({problem})"))
            .unwrap_or_default();
        panic!(
            "the test did not stop its host: end it with `stop(..).await`, which ends its \
             sessions and lets go of its data folder{problem}"
        );
    }
}

/// The author and committer every [`GitRepo`] commit is made by.
pub const GIT_AUTHOR: (&str, &str) = ("Floti Tests", "tests@floti.invalid");

/// The date every [`GitRepo`] commit is made at.
pub const GIT_DATE: &str = "2026-01-02T03:04:05+00:00";

/// A git repository for a test, made and changed by running `git` with a
/// fixed author and date and none of the machine's own configuration: no
/// system or global config file, no hooks or signing they might name, and
/// no line-ending conversion, so a test sees the same repository on every
/// machine and OS.
#[derive(Debug, Clone)]
pub struct GitRepo {
    path: PathBuf,
}

impl GitRepo {
    /// A new repository on `main` at `path`, made if it is not there.
    pub fn init(path: impl Into<PathBuf>) -> Self {
        let repo = Self { path: path.into() };
        std::fs::create_dir_all(&repo.path).expect("create the repository's folder");
        repo.git(&["init", "-q", "-b", "main"]);
        repo
    }

    /// The working tree.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// `git` in the working tree with no configuration but the repository's
    /// own and this fixture's fixed author, date and settings.
    pub fn command(&self) -> std::process::Command {
        let mut command = std::process::Command::new("git");
        command
            .current_dir(&self.path)
            .args([
                "-c",
                "core.autocrlf=false",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "tag.gpgsign=false",
                "-c",
                "init.defaultBranch=main",
            ])
            .env("GIT_CONFIG_NOSYSTEM", "1")
            // A file that is never made: git reads it as an empty global
            // config, and the user's own is never read.
            .env(
                "GIT_CONFIG_GLOBAL",
                self.path.join(".floti-test-no-global-gitconfig"),
            )
            .env("GIT_AUTHOR_NAME", GIT_AUTHOR.0)
            .env("GIT_AUTHOR_EMAIL", GIT_AUTHOR.1)
            .env("GIT_AUTHOR_DATE", GIT_DATE)
            .env("GIT_COMMITTER_NAME", GIT_AUTHOR.0)
            .env("GIT_COMMITTER_EMAIL", GIT_AUTHOR.1)
            .env("GIT_COMMITTER_DATE", GIT_DATE)
            .env("GIT_TERMINAL_PROMPT", "0");
        for inherited in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_OBJECT_DIRECTORY",
            "GIT_CONFIG",
            "GIT_CONFIG_PARAMETERS",
            "GIT_CONFIG_COUNT",
        ] {
            command.env_remove(inherited);
        }
        command
    }

    /// Runs `git` with `args` and answers what it printed, failing the test
    /// with what it said when it fails.
    pub fn git(&self, args: &[&str]) -> String {
        let output = self
            .command()
            .args(args)
            .stdin(std::process::Stdio::null())
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {} failed in {}: {}",
            args.join(" "),
            self.path.display(),
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    /// Writes `content` to `relative`, making its folders.
    pub fn write(&self, relative: &str, content: &str) {
        let path = self.path.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create a folder in the repository");
        }
        std::fs::write(path, content).expect("write a file in the repository");
    }

    /// Stages everything and commits it as `message`.
    pub fn commit_all(&self, message: &str) {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "--allow-empty", "-m", message]);
    }
}

/// Makes `link` a link to the folder `target`, the OS's way: a junction on
/// Windows, a symlink on macOS and Linux. Neither needs elevation.
pub fn link_folder(target: &Path, link: &Path) {
    use crate::platform::links::FolderLinks;
    crate::platform::links::Native
        .link_folder(target, link)
        .expect("link a folder");
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
    /// The TCP port on 127.0.0.1 it listens on, for a run started with
    /// `--fake-serve` (a child of `--fake-listen`).
    #[serde(default)]
    pub listening: Option<u16>,
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
    fn a_tree_left_in_use_fails_the_test_naming_it() {
        let dirs = TestDirs::new();
        let root = dirs.root().to_path_buf();
        let open = std::fs::File::create(dirs.data.join("still open")).unwrap();
        let dropped = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(dirs)));
        drop(open);
        match dropped {
            // An OS that removes an open file has nothing left to report.
            Ok(()) => assert!(!root.exists()),
            Err(panic) => {
                let _ = std::fs::remove_dir_all(&root);
                let message = panic
                    .downcast_ref::<String>()
                    .expect("the failure is a message");
                assert!(message.contains(&root.display().to_string()), "{message}");
            }
        }
    }

    #[test]
    fn a_git_repository_commits_with_the_fixed_author_and_date_and_no_machine_config() {
        let dirs = TestDirs::new();
        let repo = GitRepo::init(dirs.folder("a repo"));
        repo.write("notes/readme.md", "line one\r\nline two\n");
        repo.commit_all("first");

        // Seconds since the epoch, because git's strict ISO dates write UTC as
        // `+00:00` or `Z` depending on its version. 1767323045 is
        // 2026-01-02T03:04:05Z.
        let log = repo.git(&["log", "-1", "--format=%an|%ae|%at|%cn|%ct|%s"]);
        assert_eq!(
            log.trim(),
            "Floti Tests|tests@floti.invalid|1767323045|Floti Tests|1767323045|first"
        );
        assert_eq!(repo.git(&["branch", "--show-current"]).trim(), "main");
        // Only the repository's own config and this fixture's settings.
        let origins = repo.git(&["config", "--list", "--show-origin"]);
        for line in origins.lines() {
            assert!(
                line.starts_with("command line:") || line.starts_with("file:.git/config"),
                "{line}"
            );
        }
        // No line-ending conversion: the bytes committed are the bytes written.
        assert_eq!(
            repo.git(&["show", "HEAD:notes/readme.md"]),
            "line one\r\nline two\n"
        );
    }

    #[test]
    fn a_folder_link_is_a_link_and_removing_it_leaves_its_target() {
        let dirs = TestDirs::new();
        let target = dirs.folder("real folder");
        std::fs::write(target.join("kept.txt"), "still here").unwrap();
        let tree = dirs.folder("a tree");
        let link = tree.join("linked");
        link_folder(&target, &link);
        assert!(crate::platform::links::is_link(&link));
        assert_eq!(
            std::fs::read_to_string(link.join("kept.txt")).unwrap(),
            "still here"
        );

        crate::platform::links::remove_tree(&crate::platform::links::Native, &tree).unwrap();
        assert!(!tree.exists());
        assert_eq!(
            std::fs::read_to_string(target.join("kept.txt")).unwrap(),
            "still here"
        );
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
