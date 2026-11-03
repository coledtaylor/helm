//! The host's icon in the notification area: a host a desktop started, left
//! running sessions with no window of that desktop attached, shows there
//! with its session count, and offers to open the desktop again or to stop.
//!
//! What the icon shows, its text and what each of its items does are decided
//! here, over whether a desktop started the host and how busy it is
//! ([`shown`], [`on_pick`]). [`run`] follows the host's occupancy and drives
//! the OS's notification area ([`NotificationArea`]) with those decisions.
//! The area itself is the OS's: one file per OS, each defining `Native`. An
//! OS with none answers [`Error::Unsupported`](crate::Error::Unsupported)
//! from `Native::start`, shows nothing, and the host runs as it would have.
//!
//! The icon is drawn by the host, not the desktop: quitting the desktop ends
//! its process, and the icon is for exactly the time after that.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(test)]
mod tests;

#[cfg(target_os = "linux")]
pub use linux::Native;
#[cfg(target_os = "macos")]
pub use macos::Native;
#[cfg(target_os = "windows")]
pub use windows::Native;

use std::sync::Arc;

use tokio::sync::{mpsc, watch};

use crate::server::Occupancy;
use crate::{DesktopCommand, Result};

/// The item in the icon's menu that opens the desktop.
pub const OPEN_LABEL: &str = "Open Helm";
/// The item in the icon's menu that stops the host.
pub const STOP_LABEL: &str = "Stop host";

/// An item in the icon's menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayItem {
    /// Opens the desktop that started the host, which attaches to it.
    OpenDesktop,
    /// Stops the host, once the user agrees to what that ends.
    StopHost,
}

/// The icon as it is shown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayIcon {
    /// The text shown over the icon, at most [`TOOLTIP_MAX`] UTF-16 units.
    pub tooltip: String,
}

/// The longest tooltip any notification area takes, in UTF-16 units and
/// without its terminating nul: Windows's 128 less one.
pub const TOOLTIP_MAX: usize = 127;

/// A yes-or-no question, asked in the OS's own dialog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
    pub title: String,
    pub text: String,
}

/// What picking an item does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// Start the desktop's command.
    Open,
    /// Ask this first, and stop the host only if the user agrees.
    AskThenStop(Question),
}

/// The icon to show, or `None` for none: only for a host a desktop started,
/// only while it runs something, and only while no client is attached. A
/// host with nothing running and no client exits by itself.
pub fn shown(desktop_started: bool, now: Occupancy) -> Option<TrayIcon> {
    if !desktop_started || now.clients > 0 || now.sessions + now.terminals == 0 {
        return None;
    }
    Some(TrayIcon {
        tooltip: format!("Helm: {} on this PC's host", running(now)),
    })
}

/// What picking `item` does, given how busy the host is at that moment.
pub fn on_pick(item: TrayItem, now: Occupancy) -> Step {
    match item {
        TrayItem::OpenDesktop => Step::Open,
        TrayItem::StopHost => Step::AskThenStop(stop_question(now)),
    }
}

/// The question before stopping the host, saying everything stopping ends.
pub fn stop_question(now: Occupancy) -> Question {
    let text = if now.sessions + now.terminals == 0 {
        "Nothing is running in this PC's host. Stop it?".to_owned()
    } else {
        format!(
            "Stopping this PC's host ends the {} running in it. Stop it?",
            what_runs(now)
        )
    };
    Question {
        title: "Stop host".to_owned(),
        text,
    }
}

/// "2 sessions running", with the plain terminals when there are any.
fn running(now: Occupancy) -> String {
    format!("{} running", what_runs(now))
}

/// "2 sessions", "1 session and 1 terminal".
fn what_runs(now: Occupancy) -> String {
    let sessions = count(now.sessions, "session", "sessions");
    match now.terminals {
        0 => sessions,
        n if now.sessions == 0 => count(n, "terminal", "terminals"),
        n => format!("{sessions} and {}", count(n, "terminal", "terminals")),
    }
}

fn count(n: usize, one: &str, many: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {many}")
    }
}

