//! Each OS's layout, the overrides, and that resolving touches nothing.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use super::*;
use crate::platform::socket::{LocalSocket, Native as NativeSocket};
use crate::testkit::TestDirs;

fn env_with(dirs: &TestDirs, vars: &[(&str, &Path)]) -> UserEnv {
    let mut env = dirs.user_env();
    for (name, value) in vars {
        env.vars
            .insert(OsString::from(name), value.as_os_str().to_owned());
    }
    env
}

fn is_empty(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .expect("read a test folder")
        .next()
        .is_none()
}

#[test]
fn windows_data_and_logs_are_in_localappdata_floti() {
    let dirs = TestDirs::new();
    let local = dirs.folder("Local App Data");
    let folders = windows::Native
        .resolve(&env_with(&dirs, &[("LOCALAPPDATA", &local)]))
        .unwrap();
    assert_eq!(folders.data, local.join("Floti"));
    assert_eq!(folders.logs, local.join("Floti").join("logs"));
    assert_eq!(folders.config, dirs.home.join(".config").join("floti"));
}

#[test]
fn windows_without_localappdata_uses_the_profiles_appdata_local() {
    let dirs = TestDirs::new();
    let folders = windows::Native.resolve(&dirs.user_env()).unwrap();
    assert_eq!(
        folders.data,
        dirs.home.join("AppData").join("Local").join("Floti")
    );
}

#[test]
fn macos_data_and_logs_are_in_application_support_floti() {
    let dirs = TestDirs::new();
    let folders = macos::Native.resolve(&dirs.user_env()).unwrap();
    let data = dirs
        .home
        .join("Library")
        .join("Application Support")
        .join("Floti");
    assert_eq!(folders.logs, data.join("logs"));
    assert_eq!(folders.runtime, data.join("run"));
    assert_eq!(folders.data, data);
    assert_eq!(folders.config, dirs.home.join(".config").join("floti"));
}

#[test]
fn linux_defaults_to_local_share_floti_with_logs_in_local_state_floti() {
    let dirs = TestDirs::new();
    let folders = linux::Native.resolve(&dirs.user_env()).unwrap();
    assert_eq!(
        folders.data,
        dirs.home.join(".local").join("share").join("floti")
    );
    assert_eq!(
        folders.logs,
        dirs.home.join(".local").join("state").join("floti")
    );
    assert_eq!(folders.config, dirs.home.join(".config").join("floti"));
    assert_eq!(folders.runtime, folders.data.join("run"));
}

#[test]
fn linux_follows_xdg_data_state_and_runtime_folders() {
    let dirs = TestDirs::new();
    let (data, state, run) = (
        dirs.folder("xdg data"),
        dirs.folder("xdg state"),
        dirs.folder("xdg run"),
    );
    let folders = linux::Native
        .resolve(&env_with(
            &dirs,
            &[
                ("XDG_DATA_HOME", &data),
                ("XDG_STATE_HOME", &state),
                ("XDG_RUNTIME_DIR", &run),
            ],
        ))
        .unwrap();
    assert_eq!(folders.data, data.join("floti"));
    assert_eq!(folders.logs, state.join("floti"));
    assert_eq!(folders.runtime, run.join("floti"));
    assert_eq!(folders.config, dirs.home.join(".config").join("floti"));
}

#[test]
fn linux_ignores_a_relative_xdg_folder() {
    let dirs = TestDirs::new();
    let folders = linux::Native
        .resolve(&env_with(
            &dirs,
            &[("XDG_DATA_HOME", Path::new("relative"))],
        ))
        .unwrap();
    assert_eq!(
        folders.data,
        dirs.home.join(".local").join("share").join("floti")
    );
}

#[test]
fn every_layout_refuses_without_a_home_folder() {
    let env = UserEnv::default();
    let layouts: [&dyn FolderLayout; 3] = [&windows::Native, &macos::Native, &linux::Native];
    for layout in layouts {
        let err = layout.resolve(&env).unwrap_err();
        assert!(err.to_string().contains("home folder"), "{err}");
    }
}

#[test]
fn the_native_layout_is_this_oss() {
    let dirs = TestDirs::new();
    let env = dirs.user_env();
    let expected = match std::env::consts::OS {
        "windows" => windows::Native.resolve(&env),
        "macos" => macos::Native.resolve(&env),
        _ => linux::Native.resolve(&env),
    }
    .unwrap();
    assert_eq!(resolve(&env).unwrap(), expected);
}

#[test]
fn overrides_move_every_folder_and_the_socket_and_touch_nothing_real() {
    let dirs = TestDirs::new();
    let moved = dirs.folder("moved folders");
    let (data, logs, config, run) = (
        moved.join("data"),
        moved.join("logs"),
        moved.join("config"),
        moved.join("run"),
    );
    let env = env_with(
        &dirs,
        &[
            (DATA_DIR_VAR, &data),
            (LOG_DIR_VAR, &logs),
            (CONFIG_DIR_VAR, &config),
            (RUNTIME_DIR_VAR, &run),
        ],
    );

    let folders = resolve(&env).unwrap();
    assert_eq!(
        folders,
        Folders {
            data,
            logs,
            config,
            runtime: run.clone()
        }
    );

    // On macOS and Linux the socket is a file in the runtime folder; on
    // Windows it is a pipe, which has no folder to move.
    let endpoint = NativeSocket.endpoint(&folders.runtime, "host");
    let path = endpoint.as_path();
    assert!(
        path.starts_with(&run) || path.starts_with(r"\\.\pipe\"),
        "the socket is at {}",
        path.display()
    );

    // Resolving creates nothing: neither the moved folders nor anything in
    // the home the layout would have used.
    assert!(is_empty(&moved), "resolving created folders");
    assert!(is_empty(&dirs.home), "resolving touched the home folder");
}

#[test]
fn every_folder_overridden_needs_no_home_folder() {
    let dirs = TestDirs::new();
    let folders = FolderOverrides::under(dirs.root())
        .resolve(&Native, &UserEnv::default())
        .unwrap();
    assert_eq!(folders.data, dirs.root().join("data"));
    assert_eq!(folders.runtime, dirs.root().join("run"));
}

#[test]
fn one_override_moves_only_its_folder() {
    let dirs = TestDirs::new();
    let data = dirs.folder("only data");
    let folders = resolve(&env_with(&dirs, &[(DATA_DIR_VAR, &data)])).unwrap();
    let native = Native.resolve(&dirs.user_env()).unwrap();
    assert_eq!(folders.data, data);
    assert_eq!(folders.logs, native.logs);
    assert_eq!(folders.config, native.config);
    assert_eq!(folders.runtime, native.runtime);
}

#[test]
fn a_relative_override_is_refused_naming_the_variable() {
    let dirs = TestDirs::new();
    let err = resolve(&env_with(&dirs, &[(LOG_DIR_VAR, Path::new("logs here"))])).unwrap_err();
    assert_eq!(
        err.to_string(),
        "FLOTI_LOG_DIR must be an absolute path, and logs here is not."
    );
}

#[test]
fn an_empty_override_is_no_override() {
    let dirs = TestDirs::new();
    let folders = resolve(&env_with(&dirs, &[(DATA_DIR_VAR, &PathBuf::new())])).unwrap();
    assert_eq!(folders, Native.resolve(&dirs.user_env()).unwrap());
}
