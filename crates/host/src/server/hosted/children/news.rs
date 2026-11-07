//! How a child's doings become news for its parent: the rules that turn what
//! its agent's records and its program say into the five events, and the desk
//! that watches every child and writes them to the inbox.
//!
//! **Watched where activity is already read.** The activity reader
//! (`features/sessions.rs`) takes one pass over every hosted session, every
//! 750 ms and whenever a status moves; each pass is handed to
//! [`Hosted::observe_activity`], which is the only place a child's activity
//! becomes an event. There is no timer of its own and no client in it.
//!
//! **The events** (kinds in [`EventKind`]):
//!
//! - *report*: the child's `agents_report`, or, for an agent with no MCP
//!   tools, its program's OSC 7501 `done` with the program's message;
//! - *needs you*: the child's activity becomes waiting, with its kind. The
//!   backend's own records come first and OSC 7501 `blocked` after, as the
//!   merged activity already has it;
//! - *turn ended*: working to idle with no report in that turn. A turn that
//!   ends with a report is one event, the report;
//! - *ended*: its session ended, with the exit code, or stopped and by whom;
//! - *error*: its launch failed, or its program reports `error`.
//!
//! No event carries the conversation: a report's text and a program's message
//! are all the words there are.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard, PoisonError};

use floti_protocol::channels::common::ChildReport;
use floti_protocol::channels::sessions::{
    SessionActivity, SessionActivityState, SessionsOverview, StandingNotice,
};
use tokio::sync::watch;

use super::inbox::{self, EventKind, Facts, Item, StoppedBy};
use super::{notices, rows};
use crate::server::hosted::{Hosted, session_id};
use crate::session::{HostedView, ReportState, ReportedStatus, SessionId};

/// What a pass saw of one child.
pub(super) struct Observed<'a> {
    pub activity: Option<SessionActivity>,
    /// What a waiting child waits on, as the merged activity says it.
    pub waiting_for: Option<&'a str>,
    /// The program's own message for an error.
    pub message: Option<&'a str>,
    /// What its program last reported about itself (OSC 7501).
    pub report: Option<&'a ReportedStatus>,
    /// Whether the child has `agents_report`. An agent that does not is heard
    /// through its program's reports instead.
    pub reports_by_tool: bool,
}

/// What one pass turned up for one child.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct Seen {
    /// Events to write, in order.
    pub events: Vec<(EventKind, Facts)>,
    /// The child's next turn started in this pass, so the report of the turn
    /// before it is no longer its latest. False when the child already
    /// reported in the turn this pass saw begin: that report is this turn's own.
    pub turn_started: bool,
    /// The child's turn ended in this pass (it went idle after working or
    /// after a dialog), with a report or without: what a person typed before
    /// it is spent.
    pub turn_ended: bool,
}

/// The rules for one child, a pure state machine over what passes see.
#[derive(Debug, Default)]
pub(super) struct Tracker {
    activity: Option<SessionActivity>,
    /// The time of the program report last looked at, which names it.
    report_since: Option<u64>,
    /// The child reported in the turn it is in.
    reported_this_turn: bool,
    /// The child reported since the last pass, which may not have seen its
    /// turn start yet.
    reported_since_pass: bool,
}

/// Busy or running a command: the child has work in hand.
fn working(activity: Option<SessionActivity>) -> bool {
    matches!(
        activity,
        Some(SessionActivity::Busy | SessionActivity::Shell)
    )
}

/// The kinds of wait a child's records or program name.
const KINDS: [&str; 3] = ["permission prompt", "question", "sign-in"];

impl Tracker {
    /// A tracker for a child that was already running when the host started:
    /// whatever it is doing now was news, or not, before.
    pub fn baseline(now: &Observed<'_>) -> Self {
        Self {
            activity: now.activity,
            report_since: now.report.map(|status| status.since_ms),
            ..Self::default()
        }
    }

