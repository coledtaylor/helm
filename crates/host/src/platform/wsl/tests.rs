use std::path::{Path, PathBuf};

use super::*;
use crate::testkit::TestDirs;

fn env_with(vars: &[(&str, &str)]) -> UserEnv {
    let mut env = UserEnv::default();
    for (name, value) in vars {
        env.vars.insert((*name).into(), (*value).into());
    }
    env
}

#[test]
fn a_windows_host_runs_system32s_wsl_or_the_one_floti_wsl_names() {
    let system = windows::Native
        .program(&env_with(&[("SystemRoot", r"C:\Windows")]))
        .expect("Windows has WSL");
    assert_eq!(
        PathBuf::from(system.program),
        Path::new(r"C:\Windows").join("System32").join("wsl.exe")
    );
    let dirs = TestDirs::new();
    let named = dirs.root().join("wsl.exe");
    let named_env = env_with(&[(WSL_VAR, named.to_str().unwrap())]);
    assert_eq!(
        windows::Native.program(&named_env),
        Some(WslProgram::plain(named))
    );
    assert!(!windows::Native.inside(&named_env));
}

#[test]
fn s8_a_host_not_on_windows_has_no_wsl_whatever_floti_wsl_says() {
    let dirs = TestDirs::new();
    let named = dirs.root().join("wsl.exe");
    let env = env_with(&[(WSL_VAR, named.to_str().unwrap())]);
    assert_eq!(macos::Native.program(&env), None);
    assert_eq!(linux::Native.program(&env), None);
}

#[test]
fn linux_is_inside_a_distro_when_wsl_names_it_or_registered_its_interop() {
    let dirs = TestDirs::new();
    let absent = dirs.root().join("no interop");
    assert!(!linux::inside_with(&UserEnv::default(), &absent));
    assert!(linux::inside_with(
        &env_with(&[(DISTRO_NAME_VAR, "Debian")]),
        &absent
    ));
    let interop = dirs.root().join("WSLInterop");
    std::fs::write(&interop, "enabled").unwrap();
    assert!(linux::inside_with(&UserEnv::default(), &interop));
    assert!(!macos::Native.inside(&env_with(&[(DISTRO_NAME_VAR, "Debian")])));
}

#[test]
fn a_distro_name_is_letters_digits_dots_underscores_and_dashes() {
    for name in ["Ubuntu", "Ubuntu-24.04", "my_distro", "Debian"] {
        assert_eq!(distro_name_problem(name), None, "{name}");
    }
    for name in ["", "two words", "a;b", "a&b", "x\"y", "d/e", "%PATH%"] {
        assert!(distro_name_problem(name).is_some(), "{name:?}");
    }
}

#[test]
fn a_distro_is_started_with_its_name_the_line_after_two_dashes_and_utf8_output() {
    let program = WslProgram {
        program: "wsl.exe".into(),
        args: vec!["--fake".into()],
        env: vec![("EXTRA".into(), "1".into())],
    };
    let command = program.in_distro("Debian", "floti keep-awake");
    let args: Vec<_> = command.get_args().collect();
    assert_eq!(
        &args[..4],
        ["--fake", "-d", "Debian", "--"].map(std::ffi::OsStr::new)
    );
    let envs: Vec<_> = command.get_envs().collect();
    assert!(envs.contains(&(
        std::ffi::OsStr::new(UTF8_VAR),
        Some(std::ffi::OsStr::new("1"))
    )));
    assert!(envs.contains(&(
        std::ffi::OsStr::new("EXTRA"),
        Some(std::ffi::OsStr::new("1"))
    )));
}
