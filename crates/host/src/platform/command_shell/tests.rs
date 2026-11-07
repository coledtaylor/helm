use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use super::*;

fn env(vars: &[(&str, &str)]) -> UserEnv {
    UserEnv {
        home: None,
        vars: vars
            .iter()
            .map(|(name, value)| (OsString::from(name), OsString::from(value)))
            .collect::<BTreeMap<_, _>>(),
    }
}

fn words(list: &[&str]) -> Vec<String> {
    list.iter().map(|word| (*word).to_owned()).collect()
}

/// An absolute path on whichever OS runs the test.
fn absolute(name: &str) -> PathBuf {
    std::env::temp_dir().join("a folder").join(name)
}

fn text(args: &[OsString]) -> Vec<String> {
    args.iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect()
}

#[test]
fn windows_runs_powershell_7_where_it_is_found_with_no_logo_and_the_line() {
    let pwsh = absolute("pwsh.exe");
    let found = pwsh.clone();
    let shell = windows::Native.run_line(
        &env(&[]),
        &move |file| (file == "pwsh.exe").then(|| found.clone()),
        "pnpm test",
    );
    assert_eq!(shell.program, pwsh);
    let args = text(&shell.args);
    assert_eq!(&args[..2], ["-NoLogo", "-Command"]);
    assert_eq!(args.len(), 3);
    assert!(args[2].starts_with("pnpm test\n"), "{}", args[2]);
}

#[test]
fn windows_runs_windows_powershell_when_powershell_7_is_not_found() {
    let powershell = absolute("powershell.exe");
    let found = powershell.clone();
    let shell = windows::Native.run_line(
        &env(&[]),
        &move |file| (file == "powershell.exe").then(|| found.clone()),
        "dir",
    );
    assert_eq!(shell.program, powershell);

    // Neither found: the system finds the one that is part of Windows.
    let shell = windows::Native.run_line(&env(&[]), &|_| None, "dir");
    assert_eq!(shell.program, Path::new("powershell.exe"));
}

#[test]
fn windows_exits_with_the_codes_of_the_line_and_a_comment_cannot_swallow_that() {
    let shell = windows::Native.run_line(&env(&[]), &|_| None, "node a.js # all of it");
    let script = text(&shell.args).pop().expect("the script");
    let (line, check) = script.split_once('\n').expect("the check on its own line");
    assert_eq!(line, "node a.js # all of it");
    assert!(check.contains("exit $LASTEXITCODE"), "{check}");
    assert!(check.starts_with("if ($?) { exit 0 }"), "{check}");
}

#[test]
fn windows_quotes_what_powershell_reads_as_structure_and_runs_a_quoted_program_with_the_call_operator()
 {
    assert_eq!(
        windows::Native.command_line(&words(&["pnpm", "test", "--filter=a"])),
        "pnpm test --filter=a"
    );
    assert_eq!(
        windows::Native.command_line(&words(&["C:\\Program Files\\node\\node.exe", "my file.js"])),
        "& 'C:\\Program Files\\node\\node.exe' 'my file.js'"
    );
    assert_eq!(
        windows::Native.command_line(&words(&["echo", "it's", "a,b", "$env:PATH", "", "x;y"])),
        "echo 'it''s' 'a,b' '$env:PATH' '' 'x;y'"
    );
    // PowerShell reads the typographic quotes as quotes too.
    assert_eq!(
        windows::Native.command_line(&words(&["echo", "\u{2018}hi\u{2019}"])),
        "echo '\u{2018}\u{2018}hi\u{2019}\u{2019}'"
    );
    assert_eq!(windows::Native.command_line(&[]), "");
}

#[test]
fn macos_and_linux_run_the_users_login_shell_with_l_c_and_the_line() {
    let shell = absolute("zsh");
    let vars = [("SHELL", shell.to_str().unwrap())];
    for run in [
        macos::Native.run_line(&env(&vars), &|_| None, "pnpm test"),
        linux::Native.run_line(&env(&vars), &|_| None, "pnpm test"),
    ] {
        assert_eq!(run.program, shell);
        assert_eq!(text(&run.args), ["-l", "-c", "pnpm test"]);
    }
}

#[test]
fn macos_and_linux_run_bin_sh_when_shell_is_not_a_full_path() {
    for vars in [&[][..], &[("SHELL", "zsh")][..]] {
        for run in [
            macos::Native.run_line(&env(vars), &|_| None, "ls"),
            linux::Native.run_line(&env(vars), &|_| None, "ls"),
        ] {
            assert_eq!(run.program, Path::new("/bin/sh"));
            assert_eq!(text(&run.args), ["-l", "-c", "ls"]);
        }
    }
}

#[test]
fn macos_and_linux_single_quote_every_word_the_shell_would_read_as_more_than_itself() {
    for native in [
        macos::Native.command_line(&words(&["pnpm", "test", "--filter=a/b"])),
        linux::Native.command_line(&words(&["pnpm", "test", "--filter=a/b"])),
    ] {
        assert_eq!(native, "pnpm test --filter=a/b");
    }
    for line in [
        macos::Native.command_line(&words(&["/my dir/run.sh", "it's", "$HOME", "", "a;b"])),
        linux::Native.command_line(&words(&["/my dir/run.sh", "it's", "$HOME", "", "a;b"])),
    ] {
        assert_eq!(line, "'/my dir/run.sh' 'it'\\''s' '$HOME' '' 'a;b'");
    }
}
