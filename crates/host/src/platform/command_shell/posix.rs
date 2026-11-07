//! What macOS and Linux share: the login shell, `-l -c` and single quotes.

use std::path::PathBuf;

use super::ShellCommand;
use crate::platform::folders::UserEnv;

/// `$SHELL` where it is a full path, otherwise `/bin/sh`, run as a login
/// shell for the one line, as a terminal opened for the user would.
pub(super) fn run_line(env: &UserEnv, line: &str) -> ShellCommand {
    ShellCommand {
        program: env
            .absolute_var("SHELL")
            .unwrap_or_else(|| PathBuf::from("/bin/sh")),
        args: vec!["-l".into(), "-c".into(), line.into()],
    }
}

/// Words that need no quoting.
fn is_plain(word: &str) -> bool {
    !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./:=+,@%".contains(c))
}

/// One word, quoted so the shell reads it back as it is.
fn quote(word: &str) -> String {
    if is_plain(word) {
        word.to_owned()
    } else {
        format!("'{}'", word.replace('\'', "'\\''"))
    }
}

/// `words` as one line of single-quoted words.
pub(super) fn command_line(words: &[String]) -> String {
    words
        .iter()
        .map(|word| quote(word))
        .collect::<Vec<_>>()
        .join(" ")
}
