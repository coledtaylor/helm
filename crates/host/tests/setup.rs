//! `floti setup`, against a fake OS: the data folder and host key it makes,
//! the start-at-sign-in entry it writes and registers with each OS's
//! per-user mechanism, and the host it starts through that mechanism.
//!
//! Nothing here registers anything on this computer. Every OS command setup
//! runs goes to a [`FakeOs`] that records it and plays Task Scheduler,
//! launchd or systemd's user manager: it keeps their entries in memory, and
//! "starts the host" by starting a real one in-process on the test's own
//! folders, so setup's wait for it to answer meets a real host. Every
//! folder is in the test's temporary tree, the home folder included, and
//! all three OSes are played on every OS.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use floti_host::agent::AgentBackend;
use floti_host::fake_agent;
use floti_host::platform::folders::{
    CONFIG_DIR_VAR, DATA_DIR_VAR, LOG_DIR_VAR, RUNTIME_DIR_VAR, UserEnv,
};
use floti_host::platform::startup::register::{OsCommand, Ran, SignInSystem};
use floti_host::platform::startup::{StartupDefinition, linux, macos, windows};
use floti_host::server::{HOST_KEY_FILE, HostConfig, host_public_key, local_endpoint};
use floti_host::setup::{
    AT_NEXT_SIGN_IN_EXIT, AT_NEXT_SIGN_IN_LINE, RUNNING_LINE, SetupOutcome, setup,
};
use floti_host::testkit::{FakeAgent, PATIENCE, RunningHost, TestDirs};
use floti_protocol::channels::host::HostStopReason;

const WINDOWS_FLOTI: &str = r"C:\Users\me\AppData\Local\Programs\Floti\bin\floti.exe";
const WINDOWS_USER: &str = r"BUILD-BOX\me";
const UNIX_FLOTI: &str = "/home/me/.local/bin/floti";
const UID: &str = "501";

/// The user setup runs as: the test's home, and every Floti folder moved
/// into the test's tree.
fn user(dirs: &TestDirs) -> UserEnv {
    let mut env = dirs.user_env();
    for (name, folder) in [
        (DATA_DIR_VAR, &dirs.data),
        (LOG_DIR_VAR, &dirs.logs),
        (CONFIG_DIR_VAR, &dirs.config),
        (RUNTIME_DIR_VAR, &dirs.runtime),
    ] {
        env.vars
            .insert(name.into(), folder.clone().into_os_string());
    }
    env
}

fn host_config(dirs: &TestDirs, agent: &FakeAgent) -> HostConfig {
    HostConfig {
        run: Default::default(),
        folders: dirs.folders(),
        endpoint: local_endpoint(&dirs.folders()),
        backends: vec![Arc::new(agent.backend(Vec::<&str>::new())) as Arc<dyn AgentBackend>],
        inherited_env: std::env::vars_os().collect(),
    }
}

/// What the fake OS's mechanisms hold.
#[derive(Default)]
struct OsState {
    /// Every command run, as its command line.
    runs: Vec<String>,
    /// Task Scheduler's tasks, by name: the XML imported.
    tasks: BTreeMap<String, Vec<u8>>,
    /// launchd's agents loaded in the GUI domain, by label: the property
    /// list it was given.
    loaded: BTreeMap<String, Vec<u8>>,
    /// The user units systemd's user manager has enabled.
    enabled: BTreeSet<String>,
    /// How many times the mechanism started the host.
    starts: usize,
    /// The host it started, running on the test's folders.
    host: Option<RunningHost>,
}

/// An OS that is signed in to or not, plays Task Scheduler, launchd and
/// systemd's user manager in memory, and starts the host when one of them
/// is asked to.
struct FakeOs {
    signed_in: bool,
    /// A command line that starts with this fails, writing `fails_with`.
    fails: Option<(String, String)>,
    config: Mutex<Option<HostConfig>>,
    state: Mutex<OsState>,
}

impl FakeOs {
    fn new(dirs: &TestDirs, agent: &FakeAgent, signed_in: bool) -> Self {
        Self {
            signed_in,
            fails: None,
            config: Mutex::new(Some(host_config(dirs, agent))),
            state: Mutex::new(OsState::default()),
        }
    }

