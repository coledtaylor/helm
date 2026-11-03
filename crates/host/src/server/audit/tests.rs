use std::fs;

use floti_protocol::channels::devices::{
    AdminOutcome, AuditActor, AuditDevice, AuditEvent, AuditQuery, DeviceRole, PairingEnd,
};
use jiff::Timestamp;

use super::{
    AUDIT_FILE, AUDIT_PAGE, AUDIT_PAGE_MAX, AuditLog, KEPT_AUDIT_LOGS, TEST_AUDIT_LIMIT_MARKER,
};
use crate::platform::private_files::{Native as NativeFiles, PrivateFiles};
use crate::testkit::TestDirs;

fn device(name: &str) -> AuditDevice {
    AuditDevice {
        fingerprint: "0123456789abcdef".to_owned(),
        name: Some(name.to_owned()),
        role: Some(DeviceRole::Operator),
    }
}

fn connected(name: &str) -> AuditEvent {
    AuditEvent::Connected {
        device: device(name),
        away: true,
    }
}

fn at(second: i64) -> Timestamp {
    Timestamp::from_second(1_800_000_000 + second).unwrap()
}

/// Every entry's number, newest first, across every page.
fn numbers(log: &AuditLog) -> Vec<u64> {
    let mut numbers = Vec::new();
    let mut before = None;
    loop {
        let page = log
            .page(&AuditQuery {
                before,
                limit: Some(AUDIT_PAGE_MAX),
            })
            .unwrap();
        numbers.extend(page.entries.iter().map(|entry| entry.number));
        if !page.more {
            return numbers;
        }
        before = page.entries.last().map(|entry| entry.number);
    }
}

#[test]
fn s13_entries_are_numbered_from_one_and_appended_never_rewritten() {
    let dirs = TestDirs::new();
    let log = AuditLog::in_data_folder(&dirs.data);
    assert_eq!(log.append(connected("a phone"), at(0)).unwrap(), 1);
    let first = fs::read(dirs.data.join(AUDIT_FILE)).unwrap();
    assert_eq!(log.append(connected("a laptop"), at(1)).unwrap(), 2);
    let both = fs::read(dirs.data.join(AUDIT_FILE)).unwrap();
    // The first entry's bytes are untouched: the second only follows them.
    assert!(both.starts_with(&first));
    assert_eq!(both.iter().filter(|&&b| b == b'\n').count(), 2);

    let page = log.page(&AuditQuery::default()).unwrap();
    assert_eq!(
        page.entries
            .iter()
            .map(|entry| (entry.number, entry.at.clone()))
            .collect::<Vec<_>>(),
        [(2, at(1).to_string()), (1, at(0).to_string())]
    );
    assert_eq!(page.entries[1].event, connected("a phone"));
    assert!(!page.more);
}

#[test]
fn s13_the_audit_log_is_owner_only_from_the_moment_it_exists() {
    let dirs = TestDirs::new();
    let log = AuditLog::in_data_folder(&dirs.data);
    log.record(connected("a phone"));
    assert!(NativeFiles.owner_only(&dirs.data.join(AUDIT_FILE)).unwrap());
}

#[test]
fn s13_a_reopened_audit_log_carries_on_numbering_after_its_last_entry() {
    let dirs = TestDirs::new();
    let log = AuditLog::in_data_folder(&dirs.data);
    for second in 0..3 {
        log.append(connected("a phone"), at(second)).unwrap();
    }
    drop(log);
    // A host starting again on the same folder.
    let reopened = AuditLog::in_data_folder(&dirs.data);
    assert_eq!(reopened.append(connected("a phone"), at(3)).unwrap(), 4);
    assert_eq!(numbers(&reopened), [4, 3, 2, 1]);
}

#[test]
fn s13_a_line_a_crash_cut_short_is_skipped_and_numbering_carries_on() {
    let dirs = TestDirs::new();
    let log = AuditLog::in_data_folder(&dirs.data);
    log.append(connected("a phone"), at(0)).unwrap();
    drop(log);
    let path = dirs.data.join(AUDIT_FILE);
    let mut text = fs::read(&path).unwrap();
    text.extend_from_slice(b"{\"number\":2,\"at\":");
    fs::write(&path, text).unwrap();
    let reopened = AuditLog::in_data_folder(&dirs.data);
    assert_eq!(reopened.append(connected("a phone"), at(1)).unwrap(), 2);
    assert_eq!(numbers(&reopened), [2, 1]);
}

#[test]
fn s13_the_audit_log_rotates_past_its_limit_and_reads_across_its_files_newest_first() {
    let dirs = TestDirs::new();
    // About two entries a file.
    let one = serde_json::to_vec(&connected("a phone")).unwrap().len() as u64 + 60;
    let log = AuditLog::with_limit(&dirs.data, one * 2);
    for second in 0..30 {
        log.append(connected("a phone"), at(second)).unwrap();
    }
    for n in 1..=KEPT_AUDIT_LOGS {
        assert!(dirs.data.join(format!("{AUDIT_FILE}.{n}")).is_file());
    }
    assert!(
        !dirs
            .data
            .join(format!("{AUDIT_FILE}.{}", KEPT_AUDIT_LOGS + 1))
            .exists()
    );
    let kept = numbers(&log);
    // Newest first, the latest entry at the head, with no gap among those
    // kept: the oldest went with the files past the kept ones.
    assert_eq!(kept[0], 30);
    assert!(kept.windows(2).all(|pair| pair[0] == pair[1] + 1));
    assert!(kept.len() < 30);
    drop(log);
    // Numbering carries on from the newest file even when it is new.
    let reopened = AuditLog::with_limit(&dirs.data, one * 2);
    assert_eq!(reopened.append(connected("a phone"), at(31)).unwrap(), 31);
}

