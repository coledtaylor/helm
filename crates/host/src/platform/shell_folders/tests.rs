use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::Path;

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

/// An absolute folder on whichever OS runs the test.
fn local_app_data() -> String {
    std::env::temp_dir()
        .join("a user")
        .join("AppData")
        .join("Local")
        .to_string_lossy()
        .into_owned()
}

#[test]
fn windows_looks_in_the_store_aliases_under_local_app_data_however_the_name_is_spelled() {
    let local = local_app_data();
    let expected = vec![Path::new(&local).join("Microsoft").join("WindowsApps")];
    assert_eq!(
        windows::Native.folders(&env(&[("LOCALAPPDATA", &local)])),
        expected
    );
    assert_eq!(
        windows::Native.folders(&env(&[("LocalAppData", &local)])),
        expected
    );
}

#[test]
fn windows_without_an_absolute_local_app_data_looks_nowhere_else() {
    assert!(windows::Native.folders(&env(&[])).is_empty());
    assert!(
        windows::Native
            .folders(&env(&[("LOCALAPPDATA", "AppData/Local")]))
            .is_empty()
    );
}

#[test]
fn macos_and_linux_look_nowhere_but_path() {
    let vars = env(&[("LOCALAPPDATA", &local_app_data())]);
    assert!(macos::Native.folders(&vars).is_empty());
    assert!(linux::Native.folders(&vars).is_empty());
}