    fn failing(mut self, line: &str, says: &str) -> Self {
        self.fails = Some((line.to_owned(), says.to_owned()));
        self
    }

    fn runs(&self) -> Vec<String> {
        self.state.lock().unwrap().runs.clone()
    }

    fn starts(&self) -> usize {
        self.state.lock().unwrap().starts
    }

    /// Starts the host, as the mechanism would in the signed-in session; a
    /// host already running is left as it is.
    fn start_host(&self, state: &mut OsState) {
        state.starts += 1;
        if state.host.is_none() {
            let config = self.config.lock().unwrap().take().expect("one host config");
            state.host = Some(RunningHost::start(config));
        }
    }

    async fn stop(&self) {
        let host = self.state.lock().unwrap().host.take();
        if let Some(host) = host {
            host.stop(HostStopReason::Stop).await;
        }
    }
}

fn ok(stdout: &str) -> io::Result<Ran> {
    Ok(Ran {
        success: true,
        stdout: stdout.to_owned(),
        stderr: String::new(),
    })
}

fn failed(stderr: &str) -> io::Result<Ran> {
    Ok(Ran {
        success: false,
        stdout: String::new(),
        stderr: stderr.to_owned(),
    })
}

impl SignInSystem for FakeOs {
    fn run(&self, command: &OsCommand) -> io::Result<Ran> {
        let line = command.described();
        let mut state = self.state.lock().unwrap();
        state.runs.push(line.clone());
        if let Some((prefix, says)) = &self.fails
            && line.starts_with(prefix.as_str())
        {
            return failed(says);
        }
        let args: Vec<String> = command
            .args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        match (command.program.as_str(), args.as_slice()) {
            ("schtasks", ["/Create", "/TN", name, "/XML", file, rest @ ..]) => {
                if state.tasks.contains_key(*name) && rest != ["/F"] {
                    return failed("ERROR: Cannot create a file when that file already exists.");
                }
                let xml = std::fs::read(file)?;
                state.tasks.insert((*name).to_owned(), xml);
                ok("SUCCESS: The scheduled task has successfully been created.")
            }
            ("schtasks", ["/Run", "/TN", name]) if state.tasks.contains_key(*name) => {
                self.start_host(&mut state);
                ok("SUCCESS: Attempted to run the scheduled task.")
            }
            ("id", ["-u"]) => ok(&format!("{UID}\n")),
            ("launchctl", ["print", domain]) if *domain == format!("gui/{UID}") => {
                if self.signed_in {
                    ok("gui/501 = {}")
                } else {
                    failed("Bad request.\nCould not find domain for user gui: 501")
                }
            }
            ("launchctl", ["print", service]) => match service.strip_prefix("gui/501/") {
                Some(label) if self.signed_in && state.loaded.contains_key(label) => ok("{}"),
                _ => failed("Bad request.\nCould not find service in domain for user gui: 501"),
            },
            ("launchctl", ["bootout", service]) => {
                let label = service.strip_prefix("gui/501/").unwrap_or_default();
                state.loaded.remove(label);
                state.host.take();
                ok("")
            }
            ("launchctl", ["bootstrap", "gui/501", file]) => {
                let plist = std::fs::read(file)?;
                let label = Path::new(file)
                    .file_stem()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                if state.loaded.contains_key(&label) {
                    return failed("Bootstrap failed: 5: Input/output error");
                }
                state.loaded.insert(label, plist);
                // RunAtLoad: launchd starts it as it loads it.
                self.start_host(&mut state);
                ok("")
            }
            ("launchctl", ["kickstart", service]) => {
                let label = service.strip_prefix("gui/501/").unwrap_or_default();
                if !state.loaded.contains_key(label) {
                    return failed("Could not find service in domain");
                }
                self.start_host(&mut state);
                ok("")
            }
            ("systemctl", ["--user", "daemon-reload"]) => ok(""),
            ("systemctl", ["--user", "enable", unit]) => {
                state.enabled.insert((*unit).to_owned());
                ok("")
            }
            ("systemctl", ["--user", "start", unit]) if state.enabled.contains(*unit) => {
                self.start_host(&mut state);
                ok("")
            }
            _ => failed(&format!("the fake OS does not know `{line}`")),
        }
    }

