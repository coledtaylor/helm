//! The background runtime: each enabled plugin's background script in a
//! deno_core isolate of its own, whose only abilities are the `floti` API,
//! BroadcastChannel and the timers this module gives it.
//!
//! - Every isolate runs on an OS thread of its own (a `JsRuntime` is not
//!   `Send`), so a script stuck in a loop holds nothing but its own thread.
//! - Its `floti.*` calls go to the registry's call layer and are answered on
//!   the host's runtime, through one task per isolate that takes them in the
//!   order the script made them. The calls of one pass of the isolate's
//!   event loop go as one batch, so what they paint is pushed together.
//! - A script that throws at its top level, or runs past its memory limit
//!   ([`HEAP_LIMIT_BYTES`]), is reported crashed and is never restarted; a
//!   reload starts a new isolate. Switching it off, reloading or removing
//!   the plugin, and the host stopping, end the isolate, its timers and its
//!   calls in flight, by `terminate_execution` when it is busy.
//! - A session's tool call is handed in host-internally
//!   ([`BackgroundRuntime::call_tool`]), waits up to [`TOOL_WAIT`] for a
//!   script that is starting or has not registered its handler yet, and is
//!   answered as today's `tools.ts` answers.
//! - A plugin's BroadcastChannel messages are delivered within its isolate
//!   and published on [`IsolateRuntime::channel_messages`]; the host side
//!   posts into one with [`IsolateRuntime::post_to_channel`].
//! - What a script writes with `console` is kept as the plugin's log lines
//!   ([`IsolateRuntime::log`]), with the host's own notes about it.

mod isolate;
mod modules;

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use deno_core::futures::stream::FuturesUnordered;
use deno_core::futures::{FutureExt, StreamExt};
use deno_core::v8;
use floti_protocol::Payload;
use floti_protocol::channels::plugins::{PluginBackgroundState, PluginLogLine, PluginLogStream};
use serde::Serialize;
use tokio::sync::{broadcast, mpsc, oneshot, watch};

use super::PluginCall;
use super::background::{
    BackgroundEvent, BackgroundLaunch, BackgroundRuntime, ToolAnswer, ToolCall, ToolFuture,
};
use super::call::{CallResult, CancelToken, PluginCallError};
use super::registry::WeakRegistry;

/// How much heap one isolate may use before it is ended as a crash.
pub const HEAP_LIMIT_BYTES: usize = 128 * 1024 * 1024;

/// How long a tool call waits for a script that is starting, or for its
/// handler to be registered.
pub const TOOL_WAIT: Duration = Duration::from_secs(15);

/// The longest a tool call waits for its answer: as long as `floti.exec`
/// lets a program run, the longest thing a handler can be waiting on.
pub const TOOL_CALL_TIMEOUT: Duration = Duration::from_secs(600);

/// The longest answer a tool may give, in UTF-16 code units as a page
/// counts a string's length.
pub const TOOL_ANSWER_MAX_CHARS: usize = 1_000_000;

/// How long stopping an isolate waits for its thread to end.
const STOP_WAIT: Duration = Duration::from_secs(10);

/// How many log lines are kept for each plugin.
const LOG_LINES: usize = 1000;

const NOT_RUNNING: &str = "The plugin's background script is not running.";
const STOPPED_BEFORE: &str = "The plugin stopped before it answered.";
const CANCELLED: &str = "The call was cancelled.";

/// A message one of a plugin's background scripts posted on a
/// BroadcastChannel.
#[derive(Debug, Clone, PartialEq)]
pub struct ChannelMessage {
    pub plugin: String,
    pub channel: String,
    pub data: Payload,
}

/// The runtime every background script runs in. Cloning it is cheap; every
/// clone is the same one.
#[derive(Clone)]
pub struct IsolateRuntime {
    inner: Arc<Inner>,
}

struct Inner {
    /// The host's runtime, where calls are answered.
    host: tokio::runtime::Handle,
    registry: OnceLock<WeakRegistry>,
    workers: Mutex<HashMap<String, Worker>>,
    logs: Arc<Logs>,
    channels: broadcast::Sender<ChannelMessage>,
    next_tool: AtomicU32,
    tool_wait_ms: AtomicU64,
}

