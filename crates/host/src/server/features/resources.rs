//! Processes and ports: what each hosted session is holding, its process tree
//! and its listening ports.
//!
//! Requests: `sessions:watch`, a client saying it is or is no longer looking
//! (the sessions pane on screen). Events: `sessions:resources`, the whole set
//! of every running hosted session's resources, sent only when it changed.
//!
//! A pass reads the whole machine, so it costs something, and it runs only
//! while somebody is looking:
//!
//!   - Not at all while no client watches and no host-internal ask (a
//!     session-detail call) waits: no timer, no read.
//!   - At once when a client starts watching, then every [`POLL`] while any
//!     client watches, and again when a session ends. A client watching is
//!     in a set, so one client stopping or leaving never stops the passes
//!     another is watching.
//!   - A pass runs off the async threads, and never two at once: whoever
//!     asks while one runs (the interval, a new watcher, a session ending, a
//!     session-detail ask) joins it and gets its result. A machine slow
//!     enough that a pass outlasts the interval gets fewer passes, never a
//!     queue of them.
//!
//! A result that differs from the last only in when it was read sends
//! nothing. When the last watcher stops, the last result is kept rather than
//! cleared: it is the last thing the host saw, and a pane that reopened
//! empty would claim those sessions hold nothing.
//!
//! Nothing here reads anything out of a session: each tree is rooted at the
//! terminal's pid, which the host holds because it started the program.

#[cfg(test)]
mod tests;

use std::collections::BTreeSet;
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;

use floti_protocol::channel::Router;
use floti_protocol::channels::common::SessionStatus;
use floti_protocol::channels::sessions::{
    SessionResources, SessionResourcesChanged, SessionsWatch,
};
use tokio::runtime::Handle;
use tokio::sync::broadcast::{self, error::RecvError};
use tokio::sync::watch;
use tokio::time::MissedTickBehavior;

use super::{Feature, FeatureContext};
use crate::platform::process_table::{self, ProcessSnapshot, ProcessTable};
use crate::resources::session_resources;
use crate::server::events::Events;
use crate::server::hosted::Hosted;
use crate::server::records::ExitNotice;
use crate::session::ClientId;

/// How often the machine is read while a client watches. A pass is a
/// fraction of this, and what it watches (a dev server coming up, a
/// container starting) moves on this scale, not a keystroke's.
pub(crate) const POLL: Duration = Duration::from_secs(4);

/// A running hosted session: its id and the terminal's pid.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LiveRoot {
    pub id: u64,
    pub pid: u32,
}

/// The running hosted sessions, asked at the start of each pass.
type LiveRoots = dyn Fn() -> Vec<LiveRoot> + Send + Sync;

/// The pass and who is looking.
pub(crate) struct Passes {
    roots: Box<LiveRoots>,
    table: Arc<dyn ProcessTable>,
    events: Arc<Events>,
    runtime: Handle,
    every: Duration,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// The clients watching now.
    watchers: BTreeSet<ClientId>,
    /// Host-internal asks waiting for a pass.
    asking: usize,
    /// Which run of the interval is current: a timer from an earlier run
    /// stops at its next tick.
    ticking: Option<u64>,
    runs: u64,
    /// The pass running now, which a second ask joins.
    in_flight: Option<watch::Receiver<Option<Vec<SessionResources>>>>,
    /// The last pass's result, which `sessions:resources` holds.
    current: Vec<SessionResources>,
}

impl State {
    fn looked_at(&self) -> bool {
        !self.watchers.is_empty() || self.asking > 0
    }
}

/// What the blocking half of a pass saw: the running sessions, and the
/// machine unless there was no session to read it for.
type Seen = (Vec<LiveRoot>, Option<ProcessSnapshot>);