    fn desktop_session(&self) -> io::Result<bool> {
        Ok(self.signed_in)
    }
}

/// Runs setup for `definition` as the test's user against `os`.
async fn run_setup(dirs: &TestDirs, os: &FakeOs, definition: &StartupDefinition) -> SetupOutcome {
    setup(&user(dirs), os, definition, PATIENCE).await
}

fn logon_task(binary: &str) -> StartupDefinition {
    windows::logon_task(Path::new(binary), WINDOWS_USER).unwrap()
}

fn task_file(dirs: &TestDirs) -> PathBuf {
    dirs.data.join("startup").join("Floti host.xml")
}

fn plist_file(dirs: &TestDirs) -> PathBuf {
    dirs.home
        .join("Library")
        .join("LaunchAgents")
        .join("dev.floti.host.plist")
}

fn unit_file(dirs: &TestDirs) -> PathBuf {
    dirs.home
        .join(".config")
        .join("systemd")
        .join("user")
        .join("floti.service")
}

/// Asserts no command asked for admin rights or a system-wide entry.
fn assert_per_user_only(runs: &[String]) {
    for run in runs {
        for word in [
            "sudo",
            "runas",
            "/RU",
            "SYSTEM",
            "--system",
            "LaunchDaemons",
            "/etc/",
        ] {
            assert!(!run.contains(word), "{run:?} names {word}");
        }
    }
}

/// Asserts the host setup made a key for answers on the test's folders,
/// with that key.
async fn assert_host_answers_with_the_key_setup_made(dirs: &TestDirs) {
    assert!(dirs.data.join(HOST_KEY_FILE).is_file());
    let key = host_public_key(&dirs.data)
        .unwrap()
        .expect("setup made the host key");
    let client =
        floti_host::testkit::TestClient::connect(&local_endpoint(&dirs.folders()), &[]).await;
    assert_eq!(client.host_key(), key);
}

