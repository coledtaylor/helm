//! The status a session's program reports about itself: OSC 7501, the
//! Program Status Protocol, read from its output.
//!
//! A report is `ESC ] 7501 ; key=value:key=value ...`, ended by BEL or
//! `ESC \`. The fields are `state` (idle, working, done, blocked, error or
//! clear), `kind` (permission, question or auth, for blocked), `progress`
//! (0 to 100), `id` (empty for the root record), `app`, and `title` and `msg`
//! in base64.
//!
//! [`ProgramStatus`] is the one thing in a session's output the host reads.
//! It looks at nothing but OSC 7501, keeps its place across reads so a report
//! split between two of them is still taken, and only ever reads the bytes:
//! what reaches the screen and the clients is exactly what the program wrote.
//! It answers nothing, a query (`ESC ] 7501 ; ?`) included, and draws no
//! conclusion from screen text.
//!
//! Only the root record (no `id`) is the session's status, kept as the
//! program sent it with its message cut to [`MAX_MESSAGE_CHARS`]; a report
//! with an `id` passes by and is not kept, and `clear` with no `id` removes
//! the status. A report with no state or an unknown one, or that does not
//! parse, is ignored; a field that does not decode is empty.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;

/// Longer than this, counting from the `]`, is no report: the sequence is
/// passed by unread rather than held without limit.
pub const MAX_REPORT: usize = 4096;

/// A program's message is kept to this many characters.
pub const MAX_MESSAGE_CHARS: usize = 200;

/// What the program says it is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReportState {
    Idle,
    Working,
    Done,
    Blocked,
    Error,
    /// Removes the record.
    Clear,
}

impl ReportState {
    fn parse(word: &str) -> Option<Self> {
        Some(match word {
            "idle" => Self::Idle,
            "working" => Self::Working,
            "done" => Self::Done,
            "blocked" => Self::Blocked,
            "error" => Self::Error,
            "clear" => Self::Clear,
            _ => return None,
        })
    }
}

/// What a blocked program waits on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockedKind {
    Permission,
    Question,
    Auth,
}

impl BlockedKind {
    fn parse(word: &str) -> Option<Self> {
        Some(match word {
            "permission" => Self::Permission,
            "question" => Self::Question,
            "auth" => Self::Auth,
            _ => return None,
        })
    }

    /// What it waits on, in words.
    pub fn words(self) -> &'static str {
        match self {
            Self::Permission => "permission prompt",
            Self::Question => "question",
            Self::Auth => "sign-in",
        }
    }
}

/// One report, as the program sent it, its strings decoded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusReport {
    pub state: ReportState,
    pub kind: Option<BlockedKind>,
    pub progress: Option<u8>,
    /// Empty for the root record.
    pub id: String,
    pub app: String,
    pub title: String,
    /// At most [`MAX_MESSAGE_CHARS`] characters.
    pub message: String,
}

impl StatusReport {
    /// The report in `body`, what follows `7501;`, or `None` when it has no
    /// state the protocol knows or does not parse.
    fn parse(body: &[u8]) -> Option<Self> {
        let body = std::str::from_utf8(body).ok()?;
        let mut state = None;
        let mut report = Self {
            state: ReportState::Clear,
            kind: None,
            progress: None,
            id: String::new(),
            app: String::new(),
            title: String::new(),
            message: String::new(),
        };
        for field in body.split(':') {
            let (key, value) = field.split_once('=')?;
            match key {
                "state" => state = Some(ReportState::parse(value)?),
                "kind" => report.kind = BlockedKind::parse(value),
                "progress" => report.progress = value.parse().ok().filter(|p| *p <= 100),
                "id" => value.clone_into(&mut report.id),
                "app" => value.clone_into(&mut report.app),
                "title" => report.title = decoded(value),
                "msg" => report.message = decoded(value).chars().take(MAX_MESSAGE_CHARS).collect(),
                // A field a later version of the protocol adds.
                _ => {}
            }
        }
        report.state = state?;
        Some(report)
    }
}

