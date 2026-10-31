use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use super::*;
use crate::testkit::TestDirs;

fn env(vars: &[(&str, &Path)]) -> UserEnv {
    UserEnv {
        home: None,
        vars: vars
            .iter()
            .map(|(name, value)| (OsString::from(name), value.as_os_str().to_owned()))
            .collect::<BTreeMap<_, _>>(),
    }
}

/// A packaged app's resources folder: `floti` with Node's release folder
/// beside it, laid out as `layout` lays it out.
fn packaged(dirs: &TestDirs, layout: &dyn NodeLayout) -> (PathBuf, PathBuf) {
    let resources = dirs.folder("app resources");
    let exe = resources.join("floti");
    std::fs::write(&exe, "").unwrap();
    let node = layout.binary_in(&resources.join(SHIPPED_FOLDER));
    std::fs::create_dir_all(node.parent().unwrap()).unwrap();
    std::fs::write(&node, "").unwrap();
    (exe, node)
}

#[test]
fn s9_each_os_finds_node_where_its_release_puts_it() {
    let folder = Path::new("resources").join("node");
    assert_eq!(windows::Native.binary_in(&folder), folder.join("node.exe"));
    assert_eq!(
        macos::Native.binary_in(&folder),
        folder.join("bin").join("node")
    );
    assert_eq!(
        linux::Native.binary_in(&folder),
        folder.join("bin").join("node")
    );
}

#[test]
fn s9_a_packaged_host_runs_services_on_the_node_shipped_beside_it() {
    let dirs = TestDirs::new();
    for layout in [
        &windows::Native as &dyn NodeLayout,
        &macos::Native,
        &linux::Native,
    ] {
        let (exe, node) = packaged(&dirs, layout);
        assert_eq!(runtime(&env(&[]), Some(&exe), layout), Some(node));
    }
}

#[test]
fn s9_floti_node_names_the_node_in_place_of_the_shipped_one() {
    let dirs = TestDirs::new();
    let (exe, _) = packaged(&dirs, &Native);
    let named = dirs.folder("my node").join("node");
    assert_eq!(
        runtime(&env(&[(NODE_VAR, &named)]), Some(&exe), &Native),
        Some(named)
    );
    // A relative path names nothing: the shipped one is used.
    let shipped = runtime(&env(&[]), Some(&exe), &Native);
    assert_eq!(
        runtime(&env(&[(NODE_VAR, Path::new("node"))]), Some(&exe), &Native),
        shipped
    );
}

#[test]
fn s9_a_host_with_nothing_beside_it_has_no_node_and_never_looks_on_path() {
    let dirs = TestDirs::new();
    let bare = dirs.folder("bare build");
    let exe = bare.join("floti");
    std::fs::write(&exe, "").unwrap();
    // A Node on PATH is there to be found, and is not.
    let on_path = dirs.folder("on path");
    let found = Native.binary_in(&on_path);
    std::fs::create_dir_all(found.parent().unwrap()).unwrap();
    std::fs::write(&found, "").unwrap();
    assert_eq!(
        runtime(&env(&[("PATH", &on_path)]), Some(&exe), &Native),
        None
    );
    assert_eq!(runtime(&env(&[]), None, &Native), None);
}
