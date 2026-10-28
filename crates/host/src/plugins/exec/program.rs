//! Finding the program a manifest names, and the environment it runs in.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use crate::platform::launcher::{self, Program, ProgramLauncher};
use crate::plugins::loader::{Inside, resolve_inside};
use crate::session::env::STRIPPED_ENV;

/// Why a program cannot be run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Missing {
    /// No such program on this computer.
    NotFound,
    /// The path the manifest names leaves the plugin folder.
    Outside,
}

/// The file a manifest's `command` names: a path relative to the plugin
/// folder (it has a slash), an absolute path, or a name looked up on `PATH`
/// the way a terminal would.
pub fn find_program(folder: &Path, command: &str) -> Result<PathBuf, Missing> {
    let named = Path::new(command);
    let found = if named.is_absolute() {
        launcher::Native.find(named.as_os_str())
    } else if command.contains(['/', '\\']) {
        match resolve_inside(folder, command) {
            Inside::File(real) => launcher::Native.find(plain(&real).as_os_str()),
            Inside::Outside => return Err(Missing::Outside),
            Inside::Missing => None,
        }
    } else {
        launcher::Native.find(named.as_os_str())
    };
    found.map(|path| plain(&path)).ok_or(Missing::NotFound)
}

/// What to start for `file` with `args`, each reaching the program as one
/// argument, unchanged: a batch file goes through `cmd.exe` with the quoting
/// every batch file the host runs gets.
pub fn launch(file: &Path, args: &[String]) -> Program {
    let args: Vec<OsString> = args.iter().map(OsString::from).collect();
    launcher::Native.resolve(file.as_os_str(), &args)
}

/// `path` without the `\\?\` a resolved Windows path starts with, which
/// `cmd.exe` cannot take as its folder. Any other path is as it was.
pub fn plain(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(share) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{share}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

/// Whether a variable is the host's own, which no program of the user's
/// should inherit: what every session drops, the host's own `FLOTI_`
/// markers, and anything an Electron or Vite toolchain or a `claude` above
/// the host left behind, which would make a `claude` the program starts
/// believe it is a nested session. Names are compared without regard to
/// case, as Windows treats them.
fn is_hosts_own(name: &OsStr) -> bool {
    let upper = name.to_string_lossy().to_ascii_uppercase();
    (STRIPPED_ENV.contains(&upper.as_str()) && upper != "NO_COLOR")
        || ["FLOTI_", "ELECTRON_", "VITE_", "CLAUDE"]
            .iter()
            .any(|prefix| upper.starts_with(prefix))
}

/// What a plugin's program runs with: `inherited` (the user's environment
/// the host has) less what is the host's own, then the manifest's `declared`
/// variables, then what `program` needs to start.
pub fn program_env(
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
    declared: Vec<(String, String)>,
    program: &Program,
) -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = inherited
        .into_iter()
        .filter(|(name, _)| !is_hosts_own(name))
        .collect();
    let extra = declared
        .into_iter()
        .map(|(name, value)| (OsString::from(name), OsString::from(value)))
        .chain(program.env.iter().cloned());
    for (name, value) in extra {
        env.retain(|(existing, _)| !existing.eq_ignore_ascii_case(&name));
        env.push((name, value));
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_resolved_windows_path_loses_its_verbatim_prefix_and_others_stay() {
        assert_eq!(
            plain(Path::new(r"\\?\C:\Users\a b\plugin")),
            PathBuf::from(r"C:\Users\a b\plugin")
        );
        assert_eq!(
            plain(Path::new(r"\\?\UNC\server\share\x")),
            PathBuf::from(r"\\server\share\x")
        );
        assert_eq!(
            plain(Path::new("/home/a/plugin")),
            PathBuf::from("/home/a/plugin")
        );
    }

    #[test]
    fn the_hosts_own_variables_are_dropped_and_declared_ones_win() {
        let pairs = |list: &[(&str, &str)]| -> Vec<(OsString, OsString)> {
            list.iter()
                .map(|(name, value)| (OsString::from(name), OsString::from(value)))
                .collect()
        };
        let program = Program {
            program: "x".into(),
            args: Vec::new(),
            env: pairs(&[("FLOTI_BATCH_LINE", "line")]),
        };
        let env = program_env(
            pairs(&[
                ("PATH", "/bin"),
                ("NO_COLOR", "1"),
                ("CLAUDECODE", "1"),
                ("claude_code_session_id", "s"),
                ("FLOTI_DATA_DIR", "/data"),
                ("ELECTRON_RUN_AS_NODE", "1"),
                ("VITE_DEV_SERVER_URL", "http://x"),
                ("NODE_OPTIONS", "--inspect"),
                ("TOKEN", "old"),
            ]),
            vec![("token".into(), "new".into())],
            &program,
        );
        assert_eq!(
            env,
            pairs(&[
                ("PATH", "/bin"),
                ("NO_COLOR", "1"),
                ("token", "new"),
                ("FLOTI_BATCH_LINE", "line"),
            ])
        );
    }
}