    /// The child called `agents_report`: that turn ends with a report.
    pub fn reported(&mut self) {
        self.reported_this_turn = true;
        self.reported_since_pass = true;
    }

    /// What `now` adds to what was seen before.
    pub fn observe(&mut self, now: &Observed<'_>) -> Seen {
        let mut seen = Seen::default();
        let reported_between = std::mem::take(&mut self.reported_since_pass);

        // A program's report that is new. Only an agent without
        // `agents_report` is heard this way: one with the tool reports there.
        if let Some(status) = now.report
            && self.report_since != Some(status.since_ms)
        {
            self.report_since = Some(status.since_ms);
            if !now.reports_by_tool && status.report.state == ReportState::Done {
                let message = status.report.message.trim();
                seen.events.push((
                    EventKind::Report,
                    Facts {
                        state: Some("done".to_owned()),
                        detail: (!message.is_empty()).then(|| message.to_owned()),
                        exit_code: None,
                    },
                ));
                self.reported_this_turn = true;
            }
        }

        if now.activity != self.activity {
            let before = std::mem::replace(&mut self.activity, now.activity);
            seen.turn_ended = now.activity == Some(SessionActivity::Idle)
                && (working(before) || before == Some(SessionActivity::Waiting));
            match now.activity {
                Some(SessionActivity::Busy | SessionActivity::Shell) if !working(before) => {
                    self.reported_this_turn = reported_between;
                    // A report made before this pass saw the turn begin was
                    // made in it, so the turn starting does not take it away.
                    seen.turn_started = !reported_between;
                }
                Some(SessionActivity::Waiting) => {
                    seen.events
                        .push((EventKind::NeedsYou, needs_you(now.waiting_for)));
                }
                Some(SessionActivity::Error) => seen.events.push((
                    EventKind::Error,
                    Facts {
                        state: Some("program".to_owned()),
                        detail: now
                            .message
                            .map(str::trim)
                            .filter(|message| !message.is_empty())
                            .map(str::to_owned),
                        exit_code: None,
                    },
                )),
                Some(SessionActivity::Idle) if working(before) && !self.reported_this_turn => {
                    seen.events.push((EventKind::TurnEnded, Facts::default()));
                }
                _ => {}
            }
        }
        seen
    }
}

/// What a waiting child waits on: its kind when it is one of the three, else
/// its own sentence.
fn needs_you(waiting_for: Option<&str>) -> Facts {
    let text = waiting_for.map(str::trim).filter(|text| !text.is_empty());
    match text {
        Some(kind) if KINDS.contains(&kind) => Facts {
            state: Some(kind.to_owned()),
            ..Facts::default()
        },
        Some(sentence) => Facts {
            detail: Some(sentence.to_owned()),
            ..Facts::default()
        },
        None => Facts::default(),
    }
}

/// What a waiting child waits on, as its notice says it.
fn waiting_text(waiting_for: Option<&str>) -> String {
    waiting_for
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or("waiting for you")
        .to_owned()
}

/// A child's last report, for its record until its next turn starts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LastReport {
    /// `done`, `stuck` or `note`.
    pub state: String,
    pub text: String,
    /// When it was made, as the store writes a time.
    pub at: String,
}

impl From<LastReport> for ChildReport {
    fn from(report: LastReport) -> Self {
        Self {
            state: report.state,
            text: report.text,
            at: report.at,
        }
    }
}

/// What the host keeps in memory about the children it watches.
#[derive(Default)]
struct Watched {
    trackers: HashMap<SessionId, Tracker>,
    /// Sessions known not to be children, so a pass does not ask again.
    plain: HashSet<SessionId>,
    /// Children that were running when the host started.
    adopted: HashSet<SessionId>,
    /// What each child's activity was at the last pass.
    activity: HashMap<SessionId, Option<SessionActivity>>,
    /// Who ended a child that is ending, noted before it is ended.
    stopped_by: HashMap<SessionId, StoppedBy>,
    last_report: HashMap<SessionId, LastReport>,
    /// Counts the changes to `last_report`, which the clients' listing shows
    /// and the activity reader publishes again when it moves.
    report_revision: u64,
    /// The needs-you notice of each child whose activity is waiting.
    needs_you: HashMap<SessionId, StandingNotice>,
}