/// One plugin's running script.
struct Worker {
    inbound: mpsc::UnboundedSender<Inbound>,
    state: watch::Receiver<WorkerState>,
    control: Arc<Control>,
    tools: ToolTable,
    thread: Option<std::thread::JoinHandle<()>>,
    /// Disconnected once the thread has ended.
    done: std::sync::mpsc::Receiver<()>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum WorkerState {
    Starting,
    Running,
    Crashed(String),
    Stopped,
}

/// How the runtime reaches a script's thread from outside it.
#[derive(Default)]
struct Control {
    stopping: AtomicBool,
    out_of_memory: AtomicBool,
    /// Cancelled when the script ends: its calls in flight are children.
    cancel: CancelToken,
    isolate: Mutex<Option<v8::IsolateHandle>>,
}

impl Control {
    /// Gives the runtime the isolate to end, unless it is already stopping.
    fn attach(&self, isolate: v8::IsolateHandle) -> bool {
        let mut slot = lock(&self.isolate);
        if self.stopping.load(Ordering::SeqCst) {
            return false;
        }
        *slot = Some(isolate);
        true
    }

    /// Ends the script, whatever it is doing.
    fn stop(&self) {
        let slot = lock(&self.isolate);
        self.stopping.store(true, Ordering::SeqCst);
        self.cancel.cancel();
        if let Some(isolate) = slot.as_ref() {
            isolate.terminate_execution();
        }
    }
}

/// The tool calls a script is answering, by id.
type ToolTable = Arc<Mutex<HashMap<u32, oneshot::Sender<ToolAnswer>>>>;

/// A bridge call on its way to the host's call layer.
struct Job {
    call: PluginCall,
    reply: oneshot::Sender<CallResult>,
}

/// What the host sends a script.
#[derive(Debug, Serialize)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum Inbound {
    Tool {
        id: u32,
        name: String,
        args: serde_json::Value,
        session: ToolSession,
        wait_ms: u64,
    },
    ToolCancel {
        id: u32,
    },
    Event {
        name: &'static str,
        data: serde_json::Value,
    },
    Broadcast {
        name: String,
        data: Payload,
    },
}

#[derive(Debug, Serialize)]
struct ToolSession {
    id: String,
    name: String,
    cwd: String,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What a handler's answer comes to: its text, held to the size a tool may
/// answer with whatever the script let through, or its failure.
fn tool_answer(ok: bool, text: String) -> ToolAnswer {
    if !ok {
        return Err(text);
    }
    if text.encode_utf16().count() > TOOL_ANSWER_MAX_CHARS {
        return Err(format!(
            "The plugin answered with more than {TOOL_ANSWER_MAX_CHARS} characters, which is more than a tool may."
        ));
    }
    Ok(serde_json::Value::String(text))
}

/// Every plugin's log lines.
#[derive(Default)]
struct Logs {
    lines: Mutex<HashMap<String, VecDeque<PluginLogLine>>>,
}

impl Logs {
    fn push(&self, plugin: &str, stream: PluginLogStream, text: String) {
        let mut lines = lock(&self.lines);
        let kept = lines.entry(plugin.to_owned()).or_default();
        if kept.len() == LOG_LINES {
            kept.pop_front();
        }
        kept.push_back(PluginLogLine {
            at: crate::config_console::time::now_iso(),
            stream,
            text,
        });
    }

    fn of(&self, plugin: &str) -> Vec<PluginLogLine> {
        lock(&self.lines)
            .get(plugin)
            .map(|kept| kept.iter().cloned().collect())
            .unwrap_or_default()
    }
}

impl IsolateRuntime {
    /// A runtime whose calls are answered on the Tokio runtime it is made in.
    ///
    /// # Panics
    ///
    /// Outside a Tokio runtime.
    pub fn new() -> Self {
        let (channels, _) = broadcast::channel(256);
        Self {
            inner: Arc::new(Inner {
                host: tokio::runtime::Handle::current(),
                registry: OnceLock::new(),
                workers: Mutex::new(HashMap::new()),
                logs: Arc::default(),
                channels,
                next_tool: AtomicU32::new(1),
                tool_wait_ms: AtomicU64::new(millis(TOOL_WAIT)),
            }),
        }
    }

    /// The registry whose call layer answers every script's calls. A script
    /// started before it is given one has its calls refused as unavailable.
    pub fn connect(&self, registry: &super::Registry) {
        let _ = self.inner.registry.set(registry.downgrade());
    }

    /// How long a tool call waits for a starting script or a missing handler,
    /// [`TOOL_WAIT`] unless a test says otherwise.
    pub fn set_tool_wait(&self, wait: Duration) {
        self.inner
            .tool_wait_ms
            .store(millis(wait), Ordering::SeqCst);
    }

    /// The plugin's log lines, oldest first: what its script wrote with
    /// `console`, and the host's notes about it.
    pub fn log(&self, plugin: &str) -> Vec<PluginLogLine> {
        self.inner.logs.of(plugin)
    }

    /// Every message a background script posts on a BroadcastChannel, from
    /// now on.
    pub fn channel_messages(&self) -> broadcast::Receiver<ChannelMessage> {
        self.inner.channels.subscribe()
    }

