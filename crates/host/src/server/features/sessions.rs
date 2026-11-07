//! Launch and live sessions, and plain terminals.
//!
//! Requests: the session list; start, the launcher's launch, a profile's
//! launch and a resume from history; rename, resize, focus and close with its
//! confirmation; the restore offer and restore; the plain terminals' open,
//! close, resize, shell list and the check of a shell the user typed; and
//! what a device's deliberate quit asks: the sessions it started
//! (`host:deviceSessions`) and the quit itself (`host:quit`).
//!
//! Events: `session:exit` with each finished row, `session:notify`,
//! `session:confirm` when a close has to be agreed to first,
//! `session:activate`, `pterm:exit`, and
//! two that carry state: `session:activity`, what each hosted session is
//! doing, and `sessions:overview`, every live agent session on the machine.
//! Both come from each backend's own records, read every [`ACTIVITY_POLL`]
//! and again at once after a launch, a rename or an exit, or else from the
//! OSC 7501 reports a session's program writes, read again at once when one
//! changes; they are sent whole only when they changed.
//!
//! Streams: each session's terminal (`session:data`) and each plain
//! terminal's (`pterm:data`).
//!
//! Every client subscribed to `session:exit` gets every exit. An exit is
//! also worth an OS notification for each client whose user could not see
//! the session, judged as today's app judges it ([`Focus`]) from what the
//! client last said on `session:focus`; each such client, and only it, gets
//! the finished row on `session:notify` and shows the notification itself.
//! A session a client closed is nobody's surprise and notifies no one.
//!
//! A close without `force` of a session still running is not taken as meant:
//! every client subscribed to `session:confirm` is asked, the answer to the
//! close says the session was left running, and the session ends when a
//! client agrees on `session:confirmed`. The question outlives the request
//! because a request is answered at once and a person takes as long as they
//! take.

use std::collections::{BTreeSet, HashMap};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use floti_protocol::channel::Router;
use floti_protocol::channels::host::{HostDeviceSessions, HostQuit};
use floti_protocol::channels::sessions::{
    CloseSessionRequest, CloseSessionResult, HistoryResume, ProfileLaunch, PtermCheckShell,
    PtermClose, PtermExit, PtermExited, PtermOpen, PtermResize, PtermShells, PtermStreamOpen,
    PtermTerminal, SessionActivate, SessionActivityChanged, SessionActivityState, SessionClose,
    SessionConfirm, SessionConfirmAnswer, SessionConfirmKind, SessionConfirmRequest,
    SessionConfirmed, SessionExit, SessionFocus, SessionLaunch, SessionList, SessionNotify,
    SessionRename, SessionResize, SessionRestorable, SessionRestore, SessionSize,
    SessionSizeResult, SessionStart, SessionStreamOpen, SessionTerminal, SessionsOverview,
    SessionsOverviewChanged,
};
use tokio::sync::broadcast::{self, error::RecvError};

use super::{Caller, Feature, FeatureContext, Streams, TerminalAttachment};
use crate::server::events::Events;
use crate::server::hosted::{Closing, Hosted, label_of, session_id};
use crate::server::records::ExitNotice;
use crate::session::{ActivityTracker, ClientId, Session, TermSize, TerminalExit, check_shell};

/// How often the backends' records are read for activity, as today's app
/// reads them. A read is a folder listing and one small file per live
/// session.
pub(crate) const ACTIVITY_POLL: Duration = Duration::from_millis(750);

pub(crate) struct Sessions {
    hosted: Arc<Hosted>,
    events: Arc<Events>,
    confirms: Mutex<Confirms>,
    focus: Arc<Mutex<Focus>>,
    /// Asks the activity pass to run now rather than at its next tick.
    nudge: mpsc::Sender<()>,
    activity: ActivityHandle,
}

/// Closes waiting for a client to agree.
#[derive(Default)]
struct Confirms {
    next: u64,
    /// Each question's id, with the session it would end.
    pending: HashMap<u64, u64>,
}

/// Which sessions each client's user can see now, as each last said, and
/// which sessions a client closed.
#[derive(Debug, Default)]
pub(crate) struct Focus {
    seen: HashMap<ClientId, BTreeSet<u64>>,
    /// Sessions a client asked to end, whose exit is expected.
    closed: BTreeSet<u64>,
}