#[test]
fn s13_a_test_build_reads_its_audit_limit_from_its_data_folder() {
    let dirs = TestDirs::new();
    fs::write(dirs.data.join(TEST_AUDIT_LIMIT_MARKER), "10").unwrap();
    let log = AuditLog::in_data_folder(&dirs.data);
    log.append(connected("a phone"), at(0)).unwrap();
    log.append(connected("a phone"), at(1)).unwrap();
    assert!(dirs.data.join(format!("{AUDIT_FILE}.1")).is_file());
    assert_eq!(numbers(&log), [2, 1]);
}

#[test]
fn s13_a_page_holds_fifty_by_default_at_most_two_hundred_and_says_whether_more_remain() {
    let dirs = TestDirs::new();
    let log = AuditLog::in_data_folder(&dirs.data);
    for second in 0..260 {
        log.append(connected("a phone"), at(second)).unwrap();
    }
    let first = log.page(&AuditQuery::default()).unwrap();
    assert_eq!(first.entries.len(), AUDIT_PAGE as usize);
    assert_eq!(first.entries[0].number, 260);
    assert!(first.more);

    let most = log
        .page(&AuditQuery {
            before: None,
            limit: Some(10_000),
        })
        .unwrap();
    assert_eq!(most.entries.len(), AUDIT_PAGE_MAX as usize);

    // `before` is exclusive, and the last page says nothing more remains.
    let last = log
        .page(&AuditQuery {
            before: Some(11),
            limit: Some(50),
        })
        .unwrap();
    assert_eq!(
        last.entries.iter().map(|e| e.number).collect::<Vec<_>>(),
        (1..=10).rev().collect::<Vec<_>>()
    );
    assert!(!last.more);
}

#[test]
fn s13_an_empty_audit_log_reads_as_no_entries() {
    let dirs = TestDirs::new();
    let log = AuditLog::in_data_folder(&dirs.data);
    let page = log.page(&AuditQuery::default()).unwrap();
    assert!(page.entries.is_empty());
    assert!(!page.more);
    assert!(!dirs.data.join(AUDIT_FILE).exists());
}

#[test]
fn s11_a_device_name_is_written_without_its_control_characters() {
    let dirs = TestDirs::new();
    let log = AuditLog::in_data_folder(&dirs.data);
    let actor = AuditActor::Device {
        fingerprint: "ab\ncd".to_owned(),
        name: "evil\u{1b}[2J\r\nname".to_owned(),
    };
    log.append(
        AuditEvent::RoleChanged {
            device: device("a\u{7}phone\n"),
            from: DeviceRole::Operator,
            to: DeviceRole::Viewer,
            by: actor,
            away: false,
        },
        at(0),
    )
    .unwrap();
    log.append(
        AuditEvent::PairingEnded {
            device: device("tab\there"),
            why: PairingEnd::Expired,
        },
        at(1),
    )
    .unwrap();
    let text = fs::read_to_string(dirs.data.join(AUDIT_FILE)).unwrap();
    assert_eq!(text.lines().count(), 2);
    let page = log.page(&AuditQuery::default()).unwrap();
    let AuditEvent::RoleChanged { device, by, .. } = &page.entries[1].event else {
        panic!("a role change: {:?}", page.entries[1]);
    };
    assert_eq!(device.name.as_deref(), Some("aphone"));
    assert_eq!(
        by,
        &AuditActor::Device {
            fingerprint: "abcd".to_owned(),
            name: "evil[2Jname".to_owned(),
        }
    );
    let AuditEvent::PairingEnded { device, .. } = &page.entries[0].event else {
        panic!("a pairing ended: {:?}", page.entries[0]);
    };
    assert_eq!(device.name.as_deref(), Some("tabhere"));
}

#[test]
fn s12_an_entry_holds_only_its_fixed_fields() {
    let dirs = TestDirs::new();
    let log = AuditLog::in_data_folder(&dirs.data);
    log.append(
        AuditEvent::AdminAction {
            channel: "settings:write".to_owned(),
            doing: "Changing the host's settings".to_owned(),
            by: AuditActor::HostShell,
            away: false,
            outcome: AdminOutcome::Done,
        },
        at(0),
    )
    .unwrap();
    let line = fs::read_to_string(dirs.data.join(AUDIT_FILE)).unwrap();
    let value: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
    let mut keys: Vec<_> = value.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["at", "event", "number"]);
    let mut event: Vec<_> = value["event"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    event.sort();
    assert_eq!(event, ["away", "by", "channel", "doing", "kind", "outcome"]);
}
