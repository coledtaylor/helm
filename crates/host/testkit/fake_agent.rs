//! `floti-fake-agent`: the agent CLI the host's tests run instead of a real
//! one. It does what the host can observe of an agent and nothing more.
//!
//! Every run records itself as `<pid>.json` in the folder named by
//! `FLOTI_FAKE_AGENT_LOG`, when that is set: its arguments, its working
//! folder, the names of the variables it was given (values only for the few
//! the host sets, never the rest, which can hold credentials), the children
//! it started and every line it read.
//!
//! Arguments it acts on, all optional and in any order; every other argument
//! is only recorded, so a backend can pass its own flags:
//!
//! - `--fake-print=<hex>`: writes these bytes to stdout at start.
//! - `--fake-child` or `--fake-child=<ms>`: starts a child of its own that
//!   lives `<ms>` milliseconds (ten minutes by default), recorded by pid.
//! - `--fake-gui-child` or `--fake-gui-child=<ms>`: the same with
//!   `floti-fake-gui`, built beside it, as the child: a program that on
//!   Windows has no console, as a GUI app has, so the console it was started
//!   from closing does not reach it.
//! - `--fake-listen` or `--fake-listen=<ms>`: the same with a child that
//!   listens on a TCP port on 127.0.0.1 the OS picks, and records the port
//!   as `listening` in its own record. The child runs this program with
//!   `--fake-serve=<ms>`.
//! - `--fake-exit=<code>`: exits with `code` once the above are done.
//! - `--fake-sleep=<ms>`: does nothing for `<ms>` milliseconds, then exits 0.
//!   This is what a child runs.
//! - `--fake-serve=<ms>`: listens on a TCP port on 127.0.0.1, records it, and
//!   holds it for `<ms>` milliseconds, then exits 0. This is what a listening
//!   child runs.
//! - `--fake-tick=<ms>`: writes `tick <n>` every `<ms>` milliseconds while it
//!   runs, counting from 1, whether or not anyone types, and records the last
//!   `n` written in `<pid>.ticks` beside its record.
//!
//! Otherwise it reads stdin a line at a time and answers each with
//! `echo: <line>`. At its prompt, `/exit <code>` exits with `code`,
//! `/print <hex>` writes those bytes, and `/child` and `/gui-child` start a
//! child. It exits 0 when stdin ends.
//!
//! It, and every child it starts, exits 0 once the test process that owns it
//! is gone: the one the `test-owner` file nearest above its record folder
//! names (the working folder when it records nowhere), which `TestDirs` writes
//! (`owner.rs`).

mod owner;

use std::collections::BTreeMap;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use floti_host::platform::process_tree::{Native, ProcessTree};
use floti_protocol::Knowable;
use serde_json::json;

const LOG_VAR: &str = "FLOTI_FAKE_AGENT_LOG";

/// Variables whose values are recorded; the rest are recorded by name only.
const RECORDED_VALUES: &[&str] = &["TERM", "COLORTERM", "FORCE_HYPERLINK", "NO_COLOR"];

const DEFAULT_CHILD_MS: u64 = 600_000;

struct Record {
    path: Option<PathBuf>,
    argv: Vec<String>,
    cwd: String,
    env: BTreeMap<String, String>,
    env_names: Vec<String>,
    children: Vec<u32>,
    /// The TCP port it listens on, for a run with `--fake-serve`.
    listening: Option<u16>,
    input: Vec<String>,
}

impl Record {
    fn new(argv: Vec<String>) -> Self {
        let path = std::env::var_os(LOG_VAR)
            .filter(|dir| !dir.is_empty())
            .map(|dir| PathBuf::from(dir).join(format!("{}.json", std::process::id())));
        let cwd = std::env::current_dir()
            .map(|dir| dir.to_string_lossy().into_owned())
            .unwrap_or_default();
        let mut env = BTreeMap::new();
        let mut env_names = Vec::new();
        for (name, value) in std::env::vars_os() {
            let name = name.to_string_lossy().into_owned();
            if RECORDED_VALUES.contains(&name.as_str()) {
                env.insert(name.clone(), value.to_string_lossy().into_owned());
            }
            env_names.push(name);
        }
        env_names.sort();
        Self {
            path,
            argv,
            cwd,
            env,
            env_names,
            children: Vec::new(),
            listening: None,
            input: Vec::new(),
        }
    }

    /// Writes the record whole, through a temporary file and a rename, so a
    /// test reading it never sees half of one.
    fn save(&self) {
        let Some(path) = &self.path else { return };
        let body = json!({
            "pid": std::process::id(),
            "argv": self.argv,
            "cwd": self.cwd,
            "env": self.env,
            "envNames": self.env_names,
            "children": self.children,
            "listening": self.listening,
            "input": self.input,
        });
        let partial = path.with_extension("json.partial");
        let written =
            std::fs::write(&partial, body.to_string()).and_then(|()| replace(&partial, path));
        if let Err(err) = written {
            eprintln!(
                "floti-fake-agent: could not record to {}: {err}",
                path.display()
            );
        }
    }
}