/// `value` decoded from base64 as text; empty when it does not decode.
fn decoded(value: &str) -> String {
    STANDARD
        .decode(value)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_default()
}

/// The session's status, the latest root report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportedStatus {
    pub report: StatusReport,
    /// When its state word last changed, epoch ms.
    pub since_ms: u64,
}

/// Reads a session's output for its program's reports and keeps the latest
/// root one.
#[derive(Debug, Default)]
pub struct ProgramStatus {
    scanner: Scanner,
    kept: Option<ReportedStatus>,
}

impl ProgramStatus {
    /// Reads `bytes`, the next the program wrote, as of `now_ms`. True when
    /// the kept status changed.
    pub fn feed(&mut self, bytes: &[u8], now_ms: u64) -> bool {
        let mut changed = false;
        let kept = &mut self.kept;
        self.scanner.feed(bytes, |body| {
            if let Some(report) = StatusReport::parse(body) {
                changed |= keep(kept, report, now_ms);
            }
        });
        changed
    }

    /// The latest root report, unless it was cleared.
    pub fn current(&self) -> Option<&ReportedStatus> {
        self.kept.as_ref()
    }
}

/// Keeps `report` in `kept` when it is the root record's. True when that
/// changed what is kept.
fn keep(kept: &mut Option<ReportedStatus>, report: StatusReport, now_ms: u64) -> bool {
    if !report.id.is_empty() {
        return false;
    }
    if report.state == ReportState::Clear {
        return kept.take().is_some();
    }
    let since_ms = match kept {
        Some(last) if last.report.state == report.state => last.since_ms,
        _ => now_ms,
    };
    let next = ReportedStatus { report, since_ms };
    if kept.as_ref() == Some(&next) {
        return false;
    }
    *kept = Some(next);
    true
}

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const CAN: u8 = 0x18;
const SUB: u8 = 0x1a;

/// What opens a report, after `ESC ]`.
const PREFIX: &[u8] = b"7501;";

/// Finds OSC 7501 strings in a byte stream, across reads.
#[derive(Debug, Default)]
struct Scanner {
    state: Scan,
    /// The OSC string read so far, from after the `]`, while it may be a
    /// report.
    body: Vec<u8>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum Scan {
    #[default]
    Ground,
    Escape,
    /// In an OSC string that may be a report.
    Osc,
    /// After an ESC in an OSC string that may be a report.
    OscEscape,
    /// In a string that is no report: another OSC, or one past
    /// [`MAX_REPORT`].
    Skip,
    /// After an ESC in a string that is no report.
    SkipEscape,
}

impl Scanner {
    /// Reads `bytes`, handing `found` the body of each report that ends in
    /// them: what follows `7501;`.
    fn feed(&mut self, bytes: &[u8], mut found: impl FnMut(&[u8])) {
        for &byte in bytes {
            self.state = self.next(byte, &mut found);
        }
    }

    fn next(&mut self, byte: u8, found: &mut impl FnMut(&[u8])) -> Scan {
        match self.state {
            Scan::Ground => {
                if byte == ESC {
                    Scan::Escape
                } else {
                    Scan::Ground
                }
            }
            Scan::Escape => self.escape(byte),
            Scan::Osc => match byte {
                BEL => {
                    self.finish(found);
                    Scan::Ground
                }
                ESC => Scan::OscEscape,
                CAN | SUB => Scan::Ground,
                _ => self.collect(byte),
            },
            Scan::OscEscape => {
                if byte == b'\\' {
                    self.finish(found);
                    Scan::Ground
                } else {
                    // The string was cut off; this ESC starts what follows.
                    self.escape(byte)
                }
            }
            Scan::Skip => match byte {
                BEL | CAN | SUB => Scan::Ground,
                ESC => Scan::SkipEscape,
                _ => Scan::Skip,
            },
            Scan::SkipEscape => {
                if byte == b'\\' {
                    Scan::Ground
                } else {
                    self.escape(byte)
                }
            }
        }
    }

