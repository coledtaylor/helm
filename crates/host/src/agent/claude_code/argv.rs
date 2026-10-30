//! A launch becomes `claude`'s argv.
//!
//! The order is not cosmetic. `--add-dir`, `--mcp-config` and `--allowedTools`
//! are variadic:
//! each takes values until the next argument that starts with a dash.
//! `--plugin-dir` takes one path and is repeated for more. `-n`, or `--resume` for a conversation being reopened, always follows
//! `--add-dir` and always exists, which ends that list; the opening prompt
//! goes last behind `--`, which ends every list, so it can never be taken for
//! one more folder or config file.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use floti_protocol::channels::common::PermissionMode;
use floti_protocol::channels::sessions::EffortLevel;

/// The longest session name passed to `-n`.
const MAX_NAME: usize = 60;

/// What goes into one launch's argv. Empty choices pass no flag.
#[derive(Debug, Default)]
pub(super) struct Argv<'a> {
    pub extra_folders: &'a [PathBuf],
    /// A conversation to reopen; when set, no `-n`, `--session-id` or prompt.
    pub resume: Option<&'a str>,
    pub name: &'a str,
    pub plugin_dirs: &'a [PathBuf],
    pub instructions_file: Option<&'a Path>,
    pub settings_file: Option<&'a Path>,
    pub session_id: Option<&'a str>,
    /// The agent tool registration, already composed.
    pub tool_args: &'a [OsString],
    pub model: Option<&'a str>,
    pub effort: Option<EffortLevel>,
    pub permission_mode: Option<PermissionMode>,
    pub agent: Option<&'a str>,
    pub prompt: Option<&'a str>,
}

pub(super) fn build(argv: &Argv<'_>) -> Vec<OsString> {
    let mut out: Vec<OsString> = Vec::new();
    let mut push = |args: &[&dyn AsRefOs]| out.extend(args.iter().map(|arg| arg.os()));

    let folders = dedupe_paths(argv.extra_folders);
    if !folders.is_empty() {
        push(&[&"--add-dir"]);
        for folder in &folders {
            push(&[folder]);
        }
    }

    // Either one ends the folder list. A reopened conversation keeps the name
    // it already has.
    match argv.resume {
        Some(id) => push(&[&"--resume", &id]),
        None => push(&[&"-n", &sanitize_session_name(argv.name)]),
    }

    for dir in argv.plugin_dirs {
        push(&[&"--plugin-dir", dir]);
    }
    if let Some(file) = argv.instructions_file {
        push(&[&"--append-system-prompt-file", &file]);
    }
    if let Some(file) = argv.settings_file {
        push(&[&"--settings", &file]);
    }
    // Assigning the conversation id rather than discovering it later is what
    // lets the session row and the CLI's own records agree from the start.
    if argv.resume.is_none()
        && let Some(id) = argv.session_id
    {
        push(&[&"--session-id", &id]);
    }
    out.extend(argv.tool_args.iter().cloned());

    let mut push = |args: &[&dyn AsRefOs]| out.extend(args.iter().map(|arg| arg.os()));
    if let Some(model) = argv.model.filter(|model| !model.trim().is_empty()) {
        push(&[&"--model", &model]);
    }
    if let Some(effort) = argv.effort {
        push(&[&"--effort", &effort_name(effort)]);
    }
    if let Some(mode) = argv.permission_mode {
        push(&[&"--permission-mode", &permission_mode_name(mode)]);
    }
    if let Some(agent) = argv.agent.filter(|agent| !agent.trim().is_empty()) {
        push(&[&"--agent", &agent]);
    }

    // Only if it is really there: an empty string here would be a prompt.
    if argv.resume.is_none()
        && let Some(prompt) = argv
            .prompt
            .map(str::trim)
            .filter(|prompt| !prompt.is_empty())
    {
        push(&[&"--", &prompt]);
    }
    out
}

/// `--permission-mode`'s value for `mode`, as the CLI names it.
pub(super) fn permission_mode_name(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::AcceptEdits => "acceptEdits",
        PermissionMode::Auto => "auto",
        PermissionMode::BypassPermissions => "bypassPermissions",
        PermissionMode::Manual => "manual",
        PermissionMode::DontAsk => "dontAsk",
        PermissionMode::Plan => "plan",
    }
}

