//! One background script's isolate, on the OS thread that owns it.
//!
//! The thread builds the isolate on the base ([`engine::base_runtime`]) with
//! the background surface's globals (`background.js`), loads the script
//! through [`PluginModules`], and runs its event loop until the script
//! crashes or the runtime stops it. Nothing here waits on the host: calls go
//! to the host's runtime through `jobs`, and what the thread says about the
//! script is handed to the host's runtime to tell the registry, so a script
//! that never returns cannot hold anything of the host's.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use deno_core::{JsRuntime, OpState, PollEventLoopOptions, op2, v8};
use floti_protocol::Payload;
use floti_protocol::channels::plugins::{
    PluginBackgroundState, PluginErrorCode, PluginLogStream, PluginSurfaceKind,
};
use serde::Serialize;
use tokio::sync::{mpsc, oneshot};

use super::modules::PluginModules;
use super::{
    ChannelMessage, Control, HEAP_LIMIT_BYTES, Inbound, Job, Logs, ToolTable, WorkerState,
    tool_answer,
};
use crate::plugins::PluginCall;
use crate::plugins::background::BackgroundReporter;
use crate::plugins::call::{CallOrigin, CallResult, CancelToken, PluginCallError};
use crate::plugins::engine::{self, ConsoleLevel, ConsoleSink, IsolateOptions};

/// The globals the background surface adds to the base isolate's.
const KEEP: &[&str] = &[
    "floti",
    "BroadcastChannel",
    "setTimeout",
    "setInterval",
    "clearTimeout",
    "clearInterval",
];

/// Everything the thread is started with.
pub(super) struct Spawn {
    pub plugin: String,
    pub folder: std::path::PathBuf,
    pub module: String,
    pub control: Arc<Control>,
    pub inbound: mpsc::UnboundedReceiver<Inbound>,
    pub jobs: mpsc::UnboundedSender<Vec<Job>>,
    pub tools: ToolTable,
    pub logs: Arc<Logs>,
    pub channels: tokio::sync::broadcast::Sender<ChannelMessage>,
    pub state: tokio::sync::watch::Sender<WorkerState>,
    pub reporter: BackgroundReporter,
    pub host: tokio::runtime::Handle,
}

/// How a script's run ended.
enum Ended {
    /// The runtime stopped it.
    Stopped,
    Crashed(String),
}

/// Runs the script to its end. Called on the thread of its own.
pub(super) fn run(spawn: Spawn) {
    let Spawn {
        plugin,
        folder,
        module,
        control,
        inbound,
        jobs,
        tools,
        logs,
        channels,
        state,
        reporter,
        host,
    } = spawn;
    let setup = Setup {
        plugin: plugin.clone(),
        inbound: Rc::new(tokio::sync::Mutex::new(inbound)),
        outbox: Rc::new(Outbox::new(jobs)),
        isolate: control.cancel.clone(),
        cancels: RefCell::new(HashMap::new()),
        tools: Arc::clone(&tools),
        channels,
    };
    let ended = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(local) => {
            let running = Running {
                plugin: &plugin,
                logs: &logs,
                state: &state,
                reporter: &reporter,
                host: &host,
            };
            local.block_on(drive(setup, &folder, &module, &control, &running))
        }
        Err(err) => Ended::Crashed(format!("the host could not run it: {err}")),
    };
    // Whatever it had in flight ends with it.
    control.cancel.cancel();
    tools
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clear();
    match ended {
        Ended::Stopped => {
            state.send_replace(WorkerState::Stopped);
        }
        Ended::Crashed(error) => {
            logs.push(
                &plugin,
                PluginLogStream::Host,
                format!("background script stopped: {error}"),
            );
            state.send_replace(WorkerState::Crashed(error.clone()));
            host.spawn(async move {
                reporter.report(PluginBackgroundState::Crashed, Some(error));
            });
        }
    }
}

/// What the run reports to, once the script has started.
struct Running<'a> {
    plugin: &'a str,
    logs: &'a Arc<Logs>,
    state: &'a tokio::sync::watch::Sender<WorkerState>,
    reporter: &'a BackgroundReporter,
    host: &'a tokio::runtime::Handle,
}