    /// The byte after an ESC.
    fn escape(&mut self, byte: u8) -> Scan {
        match byte {
            b']' => {
                self.body.clear();
                Scan::Osc
            }
            ESC => Scan::Escape,
            _ => Scan::Ground,
        }
    }

    /// One more byte of an OSC string that may be a report.
    fn collect(&mut self, byte: u8) -> Scan {
        self.body.push(byte);
        let read = self.body.len();
        let still_a_report = if read <= PREFIX.len() {
            PREFIX.starts_with(&self.body)
        } else {
            read < MAX_REPORT
        };
        if still_a_report {
            Scan::Osc
        } else {
            self.body.clear();
            Scan::Skip
        }
    }

    fn finish(&mut self, found: &mut impl FnMut(&[u8])) {
        if let Some(body) = self.body.strip_prefix(PREFIX) {
            found(body);
        }
        self.body.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(text: &str) -> String {
        STANDARD.encode(text)
    }

    /// The root reports `bytes` hold, in order, read in one go.
    fn reports(bytes: &[u8]) -> Vec<StatusReport> {
        let mut scanner = Scanner::default();
        let mut found = Vec::new();
        scanner.feed(bytes, |body| found.extend(StatusReport::parse(body)));
        found
    }

    fn kept_after(chunks: &[&[u8]]) -> Option<ReportedStatus> {
        let mut status = ProgramStatus::default();
        for (at, chunk) in chunks.iter().enumerate() {
            status.feed(chunk, at as u64);
        }
        status.current().cloned()
    }

    #[test]
    fn a_report_ended_by_bel_or_st_is_taken_with_its_fields() {
        let bel = format!(
            "\x1b]7501;state=blocked:kind=question:progress=30:app=build:title={}:msg={}\x07",
            b64("Deploy"),
            b64("Go ahead?")
        );
        let found = reports(bel.as_bytes());
        assert_eq!(
            found,
            [StatusReport {
                state: ReportState::Blocked,
                kind: Some(BlockedKind::Question),
                progress: Some(30),
                id: String::new(),
                app: "build".into(),
                title: "Deploy".into(),
                message: "Go ahead?".into(),
            }]
        );
        let st = reports(b"\x1b]7501;state=working\x1b\\");
        assert_eq!(st.len(), 1);
        assert_eq!(st[0].state, ReportState::Working);
    }

    #[test]
    fn a_report_split_across_reads_is_taken_once_its_end_arrives() {
        let whole = b"text \x1b]7501;state=working:app=tool\x1b\\ more";
        for cut in 1..whole.len() {
            let mut status = ProgramStatus::default();
            let first = status.feed(&whole[..cut], 1);
            let second = status.feed(&whole[cut..], 2);
            assert!(first ^ second, "taken once at cut {cut}");
            let kept = status.current().expect("the split report");
            assert_eq!(kept.report.state, ReportState::Working, "cut {cut}");
            assert_eq!(kept.report.app, "tool");
        }
    }

    #[test]
    fn the_latest_root_report_is_the_status_and_its_since_moves_only_with_its_state() {
        let kept = kept_after(&[
            b"\x1b]7501;state=working:progress=10\x07",
            b"\x1b]7501;state=working:progress=60\x07",
        ])
        .unwrap();
        assert_eq!(kept.report.progress, Some(60));
        assert_eq!(kept.since_ms, 0, "the state word did not change");

        let kept = kept_after(&[
            b"\x1b]7501;state=working\x07",
            format!("\x1b]7501;state=error:msg={}\x07", b64("it broke")).as_bytes(),
        ])
        .unwrap();
        assert_eq!(kept.report.state, ReportState::Error);
        assert_eq!(kept.report.message, "it broke");
        assert_eq!(kept.report.kind, None);
        assert_eq!(kept.since_ms, 1);
    }

    #[test]
    fn a_message_is_kept_to_two_hundred_characters() {
        let long = "é".repeat(MAX_MESSAGE_CHARS + 50);
        let report = format!("\x1b]7501;state=error:msg={}\x07", b64(&long));
        let kept = kept_after(&[report.as_bytes()]).unwrap();
        assert_eq!(kept.report.message.chars().count(), MAX_MESSAGE_CHARS);
        assert!(long.starts_with(&kept.report.message));
    }

    #[test]
    fn clear_removes_the_status_and_a_report_with_an_id_is_not_kept() {
        let cleared = kept_after(&[b"\x1b]7501;state=working\x07", b"\x1b]7501;state=clear\x07"]);
        assert_eq!(cleared, None);

        let child = kept_after(&[
            b"\x1b]7501;state=working\x07",
            b"\x1b]7501;state=error:id=step/2\x07",
            b"\x1b]7501;state=clear:id=step/2\x07",
        ])
        .unwrap();
        assert_eq!(child.report.state, ReportState::Working);
    }

    #[test]
    fn an_unknown_state_a_missing_one_or_a_malformed_report_changes_nothing() {
        let mut status = ProgramStatus::default();
        assert!(status.feed(b"\x1b]7501;state=idle\x07", 1));
        for ignored in [
            &b"\x1b]7501;state=sleeping\x07"[..],
            b"\x1b]7501;app=tool\x07",
            b"\x1b]7501;state=working:nonsense\x07",
            b"\x1b]7501;state=work\xffing\x07",
            b"\x1b]7501;?\x1b\\",
            b"\x1b]7501state=working\x07",
            b"\x1b]75010;state=working\x07",
        ] {
            assert!(!status.feed(ignored, 2), "{ignored:?}");
        }
        assert_eq!(status.current().unwrap().report.state, ReportState::Idle);
    }

    #[test]
    fn a_field_that_does_not_decode_is_empty() {
        let found = reports(b"\x1b]7501;state=blocked:kind=dance:progress=140:msg=@@@:title=\x07");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].kind, None);
        assert_eq!(found[0].progress, None);
        assert_eq!(found[0].message, "");
        assert_eq!(found[0].title, "");
        // Base64 of bytes that are no text.
        let not_text = format!(
            "\x1b]7501;state=error:msg={}\x07",
            STANDARD.encode([0xff, 0xfe])
        );
        assert_eq!(reports(not_text.as_bytes())[0].message, "");
    }

