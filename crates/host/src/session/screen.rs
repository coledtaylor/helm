//! The off-screen terminal kept for each session.
//!
//! Every byte the program writes is fed to an `alacritty_terminal` screen, so
//! a client that attaches late is sent the screen as it is
//! ([`Screen::redraw`]) rather than a blank terminal until the next repaint.
//! The host keeps the screen, hands a parent its child's screen as text
//! ([`Screen::text`]), and keeps a command child's last lines at its exit
//! ([`Screen::last_lines`]); it answers no query (its event listener drops
//! every reply) and draws no conclusion from what is on it. A session's
//! status comes from the output stream instead, from the OSC 7501 reports its
//! program writes ([`super::report`]).

use std::time::Duration;

use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte::ansi::{Processor, Timeout};

use super::redraw;

/// Lines of scrollback each screen keeps, as many as a client keeps by
/// default.
pub const SCROLLBACK_LINES: usize = 10_000;

/// A terminal's size in cells.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TermSize {
    pub cols: u16,
    pub rows: u16,
}

impl TermSize {
    /// A size of at least one cell each way.
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            cols: cols.max(1),
            rows: rows.max(1),
        }
    }
}

impl Dimensions for TermSize {
    fn total_lines(&self) -> usize {
        self.screen_lines()
    }

    fn screen_lines(&self) -> usize {
        usize::from(self.rows)
    }

    fn columns(&self) -> usize {
        usize::from(self.cols)
    }
}

/// One session's screen.
pub struct Screen {
    term: Term<VoidListener>,
    parser: Processor<Unsynchronised>,
    boundary: Boundary,
}

impl Screen {
    /// An empty screen of `size`.
    pub fn new(size: TermSize) -> Self {
        let config = Config {
            scrolling_history: SCROLLBACK_LINES,
            ..Config::default()
        };
        Self {
            term: Term::new(config, &size, VoidListener),
            parser: Processor::new(),
            boundary: Boundary::default(),
        }
    }

    /// Applies bytes the program wrote.
    pub fn feed(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.term, bytes);
        self.boundary.feed(bytes);
    }

    pub fn resize(&mut self, size: TermSize) {
        self.term.resize(size);
    }

    pub fn size(&self) -> TermSize {
        TermSize::new(
            u16::try_from(self.term.columns()).unwrap_or(u16::MAX),
            u16::try_from(self.term.screen_lines()).unwrap_or(u16::MAX),
        )
    }

    /// The screen's text, as plain lines with no escape sequence: the lines
    /// of the scrollback `above` the screen (at most, and as many as there
    /// are), then the screen's own. A line that wrapped at the screen's edge
    /// is one line, and each line loses the blanks at its end. While an
    /// alternate screen shows, it is that screen's text, which has no
    /// scrollback.
    pub fn text(&self, above: usize) -> Vec<String> {
        let grid = self.term.grid();
        let columns = grid.columns();
        let top = i32::try_from(above).map_or(grid.topmost_line().0, |above| {
            grid.topmost_line().0.max(-above)
        });
        let mut lines = Vec::new();
        let mut line = String::new();
        for at in top..=grid.bottommost_line().0 {
            let row = &grid[Line(at)];
            for column in 0..columns {
                let cell = &row[Column(column)];
                if cell
                    .flags
                    .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
                {
                    continue;
                }
                line.push(cell.c);
                for combining in cell.zerowidth().into_iter().flatten() {
                    line.push(*combining);
                }
            }
            if !row[Column(columns - 1)].flags.contains(Flags::WRAPLINE) {
                lines.push(line.trim_end().to_owned());
                line.clear();
            }
        }
        if !line.is_empty() {
            lines.push(line.trim_end().to_owned());
        }
        lines
    }

    /// The last `count` lines of text there are (scrollback and screen), none
    /// of them blank at the end: what a program printed last, not the empty
    /// rows under it.
    pub fn last_lines(&self, count: usize) -> Vec<String> {
        let mut lines = self.text(usize::MAX);
        while lines.last().is_some_and(String::is_empty) {
            lines.pop();
        }
        let from = lines.len().saturating_sub(count);
        lines.split_off(from)
    }

    /// Terminal bytes that, written into an empty terminal of this size,
    /// draw this screen cell for cell with the cursor in place, followed by
    /// the start of any escape sequence the program has not finished
    /// writing, so the live output that follows completes it.
    ///
    /// It takes `&mut self` only to read the primary screen while the
    /// alternate one is showing; the screen is left as it was.
    pub fn redraw(&mut self) -> Vec<u8> {
        let mut bytes = redraw::redraw(&mut self.term);
        bytes.extend_from_slice(self.boundary.unfinished());
        bytes
    }

    #[cfg(test)]
    pub(crate) fn term(&self) -> &Term<VoidListener> {
        &self.term
    }

    #[cfg(test)]
    pub(crate) fn term_mut(&mut self) -> &mut Term<VoidListener> {
        &mut self.term
    }
}

