//! Where Floti keeps its own data, its logs, the user's own files and the
//! socket's folder.
//!
//! What Floti keeps for itself lives in `%LOCALAPPDATA%\Floti` on Windows,
//! `~/Library/Application Support/Floti` on macOS and `$XDG_DATA_HOME/floti`
//! (default `~/.local/share/floti`) on Linux, with logs in
//! `~/.local/state/floti` there. What the user writes lives in
//! `~/.config/floti` on every OS.
//!
//! Each OS's layout is plain path arithmetic over a [`UserEnv`], so all three
//! are compiled and tested on every OS; the build picks one as [`Native`].
//! Resolving touches nothing on disk: whoever uses a folder creates it.
//!
//! [`resolve`] applies the overrides first. `FLOTI_DATA_DIR`,
//! `FLOTI_LOG_DIR`, `FLOTI_CONFIG_DIR` and `FLOTI_RUNTIME_DIR` each move one
//! folder, and the socket moves with the runtime folder. Tests use them so
//! nothing reaches the real folders.

pub mod linux;
pub mod macos;
pub mod windows;

#[cfg(target_os = "linux")]
pub use linux::Native;
#[cfg(target_os = "macos")]
pub use macos::Native;
#[cfg(target_os = "windows")]
pub use windows::Native;

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::{Error, Result};

#[cfg(test)]
mod tests;

/// Every folder the host uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Folders {
    /// What Floti keeps for itself: `floti.db`, installed plugins, keys.
    pub data: PathBuf,
    /// The host's logs.
    pub logs: PathBuf,
    /// What the user writes: templates, plugins they are developing.
    pub config: PathBuf,
    /// The folder the socket lives in, where the socket is a file. Windows
    /// names a pipe instead and does not use it.
    pub runtime: PathBuf,
}

/// What resolving the folders may read: the home folder and the environment.
/// Taken as a value so a test resolves against a home of its own and never
/// the real one.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UserEnv {
    pub home: Option<PathBuf>,
    pub vars: BTreeMap<OsString, OsString>,
}

impl UserEnv {
    /// This process's home folder and environment.
    pub fn from_process() -> Self {
        Self {
            home: std::env::home_dir(),
            vars: std::env::vars_os().collect(),
        }
    }

    /// A variable, when it is set and not empty.
    pub fn var(&self, name: &str) -> Option<&OsString> {
        self.vars
            .get(&OsString::from(name))
            .filter(|value| !value.is_empty())
    }

    /// A variable whose name is matched ignoring case, when it is set and not
    /// empty. Windows names are case-insensitive and its environment block
    /// spells some its own way (`ComSpec`), so a Windows variable is looked
    /// up with this.
    pub fn var_any_case(&self, name: &str) -> Option<&OsString> {
        self.var(name).or_else(|| {
            self.vars
                .iter()
                .find(|(key, value)| {
                    !value.is_empty() && key.eq_ignore_ascii_case(OsString::from(name))
                })
                .map(|(_, value)| value)
        })
    }

    /// A variable that names a folder, when it is set to an absolute path.
    /// The XDG base directory rules say a relative one is ignored.
    pub fn absolute_var(&self, name: &str) -> Option<PathBuf> {
        self.var(name)
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
    }

    /// The home folder, or a refusal saying the host cannot place its folders
    /// without one.
    pub fn require_home(&self) -> Result<&Path> {
        self.home.as_deref().ok_or_else(|| {
            Error::Refused(
                "Floti cannot find your home folder, so it does not know where to keep its data."
                    .to_owned(),
            )
        })
    }
}

/// The OS's places for each of Floti's folders.
pub trait FolderLayout {
    /// The folders for the user `env` describes.
    fn resolve(&self, env: &UserEnv) -> Result<Folders>;
}

/// The user's own files, on every OS: `~/.config/floti`, beside today's
/// `~/.config/helm`.
pub fn config_folder(home: &Path) -> PathBuf {
    home.join(".config").join("floti")
}

/// The variables that move one folder each.
pub const DATA_DIR_VAR: &str = "FLOTI_DATA_DIR";
pub const LOG_DIR_VAR: &str = "FLOTI_LOG_DIR";
pub const CONFIG_DIR_VAR: &str = "FLOTI_CONFIG_DIR";
pub const RUNTIME_DIR_VAR: &str = "FLOTI_RUNTIME_DIR";

/// Folders moved away from where the OS's layout puts them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FolderOverrides {
    pub data: Option<PathBuf>,
    pub logs: Option<PathBuf>,
    pub config: Option<PathBuf>,
    pub runtime: Option<PathBuf>,
}

impl FolderOverrides {
    /// The overrides `env` sets. A relative path is refused rather than read
    /// against whatever folder the host happened to start in.
    pub fn from_env(env: &UserEnv) -> Result<Self> {
        let read = |name: &str| -> Result<Option<PathBuf>> {
            match env.var(name).map(PathBuf::from) {
                Some(path) if !path.is_absolute() => Err(Error::Refused(format!(
                    "{name} must be an absolute path, and {} is not.",
                    path.display()
                ))),
                other => Ok(other),
            }
        };
        Ok(Self {
            data: read(DATA_DIR_VAR)?,
            logs: read(LOG_DIR_VAR)?,
            config: read(CONFIG_DIR_VAR)?,
            runtime: read(RUNTIME_DIR_VAR)?,
        })
    }

    /// Every folder in its own subfolder of `root`.
    pub fn under(root: &Path) -> Self {
        Self {
            data: Some(root.join("data")),
            logs: Some(root.join("logs")),
            config: Some(root.join("config")),
            runtime: Some(root.join("run")),
        }
    }

    /// The folders, when every one is overridden and the layout has nothing
    /// left to say.
    fn complete(&self) -> Option<Folders> {
        Some(Folders {
            data: self.data.clone()?,
            logs: self.logs.clone()?,
            config: self.config.clone()?,
            runtime: self.runtime.clone()?,
        })
    }

    /// `folders` with each overridden folder replaced.
    fn apply(self, folders: Folders) -> Folders {
        Folders {
            data: self.data.unwrap_or(folders.data),
            logs: self.logs.unwrap_or(folders.logs),
            config: self.config.unwrap_or(folders.config),
            runtime: self.runtime.unwrap_or(folders.runtime),
        }
    }

    /// The folders `layout` gives for `env`, with these overrides applied.
    /// When every folder is overridden the layout is not consulted, so a
    /// user with no home folder still resolves.
    pub fn resolve(self, layout: &impl FolderLayout, env: &UserEnv) -> Result<Folders> {
        match self.complete() {
            Some(folders) => Ok(folders),
            None => Ok(self.apply(layout.resolve(env)?)),
        }
    }
}

/// The host's folders for the user `env` describes: this OS's layout, with
/// the `FLOTI_*_DIR` overrides `env` sets.
pub fn resolve(env: &UserEnv) -> Result<Folders> {
    FolderOverrides::from_env(env)?.resolve(&Native, env)
}
