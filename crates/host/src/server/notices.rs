//! The notification the host shows on its own computer when a device
//! attaches to it from another computer: the device's name, its role, and
//! that it came from another computer.
//!
//! It is shown through the OS ([`platform::notice`](crate::platform::notice)),
//! on a thread of its own so the connection is served without waiting for
//! it. Where the computer gives the host no way to show one (no desktop
//! session), the host's log says so once, and every connection is served as
//! before.
//!
//! Only the executable built for use raises a real notification. A test
//! build records what it would show in its data folder instead
//! ([`TEST_NOTICES_FILE`]), one JSON line a notice, so no host a test starts
//! shows one on the computer running the tests.

use std::path::Path;
#[cfg(any(test, feature = "testkit"))]
#[cfg(any(test, feature = "testkit"))]
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use floti_protocol::noise::PublicKey;

use super::audit::clean;
use crate::Error;
use crate::devices::Role;
use crate::platform::notice::{Notice, ShowNotice};

/// The file in a test build's data folder where the notifications its host
/// would have shown are recorded, one JSON line each.
#[cfg(any(test, feature = "testkit"))]
pub const TEST_NOTICES_FILE: &str = "floti-test-notices";

/// What a device attaching from another computer shows: its name, as plain
/// text, in the title, and its role in the host's own sentence.
pub fn attached_notice(name: &str, role: Role) -> Notice {
    Notice {
        title: format!("\"{}\" connected from another computer", clean(name)),
        body: format!(
            "It is paired as {} with this computer's Floti host.",
            role.with_article()
        ),
    }
}

/// How showing a notice went.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Shown {
    /// Shown, or in a test build recorded.
    Done,
    /// The computer gives the host no way to show one.
    Unsupported,
    Failed,
}

/// The host's notifications on its own computer.
pub(crate) struct HostNotices {
    shower: Arc<dyn ShowNotice>,
    /// The host's log has said the computer cannot show them.
    said_unsupported: AtomicBool,
}

impl HostNotices {
    /// The notifications of the host whose data folder is `data`: the OS's,
    /// or in a test build a record of each in [`TEST_NOTICES_FILE`] there.
    pub(crate) fn for_host(data: &Path) -> Self {
        #[cfg(any(test, feature = "testkit"))]
        let shower: Arc<dyn ShowNotice> = Arc::new(Recorded(data.join(TEST_NOTICES_FILE)));
        #[cfg(not(any(test, feature = "testkit")))]
        let shower: Arc<dyn ShowNotice> = {
            let _ = data;
            Arc::new(crate::platform::notice::Native)
        };
        Self::new(shower)
    }

    pub(crate) fn new(shower: Arc<dyn ShowNotice>) -> Self {
        Self {
            shower,
            said_unsupported: AtomicBool::new(false),
        }
    }

    /// Shows that the device `key`, named `name` and paired as `role`, has
    /// just attached from another computer, on a thread of its own.
    pub(crate) fn device_attached_from_away(
        self: &Arc<Self>,
        name: &str,
        role: Role,
        key: &PublicKey,
    ) {
        let notice = attached_notice(name, role);
        let fingerprint = key.fingerprint();
        let notices = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("connection notice".to_owned())
            .spawn(move || {
                notices.show(&notice, &fingerprint);
            });
        if let Err(err) = spawned {
            log_line!(
                "floti host: could not show that device {} connected: {err}",
                key.fingerprint()
            );
        }
    }

    /// Shows `notice`, about the device `fingerprint`, and says in the
    /// host's log when it could not: once for a computer that cannot show
    /// one, each time for any other failure.
    pub(crate) fn show(&self, notice: &Notice, fingerprint: &str) -> Shown {
        match self.shower.show(notice) {
            Ok(()) => Shown::Done,
            Err(err @ Error::Unsupported { .. }) => {
                if !self.said_unsupported.swap(true, Ordering::AcqRel) {
                    log_line!(
                        "floti host: no notification is shown on this computer when a device connects from another one ({err}); the host serves as before"
                    );
                }
                Shown::Unsupported
            }
            Err(err) => {
                log_line!(
                    "floti host: could not show that device {fingerprint} connected from another computer: {err}"
                );
                Shown::Failed
            }
        }
    }
}

/// What a test build's host shows: nothing, with each notice recorded in a
/// file of its data folder for its tests to read.
#[cfg(any(test, feature = "testkit"))]
struct Recorded(PathBuf);

#[cfg(any(test, feature = "testkit"))]
impl ShowNotice for Recorded {
    fn show(&self, notice: &Notice) -> crate::Result<()> {
        use std::io::Write;
        let mut line = serde_json::to_vec(notice)
            .map_err(|err| Error::io("record a notice", std::io::Error::other(err)))?;
        line.push(b'\n');
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.0)
            .and_then(|mut file| file.write_all(&line))
            .map_err(|source| Error::path("record a notice in", &self.0, source))
    }
}

/// Every notice the test build's host over `data` would have shown, in the
/// order it would have.
#[cfg(any(test, feature = "testkit"))]
pub fn recorded_notices(data: &Path) -> Vec<Notice> {
    std::fs::read_to_string(data.join(TEST_NOTICES_FILE))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::platform::notice::Notice;

    /// A computer's way of showing notices, as a test sets it.
    struct Fake {
        answer: fn() -> crate::Result<()>,
        shown: Mutex<Vec<Notice>>,
    }

    impl ShowNotice for Fake {
        fn show(&self, notice: &Notice) -> crate::Result<()> {
            self.shown.lock().unwrap().push(notice.clone());
            (self.answer)()
        }
    }

    fn fake(answer: fn() -> crate::Result<()>) -> Arc<Fake> {
        Arc::new(Fake {
            answer,
            shown: Mutex::new(Vec::new()),
        })
    }

    #[test]
    fn s6_the_notice_names_the_device_as_plain_text_its_role_and_another_computer() {
        let notice = attached_notice("Cole's\u{1b}[31m phone\n<b>", Role::Operator);
        assert_eq!(
            notice.title,
            "\"Cole's[31m phone<b>\" connected from another computer"
        );
        assert_eq!(
            notice.body,
            "It is paired as an operator with this computer's Floti host."
        );
    }

    #[test]
    fn s6_a_computer_with_no_way_to_show_one_says_so_and_the_host_carries_on() {
        let shower = fake(|| Err(Error::unsupported("a notification")));
        let notices = HostNotices::new(Arc::clone(&shower) as Arc<dyn ShowNotice>);
        let notice = attached_notice("a phone", Role::Viewer);
        assert_eq!(notices.show(&notice, "0123"), Shown::Unsupported);
        assert_eq!(notices.show(&notice, "0123"), Shown::Unsupported);
        assert!(notices.said_unsupported.load(Ordering::Acquire));
        assert_eq!(shower.shown.lock().unwrap().len(), 2);

        let working = fake(|| Ok(()));
        let notices = HostNotices::new(Arc::clone(&working) as Arc<dyn ShowNotice>);
        assert_eq!(notices.show(&notice, "0123"), Shown::Done);
        assert_eq!(working.shown.lock().unwrap().as_slice(), [notice]);
    }

    #[test]
    fn s6_a_test_build_records_what_it_would_show_and_shows_nothing() {
        let dirs = crate::testkit::TestDirs::new();
        let notices = HostNotices::for_host(&dirs.data);
        let notice = attached_notice("a phone", Role::Admin);
        assert_eq!(notices.show(&notice, "0123"), Shown::Done);
        assert_eq!(recorded_notices(&dirs.data), vec![notice]);
    }
}