fn main() {
    let watched = std::env::var_os(LOG_VAR)
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok());
    if let Some(folder) = watched {
        // Unknown is not gone: only an owner the OS says has exited ends it.
        owner::exit_when_owner_is_gone(&folder, |pid| {
            Native.is_alive(pid) != Knowable::Known(false)
        });
    }
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut record = Record::new(argv.clone());
    record.save();

    if let Some(ms) = flag_value(&argv, "--fake-serve") {
        serve(&mut record, parse_ms(ms));
        return;
    }
    if let Some(ms) = flag_value(&argv, "--fake-sleep") {
        thread::sleep(Duration::from_millis(parse_ms(ms)));
        return;
    }
    if let Some(hex) = flag_value(&argv, "--fake-print") {
        print_hex(hex);
    }
    if let Some(ms) = child_ms(&argv, "--fake-child") {
        start_child(&mut record, Child::Console, ms);
    }
    if let Some(ms) = child_ms(&argv, "--fake-gui-child") {
        start_child(&mut record, Child::Gui, ms);
    }
    if let Some(ms) = child_ms(&argv, "--fake-listen") {
        start_child(&mut record, Child::Listener, ms);
    }
    if let Some(code) = flag_value(&argv, "--fake-exit") {
        std::process::exit(code.parse().unwrap_or(1));
    }
    if let Some(ms) = flag_value(&argv, "--fake-tick") {
        let every = Duration::from_millis(parse_ms(ms));
        let ticks = record
            .path
            .as_ref()
            .map(|path| path.with_extension("ticks"));
        thread::spawn(move || {
            for n in 1u64..=u64::MAX {
                thread::sleep(every);
                write_out(format!("tick {n}\r\n").as_bytes());
                if let Some(ticks) = &ticks {
                    let partial = ticks.with_extension("ticks.partial");
                    let _ = std::fs::write(&partial, n.to_string())
                        .and_then(|()| replace(&partial, ticks));
                }
            }
        });
    }

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim_end_matches('\r').to_owned();
        record.input.push(line.clone());
        record.save();
        if let Some(code) = line.strip_prefix("/exit") {
            std::process::exit(code.trim().parse().unwrap_or(0));
        } else if let Some(hex) = line.strip_prefix("/print ") {
            print_hex(hex.trim());
        } else if line == "/child" {
            start_child(&mut record, Child::Console, DEFAULT_CHILD_MS);
        } else if line == "/gui-child" {
            start_child(&mut record, Child::Gui, DEFAULT_CHILD_MS);
        } else {
            write_out(format!("echo: {line}\r\n").as_bytes());
        }
    }
}

/// The value of `--name=<value>`.
fn flag_value<'a>(argv: &'a [String], name: &str) -> Option<&'a str> {
    argv.iter()
        .find_map(|arg| arg.strip_prefix(name)?.strip_prefix('='))
}

/// Renames `from` over `to`, retrying while a test has `to` open to read it:
/// Windows refuses to replace a file that is open.
fn replace(from: &Path, to: &Path) -> io::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match std::fs::rename(from, to) {
            Err(_) if Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
            done => return done,
        }
    }
}

fn parse_ms(ms: &str) -> u64 {
    ms.parse().unwrap_or(DEFAULT_CHILD_MS)
}

/// How long a child asked for with `flag` or `flag=<ms>` lives, when one
/// was.
fn child_ms(argv: &[String], flag: &str) -> Option<u64> {
    if argv.iter().any(|arg| arg == flag) {
        return Some(DEFAULT_CHILD_MS);
    }
    flag_value(argv, flag).map(parse_ms)
}

/// The program a child runs.
#[derive(Clone, Copy)]
enum Child {
    /// This program, sharing its console.
    Console,
    /// `floti-fake-gui`, beside it, with no console on Windows.
    Gui,
    /// This program, listening on a TCP port.
    Listener,
}

/// Listens on a port on 127.0.0.1 the OS picks, records it, and holds it for
/// `ms` milliseconds.
fn serve(record: &mut Record, ms: u64) {
    let listener = match std::net::TcpListener::bind(("127.0.0.1", 0)) {
        Ok(listener) => listener,
        Err(err) => {
            eprintln!("floti-fake-agent: could not listen: {err}");
            return;
        }
    };
    record.listening = listener.local_addr().ok().map(|addr| addr.port());
    record.save();
    thread::sleep(Duration::from_millis(ms));
    drop(listener);
}

fn start_child(record: &mut Record, kind: Child, ms: u64) {
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(err) => {
            eprintln!("floti-fake-agent: could not find itself to start a child: {err}");
            return;
        }
    };
    let (program, run) = match kind {
        Child::Console => (exe, "--fake-sleep"),
        Child::Gui => (
            exe.with_file_name(format!("floti-fake-gui{}", std::env::consts::EXE_SUFFIX)),
            "--fake-sleep",
        ),
        Child::Listener => (exe, "--fake-serve"),
    };
    let child = Command::new(program)
        .arg(format!("{run}={ms}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    match child {
        Ok(child) => {
            record.children.push(child.id());
            record.save();
            write_out(format!("child: {}\r\n", child.id()).as_bytes());
        }
        Err(err) => eprintln!("floti-fake-agent: could not start a child: {err}"),
    }
}

fn print_hex(hex: &str) {
    match decode_hex(hex) {
        Some(bytes) => write_out(&bytes),
        None => eprintln!("floti-fake-agent: not hex: {hex}"),
    }
}

fn decode_hex(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok())
        .collect()
}

fn write_out(bytes: &[u8]) {
    let mut out = io::stdout().lock();
    // A closed terminal is the session ending; nothing is left to tell.
    let _ = out.write_all(bytes).and_then(|()| out.flush());
}
