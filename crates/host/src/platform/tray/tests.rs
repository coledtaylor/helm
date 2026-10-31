use std::ffi::OsString;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{mpsc, watch};

use super::*;
use crate::server::Occupancy;
use crate::{DesktopCommand, Result};

fn occupied(sessions: usize, terminals: usize, clients: usize) -> Occupancy {
    Occupancy {
        sessions,
        terminals,
        clients,
    }
}

fn tooltip_of(now: Occupancy) -> Option<String> {
    shown(true, now).map(|icon| icon.tooltip)
}

#[test]
fn a_host_a_desktop_started_shows_its_session_count_while_no_client_is_attached() {
    assert_eq!(
        tooltip_of(occupied(1, 0, 0)).as_deref(),
        Some("Helm: 1 session running on this PC's host")
    );
    assert_eq!(
        tooltip_of(occupied(3, 0, 0)).as_deref(),
        Some("Helm: 3 sessions running on this PC's host")
    );
    assert_eq!(
        tooltip_of(occupied(2, 1, 0)).as_deref(),
        Some("Helm: 2 sessions and 1 terminal running on this PC's host")
    );
    assert_eq!(
        tooltip_of(occupied(0, 2, 0)).as_deref(),
        Some("Helm: 2 terminals running on this PC's host")
    );
    for icon in [occupied(1, 0, 0), occupied(9, 9, 0)].map(|now| shown(true, now)) {
        assert!(icon.unwrap().tooltip.encode_utf16().count() <= TOOLTIP_MAX);
    }
}

#[test]
fn the_icon_goes_while_a_client_is_attached_or_nothing_runs() {
    assert_eq!(shown(true, occupied(2, 0, 1)), None);
    assert_eq!(shown(true, occupied(0, 0, 0)), None);
    assert_eq!(shown(true, occupied(0, 0, 3)), None);
}

#[test]
fn a_host_started_without_a_desktop_never_shows_one() {
    for now in [occupied(1, 0, 0), occupied(0, 1, 0), occupied(4, 2, 0)] {
        assert_eq!(shown(false, now), None);
    }
}

#[test]
fn open_helm_opens_the_desktop_and_stop_host_asks_saying_how_many_sessions_it_ends() {
    assert_eq!(
        on_pick(TrayItem::OpenDesktop, occupied(2, 0, 0)),
        Step::Open
    );
    assert_eq!(
        on_pick(TrayItem::StopHost, occupied(2, 0, 0)),
        Step::AskThenStop(Question {
            title: "Stop host".to_owned(),
            text: "Stopping this PC's host ends the 2 sessions running in it. Stop it?".to_owned(),
        })
    );
    assert_eq!(
        stop_question(occupied(1, 0, 0)).text,
        "Stopping this PC's host ends the 1 session running in it. Stop it?"
    );
    assert_eq!(
        stop_question(occupied(1, 2, 0)).text,
        "Stopping this PC's host ends the 1 session and 2 terminals running in it. Stop it?"
    );
    assert_eq!(
        stop_question(occupied(0, 0, 0)).text,
        "Nothing is running in this PC's host. Stop it?"
    );
}

/// What the fake area was asked to do, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Call {
    Show(String),
    Hide,
    /// A question, and how many stops had been asked for when it was put:
    /// every earlier answer has been acted on by then.
    Confirm(String, usize),
    Open(DesktopCommand),
}

/// A notification area that records what it is asked, and answers each
/// question with the next scripted answer.
struct FakeArea {
    calls: Mutex<Vec<Call>>,
    answers: Mutex<Vec<bool>>,
    stops: Arc<AtomicUsize>,
    told: mpsc::UnboundedSender<Call>,
}

impl FakeArea {
    fn record(&self, call: Call) {
        self.calls.lock().unwrap().push(call.clone());
        let _ = self.told.send(call);
    }
}

impl NotificationArea for FakeArea {
    fn show(&self, icon: &TrayIcon) -> Result<()> {
        self.record(Call::Show(icon.tooltip.clone()));
        Ok(())
    }

    fn hide(&self) -> Result<()> {
        self.record(Call::Hide);
        Ok(())
    }

    /// Answers before it says it was asked, so the answer is in before
    /// anything the test does once it has seen the question.
    fn confirm(&self, question: &Question, answer: Answer) {
        let stops = self.stops.load(Ordering::SeqCst);
        answer(self.answers.lock().unwrap().remove(0));
        self.record(Call::Confirm(question.text.clone(), stops));
    }

    fn open(&self, desktop: &DesktopCommand) -> Result<()> {
        self.record(Call::Open(desktop.clone()));
        Ok(())
    }
}

/// The tray driven by [`run`] over a fake area, with the levers a test
/// moves and what it watches.
struct Driven {
    occupancy: watch::Sender<Occupancy>,
    picks: mpsc::UnboundedSender<TrayItem>,
    told: mpsc::UnboundedReceiver<Call>,
    stopped: mpsc::UnboundedReceiver<()>,
    stops: Arc<AtomicUsize>,
    area: Arc<FakeArea>,
}

fn desktop() -> DesktopCommand {
    DesktopCommand {
        program: OsString::from("C:\\Program Files\\Helm\\Helm.exe"),
        args: vec![OsString::from("an app folder")],
    }
}

