//! One file, as the file view shows it: its text, how its lines end, and how
//! it stands against the last commit.
//!
//! Read-only by construction: the file view is for reading a file next to
//! the session changing it, and a second writer racing an agent's edits
//! would be the one way this surface could do harm.

use std::path::Path;

use floti_protocol::channels::workspace::{FileChangeState, FileView, LineEnding, Millis};

use super::changes::read_file_changes;
use super::paths::{is_inside_root, relative_slashed};
use crate::config_console::{mtime_ms, normalize, read_file};

/// Past this a file is not read at all: the view says how large it is
/// instead of freezing on a 40 MB log.
pub const FILE_VIEW_MAX_BYTES: u64 = 5 * 1024 * 1024;

/// How the file's lines end; `None` for a file with one line or none.
fn line_endings(text: &str) -> Option<LineEnding> {
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count() - crlf;
    match (crlf, lf) {
        (0, 0) => None,
        (0, _) => Some(LineEnding::Lf),
        (_, 0) => Some(LineEnding::Crlf),
        _ => Some(LineEnding::Mixed),
    }
}

/// `path` under `root`, read for the view.
pub fn read_file_view(root: &Path, path: &Path) -> FileView {
    let base = normalize(root);
    let absolute = normalize(path);
    let empty = FileView {
        root: base.display().to_string(),
        path: absolute.display().to_string(),
        rel_path: relative_slashed(&base, &absolute),
        exists: false,
        size: 0,
        mtime_ms: Millis(0.0),
        binary: false,
        too_large: false,
        content: String::new(),
        eol: None,
        changes: FileChangeState::Unknown {
            reason: "not read".to_owned(),
        },
        error: None,
    };

    if !is_inside_root(&base, &absolute) {
        return FileView {
            error: Some(format!(
                "{} is not inside {}, and Floti reads only inside the project.",
                absolute.display(),
                base.display()
            )),
            ..empty
        };
    }

    let Ok(meta) = std::fs::metadata(&absolute) else {
        // Gone: deleted by the session, or renamed under the tab. Said, not
        // refused, because the tab outlives the file and has to show
        // something.
        return FileView {
            changes: read_file_changes(&absolute),
            ..empty
        };
    };
    if meta.is_dir() {
        return FileView {
            exists: true,
            error: Some("That is a folder, not a file.".to_owned()),
            ..empty
        };
    }

    let changes = read_file_changes(&absolute);
    if meta.len() > FILE_VIEW_MAX_BYTES {
        return FileView {
            exists: true,
            size: meta.len(),
            mtime_ms: mtime_ms(&meta),
            too_large: true,
            changes,
            ..empty
        };
    }

    let read = read_file(&absolute);
    // Line feeds only: a text area turns CRLF into LF in its value, so text
    // handed over with carriage returns would put every offset the editor
    // works out one character further out per line above it. What the file
    // uses is reported in `eol`.
    let (content, eol) = if read.binary {
        (String::new(), None)
    } else {
        (
            read.content.replace("\r\n", "\n"),
            line_endings(&read.content),
        )
    };
    FileView {
        exists: read.exists,
        size: read.size,
        mtime_ms: read.mtime_ms,
        binary: read.binary,
        content,
        eol,
        changes,
        ..empty
    }
}
