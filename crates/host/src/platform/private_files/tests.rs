use std::fs;

use super::*;
use crate::testkit::TestDirs;

/// The names in `folder`, sorted.
fn names(folder: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(folder)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn a_write_then_a_read_gives_back_the_bytes() {
    let dirs = TestDirs::new();
    let path = dirs.folder("data").join("host.key");
    let bytes: Vec<u8> = (0..=255).collect();

    Native.write(&path, &bytes).unwrap();
    assert_eq!(Native.read(&path).unwrap(), Some(bytes));
    assert!(Native.owner_only(&path).unwrap());
}

#[test]
fn a_missing_file_reads_as_missing() {
    let dirs = TestDirs::new();
    let folder = dirs.folder("data");
    assert_eq!(Native.read(&folder.join("host.key")).unwrap(), None);
    assert_eq!(
        Native
            .read(&folder.join("no folder").join("host.key"))
            .unwrap(),
        None
    );
}

#[test]
fn a_read_that_fails_otherwise_is_an_error_not_missing() {
    let dirs = TestDirs::new();
    // A folder where the file should be cannot be read as one.
    let folder = dirs.folder("data/host.key");
    let err = Native.read(&folder).expect_err("a folder is not a file");
    assert!(err.to_string().contains("host.key"), "{err}");
}

#[test]
fn a_replace_swaps_the_whole_file_and_leaves_nothing_beside_it() {
    let dirs = TestDirs::new();
    let folder = dirs.folder("data");
    let path = folder.join("devices.json");

    Native.write(&path, b"a much longer first version").unwrap();
    Native.write(&path, b"second").unwrap();
    assert_eq!(Native.read(&path).unwrap().as_deref(), Some(&b"second"[..]));
    assert!(Native.owner_only(&path).unwrap());
    assert_eq!(names(&folder), ["devices.json"], "no new file left behind");
}

#[test]
fn paths_with_spaces_are_written_and_read() {
    let dirs = TestDirs::new();
    let path = dirs
        .folder("a data folder/keys here")
        .join("device key.bin");

    Native.write(&path, b"key").unwrap();
    assert_eq!(Native.read(&path).unwrap().as_deref(), Some(&b"key"[..]));
    assert!(Native.owner_only(&path).unwrap());
}

#[test]
fn a_write_into_a_missing_folder_fails_and_makes_nothing() {
    let dirs = TestDirs::new();
    let folder = dirs.folder("data");
    let path = folder.join("missing").join("host.key");

    let err = Native
        .write(&path, b"key")
        .expect_err("no folder to write in");
    assert!(err.to_string().contains("host.key"), "{err}");
    assert!(names(&folder).is_empty());
}

#[test]
fn a_write_new_makes_the_file_once_and_never_replaces_it() {
    let dirs = TestDirs::new();
    let folder = dirs.folder("data");
    let path = folder.join("device.key");

    assert!(Native.write_new(&path, b"first").unwrap());
    assert!(!Native.write_new(&path, b"second").unwrap());
    assert_eq!(Native.read(&path).unwrap().as_deref(), Some(&b"first"[..]));
    assert!(Native.owner_only(&path).unwrap());
    assert_eq!(names(&folder), ["device.key"], "no new file left behind");
}

/// A machine whose processes answer as the test says, and any other is gone.
struct Machine(Vec<(u32, Knowable<bool>)>);

impl ProcessTree for Machine {
    fn end_tree(&self, _: u32, _: crate::platform::process_tree::Ending) -> Result<()> {
        Ok(())
    }

    fn is_alive(&self, pid: u32) -> Knowable<bool> {
        self.0
            .iter()
            .find(|(known, _)| *known == pid)
            .map_or(Knowable::Known(false), |(_, alive)| alive.clone())
    }

    fn end_tree_with_this_process(&self) -> Knowable<bool> {
        Knowable::Unknown
    }

    fn tie_tree(&self, _: u32) {}

    fn untie_tree(&self, _: u32) {}
}

#[test]
fn a_new_file_a_gone_process_left_is_swept_and_every_other_file_kept() {
    let dirs = TestDirs::new();
    let folder = dirs.folder("data");
    let this = std::process::id();
    for name in [
        "host.key",
        ".host.key.4001-0.tmp",             // gone: swept
        ".devices.json.4001-3.tmp",         // gone: swept
        ".host.key.4002-0.tmp",             // running: kept
        ".host.key.4003-0.tmp",             // would not say: kept
        &format!(".host.key.{this}-0.tmp"), // this process, writing: kept
        ".other.4001-0.tmp",                // not a name swept here: kept
        ".host.key.4001.tmp",               // not the shape: kept
        ".host.key.x-0.tmp",                // not the shape: kept
    ] {
        fs::write(folder.join(name), b"").unwrap();
    }
    let machine = Machine(vec![
        (4002, Knowable::Known(true)),
        (4003, Knowable::Unknown),
    ]);

    let mut swept: Vec<String> =
        sweep_stale_temps(&folder, &["host.key", "devices.json"], &machine)
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
    swept.sort();
    assert_eq!(swept, [".devices.json.4001-3.tmp", ".host.key.4001-0.tmp"]);
    let mut kept = vec![
        "host.key".to_owned(),
        ".host.key.4002-0.tmp".to_owned(),
        ".host.key.4003-0.tmp".to_owned(),
        format!(".host.key.{this}-0.tmp"),
        ".other.4001-0.tmp".to_owned(),
        ".host.key.4001.tmp".to_owned(),
        ".host.key.x-0.tmp".to_owned(),
    ];
    kept.sort();
    assert_eq!(names(&folder), kept);
}

#[test]
fn a_new_file_refuses_a_name_already_taken() {
    let dirs = TestDirs::new();
    let path = dirs.folder("data").join("taken");
    fs::write(&path, b"someone's").unwrap();

    let err = Native.create_new(&path).expect_err("the name is taken");
    assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
    assert_eq!(fs::read(&path).unwrap(), b"someone's");
}
