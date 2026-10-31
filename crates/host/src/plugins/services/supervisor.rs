//! One read's service: started when it is first needed (or with the plugin,
//! for `start: "enable"`), watched, started again after an exit with a
//! growing delay, and ended, with everything it started, when the read
//! stops. Today's supervisor (`desktop/main/plugins/service.ts`), on Tokio.
//!
//! Every launch and every stop bumps a generation, so an exit, a readiness
//! answer or a restart timer from an older process changes nothing. The
//! lock is never held across an await, and nothing outside it (the plugin
//! list, the log, a waiting call) is told anything while it is held.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::net::{Ipv4Addr, TcpListener};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;

use floti_protocol::channels::plugins::{PluginErrorCode, PluginServiceKind, PluginServiceState};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use url::Url;

use super::Deps;
use super::launcher::{EndTree, ServiceCommand};
use crate::plugins::call::PluginCallError;
use crate::plugins::exec::program::{Missing, find_program, launch, plain, program_env};
use crate::plugins::loader::{Inside, resolve_inside};
use crate::plugins::net::service::{ServiceChanged, ServiceEndpoint, ServicePlugin, ServiceStatus};
use crate::plugins::net::substitute::substitute_env;
use crate::plugins::secrets::SecretUse;

/// How long a service has to start listening.
pub const SERVICE_READY: Duration = Duration::from_secs(20);
/// How often its port is tried while it starts.
pub const READY_POLL: Duration = Duration::from_millis(100);
/// Restart delays double from this, up to [`BACKOFF_MAX`].
pub const BACKOFF_MIN: Duration = Duration::from_secs(1);
pub const BACKOFF_MAX: Duration = Duration::from_secs(30);
/// This many exits inside [`CRASH_WINDOW`] and the host stops trying until
/// the plugin is read again.
pub const CRASH_LIMIT: usize = 5;
pub const CRASH_WINDOW: Duration = Duration::from_secs(60);
/// A service that ran this long before it exited starts its backoff again
/// from the bottom.
pub const STABLE: Duration = Duration::from_secs(30);

/// The variables every service is told.
pub const PORT_VAR: &str = "HELM_SERVICE_PORT";
pub const TOKEN_VAR: &str = "HELM_SERVICE_TOKEN";
pub const PLUGIN_VAR: &str = "HELM_PLUGIN_ID";

/// Bytes of randomness in a run's token.
const TOKEN_BYTES: usize = 32;

type Waiter = oneshot::Sender<Result<ServiceEndpoint, PluginCallError>>;

/// One read's service. Cloning it is cheap; every clone is the same one.
#[derive(Clone)]
pub(crate) struct Supervisor {
    inner: Arc<Inner>,
}

struct Inner {
    plugin: String,
    revision: u64,
    folder: PathBuf,
    kind: PluginServiceKind,
    command: String,
    args: Vec<String>,
    env: std::collections::BTreeMap<String, String>,
    secrets: Vec<String>,
    changed: ServiceChanged,
    deps: Arc<Deps>,
    state: Mutex<State>,
    myself: Weak<Inner>,
}

/// The process of the current run.
struct Run {
    pid: Option<u32>,
    port: u16,
    started: Instant,
    end: Option<EndTree>,
}

impl Run {
    fn end(&mut self) {
        if let Some(end) = self.end.take() {
            end();
        }
    }
}

struct State {
    state: PluginServiceState,
    error: Option<String>,
    restarts: u32,
    current: Option<Run>,
    endpoint: Option<ServiceEndpoint>,
    restart: Option<JoinHandle<()>>,
    /// Exits in a row, each started again sooner than [`STABLE`] after it.
    consecutive: u32,
    /// When each exit inside the last [`CRASH_WINDOW`] happened.
    exits: VecDeque<Instant>,
    generation: u64,
    waiters: Vec<Waiter>,
    /// The read has stopped: nothing starts again.
    closed: bool,
}

/// What to tell once the lock is let go.
#[derive(Default)]
#[must_use]
struct After {
    note: Option<String>,
    settle: Option<(Vec<Waiter>, Result<ServiceEndpoint, PluginCallError>)>,
    changed: bool,
}

fn lock(state: &Mutex<State>) -> MutexGuard<'_, State> {
    state.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Marks a launch begun, so a second call in the meantime waits for it