/// The children the host watches, and the signal waits sleep on.
pub(in crate::server::hosted) struct Desk {
    watched: Mutex<Watched>,
    /// Counts what changed for a wait: news written, a child's activity
    /// moved, a session ended.
    changes: watch::Sender<u64>,
    /// Counts the changes to the standing notices.
    standing: watch::Sender<u64>,
}

impl Desk {
    pub fn new() -> Self {
        Self {
            watched: Mutex::new(Watched::default()),
            changes: watch::Sender::new(0),
            standing: watch::Sender::new(0),
        }
    }

    /// The needs-you notices standing now, by child.
    pub fn needs_you_notices(&self) -> Vec<StandingNotice> {
        let watched = self.watched();
        let mut standing: Vec<(&SessionId, &StandingNotice)> = watched.needs_you.iter().collect();
        standing.sort_by_key(|(id, _)| **id);
        standing
            .into_iter()
            .map(|(_, notice)| notice.clone())
            .collect()
    }

    /// Changes to the standing notices from now on.
    pub fn notices_changes(&self) -> watch::Receiver<u64> {
        self.standing.subscribe()
    }

    /// The standing notices have changed.
    pub fn notices_moved(&self) {
        self.standing.send_modify(|changes| *changes += 1);
    }

    fn watched(&self) -> MutexGuard<'_, Watched> {
        self.watched.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Something a wait looks at has changed.
    pub fn bump(&self) {
        self.changes.send_modify(|changes| *changes += 1);
    }

