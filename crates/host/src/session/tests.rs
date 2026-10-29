//! Sessions, tested with the fake agent in real ptys, and the kept screen's
//! redraw tested cell for cell.

use std::ffi::OsString;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use alacritty_terminal::grid::{Dimensions, Grid};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::TermMode;
use alacritty_terminal::term::cell::{Cell, Hyperlink};
use floti_protocol::Knowable;
use tokio::sync::mpsc::error::TryRecvError;

use super::live::end_after_grace;
use super::redraw::primary_grid;
use super::*;
use crate::agent::{AgentBackend, LaunchFolder, LaunchRequest};
use crate::platform::process_tree::{Native, ProcessTree};
use crate::store::Store;
use crate::testkit::{FakeAgent, FakeAgentBackend, PATIENCE, TestDirs};

const A: ClientId = ClientId(1);
const B: ClientId = ClientId(2);

/// The fake agent built beside this test binary. `cargo nextest run` and
/// `cargo test` build it for `floti-host`, because the crate has integration
/// tests.
pub(crate) fn fake_agent_exe() -> PathBuf {
    let exe = std::env::current_exe().expect("find the test binary");
    let dir = exe
        .parent()
        .and_then(Path::parent)
        .expect("the test binary is in <target>/<profile>/deps");
    let path = dir.join(format!("floti-fake-agent{}", std::env::consts::EXE_SUFFIX));
    assert!(
        path.is_file(),
        "{} is missing: build it with `cargo build -p floti-host --bin floti-fake-agent`, which `cargo nextest run -p floti-host` and `cargo test -p floti-host` do",
        path.display()
    );
    path
}

// ---------------------------------------------------------------------------
// The kept screen, redrawn cell for cell
// ---------------------------------------------------------------------------

/// How hyperlink ids are compared.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Links {
    /// Ids match exactly: `replay` was drawn from `host`'s redraw alone.
    Exact,
    /// A link written without an id gets one made up by each terminal that
    /// parses it (`<n>_alacritty`), so two terminals that each parsed the
    /// same anonymous link match by its address.
    SameAddress,
}

/// Asserts that `replay` shows what `host` shows: every cell of the primary
/// screen and its scrollback, the alternate screen when it is showing, both
/// cursors, the pen, the modes and the palette.
fn assert_same_screen(host: &mut Screen, replay: &mut Screen) {
    assert_same_screen_with(host, replay, Links::SameAddress);
}

fn assert_same_screen_with(host: &mut Screen, replay: &mut Screen, links: Links) {
    assert_eq!(host.size(), replay.size(), "size");
    let host_primary = primary_grid(host.term_mut());
    let replay_primary = primary_grid(replay.term_mut());
    assert_same_grid(&host_primary, &replay_primary, "primary screen", links);
    let (host_term, replay_term) = (host.term(), replay.term());
    assert_eq!(host_term.mode(), replay_term.mode(), "modes");
    if host_term.mode().contains(TermMode::ALT_SCREEN) {
        assert_same_grid(
            host_term.grid(),
            replay_term.grid(),
            "alternate screen",
            links,
        );
    }
    assert_eq!(
        host_term.cursor_style(),
        replay_term.cursor_style(),
        "cursor style"
    );
    for index in 0..269 {
        assert_eq!(
            host_term.colors()[index],
            replay_term.colors()[index],
            "palette entry {index}"
        );
    }
}

fn comparable(cell: &Cell, links: Links) -> Cell {
    let mut cell = cell.clone();
    if links == Links::SameAddress
        && let Some(link) = cell.hyperlink()
        && link.id().ends_with("_alacritty")
    {
        cell.set_hyperlink(Some(Hyperlink::new(Some("made up"), link.uri().to_owned())));
    }
    cell
}

