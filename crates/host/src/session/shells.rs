//! The shells a plain terminal can run, found on the host's machine.
//!
//! One table of the shells Floti knows how to launch, keyed by file name, and
//! each looked for on `PATH` by that exact name: `pwsh.exe` is only ever found
//! where executables carry `.exe`, and `bash` only where they carry nothing,
//! so the one search answers on every OS without asking which it is. The
//! user's own `$SHELL` comes first where it is set, as their terminal would
//! open it.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use floti_protocol::channels::sessions::DetectedShell;

/// A shell Floti knows how to launch.
struct KnownShell {
    file: &'static str,
    label: &'static str,
    args: &'static [&'static str],
}

/// In the order a picker offers them. The POSIX shells start without `-l`: a
/// login shell sources a profile, which may change to the home folder and
/// defeat the one thing a folder's shell is for. PowerShell's banner is
/// lines of chrome in a short pane, so it starts without it.
const KNOWN_SHELLS: &[KnownShell] = &[
    KnownShell {
        file: "pwsh.exe",
        label: "PowerShell 7",
        args: &["-NoLogo"],
    },
    KnownShell {
        file: "powershell.exe",
        label: "Windows PowerShell",
        args: &["-NoLogo"],
    },
    KnownShell {
        file: "cmd.exe",
        label: "Command Prompt",
        args: &[],
    },
    KnownShell {
        file: "wsl.exe",
        label: "WSL",
        args: &[],
    },
    KnownShell {
        file: "bash.exe",
        label: "Bash",
        args: &[],
    },
    KnownShell {
        file: "bash",
        label: "Bash",
        args: &[],
    },
    KnownShell {
        file: "zsh",
        label: "Zsh",
        args: &[],
    },
    KnownShell {
        file: "fish",
        label: "Fish",
        args: &[],
    },
    KnownShell {
        file: "sh",
        label: "Shell",
        args: &[],
    },
];

fn known(path: &Path) -> Option<&'static KnownShell> {
    let name = path.file_name()?.to_string_lossy().to_lowercase();
    KNOWN_SHELLS.iter().find(|shell| shell.file == name)
}

/// The arguments to launch `program` with. A shell Floti does not know gets
/// none.
pub fn shell_args(program: &Path) -> Vec<OsString> {
    known(program)
        .map(|shell| shell.args.iter().map(OsString::from).collect())
        .unwrap_or_default()
}

/// Every known shell found through `env`, one row per program: `$SHELL`
/// first, then the table's order.
pub fn detect_shells(env: &[(OsString, OsString)]) -> Vec<DetectedShell> {
    let var = |name: &str| {
        env.iter()
            .find(|(key, _)| key.to_string_lossy().eq_ignore_ascii_case(name))
            .map(|(_, value)| value.clone())
    };
    let mut candidates: Vec<PathBuf> = var("SHELL")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .into_iter()
        .collect();
    let path = var("PATH").unwrap_or_default();
    for shell in KNOWN_SHELLS {
        if let Some(found) = on_path(&path, OsStr::new(shell.file)) {
            candidates.push(found);
        }
    }

    let mut programs = Vec::new();
    let mut found = Vec::new();
    for candidate in candidates {
        if !present(&candidate) {
            continue;
        }
        // Where `/bin` links to `/usr/bin`, `$SHELL` and a `PATH` hit can be
        // one file under two names.
        let program = std::fs::canonicalize(&candidate).unwrap_or_else(|_| candidate.clone());
        if programs.contains(&program) {
            continue;
        }
        programs.push(program);
        let name = candidate
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let entry = known(&candidate);
        found.push(DetectedShell {
            path: candidate.to_string_lossy().into_owned(),
            label: entry.map_or_else(|| name.clone(), |shell| shell.label.to_owned()),
            args: entry
                .map(|shell| shell.args.iter().map(|arg| (*arg).to_owned()).collect())
                .unwrap_or_default(),
            name,
        });
    }
    found
}

/// The first `file` in the folders of `path`.
fn on_path(path: &OsStr, file: &OsStr) -> Option<PathBuf> {
    std::env::split_paths(path)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(file))
        .find(|candidate| present(candidate))
}

/// Whether there is a file at `path`, without following it: a launcher stub
/// some installers leave is a link the OS will run and will not let a reader
/// follow.
fn present(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| !meta.is_dir())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::TestDirs;

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "").unwrap();
    }

    #[test]
    fn shells_are_found_on_path_by_their_exact_name_with_shell_first_and_each_program_once() {
        let dirs = TestDirs::new();
        let first = dirs.folder("first bin");
        let second = dirs.folder("second bin");
        touch(&first.join("zsh"));
        touch(&second.join("zsh"));
        touch(&second.join("bash"));
        touch(&second.join("pwsh.exe"));
        let user_shell = second.join("bash");
        let path = std::env::join_paths([&first, &second]).unwrap();
        let env = vec![
            (OsString::from("Path"), path),
            (OsString::from("SHELL"), user_shell.clone().into_os_string()),
        ];

        let shells = detect_shells(&env);
        let paths: Vec<PathBuf> = shells
            .iter()
            .map(|shell| PathBuf::from(&shell.path))
            .collect();
        assert_eq!(
            paths,
            [user_shell, second.join("pwsh.exe"), first.join("zsh")],
            "{shells:?}"
        );
        assert_eq!(shells[0].label, "Bash");
        assert_eq!(shells[1].label, "PowerShell 7");
        assert_eq!(shells[1].args, ["-NoLogo"]);
        assert_eq!(shells[2].name, "zsh");
    }

    #[test]
    fn nothing_on_path_finds_nothing_and_an_unknown_shell_gets_no_arguments() {
        assert!(detect_shells(&[]).is_empty());
        assert!(shell_args(Path::new("/opt/tools/nushell")).is_empty());
        assert_eq!(
            shell_args(Path::new("C:/x/PWSH.EXE")),
            [OsString::from("-NoLogo")]
        );
    }
}
