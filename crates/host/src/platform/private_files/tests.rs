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
fn a_new_file_refuses_a_name_already_taken() {
    let dirs = TestDirs::new();
    let path = dirs.folder("data").join("taken");
    fs::write(&path, b"someone's").unwrap();

    let err = Native.create_new(&path).expect_err("the name is taken");
    assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
    assert_eq!(fs::read(&path).unwrap(), b"someone's");
}