/// Applies a synchronized update (`CSI ? 2026 h`) as it arrives instead of
/// holding it back until it ends. A client attaching mid-update is then sent
/// everything the program wrote: what the screen shows, plus the rest live.
/// A client renders its own updates in sync; the host draws nothing.
#[derive(Debug, Default)]
struct Unsynchronised;

impl Timeout for Unsynchronised {
    fn set_timeout(&mut self, _duration: Duration) {}

    fn clear_timeout(&mut self) {}

    fn pending_timeout(&self) -> bool {
        false
    }
}

/// Where the output stands relative to escape sequences and UTF-8
/// characters, kept so a redraw can hand a client the start of one the
/// program has not finished writing: the screen has not applied it yet, and
/// the live output carries only its end.
///
/// It tracks sequence boundaries only, the way a terminal's parser does, and
/// keeps nothing of what a sequence says.
#[derive(Debug, Default)]
struct Boundary {
    state: State,
    unfinished: Vec<u8>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum State {
    #[default]
    Ground,
    /// Inside a UTF-8 character, with this many bytes to come.
    Utf8(u8),
    Escape,
    EscapeIntermediate,
    Csi,
    /// An OSC, DCS, SOS, PM or APC string, ended by BEL or `ESC \`.
    String,
}

/// More than this is no escape sequence a terminal would keep; past it the
/// start is dropped rather than held without limit.
const MAX_UNFINISHED: usize = 1 << 20;

const ESC: u8 = 0x1b;
const CAN: u8 = 0x18;
const SUB: u8 = 0x1a;
const BEL: u8 = 0x07;

impl Boundary {
    fn feed(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.state = next(self.state, byte);
            if self.state == State::Ground || self.unfinished.len() >= MAX_UNFINISHED {
                self.unfinished.clear();
            } else {
                self.unfinished.push(byte);
            }
        }
    }

    fn unfinished(&self) -> &[u8] {
        &self.unfinished
    }
}

fn next(state: State, byte: u8) -> State {
    match state {
        State::Ground => match byte {
            ESC => State::Escape,
            0xc2..=0xdf => State::Utf8(1),
            0xe0..=0xef => State::Utf8(2),
            0xf0..=0xf4 => State::Utf8(3),
            _ => State::Ground,
        },
        State::Utf8(left) => match byte {
            0x80..=0xbf if left > 1 => State::Utf8(left - 1),
            0x80..=0xbf => State::Ground,
            // A broken character ends there; this byte starts afresh.
            _ => next(State::Ground, byte),
        },
        State::Escape => match byte {
            b'[' => State::Csi,
            b']' | b'P' | b'X' | b'^' | b'_' => State::String,
            0x20..=0x2f => State::EscapeIntermediate,
            CAN | SUB => State::Ground,
            ESC => State::Escape,
            // Other controls run inside a sequence without ending it.
            0x00..=0x1f => State::Escape,
            _ => State::Ground,
        },
        State::EscapeIntermediate => match byte {
            0x30..=0x7e | CAN | SUB => State::Ground,
            ESC => State::Escape,
            _ => State::EscapeIntermediate,
        },
        State::Csi => match byte {
            0x40..=0x7e | CAN | SUB => State::Ground,
            ESC => State::Escape,
            _ => State::Csi,
        },
        State::String => match byte {
            BEL | CAN | SUB => State::Ground,
            // `ESC \` ends the string: `\` is a final byte in Escape.
            ESC => State::Escape,
            _ => State::String,
        },
    }
}

