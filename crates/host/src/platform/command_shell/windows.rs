//! Windows: PowerShell, `pwsh.exe` where it is found, else `powershell.exe`,
//! started with `-NoLogo -Command`.
//!
//! A `-Command` run exits 1 for any failure and drops a native program's own
//! code, so the line is followed by a check that exits with it: 0 when the
//! last command succeeded, else the native program's code, else 1.

use super::{CommandShell, FindShell, ShellCommand};
use crate::platform::folders::UserEnv;

/// The Windows shell.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

/// What follows the user's line, on a line of its own so that a comment at
/// the end of theirs cannot swallow it.
const EXIT_WITH_THE_LINES_CODE: &str =
    "if ($?) { exit 0 } elseif ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 }";

impl CommandShell for Native {
    fn run_line(&self, _env: &UserEnv, find: FindShell<'_>, line: &str) -> ShellCommand {
        let program = ["pwsh.exe", "powershell.exe"]
            .into_iter()
            .find_map(find)
            // Windows PowerShell is part of Windows, so the system finds it.
            .unwrap_or_else(|| "powershell.exe".into());
        ShellCommand {
            program,
            args: vec![
                "-NoLogo".into(),
                "-Command".into(),
                format!("{line}\n{EXIT_WITH_THE_LINES_CODE}").into(),
            ],
        }
    }

    fn command_line(&self, words: &[String]) -> String {
        let Some((program, arguments)) = words.split_first() else {
            return String::new();
        };
        let mut line = String::new();
        // A quoted program is a string, which only `&` runs.
        if !is_plain(program) {
            line.push_str("& ");
        }
        line.push_str(&quote(program));
        for argument in arguments {
            line.push(' ');
            line.push_str(&quote(argument));
        }
        line
    }
}

/// Words PowerShell reads as themselves. `,` `@` `%` `$` and the rest of what
/// it reads as structure are quoted.
fn is_plain(word: &str) -> bool {
    !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./\\:=+".contains(c))
}

/// One word in single quotes, in which only a quote is special, and PowerShell
/// reads the typographic ones as quotes too: each is doubled.
fn quote(word: &str) -> String {
    if is_plain(word) {
        return word.to_owned();
    }
    let mut quoted = String::with_capacity(word.len() + 2);
    quoted.push('\'');
    for c in word.chars() {
        quoted.push(c);
        if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
            quoted.push(c);
        }
    }
    quoted.push('\'');
    quoted
}