fn assert_same_grid(host: &Grid<Cell>, replay: &Grid<Cell>, what: &str, links: Links) {
    assert_eq!(
        host.history_size(),
        replay.history_size(),
        "{what}: scrollback lines"
    );
    for line in host.topmost_line().0..=host.bottommost_line().0 {
        for col in 0..host.columns() {
            let at = (Line(line), Column(col));
            assert_eq!(
                comparable(&host[at.0][at.1], links),
                comparable(&replay[at.0][at.1], links),
                "{what}: the cell at line {line}, column {col}\nhost line:   {:?}\nreplay line: {:?}",
                text(host, line),
                text(replay, line),
            );
        }
    }
    assert_eq!(host.cursor.point, replay.cursor.point, "{what}: cursor");
    assert_eq!(
        host.cursor.input_needs_wrap, replay.cursor.input_needs_wrap,
        "{what}: cursor waiting to wrap"
    );
    assert_eq!(
        comparable(&host.cursor.template, links),
        comparable(&replay.cursor.template, links),
        "{what}: pen"
    );
    assert_eq!(
        host.saved_cursor.point, replay.saved_cursor.point,
        "{what}: saved cursor"
    );
    assert_eq!(
        comparable(&host.saved_cursor.template, links),
        comparable(&replay.saved_cursor.template, links),
        "{what}: saved pen"
    );
}

fn text(grid: &Grid<Cell>, line: i32) -> String {
    (0..grid.columns())
        .map(|col| grid[Line(line)][Column(col)].c)
        .collect()
}

/// Draws `bytes` on a host screen, writes its redraw into an empty screen of
/// the same size and checks the two match, and that redrawing left the host
/// as it was.
fn assert_redraws(size: TermSize, bytes: &[u8]) {
    let mut host = Screen::new(size);
    host.feed(bytes);
    let redraw = host.redraw();
    let mut replay = Screen::new(size);
    replay.feed(&redraw);
    assert_same_screen_with(&mut host, &mut replay, Links::Exact);

    let mut untouched = Screen::new(size);
    untouched.feed(bytes);
    assert_same_screen(&mut untouched, &mut host);
    assert_eq!(host.redraw(), redraw, "a second redraw differs");
}

/// A screen with colours of every kind, attributes, wide and combining
/// characters, a hyperlink, a tab, wrapped lines, lines scrolled into the
/// scrollback, erased cells with a background, cursor movement, a saved
/// cursor, a changed palette, set modes and a pen left on.
fn busy_screen() -> Vec<u8> {
    let mut s = String::new();
    s.push_str("\x1b]4;1;rgb:12/34/56\x07\x1b]11;rgb:01/02/03\x07");
    for i in 0..30 {
        let _ = write!(s, "\x1b[3{}mline {i}\x1b[0m\r\n", i % 8);
    }
    s.push_str("\x1b[1;2;3;4:3;7;9;38;2;10;20;30;48;5;200;58;5;9mstyled\x1b[0m ");
    s.push_str("\x1b[92;101mbright\x1b[0m \x1b[4:2;58;2;1;2;3mdouble\x1b[0m\r\n");
    s.push_str("wide: 漢字 e\u{301} \x1b]8;id=x;https://floti.dev\x1b\\link\x1b]8;;\x1b\\ ");
    s.push_str("\x1b]8;;https://example.com\x1b\\anon\x1b]8;;\x1b\\\r\n");
    s.push_str("a\tb\t\x1b[44mc\r\n");
    s.push_str("abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ\r\n");
    s.push_str("\x1b[45m\x1b[K\x1b[0m\r\n");
    s.push_str("xxxxxxxxxxxxxxxxxxx漢\r\n");
    s.push_str("\x1b[3;5H\x1b[33mmoved\x1b7\x1b[6;2H\x1b[1;36m");
    s.push_str("\x1b[?2004h\x1b[?1h\x1b[?1002h\x1b[?1006h\x1b[?1004h\x1b[?25l\x1b=\x1b[5 q");
    s.into_bytes()
}

#[test]
fn s16_redraw_reproduces_a_busy_screen_cell_for_cell() {
    assert_redraws(TermSize::new(20, 8), &busy_screen());
}

#[test]
fn s16_redraw_reproduces_the_alternate_screen_over_the_primary_one() {
    let mut bytes = busy_screen();
    bytes.extend_from_slice(
        "\x1b[?1049h\x1b[2J\x1b[H\x1b[32malt text\x1b[0m\r\n漢字\x1b[4;3H\x1b[41m!\x1b7\x1b[2;7H\x1b[1;35m"
            .as_bytes(),
    );
    assert_redraws(TermSize::new(20, 8), &bytes);
}