    /// Posts `data` on `plugin`'s channel `channel`, to every one of its
    /// script's channels of that name. False when the plugin has no script
    /// running.
    pub fn post_to_channel(&self, plugin: &str, channel: &str, data: Payload) -> bool {
        self.send(
            plugin,
            Inbound::Broadcast {
                name: channel.to_owned(),
                data,
            },
        )
    }

    /// Whether `plugin` has a script running, or starting.
    pub fn is_running(&self, plugin: &str) -> bool {
        lock(&self.inner.workers).get(plugin).is_some_and(|worker| {
            matches!(
                *worker.state.borrow(),
                WorkerState::Starting | WorkerState::Running
            )
        })
    }

    fn send(&self, plugin: &str, message: Inbound) -> bool {
        lock(&self.inner.workers).get(plugin).is_some_and(|worker| {
            !matches!(
                *worker.state.borrow(),
                WorkerState::Crashed(_) | WorkerState::Stopped
            ) && worker.inbound.send(message).is_ok()
        })
    }
}

impl Default for IsolateRuntime {
    fn default() -> Self {
        Self::new()
    }
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

impl Worker {
    /// Ends the script and waits, for at most [`STOP_WAIT`], for its thread.
    fn end(mut self) {
        self.control.stop();
        drop(self.inbound);
        // A session waiting on a handler hears the plugin stopped.
        lock(&self.tools).clear();
        match self.done.recv_timeout(STOP_WAIT) {
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                // Terminated and still not back: it is left to end on its
                // own rather than hold the host.
            }
            Ok(()) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                if let Some(thread) = self.thread.take() {
                    let _ = thread.join();
                }
            }
        }
    }
}

impl BackgroundRuntime for IsolateRuntime {
    fn start(&self, launch: BackgroundLaunch) -> PluginBackgroundState {
        self.stop(&launch.plugin);
        let inner = &self.inner;
        let (inbound, inbound_rx) = mpsc::unbounded_channel();
        let (jobs, jobs_rx) = mpsc::unbounded_channel();
        let (state, state_rx) = watch::channel(WorkerState::Starting);
        let control = Arc::new(Control::default());
        let tools = ToolTable::default();
        let (done_tx, done) = std::sync::mpsc::channel::<()>();
        inner
            .host
            .spawn(forward(jobs_rx, inner.registry.get().cloned()));
        let spawn = isolate::Spawn {
            plugin: launch.plugin.clone(),
            folder: launch.folder.clone(),
            module: launch.module.clone(),
            control: Arc::clone(&control),
            inbound: inbound_rx,
            jobs,
            tools: Arc::clone(&tools),
            logs: Arc::clone(&inner.logs),
            channels: inner.channels.clone(),
            state,
            reporter: launch.reporter.clone(),
            host: inner.host.clone(),
        };
        let thread = std::thread::Builder::new()
            .name(format!("floti plugin {}", launch.plugin))
            .spawn(move || {
                isolate::run(spawn);
                drop(done_tx);
            });
        let thread = match thread {
            Ok(thread) => thread,
            Err(err) => {
                let reporter = launch.reporter.clone();
                let error = format!("the host could not start a thread for it: {err}");
                inner.host.spawn(async move {
                    reporter.report(PluginBackgroundState::Crashed, Some(error));
                });
                return PluginBackgroundState::Starting;
            }
        };
        lock(&inner.workers).insert(
            launch.plugin.clone(),
            Worker {
                inbound,
                state: state_rx,
                control,
                tools,
                thread: Some(thread),
                done,
            },
        );
        PluginBackgroundState::Starting
    }

    fn stop(&self, plugin: &str) {
        let worker = lock(&self.inner.workers).remove(plugin);
        if let Some(worker) = worker {
            worker.end();
        }
    }

    fn deliver(&self, plugin: &str, event: BackgroundEvent) {
        let (name, data) = match event {
            BackgroundEvent::Command { id } => ("command", serde_json::json!({ "id": id })),
            BackgroundEvent::Settings(values) => ("settings", to_json(&values)),
            BackgroundEvent::Secrets(states) => ("secrets", to_json(&states)),
            BackgroundEvent::Sessions(sessions) => ("sessions", to_json(&sessions)),
        };
        self.send(plugin, Inbound::Event { name, data });
    }

    fn call_tool(&self, call: ToolCall, cancel: CancelToken) -> ToolFuture {
        let inner = Arc::clone(&self.inner);
        Box::pin(async move { inner.call_tool(call, cancel).await })
    }
}