fn effort_name(effort: EffortLevel) -> &'static str {
    match effort {
        EffortLevel::Low => "low",
        EffortLevel::Medium => "medium",
        EffortLevel::High => "high",
        EffortLevel::Xhigh => "xhigh",
        EffortLevel::Max => "max",
    }
}

/// A name the CLI shows as given: control characters become spaces, runs of
/// space collapse, and it is cut to sixty characters. Nothing left is
/// `session`.
pub fn sanitize_session_name(name: &str) -> String {
    let spaced: String = name
        .chars()
        .map(|c| if is_control(c) { ' ' } else { c })
        .collect();
    let clean = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.is_empty() {
        return "session".to_owned();
    }
    if clean.chars().count() > MAX_NAME {
        return clean
            .chars()
            .take(MAX_NAME)
            .collect::<String>()
            .trim_end()
            .to_owned();
    }
    clean
}

/// `base` made safe, or `base 2`, `base 3`... whichever is free among
/// `taken`, compared without regard to case because a person reads these.
/// A base already at the length cap is shortened to leave room for its
/// number, so a free name is always found.
pub fn unique_session_name<'a>(base: &str, taken: impl IntoIterator<Item = &'a str>) -> String {
    let used: std::collections::HashSet<String> =
        taken.into_iter().map(str::to_lowercase).collect();
    let root = sanitize_session_name(base);
    if !used.contains(&root.to_lowercase()) {
        return root;
    }
    (2..)
        .map(|n| {
            let suffix = format!(" {n}");
            let room = MAX_NAME.saturating_sub(suffix.chars().count());
            let stem: String = if root.chars().count() > room {
                root.chars()
                    .take(room)
                    .collect::<String>()
                    .trim_end()
                    .to_owned()
            } else {
                root.clone()
            };
            format!("{stem}{suffix}")
        })
        .find(|candidate| !used.contains(&candidate.to_lowercase()))
        .expect("some number is free")
}

/// Unicode's "other" category, as far as a name can hold it: control and
/// format characters, and the private and unassigned planes a terminal title
/// cannot show.
fn is_control(c: char) -> bool {
    c.is_control()
        || matches!(c,
            '\u{00AD}' | '\u{0600}'..='\u{0605}' | '\u{061C}' | '\u{06DD}' | '\u{070F}'
            | '\u{180E}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{206F}' | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}' | '\u{E000}'..='\u{F8FF}')
}

/// Unique without regard to case, order kept, each made absolute.
fn dedupe_paths(paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    paths
        .iter()
        .map(|path| std::path::absolute(path).unwrap_or_else(|_| path.clone()))
        .filter(|path| seen.insert(path.to_string_lossy().to_lowercase()))
        .collect()
}

/// Something that becomes one argument.
trait AsRefOs {
    fn os(&self) -> OsString;
}

impl AsRefOs for &str {
    fn os(&self) -> OsString {
        (*self).into()
    }
}

impl AsRefOs for String {
    fn os(&self) -> OsString {
        self.into()
    }
}

impl AsRefOs for PathBuf {
    fn os(&self) -> OsString {
        self.clone().into_os_string()
    }
}

impl AsRefOs for &Path {
    fn os(&self) -> OsString {
        self.as_os_str().to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::{MAX_NAME, unique_session_name};

    #[test]
    fn a_name_is_made_unique_against_the_names_taken_ignoring_case() {
        assert_eq!(unique_session_name("helm", []), "helm");
        assert_eq!(unique_session_name("helm", ["helm"]), "helm 2");
        assert_eq!(
            unique_session_name("helm", ["helm", "helm 2", "helm 3"]),
            "helm 4"
        );
        // The first number free, not one past the highest.
        assert_eq!(unique_session_name("helm", ["helm", "helm 3"]), "helm 2");
        assert_eq!(unique_session_name("Helm", ["helm"]), "Helm 2");
    }

    #[test]
    fn a_long_name_made_unique_stays_within_the_limit() {
        let long = "x".repeat(MAX_NAME);
        let unique = unique_session_name(&long, [long.as_str()]);
        assert!(unique.chars().count() <= MAX_NAME, "{unique}");
        assert!(unique.ends_with(" 2"), "{unique}");
        assert_ne!(unique, long);
    }
}