impl Focus {
    /// `client`'s user can see `ids` now, and nothing else.
    pub fn set(&mut self, client: ClientId, ids: impl IntoIterator<Item = u64>) {
        self.seen.insert(client, ids.into_iter().collect());
    }

    /// A client asked for session `id` to end: as in today's app, where a
    /// closed tab's session exits without a notification, its exit is
    /// worth one for nobody.
    pub fn closing(&mut self, id: u64) {
        self.closed.insert(id);
    }

    /// Session `id` has ended: it is gone from every client's screen.
    pub fn forget(&mut self, id: u64) {
        self.closed.remove(&id);
        for ids in self.seen.values_mut() {
            ids.remove(&id);
        }
    }

    /// `client` has gone, and what it saw with it.
    pub fn leave(&mut self, client: ClientId) {
        self.seen.remove(&client);
    }

    /// Whether session `id` ending is worth a notification for `client`, as
    /// today's app judges it: only when its user cannot see the session. A
    /// session in a background tab is as unwatched as one in a window that
    /// is not in front, so a client whose window is not in front says it
    /// sees nothing. A client that never said is watching nothing. A
    /// session a client closed is worth a notification for nobody.
    pub fn worth_notifying(&self, client: ClientId, id: u64) -> bool {
        !self.closed.contains(&id) && !self.seen.get(&client).is_some_and(|ids| ids.contains(&id))
    }
}

impl Sessions {
    pub fn new(context: &FeatureContext) -> crate::Result<Self> {
        let hosted = Arc::clone(&context.hosted);
        let events = Arc::clone(&context.events);
        events.serve_events::<SessionExit>();
        events.serve_per_client::<SessionNotify>();
        events.serve_events::<SessionConfirm>();
        events.serve_events::<SessionActivate>();
        events.serve_events::<PtermExit>();

        let mut tracker = ActivityTracker::default();
        let first = read_activity(&hosted, &mut tracker);
        events.serve_state::<SessionActivityChanged, _>(&first.states)?;
        events.serve_state::<SessionsOverviewChanged, _>(&first.overview)?;

        let (nudge, nudged) = mpsc::channel();
        // A new report is read at once, not at the next poll.
        let reported = nudge.clone();
        hosted.sessions().on_status_change(move || {
            // A reader that has stopped is a host that is stopping.
            let _ = reported.send(());
        });
        let focus = Arc::new(Mutex::new(Focus::default()));
        tokio::spawn(publish_exits(
            hosted.ledger().exits(),
            Arc::downgrade(&hosted),
            Arc::clone(&events),
            Arc::clone(&focus),
            nudge.clone(),
        ));
        tokio::spawn(publish_terminal_exits(
            hosted.terminals().exits(),
            Arc::clone(&events),
        ));
        let reader = Arc::new(ActivityReader {
            hosted: Arc::downgrade(&hosted),
            events: Arc::clone(&events),
            state: Mutex::new(ActivityState {
                tracker,
                last: first,
            }),
        });
        hosted.use_activity_reader(ActivityHandle(Arc::clone(&reader)));
        let watcher = Arc::clone(&reader);
        std::thread::Builder::new()
            .name("session activity".to_owned())
            .spawn(move || watcher.run(&nudged))
            .map_err(|err| crate::Error::io("start the session activity reader", err))?;

        Ok(Self {
            hosted,
            events,
            confirms: Mutex::new(Confirms::default()),
            focus,
            nudge,
            activity: ActivityHandle(reader),
        })
    }

    /// The activity pass, for what inside the host reads the listing.
    pub fn activity(&self) -> ActivityHandle {
        self.activity.clone()
    }

    /// The activity pass runs now: something it reads has just moved.
    fn moved(&self) {
        // A reader that has stopped is a host that is stopping.
        let _ = self.nudge.send(());
    }