/// rather than starting another: the generation it runs as.
fn begin(state: &mut State) -> u64 {
    state.restart = None;
    state.generation += 1;
    state.state = PluginServiceState::Starting;
    state.error = None;
    state.generation
}

fn service_error(message: impl Into<String>) -> PluginCallError {
    PluginCallError::new(PluginErrorCode::Service, message)
}

fn stopped_error() -> PluginCallError {
    PluginCallError::unavailable("the service was stopped")
}

/// Whole seconds where they are whole, as today's sentences say them.
fn seconds(duration: Duration) -> String {
    let secs = duration.as_secs_f64();
    if secs.fract() == 0.0 {
        format!("{}", duration.as_secs())
    } else {
        format!("{secs}")
    }
}

impl Supervisor {
    pub fn new(service: ServicePlugin, deps: Arc<Deps>) -> Self {
        let ServicePlugin {
            plugin,
            revision,
            folder,
            spec,
            secrets,
            changed,
        } = service;
        let inner = Arc::new_cyclic(|myself| Inner {
            plugin,
            revision,
            folder,
            kind: spec.kind,
            command: spec.command,
            args: spec.args,
            env: spec.env,
            secrets,
            changed,
            deps,
            state: Mutex::new(State {
                state: PluginServiceState::Stopped,
                error: None,
                restarts: 0,
                current: None,
                endpoint: None,
                restart: None,
                consecutive: 0,
                exits: VecDeque::new(),
                generation: 0,
                waiters: Vec::new(),
                closed: false,
            }),
            myself: myself.clone(),
        });
        Self { inner }
    }

    pub fn revision(&self) -> u64 {
        self.inner.revision
    }

    pub fn status(&self) -> ServiceStatus {
        let state = lock(&self.inner.state);
        ServiceStatus {
            state: state.state,
            pid: state.current.as_ref().and_then(|run| run.pid),
            port: state.current.as_ref().map(|run| run.port),
            restarts: state.restarts,
            error: state.error.clone(),
        }
    }

    /// Running and listening, starting it if it is not.
    pub async fn ensure(&self) -> Result<ServiceEndpoint, PluginCallError> {
        let (waiting, launch) = {
            let mut state = lock(&self.inner.state);
            if state.closed {
                return Err(stopped_error());
            }
            match (state.state, &state.endpoint) {
                (PluginServiceState::Running, Some(endpoint)) => return Ok(endpoint.clone()),
                (PluginServiceState::Failed, _) => {
                    return Err(service_error(format!(
                        "the service is not running: {}",
                        state.error.as_deref().unwrap_or("it failed")
                    )));
                }
                _ => {}
            }
            let (send, receive) = oneshot::channel();
            state.waiters.push(send);
            let launch = (state.state == PluginServiceState::Stopped).then(|| begin(&mut state));
            (receive, launch)
        };
        if let Some(mine) = launch {
            self.inner.spawn_launch(mine);
        }
        waiting.await.unwrap_or_else(|_| Err(stopped_error()))
    }

    /// Starts it without waiting: `start: "enable"`.
    pub fn start(&self) {
        let launch = {
            let mut state = lock(&self.inner.state);
            (!state.closed && state.state == PluginServiceState::Stopped).then(|| begin(&mut state))
        };
        if let Some(mine) = launch {
            self.inner.spawn_launch(mine);
        }
    }

    /// Ends it and everything it started, for good: the read has stopped.
    /// Calls waiting for it are refused as `unavailable`.
    pub fn close(&self) {
        let (run, waiters) = {
            let mut state = lock(&self.inner.state);
            state.closed = true;
            state.generation += 1;
            if let Some(restart) = state.restart.take() {
                restart.abort();
            }
            state.endpoint = None;
            state.state = PluginServiceState::Stopped;
            (state.current.take(), std::mem::take(&mut state.waiters))
        };
        if let Some(mut run) = run {
            run.end();
            self.inner.note("stopped");
        }
        for waiter in waiters {
            let _ = waiter.send(Err(stopped_error()));
        }
    }
}

impl Inner {
    fn note(&self, line: &str) {
        (self.deps.log)(&self.plugin, line);
    }

    fn tell(&self, after: After) {
        if let Some(note) = &after.note {
            self.note(note);
        }
        if let Some((waiters, outcome)) = after.settle {
            for waiter in waiters {
                let _ = waiter.send(outcome.clone());
            }
        }
        if after.changed {
            (self.changed)();
        }
    }

