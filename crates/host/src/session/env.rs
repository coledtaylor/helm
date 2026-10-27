//! The environment every session's program gets, whatever backend runs it.
//!
//! It is the host's own environment with two kinds of change, the rules
//! today's app applies in `packages/desktop/src/main/pty.ts`:
//!
//! - Variables a hosted agent must not inherit are removed. Claude Code
//!   stamps `CLAUDECODE` and `CLAUDE_CODE_*` on every process it spawns; a
//!   host started from inside a session would hand them on, and the hosted
//!   `claude` would decide it is a nested child and stop saving its
//!   transcript. The Electron and Node variables leak from a dev toolchain.
//! - The terminal is advertised as what the client renders: `xterm-256color`
//!   with true colour and hyperlinks, and `NO_COLOR` is dropped. Claude Code
//!   resolves colour depth from `COLORTERM` first, and writes OSC 8 links only
//!   for a terminal that says it takes them.
//!
//! Names are compared without regard to case, because Windows treats them
//! that way and a duplicate that differs only in case would reach the program.

use std::ffi::{OsStr, OsString};

/// Variables removed from every session's environment.
pub const STRIPPED_ENV: &[&str] = &[
    "ELECTRON_RUN_AS_NODE",
    "ELECTRON_RENDERER_URL",
    "ELECTRON_IS_DEV",
    "NODE_OPTIONS",
    "NODE_ENV",
    "VITE_DEV_SERVER_URL",
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_BRIDGE_SESSION_ID",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_PID",
    "NO_COLOR",
];

/// Variables every session gets, replacing any the host had.
pub const TERMINAL_ENV: &[(&str, &str)] = &[
    ("TERM", "xterm-256color"),
    ("COLORTERM", "truecolor"),
    ("FORCE_HYPERLINK", "1"),
];

/// The environment for one session: `inherited` (the host's own) with
/// [`STRIPPED_ENV`] removed and [`TERMINAL_ENV`] set, then the backend's
/// `extra` variables for this launch on top.
pub fn session_env(
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
    extra: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = inherited
        .into_iter()
        .filter(|(name, _)| {
            !STRIPPED_ENV
                .iter()
                .any(|stripped| same_name(name, stripped))
                && !TERMINAL_ENV.iter().any(|(set, _)| same_name(name, set))
        })
        .collect();
    env.extend(
        TERMINAL_ENV
            .iter()
            .map(|(name, value)| (OsString::from(name), OsString::from(value))),
    );
    for (name, value) in extra {
        env.retain(|(existing, _)| !same_name(existing, &name));
        env.push((name, value));
    }
    env
}

fn same_name(a: &OsStr, b: impl AsRef<OsStr>) -> bool {
    a.eq_ignore_ascii_case(b.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(list: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        list.iter()
            .map(|(name, value)| (OsString::from(name), OsString::from(value)))
            .collect()
    }

    fn value<'a>(env: &'a [(OsString, OsString)], name: &str) -> Vec<&'a OsStr> {
        env.iter()
            .filter(|(existing, _)| same_name(existing, name))
            .map(|(_, value)| value.as_os_str())
            .collect()
    }

    #[test]
    fn strips_claude_code_session_variables_and_advertises_the_terminal() {
        let env = session_env(
            pairs(&[
                ("PATH", "/bin"),
                ("CLAUDECODE", "1"),
                ("CLAUDE_CODE_SESSION_ID", "abc"),
                ("claude_pid", "42"),
                ("NODE_OPTIONS", "--inspect"),
                ("NO_COLOR", "1"),
                ("term", "dumb"),
                ("COLORTERM", "no"),
            ]),
            pairs(&[("FLOTI_EXTRA", "yes")]),
        );
        assert_eq!(value(&env, "PATH"), ["/bin"]);
        for gone in [
            "CLAUDECODE",
            "CLAUDE_CODE_SESSION_ID",
            "CLAUDE_PID",
            "NODE_OPTIONS",
            "NO_COLOR",
        ] {
            assert!(value(&env, gone).is_empty(), "{gone} reached the session");
        }
        assert_eq!(value(&env, "TERM"), ["xterm-256color"]);
        assert_eq!(value(&env, "COLORTERM"), ["truecolor"]);
        assert_eq!(value(&env, "FORCE_HYPERLINK"), ["1"]);
        assert_eq!(value(&env, "FLOTI_EXTRA"), ["yes"]);
    }

    #[test]
    fn a_backend_variable_replaces_one_the_host_had() {
        let env = session_env(pairs(&[("Path", "/a")]), pairs(&[("PATH", "/b")]));
        assert_eq!(value(&env, "PATH"), ["/b"]);
    }
}