    #[test]
    fn a_sequence_longer_than_the_cap_is_dropped_and_what_follows_is_read() {
        let long = format!("\x1b]7501;state=working:app={}\x07", "a".repeat(MAX_REPORT));
        let mut status = ProgramStatus::default();
        assert!(!status.feed(long.as_bytes(), 1));
        assert_eq!(status.current(), None);
        assert!(status.feed(b"\x1b]7501;state=done\x1b\\", 2));
        assert_eq!(status.current().unwrap().report.state, ReportState::Done);
    }

    #[test]
    fn other_sequences_and_cut_off_strings_are_passed_by() {
        let bytes = b"\x1b]0;7501;state=working\x07\
            \x1b]8;;https://example.com/\x1b\\link\x1b]8;;\x1b\\\
            \x1bP7501;state=working\x1b\\\
            \x1b[31m7501;state=error\x1b[0m\
            \x1b]7501;state=working\x18\
            \x1b]7501;state=blocked\x1b]7501;state=idle\x07";
        let found = reports(bytes);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].state, ReportState::Idle);
    }

    #[test]
    fn screen_text_that_looks_like_a_status_changes_nothing() {
        let mut status = ProgramStatus::default();
        assert!(status.feed(b"\x1b]7501;state=idle\x07", 1));
        let text = b"working\r\nWaiting for permission\r\nerror: build failed\r\n\
            state=working 7501;state=blocked ]7501;state=error\x07\r\n";
        assert!(!status.feed(text, 2));
        assert_eq!(status.current().unwrap().report.state, ReportState::Idle);
        assert_eq!(status.current().unwrap().since_ms, 1);
    }
}
