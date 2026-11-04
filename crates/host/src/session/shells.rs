//! The shells a plain terminal can run, found on the host's machine.
//!
//! One table of the shells Floti knows how to launch, keyed by file name, and
//! each looked for on `PATH` by that exact name: `pwsh.exe` is only ever found
//! where executables carry `.exe`, and `bash` only where they carry nothing,
//! so the one search answers on every OS without asking which it is. A shell
//! `PATH` does not have is then looked for in the folders the OS installs
//! shells in that `PATH` can leave out ([`ShellFolders`]): on Windows, the
//! Microsoft Store's app execution aliases. The user's own `$SHELL` comes
//! first where it is set, as their terminal would open it.
//!
//! A path the user types is checked the same way ([`check_shell`]): it is a
//! shell when there is a file there, looked at without following it.

use std::ffi::{OsStr, OsString};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use floti_protocol::channels::sessions::{CheckedShell, DetectedShell};

use crate::platform::folders::UserEnv;
use crate::platform::shell_folders::{self, ShellFolders};

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
    detect_shells_in(env, &shell_folders::Native)
}

/// [`detect_shells`], with each shell `PATH` lacks looked for in the folders
/// `folders` names for `env`.
fn detect_shells_in(
    env: &[(OsString, OsString)],
    folders: &dyn ShellFolders,
) -> Vec<DetectedShell> {
    let user = UserEnv {
        home: None,
        vars: env.iter().cloned().collect(),
    };
    let mut candidates: Vec<PathBuf> = user
        .var_any_case("SHELL")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .into_iter()
        .collect();
    let path_folders: Vec<PathBuf> = user
        .var_any_case("PATH")
        .map(|path| std::env::split_paths(path).collect())
        .unwrap_or_default();
    let other_folders = folders.folders(&user);
    for shell in KNOWN_SHELLS {
        let file = OsStr::new(shell.file);
        if let Some(found) =
            first_in(&path_folders, file).or_else(|| first_in(&other_folders, file))
        {
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
        found.push(described(&candidate));
    }
    found
}

/// The shell at `typed`, a path the user typed or pasted, as the pickers show
/// it, or a sentence saying why it cannot be one. Surrounding blanks and the
/// quotes Windows' "Copy as path" adds are not part of the path.
pub fn check_shell(typed: &str) -> CheckedShell {
    let trimmed = typed.trim();
    let path = Path::new(
        trimmed
            .strip_prefix('"')
            .and_then(|rest| rest.strip_suffix('"'))
            .map_or(trimmed, str::trim),
    );
    match shell_problem(path) {
        None => CheckedShell {
            shell: Some(described(path)),
            problem: None,
        },
        Some(problem) => CheckedShell {
            shell: None,
            problem: Some(problem),
        },
    }
}

/// Why `path` cannot be a shell the host runs, or `None` when it can. Looked
/// at as [`present`] looks, so an app execution alias, which the OS runs and
/// no reader can open, passes.
fn shell_problem(path: &Path) -> Option<String> {
    let shown = path.display();
    if path.as_os_str().is_empty() {
        return Some("Type the full path to a shell.".to_owned());
    }
    if !path.is_absolute() {
        return Some(format!(
            "{shown} is not a full path. Type the whole path to the shell."
        ));
    }
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => Some(format!("{shown} is a folder, not a program.")),
        Ok(_) => None,
        Err(err) if err.kind() == ErrorKind::NotFound => Some(format!("Nothing is at {shown}.")),
        Err(err) => Some(format!("{shown} could not be looked at: {err}.")),
    }
}

/// `path` as the pickers show it: a known shell by its label and with its
/// arguments, any other by its file name and with none.
fn described(path: &Path) -> DetectedShell {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let entry = known(path);
    DetectedShell {
        path: path.to_string_lossy().into_owned(),
        label: entry.map_or_else(|| name.clone(), |shell| shell.label.to_owned()),
        args: entry
            .map(|shell| shell.args.iter().map(|arg| (*arg).to_owned()).collect())
            .unwrap_or_default(),
        name,
    }
}

