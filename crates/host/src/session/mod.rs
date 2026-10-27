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

mod env;
mod ledger;
mod live;
mod redraw;
mod screen;

#[cfg(test)]
pub(crate) mod tests;

pub use env::{STRIPPED_ENV, TERMINAL_ENV, session_env};
pub use ledger::{NewSessionRow, SessionId, SessionLedger};
pub use live::{
    Attachment, ClientId, GRACE, Session, SessionExit, SessionHost, SessionOutput, StartSession,
};
pub use screen::{SCROLLBACK_LINES, Screen, TermSize};