    fn spawn_launch(&self, mine: u64) {
        let Some(myself) = self.myself.upgrade() else {
            return;
        };
        self.deps
            .runtime
            .spawn(async move { myself.launch(mine).await });
    }

    /// The read's failure: no more starts until the plugin is read again.
    fn failed(&self, state: &mut State, message: String) -> After {
        state.state = PluginServiceState::Failed;
        state.error = Some(message.clone());
        let waiters = std::mem::take(&mut state.waiters);
        After {
            note: Some(message.clone()),
            settle: Some((waiters, Err(service_error(message)))),
            changed: true,
        }
    }

    /// Fails the launch `mine`, unless something since has replaced it.
    fn fail(&self, mine: u64, message: String) {
        let after = {
            let mut state = lock(&self.state);
            if state.generation != mine || state.closed {
                return;
            }
            self.failed(&mut state, message)
        };
        self.tell(after);
    }

    /// What a `node` service runs on, or a `command` service is: the
    /// program and its arguments, or the sentence saying why there is none.
    fn program(&self) -> Result<crate::platform::launcher::Program, String> {
        match self.kind {
            PluginServiceKind::Node => {
                let Inside::File(script) = resolve_inside(&self.folder, &self.command) else {
                    return Err(format!(
                        "{} is not a file in the plugin folder",
                        self.command
                    ));
                };
                let Some(node) = &self.deps.node else {
                    return Err(format!(
                        "this host has no Node runtime to run {} on",
                        self.command
                    ));
                };
                let args: Vec<String> =
                    std::iter::once(plain(&script).to_string_lossy().into_owned())
                        .chain(self.args.iter().cloned())
                        .collect();
                Ok(launch(node, &args))
            }
            PluginServiceKind::Command => match find_program(&self.folder, &self.command) {
                Ok(file) => Ok(launch(&file, &self.args)),
                Err(Missing::NotFound) => {
                    Err(format!("{} was not found on this computer", self.command))
                }
                Err(Missing::Outside) => {
                    Err(format!("{} is outside the plugin folder", self.command))
                }
            },
        }
    }

    /// Starts the process for the launch `mine`, [`begin`] already marked.
    async fn launch(self: Arc<Self>, mine: u64) {
        (self.changed)();

        let declared = match substitute_env(&self.env, &mut |key| {
            self.deps
                .secrets
                .reveal(&self.plugin, &self.secrets, key, SecretUse::Program)
                .map(|value| value.expose().to_owned())
        }) {
            Ok(declared) => declared,
            Err(err) => {
                self.fail(
                    mine,
                    format!("the service was not started: {}", err.message),
                );
                return;
            }
        };
        let program = match self.program() {
            Ok(program) => program,
            Err(message) => {
                self.fail(mine, message);
                return;
            }
        };
        let port = match free_port() {
            Ok(port) => port,
            Err(err) => {
                self.fail(mine, format!("no free port on 127.0.0.1: {err}"));
                return;
            }
        };
        let token = new_token();
        let mut told = declared;
        told.extend([
            (PORT_VAR.to_owned(), port.to_string()),
            (TOKEN_VAR.to_owned(), token.clone()),
            (PLUGIN_VAR.to_owned(), self.plugin.clone()),
        ]);
        let inherited: Vec<(OsString, OsString)> = (self.deps.inherited)();
        let command = ServiceCommand {
            env: program_env(inherited, told, &program),
            program,
            folder: plain(&self.folder),
        };

        if lock(&self.state).generation != mine {
            return;
        }
        let child = match self.deps.launcher.launch(&command) {
            Ok(child) => child,
            Err(err) => {
                self.fail(mine, format!("the service could not be started: {err}"));
                return;
            }
        };
        drop(command);
        let mut run = Run {
            pid: child.pid,
            port,
            started: Instant::now(),
            end: Some(child.end),
        };
        // Its exit is watched whatever happens next, so it is reaped.
        let watcher = Arc::downgrade(&self);
        let exited = child.exited;
        self.deps.runtime.spawn(async move {
            let code = exited.await;
            if let Some(inner) = watcher.upgrade() {
                inner.exited(mine, code);
            }
        });
        {
            let mut state = lock(&self.state);
            if state.generation != mine || state.closed {
                drop(state);
                run.end();
                return;
            }
            state.current = Some(run);
        }
        self.note(&format!(
            "started {}, listening on 127.0.0.1:{port}",
            self.command
        ));
        (self.changed)();

        let ready = self.listening(mine, port).await;
        let after = {
            let mut state = lock(&self.state);
            if state.generation != mine || state.closed {
                return;
            }
            if ready {
                let origin = Url::parse(&format!("http://127.0.0.1:{port}/"))
                    .expect("a loopback origin is a URL");
                let endpoint = ServiceEndpoint { origin, token };
                state.endpoint = Some(endpoint.clone());
                state.state = PluginServiceState::Running;
                state.error = None;
                After {
                    note: None,
                    settle: Some((std::mem::take(&mut state.waiters), Ok(endpoint))),
                    changed: true,
                }
            } else {
                let mut run = state.current.take().expect("the run this launch started");
                run.end();
                let mut after = self.exit(&mut state, run, "stopped");
                let gave_up = after.note.take().unwrap_or_default();
                after.note = Some(format!(
                    "it did not listen on 127.0.0.1:{port} within {}s, so it was stopped; {gave_up}",
                    seconds(SERVICE_READY)
                ));
                after
            }
        };
        self.tell(after);
    }