// ---------------------------------------------------------------------------
// S4: registered with the OS's per-user mechanism, started in the signed-in
// session through it, and said to be running on one line
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s4_on_windows_setup_imports_the_logon_task_runs_it_in_the_signed_in_session_and_says_the_host_is_running()
 {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let os = FakeOs::new(&dirs, &agent, true);
    let definition = logon_task(WINDOWS_FLOTI);

    let outcome = run_setup(&dirs, &os, &definition).await;

    assert_eq!(outcome, SetupOutcome::Running);
    assert_eq!(outcome.code(), 0);
    assert_eq!(outcome.printed(), Some(RUNNING_LINE));
    assert!(!RUNNING_LINE.contains('\n'));
    let file = task_file(&dirs);
    assert_eq!(
        os.runs(),
        [
            format!("schtasks /Create /TN Floti host /XML {} /F", file.display()),
            "schtasks /Run /TN Floti host".to_owned(),
        ]
    );
    assert_per_user_only(&os.runs());
    // The task Task Scheduler holds is the definition for this user, at
    // logon, with an interactive token and least privilege.
    let tasks = os.state.lock().unwrap().tasks.clone();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks["Floti host"], definition.file_bytes());
    for part in [
        "<LogonTrigger>",
        "<LogonType>InteractiveToken</LogonType>",
        "<RunLevel>LeastPrivilege</RunLevel>",
    ] {
        assert!(definition.contents.contains(part), "{part}");
    }
    assert_eq!(os.starts(), 1);
    assert_host_answers_with_the_key_setup_made(&dirs).await;
    os.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s4_on_macos_setup_writes_the_launch_agent_loads_it_in_the_gui_domain_and_says_the_host_is_running()
 {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let os = FakeOs::new(&dirs, &agent, true);
    let definition = macos::launch_agent(Path::new(UNIX_FLOTI)).unwrap();

    let outcome = run_setup(&dirs, &os, &definition).await;

    assert_eq!(outcome, SetupOutcome::Running);
    let plist = plist_file(&dirs);
    assert_eq!(std::fs::read(&plist).unwrap(), definition.file_bytes());
    assert_eq!(
        os.runs(),
        [
            "id -u".to_owned(),
            "launchctl print gui/501".to_owned(),
            "launchctl print gui/501/dev.floti.host".to_owned(),
            format!("launchctl bootstrap gui/501 {}", plist.display()),
            "launchctl kickstart gui/501/dev.floti.host".to_owned(),
        ]
    );
    assert_per_user_only(&os.runs());
    assert!(definition.contents.contains("<string>Aqua</string>"));
    assert_host_answers_with_the_key_setup_made(&dirs).await;
    os.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s4_on_linux_setup_writes_the_user_unit_enables_and_starts_it_with_the_user_manager_and_says_the_host_is_running()
 {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let os = FakeOs::new(&dirs, &agent, true);
    let definition = linux::user_unit(Path::new(UNIX_FLOTI)).unwrap();

    let outcome = run_setup(&dirs, &os, &definition).await;

    assert_eq!(outcome, SetupOutcome::Running);
    assert_eq!(
        std::fs::read(unit_file(&dirs)).unwrap(),
        definition.file_bytes()
    );
    assert_eq!(
        os.runs(),
        [
            "systemctl --user daemon-reload",
            "systemctl --user enable floti.service",
            "systemctl --user start floti.service",
        ]
    );
    assert_per_user_only(&os.runs());
    assert_host_answers_with_the_key_setup_made(&dirs).await;
    os.stop().await;
}

// ---------------------------------------------------------------------------
// S5: with nobody signed in, registered and nothing started
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s5_on_windows_with_nobody_signed_in_setup_registers_the_logon_task_starts_no_host_and_says_it_starts_at_the_next_sign_in()
 {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let os = FakeOs::new(&dirs, &agent, false);
    let definition = logon_task(WINDOWS_FLOTI);

    let outcome = run_setup(&dirs, &os, &definition).await;

    assert_eq!(outcome, SetupOutcome::AtNextSignIn);
    assert_eq!(outcome.code(), AT_NEXT_SIGN_IN_EXIT);
    assert_eq!(outcome.printed(), Some(AT_NEXT_SIGN_IN_LINE));
    assert!(!AT_NEXT_SIGN_IN_LINE.contains('\n'));
    assert_eq!(
        os.runs(),
        [format!(
            "schtasks /Create /TN Floti host /XML {} /F",
            task_file(&dirs).display()
        )]
    );
    assert_eq!(os.state.lock().unwrap().tasks.len(), 1);
    assert_eq!(os.starts(), 0, "no host was started");
    // The data folder and its key are there for the host that starts then.
    assert!(host_public_key(&dirs.data).unwrap().is_some());
}

#[tokio::test(flavor = "multi_thread")]
async fn s5_on_macos_with_no_gui_domain_setup_leaves_the_agent_for_launchd_to_load_at_the_next_sign_in()
 {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let os = FakeOs::new(&dirs, &agent, false);
    let definition = macos::launch_agent(Path::new(UNIX_FLOTI)).unwrap();

    let outcome = run_setup(&dirs, &os, &definition).await;

    assert_eq!(outcome, SetupOutcome::AtNextSignIn);
    assert!(plist_file(&dirs).is_file());
    assert_eq!(os.runs(), ["id -u", "launchctl print gui/501"]);
    assert_eq!(os.starts(), 0);
}

// ---------------------------------------------------------------------------
// S6: running setup again replaces its one entry, never adding a second
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s6_on_windows_setup_run_again_for_an_update_replaces_the_one_logon_task() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let os = FakeOs::new(&dirs, &agent, false);

    let first = logon_task(WINDOWS_FLOTI);
    assert_eq!(
        run_setup(&dirs, &os, &first).await,
        SetupOutcome::AtNextSignIn
    );
    let moved = logon_task(r"C:\Users\me\Floti\floti.exe");
    assert_eq!(
        run_setup(&dirs, &os, &moved).await,
        SetupOutcome::AtNextSignIn
    );

    let tasks = os.state.lock().unwrap().tasks.clone();
    assert_eq!(tasks.keys().collect::<Vec<_>>(), ["Floti host"]);
    assert_eq!(tasks["Floti host"], moved.file_bytes());
    assert_eq!(
        std::fs::read_dir(dirs.data.join("startup"))
            .unwrap()
            .count(),
        1
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn s6_on_macos_setup_run_again_keeps_one_agent_reloading_it_only_when_it_changed() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let os = FakeOs::new(&dirs, &agent, true);
    let definition = macos::launch_agent(Path::new(UNIX_FLOTI)).unwrap();
    assert_eq!(
        run_setup(&dirs, &os, &definition).await,
        SetupOutcome::Running
    );
    let before = os.runs().len();

    // The same floti again, as an update in place: the loaded agent and its
    // running host are left as they are.
    assert_eq!(
        run_setup(&dirs, &os, &definition).await,
        SetupOutcome::Running
    );
    let again: Vec<String> = os.runs()[before..].to_vec();
    assert!(
        !again.iter().any(|run| run.contains("bootout")),
        "{again:?}"
    );
    assert!(
        !again.iter().any(|run| run.contains("bootstrap")),
        "{again:?}"
    );

    // A floti somewhere else: the agent is replaced, never added beside.
    os.stop().await;
    let moved = macos::launch_agent(Path::new("/Users/me/bin/floti")).unwrap();
    let os_moved = FakeOs::new(&dirs, &agent, true);
    os_moved
        .state
        .lock()
        .unwrap()
        .loaded
        .insert("dev.floti.host".to_owned(), definition.file_bytes());
    assert_eq!(
        run_setup(&dirs, &os_moved, &moved).await,
        SetupOutcome::Running
    );
    let runs = os_moved.runs();
    let bootout = runs.iter().position(|run| run.contains("bootout")).unwrap();
    let bootstrap = runs
        .iter()
        .position(|run| run.contains("bootstrap"))
        .unwrap();
    assert!(bootout < bootstrap, "{runs:?}");
    let loaded = os_moved.state.lock().unwrap().loaded.clone();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded["dev.floti.host"], moved.file_bytes());
    let agents: Vec<OsString> = std::fs::read_dir(plist_file(&dirs).parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(agents, ["dev.floti.host.plist"]);
    os_moved.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s6_on_linux_setup_run_again_keeps_one_enabled_unit() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let os = FakeOs::new(&dirs, &agent, true);
    let first = linux::user_unit(Path::new(UNIX_FLOTI)).unwrap();
    assert_eq!(run_setup(&dirs, &os, &first).await, SetupOutcome::Running);
    let moved = linux::user_unit(Path::new("/home/me/bin/floti")).unwrap();
    assert_eq!(run_setup(&dirs, &os, &moved).await, SetupOutcome::Running);

    assert_eq!(
        os.state.lock().unwrap().enabled.iter().collect::<Vec<_>>(),
        ["floti.service"]
    );
    assert_eq!(std::fs::read(unit_file(&dirs)).unwrap(), moved.file_bytes());
    assert_eq!(
        std::fs::read_dir(unit_file(&dirs).parent().unwrap())
            .unwrap()
            .count(),
        1
    );
    os.stop().await;
}

// ---------------------------------------------------------------------------
// A failing registration says the OS's last line and starts nothing
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_registration_the_os_refuses_fails_with_its_last_line_unedited_and_starts_nothing() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let os = FakeOs::new(&dirs, &agent, true)
        .failing("schtasks /Create", "ERROR: Access is denied.\r\n");

    let outcome = run_setup(&dirs, &os, &logon_task(WINDOWS_FLOTI)).await;

    assert_eq!(
        outcome,
        SetupOutcome::Failed("ERROR: Access is denied.".to_owned())
    );
    assert_eq!(outcome.code(), 1);
    assert_eq!(outcome.printed(), None);
    assert_eq!(os.starts(), 0);
    assert_eq!(os.runs().len(), 1);
}