#[test]
fn s16_redraw_reproduces_a_cursor_waiting_to_wrap() {
    assert_redraws(TermSize::new(10, 4), b"0123456789");
    assert_redraws(TermSize::new(10, 4), "abc\r\n01234567漢".as_bytes());
    assert_redraws(TermSize::new(10, 4), b"\x1b[?7l0123456789XYZ");
}

#[test]
fn s16_redraw_reproduces_modes_set_away_from_their_defaults() {
    assert_redraws(
        TermSize::new(12, 4),
        b"\x1b[4h\x1b[20h\x1b[?1007l\x1b[?1000h\x1b[?1005hab",
    );
}

#[test]
fn s16_a_client_attaching_inside_an_escape_sequence_continues_it() {
    let size = TermSize::new(20, 5);
    let first: &[u8] = "plain \x1b[1;3".as_bytes();
    let rest: &[u8] = "1mred\x1b]8;;https://x\x1b\\lnk\x1b]8;;\x1b\\ \u{20ac}".as_bytes();
    // The euro sign's three bytes are split across the boundary too.
    let split = rest.len() - 2;

    let mut host = Screen::new(size);
    host.feed(first);
    host.feed(&rest[..split]);
    let mut replay = Screen::new(size);
    replay.feed(&host.redraw());
    host.feed(&rest[split..]);
    replay.feed(&rest[split..]);
    assert_same_screen(&mut host, &mut replay);

    let mut host = Screen::new(size);
    host.feed(first);
    let mut replay = Screen::new(size);
    replay.feed(&host.redraw());
    host.feed(rest);
    replay.feed(rest);
    assert_same_screen(&mut host, &mut replay);
}

// ---------------------------------------------------------------------------
// Sessions in ptys, with the fake agent
// ---------------------------------------------------------------------------

/// What one attached client has been sent.
struct Watcher {
    redraw: Vec<u8>,
    output: tokio::sync::mpsc::UnboundedReceiver<SessionOutput>,
    data: Vec<u8>,
    events: Vec<SessionOutput>,
    closed: bool,
}

impl Watcher {
    fn attach(session: &Session, client: ClientId, size: TermSize) -> Self {
        let attachment = session.attach(client, size).expect("attach");
        Self {
            redraw: attachment.redraw,
            output: attachment.output,
            data: Vec::new(),
            events: Vec::new(),
            closed: false,
        }
    }

    /// Takes in what has arrived; whether anything had.
    fn pump(&mut self) -> bool {
        let mut any = false;
        loop {
            match self.output.try_recv() {
                Ok(output) => {
                    any = true;
                    if let SessionOutput::Data(bytes) = &output {
                        self.data.extend_from_slice(bytes);
                    }
                    self.events.push(output);
                }
                Err(TryRecvError::Empty) => return any,
                Err(TryRecvError::Disconnected) => {
                    self.closed = true;
                    return any;
                }
            }
        }
    }