    /// Whether the launch `mine`'s port accepts a connection within
    /// [`SERVICE_READY`], trying every [`READY_POLL`].
    async fn listening(&self, mine: u64, port: u16) -> bool {
        let until = Instant::now() + SERVICE_READY;
        while Instant::now() < until {
            if lock(&self.state).generation != mine {
                return false;
            }
            if self.deps.launcher.accepts(port).await {
                return true;
            }
            tokio::time::sleep(READY_POLL).await;
        }
        false
    }

    /// The process of the launch `mine` exited on its own.
    fn exited(&self, mine: u64, code: Option<i32>) {
        let after = {
            let mut state = lock(&self.state);
            if state.generation != mine || state.closed {
                return;
            }
            let Some(run) = state.current.take() else {
                return;
            };
            let how = code.map_or_else(
                || "stopped".to_owned(),
                |code| format!("exited with code {code}"),
            );
            self.exit(&mut state, run, &how)
        };
        self.tell(after);
    }

    /// Counts `run`'s exit and starts it again after its delay, or gives up.
    fn exit(&self, state: &mut State, run: Run, how: &str) -> After {
        state.generation += 1;
        state.endpoint = None;
        let now = Instant::now();
        if now.duration_since(run.started) >= STABLE {
            state.consecutive = 0;
        }
        state.consecutive += 1;
        while state
            .exits
            .front()
            .is_some_and(|at| now.duration_since(*at) >= CRASH_WINDOW)
        {
            state.exits.pop_front();
        }
        state.exits.push_back(now);
        if state.exits.len() >= CRASH_LIMIT {
            return self.failed(
                state,
                format!(
                    "it {how}, and has stopped {CRASH_LIMIT} times in a minute; \
                     it will not be started again until the plugin is reloaded"
                ),
            );
        }
        let doublings = (state.consecutive - 1).min(16);
        let delay = BACKOFF_MIN.saturating_mul(1 << doublings).min(BACKOFF_MAX);
        state.restarts += 1;
        state.state = PluginServiceState::Crashed;
        state.error = Some(format!("it {how}"));
        let restart = self.myself.clone();
        let exited = state.generation;
        state.restart = Some(self.deps.runtime.spawn(async move {
            tokio::time::sleep(delay).await;
            let Some(inner) = restart.upgrade() else {
                return;
            };
            let mine = {
                let mut state = lock(&inner.state);
                if state.closed || state.generation != exited {
                    return;
                }
                begin(&mut state)
            };
            inner.launch(mine).await;
        }));
        After {
            note: Some(format!(
                "it {how}; starting it again in {}s",
                seconds(delay)
            )),
            settle: None,
            changed: true,
        }
    }
}

/// A port nothing listens on, for the service to take.
fn free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    Ok(listener.local_addr()?.port())
}

/// A token for one run: [`TOKEN_BYTES`] from the OS, in hex.
fn new_token() -> String {
    let mut bytes = [0u8; TOKEN_BYTES];
    crate::agent::fill_random(&mut bytes);
    crate::agent::hex(&bytes)
}