impl Passes {
    /// Serves `sessions:resources`, starting empty. Call it from inside a
    /// Tokio runtime.
    pub fn new(
        roots: impl Fn() -> Vec<LiveRoot> + Send + Sync + 'static,
        table: Arc<dyn ProcessTable>,
        events: Arc<Events>,
        every: Duration,
    ) -> crate::Result<Arc<Self>> {
        events.serve_state::<SessionResourcesChanged, _>(&Vec::<SessionResources>::new())?;
        Ok(Arc::new(Self {
            roots: Box::new(roots),
            table,
            events,
            runtime: Handle::current(),
            every,
            state: Mutex::new(State::default()),
        }))
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The last pass's result. Empty before the first.
    pub fn current(&self) -> Vec<SessionResources> {
        self.lock().current.clone()
    }

    /// `client` says it is, or is no longer, looking. Starting to look runs a
    /// pass at once, so a pane that has just opened is not blank for an
    /// interval.
    pub fn watch(self: &Arc<Self>, client: ClientId, watching: bool) {
        if watching {
            let start = {
                let mut state = self.lock();
                state.watchers.insert(client);
                if state.ticking.is_some() {
                    None
                } else {
                    state.runs += 1;
                    state.ticking = Some(state.runs);
                    state.ticking
                }
            };
            if let Some(run) = start {
                self.runtime
                    .spawn(tick(Arc::downgrade(self), run, self.every));
            }
            drop(self.pass());
        } else {
            self.stopped_watching(client);
        }
    }

    /// `client` is not looking any more, by saying so or by leaving. The
    /// last watcher gone stops the interval and keeps the last result.
    pub fn stopped_watching(&self, client: ClientId) {
        let mut state = self.lock();
        state.watchers.remove(&client);
        if state.watchers.is_empty() {
            state.ticking = None;
        }
    }

    /// A session has ended: a pass runs, if anybody is looking, so its tree
    /// leaves the set without waiting for the interval.
    pub fn session_ended(self: &Arc<Self>) {
        if self.lock().looked_at() {
            drop(self.pass());
        }
    }

    /// What every running hosted session is holding, from exactly one pass
    /// run for this ask (or joined, when one is running), as a
    /// session-detail call needs it. It costs nothing afterwards: no pass
    /// runs for it once it has its answer.
    pub async fn one_pass(self: &Arc<Self>) -> Vec<SessionResources> {
        struct Asking<'a>(&'a Passes);
        impl Drop for Asking<'_> {
            fn drop(&mut self) {
                let mut state = self.0.lock();
                state.asking = state.asking.saturating_sub(1);
            }
        }
        self.lock().asking += 1;
        let _asking = Asking(self);
        self.pass().await
    }

    /// Starts a pass, or joins the one running; the future is its result.
    /// The pass runs whether or not the future is awaited.
    fn pass(self: &Arc<Self>) -> impl Future<Output = Vec<SessionResources>> + use<> {
        let receiver = {
            let mut state = self.lock();
            if let Some(running) = &state.in_flight {
                running.clone()
            } else {
                let (sender, receiver) = watch::channel(None);
                state.in_flight = Some(receiver.clone());
                let passes = Arc::clone(self);
                self.runtime.spawn(async move {
                    let reader = Arc::clone(&passes);
                    // A reader that fails outright (a panic) is a pass that
                    // saw nothing: it changes nothing.
                    let seen = tokio::task::spawn_blocking(move || reader.read())
                        .await
                        .ok();
                    let landed = passes.land(seen);
                    let _ = sender.send(Some(landed));
                });
                receiver
            }
        };
        let passes = Arc::downgrade(self);
        async move {
            let mut receiver = receiver;
            let landed = receiver
                .wait_for(Option::is_some)
                .await
                .ok()
                .and_then(|landed| landed.clone());
            landed.unwrap_or_else(|| {
                passes
                    .upgrade()
                    .map(|passes| passes.current())
                    .unwrap_or_default()
            })
        }
    }

    /// The blocking half of a pass: the running sessions, then the machine.
    fn read(&self) -> Seen {
        let roots = (self.roots)();
        if roots.is_empty() {
            return (roots, None);
        }
        let snapshot = process_table::snapshot(self.table.as_ref());
        (roots, Some(snapshot))
    }

    /// A pass has landed: its result becomes the state, sent to subscribers
    /// when it differs from the last in anything but when it was read.
    fn land(&self, seen: Option<Seen>) -> Vec<SessionResources> {
        let mut state = self.lock();
        state.in_flight = None;
        let next = match seen {
            None => return state.current.clone(),
            Some((_, None)) => Vec::new(),
            Some((roots, Some(snapshot))) => roots
                .iter()
                .map(|root| session_resources(root.id, root.pid, &snapshot))
                .collect(),
        };
        let moved = !same_but_for_time(&state.current, &next);
        // Replaced even when unchanged, so `at_ms` is the time of the pass
        // that last confirmed it: a surface saying "as of" never says
        // something older than the last time the host looked.
        state.current = next;
        if moved
            && let Err(err) = self
                .events
                .set_state::<SessionResourcesChanged, _>(&state.current)
        {
            eprintln!("floti host: {err}");
        }
        state.current.clone()
    }

    /// Whether the interval run `run` is still the current one.
    fn ticking(&self, run: u64) -> bool {
        self.lock().ticking == Some(run)
    }
}