    fn wait_for(&mut self, what: &str, done: impl Fn(&Self) -> bool) {
        let deadline = Instant::now() + PATIENCE;
        loop {
            self.pump();
            if done(self) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "waited {PATIENCE:?} for {what}; received so far: {:?}",
                String::from_utf8_lossy(&self.data)
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn wait_for_text(&mut self, text: &str) {
        self.wait_for(&format!("{text:?}"), |watcher| watcher.has(text));
    }

    fn has(&self, text: &str) -> bool {
        self.data
            .windows(text.len())
            .any(|window| window == text.as_bytes())
    }

    fn exit(&self) -> Option<&SessionExit> {
        self.events.iter().find_map(|event| match event {
            SessionOutput::Exited(exit) => Some(exit),
            _ => None,
        })
    }

    /// An empty terminal of `size` with everything this client was sent
    /// written into it.
    fn replay(&self, size: TermSize) -> Screen {
        let mut screen = Screen::new(size);
        screen.feed(&self.redraw);
        screen.feed(&self.data);
        screen
    }
}

/// What [`settle`] has the program print.
const CAUGHT_UP: &str = "all caught up";

/// Has the program print [`CAUGHT_UP`] after everything it was sent, and
/// waits until every watcher has it: all the output before it has reached
/// each of them.
fn settle(session: &Session, watchers: &mut [&mut Watcher]) {
    let line = format!("{CAUGHT_UP}\r\n");
    session
        .input(A, format!("/print {}\r", hex(line.as_bytes())).as_bytes())
        .unwrap();
    for watcher in watchers.iter_mut() {
        watcher.wait_for_text(CAUGHT_UP);
    }
}

/// The store, noting at each exit whether the host still listed the session
/// when the exit was recorded: the moment the clients are told.
struct WatchedLedger {
    store: Arc<Mutex<Store>>,
    host: OnceLock<Weak<SessionHost>>,
    listed_at_exit: Mutex<Vec<(SessionId, bool)>>,
}

impl SessionLedger for WatchedLedger {
    fn started(&self, row: &NewSessionRow) -> crate::error::Result<SessionId> {
        self.store.as_ref().started(row)
    }

    fn finished(&self, id: SessionId, exit: &SessionExit) -> crate::error::Result<()> {
        let listed = self
            .host
            .get()
            .and_then(Weak::upgrade)
            .is_some_and(|host| host.get(id).is_some());
        self.listed_at_exit.lock().unwrap().push((id, listed));
        self.store.as_ref().finished(id, exit)
    }
}

struct Fixture {
    agent: FakeAgent,
    host: Arc<SessionHost>,
    ledger: Arc<WatchedLedger>,
    store: Arc<Mutex<Store>>,
    /// Last: fields drop in order, and the folder goes only once nothing in it is open.
    dirs: TestDirs,
}

impl Fixture {
    fn new() -> Self {
        Self::with_env(std::env::vars_os().collect())
    }

    fn with_env(inherited: Vec<(OsString, OsString)>) -> Self {
        let dirs = TestDirs::new();
        let agent = FakeAgent::new(fake_agent_exe(), &dirs);
        let store = Arc::new(Mutex::new(Store::open(&dirs.data).expect("open the store")));
        let ledger = Arc::new(WatchedLedger {
            store: store.clone(),
            host: OnceLock::new(),
            listed_at_exit: Mutex::new(Vec::new()),
        });
        let host = Arc::new(SessionHost::new(
            inherited,
            ledger.clone(),
            Arc::new(Native),
        ));
        let _ = ledger.host.set(Arc::downgrade(&host));
        Self {
            dirs,
            agent,
            host,
            ledger,
            store,
        }
    }

    fn start(&self, folder: &Path, args: &[&str], size: TermSize) -> Arc<Session> {
        let launch_folder = LaunchFolder::create(&self.dirs.data).expect("create a launch folder");
        let backend = self.agent.backend(args.iter().copied());
        let spec = backend
            .launch(
                &LaunchRequest {
                    folder: folder.to_path_buf(),
                    ..LaunchRequest::default()
                },
                &launch_folder,
            )
            .unwrap()
            .spec;
        self.host
            .start(StartSession {
                spec,
                name: "fake 1".into(),
                size,
                client: Some(A),
                conversation_id: Some("conversation-1".into()),
                backend: backend.id().clone(),
                origin: Default::default(),
            })
            .expect("start the session")
    }

    /// The session's row: status, exit code, ended_at, duration_ms, name,
    /// cwd, argv, conversation and backend.
    fn row(&self, id: SessionId) -> Row {
        let store = self.store.lock().unwrap();
        store
            .connection()
            .query_row(
                "SELECT status, exit_code, ended_at, duration_ms, name, cwd, argv, \
                 claude_session_id, backend FROM sessions WHERE id = ?1",
                [id.0],
                |row| {
                    Ok(Row {
                        status: row.get(0)?,
                        exit_code: row.get(1)?,
                        ended_at: row.get(2)?,
                        duration_ms: row.get(3)?,
                        name: row.get(4)?,
                        cwd: row.get(5)?,
                        argv: row.get(6)?,
                        conversation_id: row.get(7)?,
                        backend: row.get(8)?,
                    })
                },
            )
            .expect("the session has a row")
    }
}

#[derive(Debug)]
struct Row {
    status: String,
    exit_code: Option<i64>,
    ended_at: Option<String>,
    duration_ms: Option<i64>,
    name: String,
    cwd: String,
    argv: String,
    conversation_id: Option<String>,
    backend: Option<String>,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

fn wait_until(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + PATIENCE;
    while !done() {
        assert!(Instant::now() < deadline, "waited {PATIENCE:?} for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn s15_a_session_runs_in_a_pty_in_its_folder_with_the_session_environment_and_relays_output_and_keys()
 {
    let mut inherited: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    for (name, value) in [
        ("CLAUDECODE", "1"),
        ("CLAUDE_CODE_SESSION_ID", "outer"),
        ("CLAUDE_CODE_ENTRYPOINT", "cli"),
        ("CLAUDE_CODE_CHILD_SESSION", "1"),
        ("CLAUDE_PID", "4242"),
        ("NO_COLOR", "1"),
        ("TERM", "dumb"),
        ("COLORTERM", "no"),
    ] {
        inherited.retain(|(existing, _)| !existing.eq_ignore_ascii_case(name));
        inherited.push((name.into(), value.into()));
    }
    let fx = Fixture::with_env(inherited);
    let folder = fx.dirs.folder("a project with spaces");
    let size = TermSize::new(80, 24);
    let session = fx.start(&folder, &[], size);
    let mut a = Watcher::attach(&session, A, size);
    let mut b = Watcher::attach(&session, B, size);

    session.input(A, b"hello there\r").unwrap();
    session.input(B, b"from b\r").unwrap();
    a.wait_for_text("echo: from b");
    b.wait_for_text("echo: from b");
    settle(&session, &mut [&mut a, &mut b]);

    let record = fx
        .agent
        .wait_for_record(session.pid(), PATIENCE, |record| record.input.len() >= 2);
    assert_eq!(
        record.input[..2],
        ["hello there", "from b"],
        "the keys reached the program"
    );
    assert_eq!(
        std::fs::canonicalize(&record.cwd).unwrap(),
        std::fs::canonicalize(&folder).unwrap(),
        "the program ran in the session's folder"
    );
    assert_eq!(
        record.env.get("TERM").map(String::as_str),
        Some("xterm-256color")
    );
    assert_eq!(
        record.env.get("COLORTERM").map(String::as_str),
        Some("truecolor")
    );
    assert_eq!(
        record.env.get("FORCE_HYPERLINK").map(String::as_str),
        Some("1")
    );
    for gone in STRIPPED_ENV {
        assert!(
            !record
                .env_names
                .iter()
                .any(|name| name.eq_ignore_ascii_case(gone)),
            "{gone} reached the session: {:?}",
            record.env_names
        );
    }
    assert!(
        record
            .env_names
            .iter()
            .any(|name| name == "FLOTI_FAKE_AGENT_LOG")
    );

    // Byte for byte: B attached after A, so what B was sent live is exactly
    // the end of what A was sent.
    assert!(!b.data.is_empty());
    assert!(
        a.data.ends_with(&b.data),
        "A and B were sent different output\nA: {:?}\nB: {:?}",
        String::from_utf8_lossy(&a.data),
        String::from_utf8_lossy(&b.data)
    );
    assert!(a.has("echo: hello there"));

    let row = fx.row(session.id());
    assert_eq!(row.status, "running");
    assert_eq!(row.name, "fake 1");
    assert_eq!(Path::new(&row.cwd), folder);
    assert_eq!(row.argv, "[]");
    assert_eq!(row.conversation_id.as_deref(), Some("conversation-1"));
    assert_eq!(row.backend.as_deref(), Some(FakeAgentBackend::ID));

    session.end_now().unwrap();
    assert!(session.wait_exit(PATIENCE).is_some());
}

#[test]
fn s16_a_client_attaching_mid_session_gets_the_screen_then_the_live_output() {
    let fx = Fixture::new();
    let folder = fx.dirs.folder("project");
    let size = TermSize::new(40, 10);
    let mut drawing = String::new();
    for i in 0..25 {
        let _ = write!(drawing, "\x1b[3{}mrow {i}\x1b[0m\r\n", i % 8);
    }
    drawing.push_str("\x1b[1;44mbold on blue\x1b[0m 漢字 \x1b[3;10Hmoved here\x1b[8;1Hdrawn\r\n");
    let print = format!("--fake-print={}", hex(drawing.as_bytes()));
    let session = fx.start(&folder, &[&print], size);
    let mut a = Watcher::attach(&session, A, size);
    a.wait_for_text("drawn");
    session.input(A, b"first\r").unwrap();
    a.wait_for_text("echo: first");

    let mut b = Watcher::attach(&session, B, size);
    assert!(!b.redraw.is_empty());
    let later = "\x1b[?1049h\x1b[2J\x1b[H\x1b[32malternate\x1b[0m\x1b[4;6H\x1b[1mhere";
    session
        .input(A, format!("/print {}\r", hex(later.as_bytes())).as_bytes())
        .unwrap();
    session.input(B, b"second\r").unwrap();
    a.wait_for_text("echo: second");
    b.wait_for_text("echo: second");
    settle(&session, &mut [&mut a, &mut b]);

    assert!(
        a.data.ends_with(&b.data),
        "B's live output is not exactly the end of A's"
    );
    let mut b_screen = b.replay(size);
    let mut a_screen = a.replay(size);
    session
        .with_screen(|host| {
            assert_same_screen(host, &mut b_screen);
            assert_same_screen(host, &mut a_screen);
        })
        .expect("the session still has its screen");

    session.end_now().unwrap();
    assert!(session.wait_exit(PATIENCE).is_some());
}

#[test]
fn s17_a_session_takes_the_size_of_the_client_that_typed_last() {
    let fx = Fixture::new();
    let folder = fx.dirs.folder("project");
    let small = TermSize::new(80, 24);
    let large = TermSize::new(120, 40);
    let session = fx.start(&folder, &[], small);
    let mut a = Watcher::attach(&session, A, small);
    let mut b = Watcher::attach(&session, B, large);
    assert_eq!(session.size(), small, "attaching does not resize");

    session.input(B, b"from b\r").unwrap();
    assert_eq!(session.size(), large);
    assert_eq!(session.pty_size(), Some(large), "the pty took B's size");
    assert_eq!(session.with_screen(|screen| screen.size()), Some(large));
    a.wait_for("A told of the new size", |w| {
        w.events.contains(&SessionOutput::Resized(large))
    });
    b.wait_for_text("echo: from b");

    session.input(A, b"from a\r").unwrap();
    assert_eq!(session.size(), small);
    assert_eq!(session.pty_size(), Some(small));
    assert_eq!(session.with_screen(|screen| screen.size()), Some(small));

    // A typed last: its resize applies at once, B's waits until B types.
    let medium = TermSize::new(100, 30);
    session.resize(A, medium).unwrap();
    assert_eq!(session.size(), medium);
    session.resize(B, TermSize::new(132, 50)).unwrap();
    assert_eq!(session.size(), medium);
    session.input(B, b"again\r").unwrap();
    assert_eq!(session.size(), TermSize::new(132, 50));
    assert_eq!(session.pty_size(), Some(TermSize::new(132, 50)));

    session.end_now().unwrap();
    assert!(session.wait_exit(PATIENCE).is_some());
}

#[test]
fn s18_when_the_program_exits_clients_get_its_code_its_row_records_it_and_its_pty_and_screen_go() {
    let fx = Fixture::new();
    let folder = fx.dirs.folder("project");
    let size = TermSize::new(80, 24);
    let session = fx.start(&folder, &[], size);
    let mut a = Watcher::attach(&session, A, size);
    let mut b = Watcher::attach(&session, B, size);
    assert_eq!(fx.row(session.id()).status, "running");

    session.input(A, b"/exit 7\r").unwrap();
    for watcher in [&mut a, &mut b] {
        watcher.wait_for("the exit", |w| w.closed);
        assert_eq!(
            watcher.events.last(),
            Some(&SessionOutput::Exited(SessionExit {
                code: 7,
                signal: None
            })),
            "the exit is the last thing a client is sent"
        );
        assert_eq!(watcher.exit().map(|exit| exit.code), Some(7));
    }

    let row = fx.row(session.id());
    assert_eq!(row.status, "exited");
    assert_eq!(row.exit_code, Some(7));
    assert!(row.ended_at.is_some(), "{row:?}");
    assert!(row.duration_ms.is_some_and(|ms| ms >= 0), "{row:?}");

    assert!(session.released(), "the pty and the screen were kept");
    assert_eq!(session.exit().map(|exit| exit.code), Some(7));
    assert!(fx.host.get(session.id()).is_none());
    assert!(fx.host.list().is_empty());
    // Gone from the list before the exit is recorded, which is when the
    // clients hear of it: a client told of an exit that lists again never
    // finds the session still running.
    assert_eq!(
        *fx.ledger.listed_at_exit.lock().unwrap(),
        [(session.id(), false)]
    );
    assert!(session.attach(A, size).is_err());
    assert!(session.input(A, b"x").is_err());
    assert_eq!(Native.is_alive(session.pid()), Knowable::Known(false));
}

#[test]
fn ending_a_session_now_ends_its_whole_process_tree() {
    let fx = Fixture::new();
    let folder = fx.dirs.folder("project");
    let session = fx.start(&folder, &["--fake-child"], TermSize::new(80, 24));
    let record = fx.agent.wait_for_record(session.pid(), PATIENCE, |record| {
        !record.children.is_empty()
    });
    let child = record.children[0];
    assert_eq!(Native.is_alive(child), Knowable::Known(true));

    session.end_now().unwrap();
    assert!(
        session.wait_exit(PATIENCE).is_some(),
        "the session did not end"
    );
    wait_until("the agent's child to end", || {
        Native.is_alive(child) == Knowable::Known(false)
    });
    let row = fx.row(session.id());
    assert_eq!(row.status, "exited");
}

#[test]
fn closing_a_session_ends_its_program_and_children_within_the_grace() {
    let fx = Fixture::new();
    let folder = fx.dirs.folder("project");
    let session = fx.start(&folder, &["--fake-child"], TermSize::new(80, 24));
    let record = fx.agent.wait_for_record(session.pid(), PATIENCE, |record| {
        !record.children.is_empty()
    });
    let child = record.children[0];

    // The agent takes the polite ending; what follows when one does not is
    // stepped below, rather than waited out.
    session.close();
    assert!(
        session.wait_exit(PATIENCE).is_some(),
        "the session did not end"
    );
    wait_until("the agent's child to end", || {
        Native.is_alive(child) == Knowable::Known(false)
    });
}

#[test]
fn a_closed_session_still_running_after_the_grace_is_ended_outright() {
    let mut waited = None;
    let mut forced = false;
    end_after_grace(
        |grace| {
            waited = Some(grace);
            false
        },
        || forced = true,
    );
    assert_eq!(waited, Some(GRACE));
    assert!(forced);
}

#[test]
fn a_closed_session_that_ends_within_the_grace_is_not_ended_outright() {
    let mut forced = false;
    end_after_grace(|_| true, || forced = true);
    assert!(!forced);
}

#[test]
fn a_session_outlives_its_clients() {
    let fx = Fixture::new();
    let folder = fx.dirs.folder("project");
    let size = TermSize::new(80, 24);
    let session = fx.start(&folder, &[], size);
    let a = Watcher::attach(&session, A, size);
    session.detach(A);
    drop(a);
    session.input(A, b"still here\r").unwrap();
    fx.agent.wait_for_record(session.pid(), PATIENCE, |record| {
        record.input.iter().any(|line| line == "still here")
    });
    let shows = |text: &str| {
        let redraw = session.with_screen(Screen::redraw).unwrap_or_default();
        redraw
            .windows(text.len())
            .any(|window| window == text.as_bytes())
    };
    wait_until("the answer on the session's screen", || {
        shows("echo: still here")
    });
    assert!(session.exit().is_none());
    assert_eq!(fx.host.list().len(), 1);

    let mut b = Watcher::attach(&session, B, size);
    assert!(
        b.redraw
            .windows(16)
            .any(|window| window == b"echo: still here"),
        "a client attaching later is sent the screen with what was typed while none was"
    );
    session.end_now().unwrap();
    b.wait_for("the exit", |w| w.exit().is_some());
}
