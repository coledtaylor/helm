//! Where to point a fresh install, as `packages/core/src/discovery/roots.ts`
//! does. The host only ever suggests: it never scans a folder the user did
//! not choose, and never falls back to the home folder, which would walk a
//! decade of unrelated files on a first run.

use std::path::{Path, PathBuf};

use super::scan::is_harness;
use crate::config_console::normalize;

/// The nearest folder at or above `start` that holds a `harness.yaml`. The
/// host is normally started from inside the harness it serves, so where it
/// runs is the strongest hint there is.
pub fn find_enclosing_harness(start: &Path) -> Option<PathBuf> {
    let mut current = normalize(start);
    loop {
        if is_harness(&current) {
            return Some(current);
        }
        if !current.pop() {
            return None;
        }
    }
}

/// Ordered best guesses for a first-run scan root, each an existing folder
/// and each once ignoring case: the folder holding the harness enclosing
/// `start` (it covers that harness and its siblings), then `.harness` in
/// `home`. Empty is an answer: the client then asks rather than guesses.
pub fn suggest_roots(start: &Path, home: Option<&Path>) -> Vec<String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(enclosing) = find_enclosing_harness(start) {
        candidates.push(
            enclosing
                .parent()
                .map_or_else(|| enclosing.clone(), Path::to_path_buf),
        );
    }
    if let Some(home) = home {
        candidates.push(home.join(".harness"));
    }
    let mut out: Vec<String> = Vec::new();
    for candidate in candidates {
        let normalised = normalize(&candidate).to_string_lossy().into_owned();
        if out
            .iter()
            .any(|existing| existing.to_lowercase() == normalised.to_lowercase())
        {
            continue;
        }
        if std::fs::metadata(&normalised).is_ok_and(|meta| meta.is_dir()) {
            out.push(normalised);
        }
    }
    out
}