/// Whether `a` and `b` say the same thing, apart from when each was read:
/// which processes, at what depth, with which command lines, holding which
/// ports, and what is Unknown.
fn same_but_for_time(a: &[SessionResources], b: &[SessionResources]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b).all(|(a, b)| {
            SessionResources {
                at_ms: 0,
                ..a.clone()
            } == SessionResources {
                at_ms: 0,
                ..b.clone()
            }
        })
}

/// A pass every `every` until run `run` stops being the current one.
async fn tick(passes: Weak<Passes>, run: u64, every: Duration) {
    let mut interval = tokio::time::interval(every);
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    // The first tick is now; watching started a pass of its own.
    interval.tick().await;
    loop {
        interval.tick().await;
        let Some(passes) = passes.upgrade() else {
            return;
        };
        if !passes.ticking(run) {
            return;
        }
        let pass = passes.pass();
        drop(passes);
        pass.await;
    }
}

/// The host's handle on the pass, for what inside it asks for the
/// sessions' resources: a session-detail call takes a watch for exactly one
/// pass.
#[derive(Clone)]
pub struct ResourcesHandle(Arc<Passes>);

impl ResourcesHandle {
    /// What each running hosted session is holding, from one pass run for
    /// this ask; see [`Passes::one_pass`].
    pub async fn one_pass(&self) -> Vec<SessionResources> {
        self.0.one_pass().await
    }
}

/// The feature: `sessions:watch` and `sessions:resources`.
pub(crate) struct Resources {
    passes: Arc<Passes>,
}

impl Resources {
    pub fn new(context: &FeatureContext) -> crate::Result<Self> {
        let hosted = Arc::downgrade(&context.hosted);
        let passes = Passes::new(
            move || {
                hosted
                    .upgrade()
                    .map(|hosted| running_roots(&hosted))
                    .unwrap_or_default()
            },
            Arc::new(process_table::Native),
            Arc::clone(&context.events),
            POLL,
        )?;
        tokio::spawn(pass_on_exits(
            context.hosted.ledger().exits(),
            Arc::downgrade(&passes),
        ));
        Ok(Self { passes })
    }

    pub fn handle(&self) -> ResourcesHandle {
        ResourcesHandle(Arc::clone(&self.passes))
    }
}

impl Feature for Resources {
    fn requests<'a>(&'a self, client: ClientId, router: &mut Router<'a>) {
        router.handle::<SessionsWatch>(move |request| {
            self.passes.watch(client, request.watching);
            Ok(())
        });
    }

    fn client_left(&self, client: ClientId) {
        self.passes.stopped_watching(client);
    }
}

/// Every hosted session whose row says it is running, rooted at the
/// terminal's pid the host holds. A session whose program has exited is not
/// one, even in the moment before it leaves the host's list.
fn running_roots(hosted: &Hosted) -> Vec<LiveRoot> {
    hosted
        .sessions()
        .list()
        .iter()
        .filter_map(|session| {
            let record = hosted.record(session.id()).ok()?;
            (record.status == SessionStatus::Running).then_some(LiveRoot {
                id: record.id,
                pid: session.pid(),
            })
        })
        .collect()
}

/// A pass for each session that ends, while anybody is looking. Holds the
/// pass weakly; the exits close with the host and this ends.
async fn pass_on_exits(mut exits: broadcast::Receiver<ExitNotice>, passes: Weak<Passes>) {
    loop {
        match exits.recv().await {
            Ok(_) | Err(RecvError::Lagged(_)) => {
                let Some(passes) = passes.upgrade() else {
                    return;
                };
                passes.session_ended();
            }
            Err(RecvError::Closed) => return,
        }
    }
}