async fn drive(
    setup: Setup,
    folder: &std::path::Path,
    module: &str,
    control: &Arc<Control>,
    running: &Running<'_>,
) -> Ended {
    let modules = PluginModules::new(folder);
    let main = match modules.main(module) {
        Ok(main) => main,
        Err(error) => return Ended::Crashed(error),
    };
    let logs_plugin = running.plugin.to_owned();
    let logs = Arc::clone(running.logs);
    let outbox = Rc::clone(&setup.outbox);
    let mut js = match engine::base_runtime(IsolateOptions {
        extensions: vec![floti_background::init(setup)],
        keep: KEEP.to_vec(),
        console: Some(ConsoleSink(Box::new(move |level, text| {
            let stream = match level {
                ConsoleLevel::Warn | ConsoleLevel::Error => PluginLogStream::Err,
                ConsoleLevel::Debug | ConsoleLevel::Info => PluginLogStream::Out,
            };
            logs.push(&logs_plugin, stream, text.to_owned());
        }))),
        module_loader: Some(Rc::new(modules)),
        create_params: Some(v8::CreateParams::default().heap_limits(0, HEAP_LIMIT_BYTES)),
    }) {
        Ok(js) => js,
        Err(error) => return Ended::Crashed(error),
    };
    let handle = js.v8_isolate().thread_safe_handle();
    if !control.attach(handle.clone()) {
        return Ended::Stopped;
    }
    let near_limit = Arc::clone(control);
    js.add_near_heap_limit_callback(move |current, _initial| {
        near_limit.out_of_memory.store(true, Ordering::SeqCst);
        handle.terminate_execution();
        // Room to unwind in: the script is ended, not the process.
        current.saturating_mul(2)
    });

    let stop = control.cancel.clone();
    let evaluated = tokio::select! {
        biased;
        () = stop.cancelled() => return Ended::Stopped,
        evaluated = in_passes(evaluate(&mut js, &main), &outbox) => evaluated,
    };
    if let Err(error) = evaluated {
        return ended(control, &error);
    }
    running.state.send_replace(WorkerState::Running);
    running.logs.push(
        running.plugin,
        PluginLogStream::Host,
        "background script started".to_owned(),
    );
    let reporter = running.reporter.clone();
    running.host.spawn(async move {
        reporter.report(PluginBackgroundState::Running, None);
    });

    let event_loop = in_passes(js.run_event_loop(PollEventLoopOptions::default()), &outbox);
    let finished = tokio::select! {
        biased;
        () = stop.cancelled() => return Ended::Stopped,
        finished = event_loop => finished,
    };
    match finished {
        // Nothing is left to wake it: the host let go of it.
        Ok(()) => Ended::Stopped,
        Err(error) => ended(control, &error),
    }
}

async fn evaluate(
    js: &mut JsRuntime,
    main: &deno_core::ModuleSpecifier,
) -> Result<(), deno_core::error::CoreError> {
    let id = js.load_main_es_module(main).await?;
    let evaluation = js.mod_evaluate(id);
    js.with_event_loop_promise(Box::pin(evaluation), PollEventLoopOptions::default())
        .await?;
    // A module that threw after an `await` settles its evaluation as done
    // and rethrows into the rejection handler, which only logs it; the
    // module's own status is what says it failed.
    js.get_module_namespace(id).map(|_| ())
}

/// What an error that ended the script means: a stop, the memory limit, or
/// the script's own failure.
fn ended(control: &Control, error: &deno_core::error::CoreError) -> Ended {
    if control.stopping.load(Ordering::SeqCst) {
        return Ended::Stopped;
    }
    if control.out_of_memory.load(Ordering::SeqCst) {
        return Ended::Crashed(format!(
            "it ran past its memory limit of {} MB",
            HEAP_LIMIT_BYTES / (1024 * 1024)
        ));
    }
    let text = error.to_string();
    let first = text.lines().next().unwrap_or("").trim();
    Ended::Crashed(if first.is_empty() {
        "it stopped".to_owned()
    } else {
        first.to_owned()
    })
}

/// The calls the script made in the pass of its event loop now running,
/// sent to the host as one batch when the pass ends ([`in_passes`]).
struct Outbox {
    jobs: mpsc::UnboundedSender<Vec<Job>>,
    batch: RefCell<Vec<Job>>,
}

impl Outbox {
    fn new(jobs: mpsc::UnboundedSender<Vec<Job>>) -> Self {
        Self {
            jobs,
            batch: RefCell::new(Vec::new()),
        }
    }

    /// False when the host takes no more calls.
    fn push(&self, job: Job) -> bool {
        if self.jobs.is_closed() {
            return false;
        }
        self.batch.borrow_mut().push(job);
        true
    }

    fn send(&self) {
        let batch = std::mem::take(&mut *self.batch.borrow_mut());
        if !batch.is_empty() {
            // A batch the host no longer takes drops its replies, and each
            // call is answered that the host stopped.
            let _ = self.jobs.send(batch);
        }
    }
}

/// Runs `work`, the isolate's event loop or its script's first evaluation,
/// sending the calls made during each poll of it, one pass, as one batch.
async fn in_passes<F: Future>(work: F, outbox: &Outbox) -> F::Output {
    let mut work = std::pin::pin!(work);
    std::future::poll_fn(|cx| {
        let polled = work.as_mut().poll(cx);
        outbox.send();
        polled
    })
    .await
}