/// Called once with whether the user agreed to a [`Question`].
pub type Answer = Box<dyn FnOnce(bool) + Send>;

/// The OS's notification area, as the host uses it: one icon, shown,
/// changed or taken away, a yes-or-no question, and the desktop opened.
pub trait NotificationArea: Send + Sync {
    /// Shows the icon, or changes it to `icon` when it is shown.
    fn show(&self, icon: &TrayIcon) -> Result<()>;

    /// Takes the icon away; nothing when none is shown.
    fn hide(&self) -> Result<()>;

    /// Asks `question` in the OS's own dialog, without waiting for the
    /// answer: `answer` is called once, from any thread, with whether the
    /// user agreed. A question that could not be asked is not agreed to.
    fn confirm(&self, question: &Question, answer: Answer);

    /// Starts `desktop` on its own, outliving the host, with the host's
    /// environment.
    fn open(&self, desktop: &DesktopCommand) -> Result<()>;
}

/// Shows the icon [`shown`] says for a host a desktop started, as the
/// host's occupancy changes, and answers each item picked from `picks` with
/// what [`on_pick`] says: `stop` stops the host as a plain stop does. Runs
/// until the occupancy is no longer watched or the picks end, and leaves
/// the icon as it last was: whoever stops the host takes it away.
pub async fn run<A: NotificationArea + 'static>(
    area: Arc<A>,
    desktop: DesktopCommand,
    mut occupancy: watch::Receiver<Occupancy>,
    mut picks: mpsc::UnboundedReceiver<TrayItem>,
    stop: impl Fn() + Send + 'static,
) {
    let (answers, mut answered) = mpsc::unbounded_channel::<bool>();
    let mut showing: Option<TrayIcon> = None;
    let mut asking = false;
    let mut said_failure = false;
    let mut follow = |now: Occupancy, showing: &mut Option<TrayIcon>| {
        let want = shown(true, now);
        if want == *showing {
            return;
        }
        let done = match &want {
            Some(icon) => area.show(icon),
            None => area.hide(),
        };
        match done {
            Ok(()) => *showing = want,
            // Said once: an area that will not show the icon now is unlikely
            // to the next time the count moves, and the host runs on either way.
            Err(err) if !said_failure => {
                said_failure = true;
                log_line!("floti host: the notification area: {err}");
            }
            Err(_) => {}
        }
    };
    follow(*occupancy.borrow_and_update(), &mut showing);
    loop {
        tokio::select! {
            // An answer is taken before a pick made after it was given, so a
            // second pick is a second question only once the first is done.
            biased;
            Some(agreed) = answered.recv() => {
                asking = false;
                if agreed {
                    stop();
                }
            }
            changed = occupancy.changed() => {
                if changed.is_err() {
                    return;
                }
                follow(*occupancy.borrow_and_update(), &mut showing);
            }
            pick = picks.recv() => {
                let Some(item) = pick else { return };
                match on_pick(item, *occupancy.borrow()) {
                    Step::Open => {
                        if let Err(err) = area.open(&desktop) {
                            log_line!("floti host: could not open the desktop: {err}");
                        }
                    }
                    // One question at a time: a second pick while it is up
                    // would only stack another dialog on it.
                    Step::AskThenStop(_) if asking => {}
                    Step::AskThenStop(question) => {
                        asking = true;
                        let reply = Reply(Some(answers.clone()));
                        area.confirm(&question, Box::new(move |agreed| reply.send(agreed)));
                    }
                }
            }
        }
    }
}

/// Sends an answer once: what it was, or no when the [`Answer`] holding it
/// is dropped without being called, so a question that went nowhere never
/// leaves the next one waiting.
struct Reply(Option<mpsc::UnboundedSender<bool>>);

impl Reply {
    fn send(mut self, agreed: bool) {
        if let Some(answers) = self.0.take() {
            let _ = answers.send(agreed);
        }
    }
}

impl Drop for Reply {
    fn drop(&mut self) {
        if let Some(answers) = self.0.take() {
            let _ = answers.send(false);
        }
    }
}