/// The first `file` in `folders`. A folder that is not there, or is not
/// absolute, is passed over.
fn first_in(folders: &[PathBuf], file: &OsStr) -> Option<PathBuf> {
    folders
        .iter()
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
    use crate::platform::shell_folders::{linux, macos, windows};
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

    /// A Windows machine whose `PATH` has lost the Store's alias folder: it
    /// names a Store version folder that is gone, and System32. PowerShell 7
    /// is installed from the Store, so it is only an alias under
    /// `LOCALAPPDATA`.
    struct StoreMachine {
        _dirs: TestDirs,
        alias: PathBuf,
        system: PathBuf,
        env: Vec<(OsString, OsString)>,
    }

    fn store_machine() -> StoreMachine {
        let dirs = TestDirs::new();
        let local = dirs.folder("App Data Local");
        let alias = local.join("Microsoft").join("WindowsApps").join("pwsh.exe");
        touch(&alias);
        let system = dirs.folder("System32");
        touch(&system.join("powershell.exe"));
        touch(&system.join("cmd.exe"));
        let vanished = dirs
            .root()
            .join("WindowsApps")
            .join("Microsoft.PowerShell_7.3.1.0_x64__8wekyb3d8bbwe");
        let path = std::env::join_paths([&vanished, &system]).unwrap();
        let env = vec![
            (OsString::from("Path"), path),
            (OsString::from("LOCALAPPDATA"), local.into_os_string()),
        ];
        StoreMachine {
            _dirs: dirs,
            alias,
            system,
            env,
        }
    }

    fn paths(shells: &[DetectedShell]) -> Vec<PathBuf> {
        shells
            .iter()
            .map(|shell| PathBuf::from(&shell.path))
            .collect()
    }

    #[test]
    fn windows_finds_powershell_7_from_the_store_off_path_and_offers_it_before_windows_powershell()
    {
        let machine = store_machine();

        let shells = detect_shells_in(&machine.env, &windows::Native);
        assert_eq!(
            paths(&shells),
            [
                machine.alias.clone(),
                machine.system.join("powershell.exe"),
                machine.system.join("cmd.exe"),
            ],
            "{shells:?}"
        );
        assert_eq!(shells[0].name, "pwsh.exe");
        assert_eq!(shells[0].label, "PowerShell 7");
        assert_eq!(shells[0].args, ["-NoLogo"]);
        assert_eq!(shell_args(&machine.alias), [OsString::from("-NoLogo")]);
    }

    #[test]
    fn the_alias_folder_is_searched_after_path_and_only_for_shells_path_lacks() {
        let dirs = TestDirs::new();
        let local = dirs.folder("App Data Local");
        let aliases = local.join("Microsoft").join("WindowsApps");
        touch(&aliases.join("pwsh.exe"));
        touch(&aliases.join("wsl.exe"));
        let installed = dirs.folder("PowerShell 7");
        touch(&installed.join("pwsh.exe"));
        let env = vec![
            (OsString::from("PATH"), installed.clone().into_os_string()),
            (OsString::from("LocalAppData"), local.into_os_string()),
        ];

        let shells = detect_shells_in(&env, &windows::Native);
        assert_eq!(
            paths(&shells),
            [installed.join("pwsh.exe"), aliases.join("wsl.exe")],
            "{shells:?}"
        );
    }

    #[test]
    fn folders_that_are_not_there_are_passed_over() {
        let dirs = TestDirs::new();
        let system = dirs.folder("System32");
        touch(&system.join("cmd.exe"));
        let gone = dirs.root().join("gone");
        let path = std::env::join_paths([&gone, &system]).unwrap();
        let env = vec![
            (OsString::from("PATH"), path),
            (OsString::from("LOCALAPPDATA"), gone.into_os_string()),
        ];

        let shells = detect_shells_in(&env, &windows::Native);
        assert_eq!(paths(&shells), [system.join("cmd.exe")], "{shells:?}");
    }

    #[test]
    fn macos_and_linux_find_only_what_path_has() {
        let machine = store_machine();
        for folders in [&macos::Native as &dyn ShellFolders, &linux::Native] {
            let shells = detect_shells_in(&machine.env, folders);
            assert_eq!(
                paths(&shells),
                [
                    machine.system.join("powershell.exe"),
                    machine.system.join("cmd.exe"),
                ],
                "{shells:?}"
            );
        }
    }

    #[test]
    fn a_typed_path_that_is_there_is_the_shell_the_pickers_show() {
        let machine = store_machine();
        let typed = machine.alias.to_string_lossy().into_owned();

        let checked = check_shell(&typed);
        assert_eq!(checked.problem, None);
        let shell = checked.shell.unwrap();
        assert_eq!(PathBuf::from(&shell.path), machine.alias);
        assert_eq!(shell.label, "PowerShell 7");
        assert_eq!(shell.args, ["-NoLogo"]);

        let pasted = check_shell(&format!("  \"{typed}\" "));
        assert_eq!(pasted.shell.map(|shell| shell.path), Some(typed));

        let other = machine.system.join("nu.exe");
        touch(&other);
        let shell = check_shell(&other.to_string_lossy()).shell.unwrap();
        assert_eq!(
            (shell.name.as_str(), shell.label.as_str()),
            ("nu.exe", "nu.exe")
        );
        assert!(shell.args.is_empty());
    }

    #[test]
    fn a_typed_path_that_is_not_a_shell_is_refused_in_a_sentence() {
        let machine = store_machine();
        let missing = machine.system.join("gone.exe");
        let folder = machine.system.clone();
        let cases = [
            (
                missing.to_string_lossy().into_owned(),
                format!("Nothing is at {}.", missing.display()),
            ),
            (
                folder.to_string_lossy().into_owned(),
                format!("{} is a folder, not a program.", folder.display()),
            ),
            (
                "pwsh.exe".to_owned(),
                "pwsh.exe is not a full path. Type the whole path to the shell.".to_owned(),
            ),
            ("  ".to_owned(), "Type the full path to a shell.".to_owned()),
        ];
        for (typed, sentence) in cases {
            let checked = check_shell(&typed);
            assert_eq!(checked.shell, None, "{typed}");
            assert_eq!(
                checked.problem.as_deref(),
                Some(sentence.as_str()),
                "{typed}"
            );
        }
    }
}