    /// Ends a session, asking first when it is still running and the close
    /// is not forced.
    fn close(&self, request: CloseSessionRequest) -> Result<CloseSessionResult, String> {
        if self.hosted.running(request.id).is_err() {
            // Ended already: closing it is done.
            return Ok(CloseSessionResult { closed: true });
        }
        if request.force {
            self.end(request.id);
            return Ok(CloseSessionResult { closed: true });
        }
        let (record, agent) = self
            .hosted
            .describe(request.id)
            .ok_or_else(|| format!("Session {} is not in this database.", request.id))?;
        let label = label_of(&record);
        // The agents it started end with it unless they were started to
        // outlive it: the question names both.
        let closing = self.hosted.closing(request.id);
        let question = {
            let mut confirms = lock(&self.confirms);
            confirms.next += 1;
            let id = confirms.next;
            confirms.pending.insert(id, request.id);
            SessionConfirmRequest {
                id,
                kind: SessionConfirmKind::CloseSession,
                message: format!("\u{201c}{label}\u{201d} is still running."),
                detail: close_detail(&agent, &record.cwd, &closing),
                confirm_label: close_button(closing.ending.len()),
                session_names: std::iter::once(label)
                    .chain(closing.ending.iter().map(|(_, name)| name.clone()))
                    .collect(),
                ending_ids: closing.ending.iter().map(|(id, _)| *id).collect(),
                outliving_ids: closing.outliving.iter().map(|(id, _)| *id).collect(),
            }
        };
        self.events
            .emit::<SessionConfirm>(&question)
            .map_err(|err| err.to_string())?;
        Ok(CloseSessionResult { closed: false })
    }

    /// A client's answer to a close's question. Only the first answer to a
    /// question counts.
    fn confirmed(&self, answer: SessionConfirmAnswer) -> Result<(), String> {
        let session = lock(&self.confirms)
            .pending
            .remove(&answer.id)
            .ok_or_else(|| {
                format!(
                    "Confirmation {} is not waiting for an answer: it was answered already or never asked.",
                    answer.id
                )
            })?;
        if answer.agreed {
            self.end(session);
        }
        Ok(())
    }

    /// `client`'s device is quitting on purpose: what it opened ends, as
    /// [`Hosted::quit`] says. A session ended this way was meant to end, so
    /// its exit is worth a notification for nobody.
    fn quit(&self, client: ClientId, end: bool) -> Result<(), String> {
        let device = self
            .hosted
            .device_of(client)
            .ok_or_else(|| "This connection has no device to quit.".to_owned())?;
        if end {
            let mut focus = lock(&self.focus);
            for session in self.hosted.started_by(&device) {
                focus.closing(session.id);
            }
        }
        self.hosted.quit(&device, end);
        self.moved();
        Ok(())
    }

    fn end(&self, id: u64) {
        // Before the session is ended, so its exit is judged as closed.
        lock(&self.focus).closing(id);
        self.hosted.end(&CloseSessionRequest { id, force: true });
    }

    /// Attaches `client` to `session`: the stream carries its current
    /// screen, then its live output.
    fn attach(client: ClientId, session: Arc<Session>) -> Result<TerminalAttachment, String> {
        let attachment = session
            .attach(client, session.size())
            .map_err(|err| err.to_string())?;
        Ok(TerminalAttachment {
            session,
            redraw: attachment.redraw,
            output: attachment.output,
        })
    }

    /// Attaches `client` to `session` to watch only: its current screen and
    /// live output reach the client, and its keys and sizes reach nothing.
    fn watch(client: ClientId, session: Arc<Session>) -> Result<TerminalAttachment, String> {
        let attachment = session.watch(client).map_err(|err| err.to_string())?;
        Ok(TerminalAttachment {
            session,
            redraw: attachment.redraw,
            output: attachment.output,
        })
    }

    fn attach_session(
        &self,
        client: ClientId,
        open: SessionStreamOpen,
    ) -> Result<TerminalAttachment, String> {
        let SessionStreamOpen { id, watch } = open;
        let session = session_id(id)
            .and_then(|id| self.hosted.sessions().get(id))
            .ok_or_else(|| format!("Session {id} is not running on this Floti host."))?;
        if watch {
            return Self::watch(client, session);
        }
        Self::attach(client, session)
    }

    fn attach_terminal(
        &self,
        client: ClientId,
        open: PtermStreamOpen,
    ) -> Result<TerminalAttachment, String> {
        let PtermStreamOpen { id } = open;
        let session = self
            .hosted
            .terminals()
            .get(id)
            .ok_or_else(|| format!("Terminal {id} is not open on this Floti host."))?;
        Self::attach(client, session)
    }
}

