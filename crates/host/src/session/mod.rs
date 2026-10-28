//! Sessions: each one a program in a pty, launched through its agent backend,
//! with its screen kept by an off-screen terminal so a client attaching late
//! draws it as it is. The host keeps the screen and reads nothing in it.
//!
//! - [`SessionHost`] starts sessions and holds the running ones. A session
//!   outlives its clients: it ends when its program exits or the host ends
//!   it.
//! - [`Session`] is one of them: clients attach to it, type into it and
//!   resize it, and it takes the size of the client that typed last.
//! - [`Screen`] is the kept screen, and [`Screen::redraw`] the bytes that
//!   draw it again.
//! - [`session_env`] is the environment every session gets.
//! - [`SessionLedger`] is where a session's row is written, on spawn and
//!   when it ends.
//! - [`ActivityTracker`] joins the host's sessions to their backends' own
//!   records, for what each is doing and every live session on the machine.
//! - [`Terminals`] are plain terminals: a shell in a folder, run the same way
//!   with no row, from the shells [`detect_shells`] finds.

mod activity;
pub(crate) mod env;
mod ledger;
mod live;
mod redraw;
mod screen;
mod shells;
mod terminals;

#[cfg(test)]
pub(crate) mod tests;

pub use activity::{ActivityPass, ActivityTracker, HostedView};
pub use env::{STRIPPED_ENV, TERMINAL_ENV, session_env};
pub use ledger::{NewSessionRow, SessionId, SessionLedger, SessionOrigin};
pub use live::{
    Attachment, ClientId, GRACE, Session, SessionExit, SessionHost, SessionOutput, StartSession,
};
pub use screen::{SCROLLBACK_LINES, Screen, TermSize};
pub use shells::{detect_shells, shell_args};
pub use terminals::{TerminalExit, Terminals};
