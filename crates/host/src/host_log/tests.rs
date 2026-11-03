//! The log's rotation, on a log in a test folder with a small limit, and a
//! stand-in for standard error that counts where it was pointed: these tests
//! never point the test process's own standard error anywhere.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::{HostLog, KEPT_LOGS, LOG_FILE, LOG_LIMIT, TEST_LOG_LIMIT_MARKER, log_limit};
use crate::platform::private_files::{Native as NativeFiles, PrivateFiles};
use crate::platform::standard_error::StandardError;
use crate::testkit::TestDirs;

const LIMIT: u64 = 100;

/// Standard error as these tests see it: how many times it was pointed at a
/// file.
#[derive(Clone, Default)]
struct Pointed(Arc<AtomicUsize>);

impl Pointed {
    fn times(&self) -> usize {
        self.0.load(Ordering::SeqCst)
    }
}

impl StandardError for Pointed {
    fn point_at(&self, _file: &File) -> std::io::Result<()> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

fn numbered(folder: &Path, n: u32) -> PathBuf {
    folder.join(format!("{LOG_FILE}.{n}"))
}

/// What standard error would write: `bytes` appended to the log.
fn write(log: &HostLog, bytes: usize) {
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(log.path())
        .unwrap();
    file.write_all(&vec![b'x'; bytes]).unwrap();
}

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
fn a_new_log_is_made_owner_only_and_standard_error_is_pointed_at_it() {
    let dirs = TestDirs::new();
    let folder = dirs.logs.join("not made yet");
    let pointed = Pointed::default();
    let log = HostLog::open(&folder, LIMIT, pointed.clone()).unwrap();
    assert_eq!(log.path(), folder.join(LOG_FILE));
    assert!(NativeFiles.owner_only(log.path()).unwrap());
    assert_eq!(pointed.times(), 1);
}

#[test]
fn a_log_past_its_limit_at_start_is_rotated_once_the_host_owns_it_keeping_three_older_files() {
    let dirs = TestDirs::new();
    let folder = &dirs.logs;
    fs::write(folder.join(LOG_FILE), "the last run\n".repeat(10)).unwrap();
    for n in 1..=KEPT_LOGS {
        fs::write(numbered(folder, n), format!("rotated {n}\n")).unwrap();
    }
    let pointed = Pointed::default();
    let log = HostLog::open(folder, LIMIT, pointed.clone()).unwrap();

    // Another host may still be writing to it until this one holds its data
    // folder.
    assert!(!log.rotate_if_full().unwrap());
    assert_eq!(pointed.times(), 1);

    assert!(log.own().unwrap());
    assert_eq!(pointed.times(), 2);
    assert_eq!(fs::read_to_string(log.path()).unwrap(), "");
    assert_eq!(
        fs::read_to_string(numbered(folder, 1)).unwrap(),
        "the last run\n".repeat(10)
    );
    assert_eq!(
        fs::read_to_string(numbered(folder, 2)).unwrap(),
        "rotated 1\n"
    );
    assert_eq!(
        fs::read_to_string(numbered(folder, 3)).unwrap(),
        "rotated 2\n"
    );
    assert_eq!(
        names(folder),
        ["host.log", "host.log.1", "host.log.2", "host.log.3"]
    );
}

#[test]
fn writes_past_the_limit_rotate_the_log_and_only_three_older_files_are_kept() {
    let dirs = TestDirs::new();
    let folder = &dirs.logs;
    let pointed = Pointed::default();
    let log = HostLog::open(folder, LIMIT, pointed.clone()).unwrap();
    assert!(!log.own().unwrap());

    write(&log, 60);
    assert!(!log.rotate_if_full().unwrap(), "under the limit");
    for round in 1..=6 {
        write(&log, 60);
        assert!(log.rotate_if_full().unwrap(), "round {round}");
        assert_eq!(fs::metadata(log.path()).unwrap().len(), 0);
        write(&log, 0);
        assert!(!log.rotate_if_full().unwrap(), "round {round}, empty");
        write(&log, 60);
    }
    assert_eq!(pointed.times(), 1 + 6);
    assert_eq!(
        names(folder),
        ["host.log", "host.log.1", "host.log.2", "host.log.3"]
    );
    for n in 1..=KEPT_LOGS {
        let size = fs::metadata(numbered(folder, n)).unwrap().len();
        assert_eq!(size, 120, "host.log.{n}");
    }
}

#[test]
fn a_log_under_its_limit_is_left_as_it_is() {
    let dirs = TestDirs::new();
    fs::write(dirs.logs.join(LOG_FILE), "short\n").unwrap();
    let log = HostLog::open(&dirs.logs, LIMIT, Pointed::default()).unwrap();
    assert!(!log.own().unwrap());
    assert_eq!(fs::read_to_string(log.path()).unwrap(), "short\n");
    assert_eq!(names(&dirs.logs), ["host.log"]);
}

#[test]
fn the_limit_is_five_mebibytes_unless_a_test_build_is_given_one() {
    let dirs = TestDirs::new();
    assert_eq!(log_limit(&dirs.data), LOG_LIMIT);
    assert_eq!(LOG_LIMIT, 5 * 1024 * 1024);
    fs::write(dirs.data.join(TEST_LOG_LIMIT_MARKER), "300").unwrap();
    assert_eq!(log_limit(&dirs.data), 300);
}