    /// Changes from now on, for a wait to sleep on.
    pub fn changes(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    /// Children running when the host started: their first pass is taken as
    /// where they were, not as news.
    pub fn adopt(&self, ids: impl IntoIterator<Item = SessionId>) {
        self.watched().adopted.extend(ids);
    }

    /// What child `id`'s activity was at the last pass; `None` when it is not
    /// known.
    pub fn activity_of(&self, id: SessionId) -> Option<SessionActivity> {
        self.watched().activity.get(&id).copied().flatten()
    }

    /// Child `id` is about to be ended by `by`. The first to say wins: a
    /// person's Stop on a child its parent is already stopping is the
    /// parent's.
    pub fn note_stopped(&self, id: SessionId, by: StoppedBy) {
        self.watched().stopped_by.entry(id).or_insert(by);
    }

    fn take_stopped(&self, id: SessionId) -> Option<StoppedBy> {
        self.watched().stopped_by.remove(&id)
    }

    /// Child `id`'s last report, until its next turn starts.
    pub fn last_report(&self, id: SessionId) -> Option<LastReport> {
        self.watched().last_report.get(&id).cloned()
    }

    /// How many times a child's last report has been set or cleared.
    pub fn report_revision(&self) -> u64 {
        self.watched().report_revision
    }

    /// Lets go of what is kept about session `id`. Whether it had a needs-you
    /// notice standing.
    fn forget(&self, id: SessionId) -> bool {
        let mut watched = self.watched();
        watched.trackers.remove(&id);
        watched.activity.remove(&id);
        watched.plain.remove(&id);
        watched.adopted.remove(&id);
        watched.stopped_by.remove(&id);
        if watched.last_report.remove(&id).is_some() {
            watched.report_revision += 1;
        }
        watched.needs_you.remove(&id).is_some()
    }
}

impl Hosted {
    /// One pass of the activity reader over the hosted sessions: the events
    /// each child's doings give its parent. `views` and `states` are the
    /// pass's input and output, in the same order. `overview` is the pass's
    /// listing, which says since when each session has had its status: a
    /// session idle since after a person last typed has had a turn end since,
    /// even one no pass saw working.
    pub(crate) fn observe_activity(
        &self,
        views: &[HostedView],
        states: &[SessionActivityState],
        overview: &SessionsOverview,
    ) {
        let desk = &self.children.news;
        let mut events: Vec<(SessionId, EventKind, Facts)> = Vec::new();
        let mut moved = false;
        let mut noticed = false;
        let mut turns_ended: Vec<SessionId> = Vec::new();
        let mut idle_since: Vec<(SessionId, u64)> = Vec::new();
        {
            let mut watched = desk.watched();
            let live: HashSet<SessionId> = views
                .iter()
                .filter_map(|view| session_id(view.id))
                .collect();
            for (view, state) in views.iter().zip(states) {
                let Some(id) = session_id(view.id) else {
                    continue;
                };
                if watched.plain.contains(&id) {
                    continue;
                }
                let reports_by_tool = self
                    .find_backend(&view.backend)
                    .is_some_and(|backend| backend.tool_support().mcp_tools);
                let observed = Observed {
                    activity: state.activity,
                    waiting_for: state.waiting_for.as_deref(),
                    message: state.message.as_deref(),
                    report: view.report.as_ref(),
                    reports_by_tool,
                };
                if !watched.trackers.contains_key(&id) {
                    match rows::link_of(&self.ledger.store(), id) {
                        Ok(Some(_)) => {
                            let tracker = if watched.adopted.contains(&id) {
                                Tracker::baseline(&observed)
                            } else {
                                Tracker::default()
                            };
                            watched.trackers.insert(id, tracker);
                        }
                        Ok(None) => {
                            watched.plain.insert(id);
                            continue;
                        }
                        Err(err) => {
                            log_line!("floti host: {err}");
                            continue;
                        }
                    }
                }
                let seen = watched
                    .trackers
                    .get_mut(&id)
                    .map(|tracker| tracker.observe(&observed))
                    .unwrap_or_default();
                if watched.activity.insert(id, state.activity) != Some(state.activity) {
                    moved = true;
                }
                if state.activity == Some(SessionActivity::Waiting) {
                    let text = waiting_text(state.waiting_for.as_deref());
                    match watched.needs_you.get_mut(&id) {
                        Some(notice) if notice.text != text => {
                            notice.text = text;
                            noticed = true;
                        }
                        Some(_) => {}
                        None => {
                            if let Some(notice) = self.needs_you_notice(id, &text) {
                                watched.needs_you.insert(id, notice);
                                noticed = true;
                            }
                        }
                    }
                } else if watched.needs_you.remove(&id).is_some() {
                    noticed = true;
                }
                if seen.turn_ended {
                    turns_ended.push(id);
                } else if state.activity == Some(SessionActivity::Idle)
                    && let Some(since) = overview
                        .sessions
                        .iter()
                        .find(|listed| listed.host_session_id == Some(view.id))
                        .and_then(|listed| listed.status_since_ms)
                {
                    idle_since.push((id, since));
                }
                if seen.turn_started && watched.last_report.remove(&id).is_some() {
                    watched.report_revision += 1;
                    moved = true;
                }
                events.extend(
                    seen.events
                        .into_iter()
                        .map(|(kind, facts)| (id, kind, facts)),
                );
            }
            watched.plain.retain(|id| live.contains(id));
        }
        for session in turns_ended
            .into_iter()
            .filter_map(|id| self.sessions.get(id))
        {
            session.turn_ended();
        }
        for (session, since) in idle_since
            .into_iter()
            .filter_map(|(id, since)| self.sessions.get(id).map(|session| (session, since)))
        {
            session.idle_since(since);
        }
        for (child, kind, facts) in events {
            if kind == EventKind::Error {
                self.program_error_noticed(child, &facts);
            }
            self.write_news(child, kind, &facts);
        }
        if noticed {
            desk.notices_moved();
        }
        if moved {
            desk.bump();
        }
    }

