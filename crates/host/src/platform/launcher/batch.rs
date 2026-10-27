//! The `cmd.exe` line that runs a batch file with an argument list, as text.
//!
//! `cmd.exe` re-parses its command line: unless there are exactly two quotes
//! on it, it strips the first and the last, whatever they were quoting. So
//! the line is not put on `cmd.exe`'s command line at all. It goes in
//! [`LINE_VAR`], and the command line is `/d /c %FLOTI_BATCH_LINE%`, which
//! holds no quote to strip; `cmd.exe` expands the variable once and runs what
//! it holds. `/d` keeps AutoRun commands out.
//!
//! Pure text, compiled on every OS so its rules are tested everywhere; only
//! the Windows launcher uses it.

use std::ffi::OsString;
use std::path::Path;

/// The variable holding the line `cmd.exe` runs.
pub const LINE_VAR: &str = "FLOTI_BATCH_LINE";

/// `cmd.exe`'s arguments: run what [`LINE_VAR`] holds.
pub fn cmd_args() -> Vec<OsString> {
    ["/d", "/c", "%FLOTI_BATCH_LINE%"]
        .into_iter()
        .map(OsString::from)
        .collect()
}

/// Whether `path` is a batch file, which only `cmd.exe` can run.
pub fn is_batch_file(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
}

/// Whether `cmd.exe` would read a character as structure rather than text.
fn is_special(c: char) -> bool {
    c.is_whitespace() || matches!(c, '"' | '&' | '<' | '>' | '(' | ')' | '@' | '^' | '|')
}

/// One argument, quoted so `cmd.exe` hands it to the batch file intact.
///
/// `cmd.exe` does no special-character processing inside quotes, so an `&`
/// reaches the program as an ampersand rather than ending the command. A
/// literal `"` cannot be expressed through `cmd.exe` at all, so it is dropped
/// rather than allowed to end the argument early.
pub fn quote(arg: &str) -> String {
    let clean: String = arg.chars().filter(|&c| c != '"').collect();
    if clean.is_empty() || clean.chars().any(is_special) {
        format!("\"{clean}\"")
    } else {
        clean
    }
}

/// The line that runs `batch_file` with `args`.
pub fn line(batch_file: &Path, args: &[OsString]) -> String {
    std::iter::once(batch_file.as_os_str())
        .chain(args.iter().map(OsString::as_os_str))
        .map(|part| quote(&part.to_string_lossy()))
        .collect::<Vec<_>>()
        .join(" ")
}