impl Feature for Sessions {
    fn requests<'a>(&'a self, Caller { client, .. }: Caller, router: &mut Router<'a>) {
        let hosted = &self.hosted;
        let terminals = hosted.terminals();
        router
            .handle::<SessionList>(|()| hosted.list())
            .handle::<SessionStart>(move |request| {
                let started = hosted
                    .start(client, request)
                    .map(|launched| launched.session);
                self.moved();
                started
            })
            .handle::<SessionLaunch>(move |request| {
                let launched = hosted.launch(client, request);
                self.moved();
                launched
            })
            .handle::<ProfileLaunch>(move |request| {
                let launched = hosted.launch_profile(client, request);
                self.moved();
                launched
            })
            .handle::<HistoryResume>(move |request| {
                let resumed = hosted.resume(client, request);
                self.moved();
                resumed
            })
            .handle::<SessionRename>(|request| {
                let renamed = hosted.rename(request);
                self.moved();
                renamed
            })
            .handle::<SessionClose>(|request| self.close(request))
            .handle::<SessionConfirmed>(|answer| self.confirmed(answer))
            .handle::<SessionResize>(move |request| hosted.resize(client, request))
            .handle::<SessionSize>(|request| {
                hosted.size(request.id).map(|size| SessionSizeResult {
                    cols: size.cols,
                    rows: size.rows,
                })
            })
            .handle::<SessionFocus>(move |request| {
                lock(&self.focus).set(client, request.ids);
                Ok(())
            })
            .handle::<SessionRestorable>(|()| Ok(hosted.restorable()))
            .handle::<HostDeviceSessions>(move |()| {
                Ok(hosted
                    .device_of(client)
                    .map(|device| hosted.started_by(&device))
                    .unwrap_or_default())
            })
            .handle::<HostQuit>(move |request| self.quit(client, request.end))
            .handle::<SessionRestore>(move |request| {
                let restored = hosted.restore(client, request);
                self.moved();
                Ok(restored)
            })
            .handle::<PtermShells>(|()| Ok(terminals.shells()))
            .handle::<PtermCheckShell>(|request| Ok(check_shell(&request.path)))
            .handle::<PtermOpen>(move |request| hosted.open_terminal(client, request))
            .handle::<PtermClose>(|request| {
                terminals.close(request.id);
                Ok(())
            })
            .handle::<PtermResize>(move |request| {
                terminals.resize(
                    client,
                    request.id,
                    TermSize::new(request.cols, request.rows),
                )
            });
    }

    fn streams<'a>(&'a self, streams: &mut Streams<'a>) {
        streams
            .handle::<SessionTerminal>(|client, open| self.attach_session(client, open))
            .handle::<PtermTerminal>(|client, open| self.attach_terminal(client, open));
    }

    fn client_left(&self, client: ClientId) {
        lock(&self.focus).leave(client);
    }
}

/// What one read of the backends' records gave.
struct Activity {
    states: Vec<SessionActivityState>,
    overview: SessionsOverview,
    /// How many times a child's report has been set or cleared. The states
    /// carry neither, but a client lists a child's report with its row when
    /// the states are published, so a report moves the publication.
    reports: u64,
}

impl Activity {
    /// Whether `next` says anything different. When the records were read
    /// is not part of it: it moves on every read by construction.
    fn same_as(&self, next: &Activity) -> bool {
        self.states == next.states
            && self.overview.sessions == next.overview.sessions
            && self.reports == next.reports
    }
}

fn read_activity(hosted: &Hosted, tracker: &mut ActivityTracker) -> Activity {
    let views = hosted.views();
    let registries = hosted.registries();
    let pass = tracker.pass(&views, &registries, now_ms());
    // A cleared conversation: the row has to know which one a crash would
    // have taken.
    for (id, conversation) in &pass.moved {
        hosted.note_conversation(*id, conversation);
    }
    // What each agent's child is doing is news for its parent.
    hosted.observe_activity(&views, &pass.states, &pass.overview);
    Activity {
        states: pass.states,
        overview: pass.overview,
        reports: hosted.report_revision(),
    }
}