    /// The needs-you notice for child `child`, waiting on `text`, or `None`
    /// when it is not a child with a parent.
    fn needs_you_notice(&self, child: SessionId, text: &str) -> Option<StandingNotice> {
        let store = self.ledger.store();
        let link = match rows::link_of(&store, child) {
            Ok(link) => link?,
            Err(err) => {
                log_line!("floti host: {err}");
                return None;
            }
        };
        let parent = rows::label_of(&store, link.parent)
            .ok()
            .flatten()
            .unwrap_or_default();
        Some(notices::needs_you(
            child,
            &link.name,
            link.parent,
            &parent,
            text,
            store_now(&store),
        ))
    }

    /// Child `child`'s program reported an error: a notice stands until it is
    /// dismissed or the parent ends.
    fn program_error_noticed(&self, child: SessionId, facts: &Facts) {
        let link = match rows::link_of(&self.ledger.store(), child) {
            Ok(Some(link)) => link,
            Ok(None) => return,
            Err(err) => {
                log_line!("floti host: {err}");
                return;
            }
        };
        let text = match facts.detail.as_deref() {
            Some(message) => format!("{} reported an error: {message}", link.name),
            None => format!("{} reported an error.", link.name),
        };
        self.error_noticed(&link, Some(child), &text);
    }

    /// Writes `facts` as an event of child `child` into its parent's inbox,
    /// and wakes the waits. A child with no parent has no inbox to write to.
    fn write_news(&self, child: SessionId, kind: EventKind, facts: &Facts) {
        let link = match rows::link_of(&self.ledger.store(), child) {
            Ok(Some(link)) => link,
            Ok(None) => return,
            Err(err) => {
                log_line!("floti host: {err}");
                return;
            }
        };
        self.write_news_to(&link, Some(child), kind, facts);
    }

    fn write_news_to(
        &self,
        link: &rows::Link,
        child: Option<SessionId>,
        kind: EventKind,
        facts: &Facts,
    ) {
        let written = inbox::record(
            &self.ledger.store(),
            &Item {
                parent: link.parent,
                parent_conversation: link.conversation.as_deref(),
                child,
                child_name: &link.name,
                event: kind,
                facts,
            },
        );
        if let Err(err) = written {
            log_line!("floti host: {err}");
        }
        self.children.news.bump();
    }

    /// Child `child` called `agents_report`: the report is news for its
    /// parent, and that turn ends with it.
    ///
    /// # Errors
    ///
    /// A sentence when the child has no parent to tell.
    pub(crate) fn child_reported(
        &self,
        child: SessionId,
        state: &str,
        text: &str,
    ) -> Result<(), String> {
        let link = rows::link_of(&self.ledger.store(), child)
            .map_err(|err| err.to_string())?
            .ok_or_else(|| {
                "You were not started by another agent, so you have no one to report to.".to_owned()
            })?;
        let facts = Facts {
            state: Some(state.to_owned()),
            detail: Some(text.to_owned()),
            exit_code: None,
        };
        {
            let mut watched = self.children.news.watched();
            if let Some(tracker) = watched.trackers.get_mut(&child) {
                tracker.reported();
            }
            let at = store_now(&self.ledger.store());
            watched.last_report.insert(
                child,
                LastReport {
                    state: state.to_owned(),
                    text: text.to_owned(),
                    at,
                },
            );
            watched.report_revision += 1;
        }
        self.write_news_to(&link, Some(child), EventKind::Report, &facts);
        // The child's card shows the report now, not at the next time
        // something else about the child moves.
        self.sessions.status_moved();
        Ok(())
    }

    /// How many times a child's last report has been set or cleared, for the
    /// reader of the sessions' activity to tell a listing has changed.
    pub(crate) fn report_revision(&self) -> u64 {
        self.children.news.report_revision()
    }