fn to_json<T: Serialize>(value: &T) -> serde_json::Value {
    serde_json::to_value(value).unwrap_or(serde_json::Value::Null)
}

impl Inner {
    async fn call_tool(&self, call: ToolCall, cancel: CancelToken) -> ToolAnswer {
        let arrived = Instant::now();
        let wait = Duration::from_millis(self.tool_wait_ms.load(Ordering::SeqCst));
        let (mut state, inbound, tools) = {
            let workers = lock(&self.workers);
            let Some(worker) = workers.get(&call.plugin) else {
                return Err(NOT_RUNNING.to_owned());
            };
            (
                worker.state.clone(),
                worker.inbound.clone(),
                Arc::clone(&worker.tools),
            )
        };

        // A script that is starting is waited for, briefly.
        let started = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(CANCELLED.to_owned()),
            started = tokio::time::timeout(
                wait,
                state.wait_for(|now| *now != WorkerState::Starting),
            ) => started.map(|now| now.map(|now| now.clone())),
        };
        match started {
            Err(_) => {
                return Err(format!(
                    "The plugin's background script did not start within {} seconds.",
                    wait.as_secs()
                ));
            }
            Ok(Err(_)) => return Err(NOT_RUNNING.to_owned()),
            Ok(Ok(now)) => match &now {
                WorkerState::Running => {}
                WorkerState::Crashed(error) => {
                    return Err(format!(
                        "The plugin's background script stopped ({error}). Reloading the plugin in Settings > Plugins starts it again."
                    ));
                }
                WorkerState::Starting | WorkerState::Stopped => return Err(NOT_RUNNING.to_owned()),
            },
        }

        let id = self.next_tool.fetch_add(1, Ordering::SeqCst) & 0x3fff_ffff;
        let (answer, answered) = oneshot::channel();
        lock(&tools).insert(id, answer);
        self.logs.push(
            &call.plugin,
            PluginLogStream::Host,
            format!("{} called by session \"{}\"", call.tool, call.session.name),
        );
        let message = Inbound::Tool {
            id,
            name: call.tool,
            args: call.args,
            session: ToolSession {
                id: call.session.id,
                name: call.session.name,
                cwd: call.session.cwd,
            },
            wait_ms: millis(wait.saturating_sub(arrived.elapsed())),
        };
        if inbound.send(message).is_err() {
            lock(&tools).remove(&id);
            return Err(STOPPED_BEFORE.to_owned());
        }
        let abandon = |message: String| {
            if lock(&tools).remove(&id).is_some() {
                let _ = inbound.send(Inbound::ToolCancel { id });
            }
            Err(message)
        };
        tokio::select! {
            biased;
            answer = answered => answer.unwrap_or_else(|_| Err(STOPPED_BEFORE.to_owned())),
            () = cancel.cancelled() => abandon(CANCELLED.to_owned()),
            () = tokio::time::sleep(TOOL_CALL_TIMEOUT) => abandon(format!(
                "The plugin did not answer within {} minutes.",
                TOOL_CALL_TIMEOUT.as_secs() / 60
            )),
        }
    }
}

/// Takes one script's calls to the call layer, in the order it made them,
/// and answers each when the layer does. Calls queued together are started
/// together, so what they paint goes out in one push.
async fn forward(mut jobs: mpsc::UnboundedReceiver<Vec<Job>>, registry: Option<WeakRegistry>) {
    let mut running = FuturesUnordered::new();
    loop {
        tokio::select! {
            biased;
            batch = jobs.recv() => match batch {
                Some(batch) => {
                    // Every call in the batch is started, and what it
                    // painted applied, before one push carries all of it.
                    let _held = registry
                        .as_ref()
                        .and_then(WeakRegistry::upgrade)
                        .map(|registry| registry.hold_pushes());
                    for job in batch {
                        let mut answering = Box::pin(answer(job, registry.clone()));
                        if (&mut answering).now_or_never().is_none() {
                            running.push(answering);
                        }
                    }
                }
                // The script ended: what it had in flight was cancelled
                // with it, and nobody is waiting for the answers.
                None => return,
            },
            Some(()) = running.next(), if !running.is_empty() => {}
        }
    }
}

async fn answer(job: Job, registry: Option<WeakRegistry>) {
    let Job { call, reply } = job;
    let result = if call.cancel.is_cancelled() {
        // A call from a script that has since been stopped is never started:
        // it could paint the read that replaced it.
        Err(PluginCallError::aborted())
    } else {
        match registry.as_ref().and_then(WeakRegistry::upgrade) {
            Some(registry) => registry.call(call).await,
            None => Err(PluginCallError::unavailable("the host is shutting down")),
        }
    };
    let _ = reply.send(result);
}