fn drive(start: Occupancy, answers: &[bool]) -> Driven {
    let (occupancy, watched) = watch::channel(start);
    let (picks, picked) = mpsc::unbounded_channel();
    let (told_tx, told) = mpsc::unbounded_channel();
    let (stopped_tx, stopped) = mpsc::unbounded_channel();
    let stops = Arc::new(AtomicUsize::new(0));
    let area = Arc::new(FakeArea {
        calls: Mutex::new(Vec::new()),
        answers: Mutex::new(answers.to_vec()),
        stops: Arc::clone(&stops),
        told: told_tx,
    });
    let counted = Arc::clone(&stops);
    tokio::spawn(run(
        Arc::clone(&area),
        desktop(),
        watched,
        picked,
        move || {
            counted.fetch_add(1, Ordering::SeqCst);
            let _ = stopped_tx.send(());
        },
    ));
    Driven {
        occupancy,
        picks,
        told,
        stopped,
        stops,
        area,
    }
}

/// How long a test waits for the driver to do what it was asked: bounded,
/// and only ever reached by a failure.
const PATIENCE: Duration = Duration::from_secs(20);

impl Driven {
    async fn next(&mut self) -> Call {
        tokio::time::timeout(PATIENCE, self.told.recv())
            .await
            .expect("the tray did nothing")
            .expect("the tray's area went away")
    }

    fn calls(&self) -> Vec<Call> {
        self.area.calls.lock().unwrap().clone()
    }
}

#[tokio::test]
async fn the_icon_follows_the_session_count_and_goes_when_a_client_attaches() {
    // Helm has gone, its sessions still run: the icon shows at once.
    let mut tray = drive(occupied(2, 0, 0), &[]);
    assert_eq!(
        tray.next().await,
        Call::Show("Helm: 2 sessions running on this PC's host".to_owned())
    );

    // The count is kept current.
    tray.occupancy.send_replace(occupied(1, 0, 0));
    assert_eq!(
        tray.next().await,
        Call::Show("Helm: 1 session running on this PC's host".to_owned())
    );

    // Helm attaches again: the icon goes.
    tray.occupancy.send_replace(occupied(1, 0, 1));
    assert_eq!(tray.next().await, Call::Hide);

    // A change that leaves it hidden changes nothing; the next one that
    // shows it is the next call.
    tray.occupancy.send_replace(occupied(3, 0, 1));
    tray.occupancy.send_replace(occupied(3, 0, 0));
    assert_eq!(
        tray.next().await,
        Call::Show("Helm: 3 sessions running on this PC's host".to_owned())
    );
}

#[tokio::test]
async fn a_host_with_a_client_attached_from_the_start_shows_nothing_until_it_leaves() {
    let mut tray = drive(occupied(1, 0, 1), &[]);
    tray.occupancy.send_replace(occupied(1, 0, 0));
    assert_eq!(
        tray.next().await,
        Call::Show("Helm: 1 session running on this PC's host".to_owned())
    );
    assert_eq!(tray.calls().len(), 1, "{:?}", tray.calls());
}

#[tokio::test]
async fn open_helm_starts_the_desktop_that_started_the_host() {
    let mut tray = drive(occupied(1, 0, 0), &[]);
    tray.next().await;
    tray.picks.send(TrayItem::OpenDesktop).unwrap();
    assert_eq!(tray.next().await, Call::Open(desktop()));
    assert_eq!(tray.stops.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn stop_host_asks_with_the_count_and_stops_only_on_agreement() {
    let mut tray = drive(occupied(2, 0, 0), &[false, true]);
    tray.next().await;

    // Cancelled: nothing stops.
    tray.picks.send(TrayItem::StopHost).unwrap();
    assert_eq!(
        tray.next().await,
        Call::Confirm(
            "Stopping this PC's host ends the 2 sessions running in it. Stop it?".to_owned(),
            0
        )
    );

    // Asked again once a session has ended: the count is the one now, and
    // the cancelled answer, acted on before this question, stopped nothing.
    tray.occupancy.send_replace(occupied(1, 0, 0));
    assert_eq!(
        tray.next().await,
        Call::Show("Helm: 1 session running on this PC's host".to_owned())
    );
    tray.picks.send(TrayItem::StopHost).unwrap();
    assert_eq!(
        tray.next().await,
        Call::Confirm(
            "Stopping this PC's host ends the 1 session running in it. Stop it?".to_owned(),
            0
        )
    );

    // Agreed: the host is stopped, once.
    tokio::time::timeout(PATIENCE, tray.stopped.recv())
        .await
        .expect("the host was not stopped")
        .unwrap();
    assert_eq!(tray.stops.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn the_tray_ends_when_the_host_is_no_longer_watched() {
    let tray = drive(occupied(0, 0, 0), &[]);
    let Driven {
        occupancy,
        mut told,
        area,
        ..
    } = tray;
    drop(area);
    // The driver ends, dropping its area and with it the fake's sender.
    drop(occupancy);
    assert!(
        tokio::time::timeout(PATIENCE, told.recv())
            .await
            .expect("the tray did not end")
            .is_none()
    );
}