    /// Child `child`'s session has ended: the parent is told how, from the
    /// row the ledger wrote.
    pub(crate) fn child_ended(&self, child: SessionId) {
        let ended = rows::ended_of(&self.ledger.store(), child);
        let desk = &self.children.news;
        let last_lines = self.ledger.last_lines_of(child);
        match ended {
            Ok(Some(ended)) => {
                let by = desk.take_stopped(child);
                let facts = if ended.stopped {
                    Facts {
                        state: Some("stopped".to_owned()),
                        // A stop nobody noted is a person's: every other
                        // route notes itself first.
                        detail: Some(by.unwrap_or(StoppedBy::Person).word().to_owned()),
                        exit_code: None,
                    }
                } else {
                    Facts {
                        state: Some(inbox::EXITED.to_owned()),
                        // A command child's parent is told what it last
                        // printed with its exit.
                        detail: (!last_lines.is_empty()).then(|| told_lines(&last_lines)),
                        exit_code: ended.exit_code,
                    }
                };
                self.write_news_to(&ended.link, Some(child), EventKind::Ended, &facts);
                if !ended.stopped
                    && let Some(code) = ended.exit_code.filter(|code| *code != 0)
                {
                    self.error_noticed(
                        &ended.link,
                        Some(child),
                        &format!(
                            "{} ended in error: it exited with code {code}.",
                            ended.link.name
                        ),
                    );
                }
            }
            Ok(None) => {}
            Err(err) => log_line!("floti host: {err}"),
        }
        // What it was waiting on is no longer standing, and nothing stands
        // under a session that has ended.
        if desk.forget(child) {
            desk.notices_moved();
        }
        self.notices_of_ended(child);
        // A wait on a parent that has ended looks again.
        desk.bump();
    }

    /// A child of `parent` could not be started: `reason` is news for it.
    pub(super) fn launch_failed(&self, link: &rows::Link, reason: &str) {
        self.error_noticed(
            link,
            None,
            &format!("{} could not be started: {reason}", link.name),
        );
        self.write_news_to(
            link,
            None,
            EventKind::Error,
            &Facts {
                state: Some("launch".to_owned()),
                detail: Some(reason.to_owned()),
                exit_code: None,
            },
        );
    }

    /// Child `child` is about to be ended by `by`.
    pub(crate) fn note_stopped(&self, child: SessionId, by: StoppedBy) {
        self.children.news.note_stopped(child, by);
    }

    /// Child `child`'s last report, until its next turn starts.
    pub(crate) fn last_report_of(&self, child: SessionId) -> Option<LastReport> {
        self.children.news.last_report(child)
    }