/// The one reader of the backends' records: on a timer and at once when
/// nudged ([`ActivityReader::run`]), and whenever something in the host asks
/// for the listing as of now ([`ActivityHandle::read_now`]). Each read is
/// published to the clients when it changed anything.
struct ActivityReader {
    hosted: Weak<Hosted>,
    events: Arc<Events>,
    /// The joins kept from pass to pass and the last read, behind one lock,
    /// so two reads never interleave.
    state: Mutex<ActivityState>,
}

struct ActivityState {
    tracker: ActivityTracker,
    last: Activity,
}

impl ActivityReader {
    fn run(&self, nudged: &mpsc::Receiver<()>) {
        loop {
            match nudged.recv_timeout(ACTIVITY_POLL) {
                Ok(()) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
            // Several nudges at once are one read.
            while nudged.try_recv().is_ok() {}
            if self.read_now().is_none() {
                return;
            }
        }
    }

    /// Reads the records now, publishes what changed, and answers the
    /// machine-wide listing; `None` once the host has gone.
    fn read_now(&self) -> Option<SessionsOverview> {
        let hosted = self.hosted.upgrade()?;
        let mut state = lock(&self.state);
        let next = read_activity(&hosted, &mut state.tracker);
        drop(hosted);
        let overview = next.overview.clone();
        state.publish(next, &self.events);
        Some(overview)
    }
}

/// The activity pass, for what inside the host asks for the listing as of
/// now: a session tool re-reads it for every call.
#[derive(Clone)]
pub(crate) struct ActivityHandle(Arc<ActivityReader>);

impl ActivityHandle {
    /// Every live agent session on the machine, read now. `None` once the
    /// host has gone. Blocking: it reads each backend's records.
    pub fn read_now(&self) -> Option<SessionsOverview> {
        self.0.read_now()
    }
}

impl ActivityState {
    fn publish(&mut self, next: Activity, events: &Events) {
        if self.last.same_as(&next) {
            return;
        }
        if self.last.overview.sessions != next.overview.sessions
            && let Err(err) = events.set_state::<SessionsOverviewChanged, _>(&next.overview)
        {
            log_line!("floti host: {err}");
        }
        if (self.last.states != next.states || self.last.reports != next.reports)
            && let Err(err) = events.set_state::<SessionActivityChanged, _>(&next.states)
        {
            log_line!("floti host: {err}");
        }
        self.last = next;
    }
}

/// Each session that ends, as its finished row: on `session:exit` to every
/// subscriber, and on `session:notify` to each client for which the exit is
/// worth a notification. Holds the sessions weakly, so the store is let go
/// when the host is; the exits close then and this ends.
async fn publish_exits(
    mut exits: broadcast::Receiver<ExitNotice>,
    hosted: Weak<Hosted>,
    events: Arc<Events>,
    focus: Arc<Mutex<Focus>>,
    nudge: mpsc::Sender<()>,
) {
    loop {
        match exits.recv().await {
            Ok(notice) => {
                let Some(hosted) = hosted.upgrade() else {
                    return;
                };
                let _ = nudge.send(());
                let Ok(record) = hosted.record(notice.session) else {
                    continue;
                };
                // Judged before the session leaves every screen, against
                // what each client listening now last said it sees, and sent
                // before the exit, so a client that has the exit has any
                // notification for it too.
                {
                    let mut focus = lock(&focus);
                    for client in events.clients() {
                        if focus.worth_notifying(client, record.id)
                            && let Err(err) = events.emit_to::<SessionNotify>(client, &record)
                        {
                            log_line!("floti host: {err}");
                        }
                    }
                    focus.forget(record.id);
                }
                if let Err(err) = events.emit::<SessionExit>(&record) {
                    log_line!("floti host: {err}");
                }
            }
            // Missed exits are missed events; the clients see a gap in the
            // numbers and list again.
            Err(RecvError::Lagged(_)) => {}
            Err(RecvError::Closed) => return,
        }
    }
}

/// Each plain terminal whose shell ended, on `pterm:exit`.
async fn publish_terminal_exits(mut exits: broadcast::Receiver<TerminalExit>, events: Arc<Events>) {
    loop {
        match exits.recv().await {
            Ok(exit) => {
                if let Err(err) = events.emit::<PtermExit>(&terminal_exited(exit)) {
                    log_line!("floti host: {err}");
                }
            }
            Err(RecvError::Lagged(_)) => {}
            Err(RecvError::Closed) => return,
        }
    }
}

/// What a client is told of a plain terminal whose shell ended.
fn terminal_exited(exit: TerminalExit) -> PtermExited {
    PtermExited {
        id: u64::try_from(exit.id.0).unwrap_or(0),
        // Windows reports an NTSTATUS such as 0xC0000005 as a `u32`; the
        // signed value (-1073741819) is what PowerShell's `$LASTEXITCODE`
        // says, so keep the low 32 bits and never clamp.
        exit_code: exit.code as i32,
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The close question's button: `End session` when only the session ends,
/// `End 4 sessions` when it and three others do. `ending` is how many end
/// beyond the session itself.
fn close_button(ending: usize) -> String {
    match ending {
        0 => "End session".to_owned(),
        more => format!("End {} sessions", more + 1),
    }
}

/// What the close question says of a session: its agent and folder, and the
/// sessions that end with it, which the client lists. The ones that keep
/// running are named by the client from the ids the question carries.
fn close_detail(agent: &str, cwd: &str, closing: &Closing) -> String {
    match closing.ending.len() {
        0 => format!("Closing the tab ends the {agent} session in {cwd}."),
        // The sessions follow as a list, which the client draws from the ids.
        1 => format!(
            "Ending it stops the {agent} session in {cwd}, and the session it started, which ends with it:"
        ),
        count => format!(
            "Ending it stops the {agent} session in {cwd}, and the {count} sessions it started, which end with it:"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: ClientId = ClientId(1);
    const B: ClientId = ClientId(2);

    #[test]
    fn a_close_question_counts_the_session_and_what_ends_with_it_and_names_who_keeps_running() {
        assert_eq!(close_button(0), "End session");
        assert_eq!(close_button(3), "End 4 sessions");

        let alone = Closing::default();
        assert_eq!(
            close_detail("Claude Code", "C:/work", &alone),
            "Closing the tab ends the Claude Code session in C:/work."
        );
        let family = Closing {
            ending: vec![(2, "worker".into()), (3, "helper".into())],
            outliving: vec![(4, "watcher".into())],
        };
        assert_eq!(
            close_detail("Claude Code", "C:/work", &family),
            "Ending it stops the Claude Code session in C:/work, and the 2 sessions it started, which end with it:"
        );
    }

    #[test]
    fn a_shell_that_exited_above_i32_is_told_as_the_signed_code_powershell_says() {
        use crate::session::SessionId;
        for (code, told) in [
            (0, 0),
            (3, 3),
            (0xC000_0005, -1_073_741_819),
            (u32::MAX, -1),
        ] {
            let exit = TerminalExit {
                id: SessionId(7),
                code,
            };
            let ended = terminal_exited(exit);
            assert_eq!(ended.id, 7);
            assert_eq!(ended.exit_code, told, "{code}");
        }
    }

    #[test]
    fn an_exit_is_worth_a_notification_only_for_a_client_whose_user_cannot_see_it() {
        let mut focus = Focus::default();
        // Nobody has said what they see: every exit is unwatched.
        assert!(focus.worth_notifying(A, 7));

        focus.set(A, [7, 9]);
        focus.set(B, [9]);
        assert!(!focus.worth_notifying(A, 7), "on A's screen");
        assert!(focus.worth_notifying(B, 7), "in a tab B's user cannot see");
        assert!(!focus.worth_notifying(B, 9));

        // A window that is not in front sees nothing.
        focus.set(A, []);
        assert!(focus.worth_notifying(A, 7));

        // An ended session leaves every screen.
        focus.forget(9);
        assert!(focus.worth_notifying(B, 9));

        // A client that has gone takes what it saw with it.
        focus.set(B, [4]);
        focus.leave(B);
        assert!(focus.worth_notifying(B, 4));
    }

    #[test]
    fn a_session_a_client_closed_is_worth_a_notification_for_nobody_until_it_has_ended() {
        let mut focus = Focus::default();
        focus.set(A, []);
        focus.closing(7);
        assert!(!focus.worth_notifying(A, 7));
        assert!(!focus.worth_notifying(B, 7), "a client that never said");

        // Its number is let go with the exit.
        focus.forget(7);
        assert!(focus.worth_notifying(A, 7));
    }
}
