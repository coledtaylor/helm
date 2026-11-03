//! `floti presence [--window <handle>] <reason>`: asks this computer to
//! confirm its user is present (Windows Hello, Touch ID or the account
//! password, [`crate::platform::presence`]), giving `reason`, and says what
//! it answered by its exit status alone ([`PresenceExit`]).
//!
//! The desktop runs it before it tells a host on another computer
//! `devices:presence`, when an admin action there was refused for presence;
//! `--window` names the desktop's window (an `HWND`, in decimal) so the
//! prompt is that window's. Nothing is printed on success; a check that was
//! declined or cannot be made says so on standard error in one line.

use crate::platform::presence::{Presence, PresenceCheck};

/// How `floti presence` ended, which is its exit status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PresenceExit {
    /// The user confirmed it is them.
    Confirmed,
    /// The command line was not `floti presence [--window <handle>] <reason>`.
    Usage,
    /// The user cancelled the check or did not pass it.
    Declined,
    /// This computer has no check Floti can ask.
    Unavailable,
}

impl PresenceExit {
    /// The process's exit status.
    pub fn code(self) -> u8 {
        match self {
            Self::Confirmed => 0,
            Self::Usage => 2,
            Self::Declined => 3,
            Self::Unavailable => 4,
        }
    }
}

/// What to ask: over which window, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ask {
    pub window: Option<isize>,
    pub reason: String,
}

/// What follows `presence`: `[--window <handle>] <reason>`, the reason not
/// blank. `None` for anything else, which is answered with the usage.
pub fn parse(args: &[String]) -> Option<Ask> {
    let (window, rest) = match args {
        [flag, handle, rest @ ..] if flag == "--window" => (Some(handle.parse().ok()?), rest),
        rest => (None, rest),
    };
    match rest {
        [reason] if !reason.trim().is_empty() => Some(Ask {
            window,
            reason: reason.clone(),
        }),
        _ => None,
    }
}

/// Asks `check`, saying a declined or impossible check on `say`, and the
/// status to exit with.
pub fn run_with(check: &impl PresenceCheck, ask: &Ask, say: &mut impl FnMut(&str)) -> PresenceExit {
    match check.confirm(ask.window, &ask.reason) {
        Presence::Confirmed => PresenceExit::Confirmed,
        Presence::Declined => {
            say("floti presence: not confirmed; nothing was asked of the host.");
            PresenceExit::Declined
        }
        Presence::Unavailable(why) => {
            say(&format!(
                "floti presence: presence cannot be confirmed on this computer: {why}."
            ));
            PresenceExit::Unavailable
        }
    }
}

/// Asks this computer's own check, saying what went wrong on standard error.
pub fn run(ask: &Ask) -> PresenceExit {
    run_with(&crate::platform::presence::Native, ask, &mut |line| {
        eprintln!("{line}");
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| (*word).to_owned()).collect()
    }

    /// A check that answers what it was built with, keeping what it was asked.
    struct Answers(Presence, std::cell::RefCell<Vec<(Option<isize>, String)>>);

    impl PresenceCheck for Answers {
        fn confirm(&self, window: Option<isize>, reason: &str) -> Presence {
            self.1.borrow_mut().push((window, reason.to_owned()));
            self.0.clone()
        }
    }

    #[test]
    fn s13_presence_takes_a_reason_and_optionally_the_window_to_ask_over() {
        assert_eq!(
            parse(&args(&["Approve a device on build box"])),
            Some(Ask {
                window: None,
                reason: "Approve a device on build box".to_owned()
            })
        );
        assert_eq!(
            parse(&args(&["--window", "131844", "Revoke a phone"])),
            Some(Ask {
                window: Some(131_844),
                reason: "Revoke a phone".to_owned()
            })
        );
        for bad in [
            &[][..],
            &[" "],
            &["--window", "not a handle", "why"],
            &["--window", "12"],
            &["one", "two"],
        ] {
            assert_eq!(parse(&args(bad)), None, "{bad:?}");
        }
    }

    #[test]
    fn s13_confirmed_declined_and_unavailable_each_exit_with_a_status_of_their_own() {
        let ask = Ask {
            window: Some(7),
            reason: "Approve a device".to_owned(),
        };
        let mut codes = Vec::new();
        for (answer, said) in [
            (Presence::Confirmed, None),
            (
                Presence::Declined,
                Some("floti presence: not confirmed; nothing was asked of the host."),
            ),
            (
                Presence::Unavailable("Windows Hello is not set up for this user".to_owned()),
                Some(
                    "floti presence: presence cannot be confirmed on this computer: Windows Hello is not set up for this user.",
                ),
            ),
        ] {
            let check = Answers(answer, Default::default());
            let mut lines = Vec::new();
            let exit = run_with(&check, &ask, &mut |line| lines.push(line.to_owned()));
            assert_eq!(
                lines,
                said.map(str::to_owned).into_iter().collect::<Vec<_>>()
            );
            assert_eq!(
                check.1.into_inner(),
                [(Some(7), "Approve a device".to_owned())]
            );
            codes.push(exit.code());
        }
        assert_eq!(codes, [0, 3, 4]);
        assert_ne!(PresenceExit::Usage.code(), 0);
    }
}