#[cfg(test)]
mod boundary_tests {
    use super::*;

    fn unfinished(bytes: &[u8]) -> Vec<u8> {
        let mut boundary = Boundary::default();
        boundary.feed(bytes);
        boundary.unfinished
    }

    #[test]
    fn keeps_only_the_start_of_an_unfinished_sequence() {
        assert_eq!(unfinished(b"plain text"), b"");
        assert_eq!(unfinished(b"a\x1b[31mb\x1b[3"), b"\x1b[3");
        assert_eq!(unfinished(b"\x1b]8;;http://x"), b"\x1b]8;;http://x");
        assert_eq!(unfinished(b"\x1b]0;title\x07"), b"");
        assert_eq!(unfinished(b"\x1b]0;title\x1b\\"), b"");
        assert_eq!(unfinished(b"\x1b("), b"\x1b(");
        assert_eq!(unfinished(b"\x1b(B"), b"");
        assert_eq!(unfinished("é".as_bytes()), b"");
        assert_eq!(unfinished(&"é".as_bytes()[..1]), &"é".as_bytes()[..1]);
        assert_eq!(unfinished(&"€".as_bytes()[..2]), &"€".as_bytes()[..2]);
        assert_eq!(unfinished(b"\x1b[3\x18"), b"");
    }
}

#[cfg(test)]
mod text_tests {
    use super::*;

    fn fed(cols: u16, rows: u16, written: &str) -> Screen {
        let mut screen = Screen::new(TermSize::new(cols, rows));
        screen.feed(written.as_bytes());
        screen
    }

    #[test]
    fn the_text_is_the_screens_lines_with_no_escape_sequence_and_no_blanks_at_their_ends() {
        let screen = fed(20, 4, "\x1b[31mred\x1b[0m  text\r\nsecond\r\n");
        assert_eq!(screen.text(0), ["red  text", "second", "", ""]);
    }

    #[test]
    fn a_line_that_wrapped_at_the_edge_is_one_line() {
        let screen = fed(5, 4, "abcdefghij\r\nk");
        // Four rows, the first two of them one line.
        assert_eq!(screen.text(0), ["abcdefghij", "k", ""]);
    }

    #[test]
    fn the_text_reaches_up_into_the_scrollback_by_as_many_lines_as_asked() {
        let written: String = (1..=10).map(|n| format!("line {n}\r\n")).collect();
        let screen = fed(20, 3, &written);
        assert_eq!(screen.text(0), ["line 9", "line 10", ""]);
        assert_eq!(
            screen.text(2),
            ["line 7", "line 8", "line 9", "line 10", ""]
        );
        assert_eq!(screen.text(usize::MAX).len(), 11);
        assert_eq!(screen.text(usize::MAX)[0], "line 1");
    }

    #[test]
    fn wide_characters_and_combining_marks_are_one_character_each() {
        let screen = fed(10, 2, "a\u{4e2d}b e\u{301}\r\n");
        assert_eq!(screen.text(0)[0], "a\u{4e2d}b e\u{301}");
    }

    #[test]
    fn the_last_lines_are_what_was_printed_last_without_the_empty_rows_under_it() {
        let written: String = (1..=60).map(|n| format!("line {n}\r\n")).collect();
        let last = fed(80, 24, &written).last_lines(40);
        assert_eq!(last.len(), 40);
        assert_eq!(last.first().map(String::as_str), Some("line 21"));
        assert_eq!(last.last().map(String::as_str), Some("line 60"));
        assert_eq!(
            fed(80, 24, "two\r\nlines\r\n").last_lines(40),
            ["two", "lines"]
        );
        assert!(fed(80, 24, "").last_lines(40).is_empty());
    }
}