/// What the ops find in the isolate's state.
struct Setup {
    plugin: String,
    inbound: Rc<tokio::sync::Mutex<mpsc::UnboundedReceiver<Inbound>>>,
    outbox: Rc<Outbox>,
    /// Cancelled when the script ends: every call it makes is a child.
    isolate: CancelToken,
    /// The calls in flight, by the id the script gave them.
    cancels: RefCell<HashMap<u32, CancelToken>>,
    tools: ToolTable,
    channels: tokio::sync::broadcast::Sender<ChannelMessage>,
}

/// A call's answer, as `background.js` reads it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CallOutcome {
    ok: bool,
    value: Payload,
    code: Option<PluginErrorCode>,
    message: Option<String>,
}

impl From<CallResult> for CallOutcome {
    fn from(result: CallResult) -> Self {
        match result {
            Ok(value) => Self {
                ok: true,
                value,
                code: None,
                message: None,
            },
            Err(PluginCallError { code, message }) => Self {
                ok: false,
                value: Payload::Null,
                code: Some(code),
                message: Some(message),
            },
        }
    }
}

#[derive(Serialize)]
struct Context {
    plugin: String,
}

#[op2]
#[serde]
fn op_floti_bg_context(state: &OpState) -> Context {
    Context {
        plugin: state.borrow::<Setup>().plugin.clone(),
    }
}

/// The next thing the host sends, or null once it will send nothing more.
#[op2]
#[serde]
async fn op_floti_bg_next(state: Rc<RefCell<OpState>>) -> Option<Inbound> {
    let inbound = Rc::clone(&state.borrow().borrow::<Setup>().inbound);
    let mut receiver = inbound.lock().await;
    receiver.recv().await
}

/// One `floti.*` call, answered by the host's call layer on the host's
/// runtime.
#[op2]
#[serde]
async fn op_floti_bg_call(
    state: Rc<RefCell<OpState>>,
    #[smi] id: u32,
    #[string] method: String,
    #[serde] args: Vec<Payload>,
) -> CallOutcome {
    let reply = {
        let state = state.borrow();
        let setup = state.borrow::<Setup>();
        let cancel = setup.isolate.child();
        setup.cancels.borrow_mut().insert(id, cancel.clone());
        let (reply, answer) = oneshot::channel();
        let call = PluginCall {
            plugin: setup.plugin.clone(),
            surface: PluginSurfaceKind::Background,
            method,
            args,
            origin: CallOrigin::Host,
            cancel,
        };
        setup.outbox.push(Job { call, reply }).then_some(answer)
    };
    let result = match reply {
        Some(answer) => answer.await.unwrap_or_else(|_| {
            Err(PluginCallError::unavailable(
                "the host stopped before it answered",
            ))
        }),
        None => Err(PluginCallError::unavailable("the host is shutting down")),
    };
    state
        .borrow()
        .borrow::<Setup>()
        .cancels
        .borrow_mut()
        .remove(&id);
    CallOutcome::from(result)
}

/// The script aborted the call `id`.
#[op2(fast)]
fn op_floti_bg_cancel(state: &mut OpState, #[smi] id: u32) {
    let cancel = state.borrow::<Setup>().cancels.borrow_mut().remove(&id);
    if let Some(cancel) = cancel {
        cancel.cancel();
    }
}

/// A tool handler's answer for the call `id`.
#[op2(fast)]
fn op_floti_bg_tool_result(state: &mut OpState, #[smi] id: u32, ok: bool, #[string] text: &str) {
    let waiting = state
        .borrow::<Setup>()
        .tools
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&id);
    if let Some(waiting) = waiting {
        let _ = waiting.send(tool_answer(ok, text.to_owned()));
    }
}

/// A message the script posted on one of its channels, for the host side.
#[op2]
fn op_floti_bg_broadcast(state: &mut OpState, #[string] name: String, #[serde] data: Payload) {
    let setup = state.borrow::<Setup>();
    // Nobody listening on the host side is not the script's problem.
    let _ = setup.channels.send(ChannelMessage {
        plugin: setup.plugin.clone(),
        channel: name,
        data,
    });
}

deno_core::extension!(
    floti_background,
    ops = [
        op_floti_bg_context,
        op_floti_bg_next,
        op_floti_bg_call,
        op_floti_bg_cancel,
        op_floti_bg_tool_result,
        op_floti_bg_broadcast,
    ],
    esm_entry_point = "ext:floti_background/background.js",
    esm = [dir "src/plugins/runtime", "background.js"],
    options = { setup: Setup },
    state = |state, options| {
        state.put(options.setup);
    },
);
