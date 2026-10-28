//! Which paths a note save may write.
//!
//! Saving a note goes through the config console's [`SnapshotWriter`], not
//! beside it: the snapshot before the bytes are touched, the abort when it
//! cannot be taken, the conflict when the file on disk is not the one the
//! editor opened, and the refusal to rewrite what is not text are the
//! guarantees a note wants too. The only thing of its own is this guard.
//!
//! [`SnapshotWriter`]: crate::config_console::SnapshotWriter

use std::path::{Component, Path, PathBuf};

use floti_protocol::channels::workspace::ContentFileKind;

use super::kinds::content_file_kind;
use crate::config_console::{PathGuard, normalize};

/// Folders that are never content, whatever they hold. `repos` matters most:
/// each repository under a harness is a scope of its own, and a save that
/// reached into one through the harness would file its snapshot under the
/// wrong scope.
pub const FORBIDDEN: &[&str] = &[
    "repos",
    "node_modules",
    ".git",
    "out",
    "dist",
    "build",
    "coverage",
    "target",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".cache",
    ".turbo",
];

/// What a path is below a folder: each part of it, compared ignoring case as
/// every known folder is. `None` when it is not below the folder; empty when
/// it is the folder.
pub fn segments_below(base: &Path, path: &Path) -> Option<Vec<String>> {
    let base = normalize(base);
    let path = normalize(path);
    let mut base_parts = base
        .components()
        .filter(|part| !matches!(part, Component::CurDir));
    let mut path_parts = path
        .components()
        .filter(|part| !matches!(part, Component::CurDir));
    for expected in base_parts.by_ref() {
        let found = path_parts.next()?;
        let same = expected
            .as_os_str()
            .to_string_lossy()
            .to_lowercase()
            .trim_end_matches(['/', '\\'])
            == found
                .as_os_str()
                .to_string_lossy()
                .to_lowercase()
                .trim_end_matches(['/', '\\']);
        if !same {
            return None;
        }
    }
    Some(
        path_parts
            .map(|part| part.as_os_str().to_string_lossy().into_owned())
            .collect(),
    )
}

/// `path` spelled from `base` as `base` spells itself, when it lies at or
/// below it.
pub fn rebuilt_below(base: &Path, path: &Path) -> Option<PathBuf> {
    let parts = segments_below(base, path)?;
    Some(
        parts
            .iter()
            .fold(normalize(base), |path, part| path.join(part)),
    )
}

/// The content write guard: inside the scope, under no folder that is not
/// content, and not a binary file.
#[derive(Debug, Clone, Copy, Default)]
pub struct ContentGuard;

impl ContentGuard {
    pub fn check(scope: &Path, path: &Path) -> Result<(), String> {
        if !path.is_absolute() {
            return Err(format!(
                "Refusing to write a relative path: {}",
                path.display()
            ));
        }
        let absolute = normalize(path);
        let base = normalize(scope);
        let segments = match segments_below(&base, &absolute) {
            Some(segments) if !segments.is_empty() => segments,
            _ => {
                return Err(format!(
                    "Refusing to write {}: it is not inside {}.",
                    absolute.display(),
                    base.display()
                ));
            }
        };
        let (name, folders) = segments.split_last().expect("not empty");
        if let Some(segment) = folders
            .iter()
            .find(|segment| FORBIDDEN.contains(&segment.to_lowercase().as_str()))
        {
            return Err(format!(
                "Refusing to write {}: {segment} is not content.",
                absolute.display()
            ));
        }
        // Everything the viewer reads as text it may also save, a script
        // included; bytes it cannot read it will not rewrite.
        if content_file_kind(name) == ContentFileKind::Binary {
            return Err(format!(
                "Refusing to write {}: the content viewer edits text, not binary files.",
                absolute.display()
            ));
        }
        Ok(())
    }
}

impl PathGuard for ContentGuard {
    fn check(&self, scope: &Path, path: &Path) -> Result<(), String> {
        Self::check(scope, path)
    }
}