    /// Whether session `id` is a child with a parent to report to.
    pub(crate) fn reports_to_parent(&self, id: SessionId) -> bool {
        rows::link_of(&self.ledger.store(), id)
            .map(|link| link.is_some())
            .unwrap_or_else(|err| {
                log_line!("floti host: {err}");
                false
            })
    }
}

/// The most characters of one line of a command's output a parent is told.
const TOLD_LINE_CHARS: usize = 400;

/// A command child's last lines as one text, each cut to a length a parent
/// can read.
fn told_lines(lines: &[String]) -> String {
    lines
        .iter()
        .map(|line| line.chars().take(TOLD_LINE_CHARS).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The store's own "now", in the text it writes times in.
fn store_now(store: &crate::store::Store) -> String {
    store
        .connection()
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |row| {
            row.get(0)
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use floti_protocol::channels::sessions::SessionActivity::{Busy, Idle, Shell, Waiting};

    use super::*;
    use crate::session::{BlockedKind, StatusReport};

    fn at(activity: Option<SessionActivity>) -> Observed<'static> {
        Observed {
            activity,
            waiting_for: None,
            message: None,
            report: None,
            reports_by_tool: true,
        }
    }

    fn kinds(seen: &Seen) -> Vec<EventKind> {
        seen.events.iter().map(|(kind, _)| *kind).collect()
    }

    #[test]
    fn a_turn_that_ends_with_no_report_is_a_turn_ended_event_and_one_that_reported_is_not() {
        let mut tracker = Tracker::default();
        assert!(tracker.observe(&at(Some(Busy))).events.is_empty());
        assert_eq!(
            kinds(&tracker.observe(&at(Some(Idle)))),
            [EventKind::TurnEnded]
        );

        // The next turn reports: the report is the event, the idle is not.
        assert!(tracker.observe(&at(Some(Busy))).turn_started);
        tracker.reported();
        assert!(tracker.observe(&at(Some(Idle))).events.is_empty());

        // And the turn after that has its own.
        tracker.observe(&at(Some(Busy)));
        assert_eq!(
            kinds(&tracker.observe(&at(Some(Idle)))),
            [EventKind::TurnEnded]
        );
    }

    #[test]
    fn a_turn_ends_when_the_child_goes_idle_after_working_or_after_a_dialog_with_or_without_a_report()
     {
        let mut tracker = Tracker::default();
        assert!(!tracker.observe(&at(Some(Idle))).turn_ended);
        assert!(!tracker.observe(&at(Some(Busy))).turn_ended);
        assert!(tracker.observe(&at(Some(Idle))).turn_ended);
        // A turn that reported ends all the same.
        tracker.observe(&at(Some(Busy)));
        tracker.reported();
        assert!(tracker.observe(&at(Some(Idle))).turn_ended);
        // A dialog that is answered and then leaves the child idle.
        tracker.observe(&at(Some(Waiting)));
        assert!(tracker.observe(&at(Some(Idle))).turn_ended);
        // Passes that change nothing end nothing.
        assert!(!tracker.observe(&at(Some(Idle))).turn_ended);
    }

    #[test]
    fn a_report_made_before_the_pass_saw_the_turn_start_still_ends_that_turn() {
        let mut tracker = Tracker::default();
        tracker.reported();
        tracker.observe(&at(Some(Busy)));
        assert!(tracker.observe(&at(Some(Idle))).events.is_empty());
    }

    #[test]
    fn a_report_made_before_the_pass_saw_its_turn_start_stays_until_the_turn_after() {
        let mut tracker = Tracker::default();
        tracker.observe(&at(Some(Busy)));
        tracker.observe(&at(Some(Idle)));

        // The child begins a turn and reports in it, between two passes: the
        // pass that sees the turn begin does not take its report away.
        tracker.reported();
        assert!(!tracker.observe(&at(Some(Busy))).turn_started);
        tracker.observe(&at(Some(Idle)));

        // The turn after it does, as a turn whose report came later would.
        assert!(tracker.observe(&at(Some(Busy))).turn_started);
    }

    #[test]
    fn running_a_command_is_working_and_a_pass_that_changes_nothing_adds_nothing() {
        let mut tracker = Tracker::default();
        tracker.observe(&at(Some(Busy)));
        assert!(tracker.observe(&at(Some(Shell))).events.is_empty());
        assert!(tracker.observe(&at(Some(Shell))).events.is_empty());
        assert_eq!(
            kinds(&tracker.observe(&at(Some(Idle)))),
            [EventKind::TurnEnded]
        );
        assert!(tracker.observe(&at(Some(Idle))).events.is_empty());
        // Idle with no turn before it is not the end of one.
        let mut fresh = Tracker::default();
        assert!(fresh.observe(&at(Some(Idle))).events.is_empty());
    }

    #[test]
    fn waiting_is_needs_you_with_its_kind_once_per_wait() {
        let mut tracker = Tracker::default();
        tracker.observe(&at(Some(Busy)));
        let waiting = |waiting_for| Observed {
            waiting_for,
            ..at(Some(Waiting))
        };
        let seen = tracker.observe(&waiting(Some("permission prompt")));
        assert_eq!(
            seen.events,
            [(
                EventKind::NeedsYou,
                Facts {
                    state: Some("permission prompt".into()),
                    ..Facts::default()
                }
            )]
        );
        // Still waiting, on another sentence: not a new event.
        assert!(
            tracker
                .observe(&waiting(Some("approve Bash")))
                .events
                .is_empty()
        );
        // Answering is not news, and waiting again is.
        assert!(tracker.observe(&at(Some(Busy))).events.is_empty());
        let again = tracker.observe(&waiting(Some("approve Bash")));
        assert_eq!(again.events[0].1.detail.as_deref(), Some("approve Bash"));
        assert_eq!(again.events[0].1.state, None);
    }

    #[test]
    fn a_child_that_started_waiting_before_any_pass_still_gives_the_event_but_an_adopted_one_does_not()
     {
        let waiting = Observed {
            waiting_for: Some("question"),
            ..at(Some(Waiting))
        };
        assert_eq!(
            kinds(&Tracker::default().observe(&waiting)),
            [EventKind::NeedsYou]
        );
        let mut adopted = Tracker::baseline(&waiting);
        assert!(adopted.observe(&waiting).events.is_empty());
        assert_eq!(
            kinds(&adopted.observe(&at(Some(Busy)))),
            Vec::<EventKind>::new()
        );
    }

    #[test]
    fn a_program_that_reports_an_error_gives_an_error_event_with_its_message() {
        let mut tracker = Tracker::default();
        tracker.observe(&at(Some(Busy)));
        let seen = tracker.observe(&Observed {
            message: Some("the build broke"),
            ..at(Some(SessionActivity::Error))
        });
        assert_eq!(
            seen.events,
            [(
                EventKind::Error,
                Facts {
                    state: Some("program".into()),
                    detail: Some("the build broke".into()),
                    exit_code: None,
                }
            )]
        );
    }

    fn done_report(since_ms: u64, message: &str) -> ReportedStatus {
        ReportedStatus {
            report: StatusReport {
                state: ReportState::Done,
                kind: None::<BlockedKind>,
                progress: None,
                id: String::new(),
                app: String::new(),
                title: String::new(),
                message: message.to_owned(),
            },
            since_ms,
        }
    }

    #[test]
    fn a_program_that_says_done_is_a_done_report_with_its_message_unless_the_agent_has_the_tool() {
        let report = done_report(10, "Wrote the file.");
        let mut tracker = Tracker::default();
        tracker.observe(&at(Some(Busy)));
        let heard = tracker.observe(&Observed {
            report: Some(&report),
            reports_by_tool: false,
            ..at(Some(Idle))
        });
        // One event, the report: the idle after it is not a turn ended.
        assert_eq!(
            heard.events,
            [(
                EventKind::Report,
                Facts {
                    state: Some("done".into()),
                    detail: Some("Wrote the file.".into()),
                    exit_code: None,
                }
            )]
        );
        // The same report seen again is not a second one.
        assert!(
            tracker
                .observe(&Observed {
                    report: Some(&report),
                    reports_by_tool: false,
                    ..at(Some(Idle))
                })
                .events
                .is_empty()
        );

        // An agent with agents_report reports there, not by its program.
        let mut with_tool = Tracker::default();
        with_tool.observe(&at(Some(Busy)));
        let heard = with_tool.observe(&Observed {
            report: Some(&report),
            reports_by_tool: true,
            ..at(Some(Idle))
        });
        assert_eq!(kinds(&heard), [EventKind::TurnEnded]);
    }

    #[test]
    fn a_new_turn_is_what_clears_a_childs_last_report() {
        let mut tracker = Tracker::default();
        assert!(tracker.observe(&at(Some(Busy))).turn_started);
        assert!(!tracker.observe(&at(Some(Shell))).turn_started);
        tracker.observe(&at(Some(Idle)));
        assert!(tracker.observe(&at(Some(Busy))).turn_started);
    }
}
