//! Setup: for each agent backend with an executable to find, whether it is
//! here, where it came from, the version it reports against the range the
//! backend was tested with, and whether the agent is signed in.
//!
//! Sign-in is the backend's own check ([`SignInCheck`](crate::agent::SignInCheck)),
//! which judges it from a sign-in artefact existing and never opens one; a
//! backend without a check is Unknown. Nothing here reads a credential.
//!
//! An executable the user chose wins over the one the host finds, and one
//! that has since gone is reported rather than quietly replaced: the user
//! chose it, and a found one taking over would show a version they did not
//! pick. A file the user picks is run for its version before it is kept, so
//! a mis-click is a sentence rather than a session that opens and closes.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use floti_protocol::channels::workspace::{
    BackendStatus, ExecutableSource, SetupStatus, TestedRange,
};
use floti_protocol::{BackendId, Knowable};

use crate::agent::{AgentBackend, Version, VersionCheck};
use crate::platform::launcher::{self, ProgramLauncher};

/// What setup found for every backend that has an executable to find, the
/// user's choices in `chosen`.
pub fn setup_status(
    backends: &[std::sync::Arc<dyn AgentBackend>],
    chosen: &BTreeMap<BackendId, String>,
) -> SetupStatus {
    SetupStatus {
        backends: backends
            .iter()
            .filter_map(|backend| {
                let status = backend_status(
                    backend.as_ref(),
                    chosen.get(backend.id()).map(String::as_str),
                )?;
                Some((backend.id().clone(), status))
            })
            .collect(),
    }
}

/// What setup found for `backend`, with `chosen` the executable the user
/// picked for it, if any. `None` for a backend with no executable to find.
pub fn backend_status(backend: &dyn AgentBackend, chosen: Option<&str>) -> Option<BackendStatus> {
    let executable = backend.executable()?;
    let chosen = chosen.map(str::trim).filter(|path| !path.is_empty());

    let mut error = None;
    let mut found: Option<(PathBuf, ExecutableSource)> = None;
    if let Some(chosen) = chosen {
        if Path::new(chosen).is_file() {
            found = Some((PathBuf::from(chosen), ExecutableSource::Setting));
        } else {
            error = Some(format!("The chosen {chosen} is no longer there."));
        }
    }
    if found.is_none() {
        found = executable
            .discovered()
            .map(|path| (path, ExecutableSource::Discovered));
    }

    let version = match &found {
        None => {
            error.get_or_insert_with(|| {
                format!(
                    "{} was not found on PATH or in the usual install folders.",
                    backend.name()
                )
            });
            None
        }
        Some((path, source)) => {
            let version = executable.version(match source {
                ExecutableSource::Setting => Some(path.as_path()),
                ExecutableSource::Discovered => None,
            });
            if version.is_none() {
                error.get_or_insert_with(|| {
                    format!(
                        "{} did not answer `{}`.",
                        path.display(),
                        executable.version_command()
                    )
                });
            }
            version
        }
    };

    let range = backend.tested_range();
    let tested = match (&range, &version) {
        (Some(range), Some(version)) => matches!(range.check(version), VersionCheck::Tested(_)),
        _ => false,
    };
    let config_dir = executable.config_dir();
    let sign_in = backend.sign_in().map(|check| check.signed_in());
    Some(BackendStatus {
        installed: found.is_some() && version.is_some(),
        path: found.as_ref().map(|(path, _)| path.display().to_string()),
        source: found.as_ref().map(|(_, source)| *source),
        semver: version
            .as_deref()
            .and_then(Version::find_in)
            .map(|version| version.to_string()),
        version,
        tested,
        tested_range: range.map_or_else(
            || TestedRange {
                min: String::new(),
                max: String::new(),
            },
            |range| TestedRange {
                min: range.min.to_string(),
                max: range.below.to_string(),
            },
        ),
        config_dir_exists: config_dir.as_deref().is_some_and(Path::is_dir),
        config_dir: config_dir.map(|dir| dir.display().to_string()),
        signed_in: sign_in
            .as_ref()
            .map_or(Knowable::Unknown, |answer| answer.signed_in.clone()),
        sign_in_signal: sign_in.map_or_else(
            || {
                format!(
                    "{} has no way to say whether it is signed in.",
                    backend.name()
                )
            },
            |answer| answer.signal,
        ),
        error,
    })
}

/// Why `path` is not an executable for `backend` to run, or `Ok` when it
/// is: it is a file this user may run, and it answers its version command.
pub fn check_chosen(backend: &dyn AgentBackend, path: &str) -> Result<(), String> {
    let Some(executable) = backend.executable() else {
        return Err(format!("{} has no executable to choose.", backend.name()));
    };
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err("That is not a full path to a file.".to_owned());
    }
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() => {}
        Ok(_) => return Err("That is not a file.".to_owned()),
        Err(_) => return Err("That file could not be read.".to_owned()),
    }
    if launcher::Native.find(path.as_os_str()).is_none() {
        return Err("That file is not executable.".to_owned());
    }
    if executable.version(Some(path)).is_none() {
        return Err(format!(
            "That program did not answer `{}`.",
            executable.version_command()
        ));
    }
    Ok(())
}
