//! What the two fake agent CLIs (`test/fake-agents/claude-code.mjs` and
//! `other-agent.mjs`) do with what is typed at them, each on its own keys: a
//! bracketed paste is one block whose newlines submit nothing, a submit key
//! that arrives in the same read as the paste's end is part of the paste, text
//! submitted while a turn runs is queued as the next turn, the agent's stop key
//! ends a running turn, and a permission prompt is held until y or n.
//!
//! Each fake runs under Node with its input on a pipe, and what it did is read
//! from the run log it writes about itself. A test waits on the log, never on
//! time, and shows that something did not happen by what a later, ordered input
//! then finds.

use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};

use floti_host::testkit::{PATIENCE, TestDirs};
use serde_json::{Value, json};

const PASTE_OPEN: &[u8] = b"\x1b[200~";
const PASTE_CLOSE: &[u8] = b"\x1b[201~";

/// One fake and the keys it is made to take.
struct Fake {
    name: &'static str,
    script: &'static str,
    /// The variable naming the folder it keeps its run log under.
    home_var: &'static str,
    submit: &'static [u8],
    stop: &'static [u8],
    /// A control key that is not this fake's stop key (the other fake's, or
    /// one neither takes), which must end nothing. Escape is not used for the
    /// fake that reads it as the start of a key sequence.
    other_stop: &'static [u8],
}

const FAKES: [Fake; 2] = [
    Fake {
        name: "claude-code",
        script: "claude-code.mjs",
        home_var: "CLAUDE_CONFIG_DIR",
        submit: b"\r",
        stop: b"\x1b",
        other_stop: b"\x18",
    },
    Fake {
        name: "other-agent",
        script: "other-agent.mjs",
        home_var: "OTHER_AGENT_HOME",
        submit: b"\n",
        stop: b"\x18",
        other_stop: b"\x01",
    },
];

fn script(name: &str) -> PathBuf {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("test")
        .join("fake-agents")
        .join(name);
    let canonical = std::fs::canonicalize(&path).unwrap_or(path);
    match canonical.to_string_lossy().strip_prefix(r"\\?\") {
        Some(plain) => PathBuf::from(plain),
        None => canonical,
    }
}

/// A running fake with its input open.
struct Run {
    child: Child,
    stdin: ChildStdin,
    log: PathBuf,
    fake: &'static Fake,
}

impl Run {
    fn start(fake: &'static Fake, dirs: &TestDirs) -> Self {
        let home = dirs.folder(&format!("{} home", fake.name));
        let mut child = Command::new("node")
            .arg(script(fake.script))
            .current_dir(dirs.folder("work"))
            .env_remove("FAKE_AGENT_VERSION")
            .env(fake.home_var, &home)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("run node");
        let stdin = child.stdin.take().expect("piped input");
        let log = home.join("fake-agent").join(format!("{}.json", child.id()));
        Self {
            child,
            stdin,
            log,
            fake,
        }
    }

    fn send(&mut self, bytes: &[u8]) {
        use std::io::Write as _;
        self.stdin.write_all(bytes).expect("write to the fake");
        self.stdin.flush().expect("flush to the fake");
    }

    /// `text` and then the submit key, as a person types a line.
    fn type_line(&mut self, text: &str) {
        let mut bytes = text.as_bytes().to_vec();
        bytes.extend_from_slice(self.fake.submit);
        self.send(&bytes);
    }

    /// `text` as one bracketed paste, written in one go.
    fn paste(&mut self, text: &str, then: &[u8]) {
        let mut bytes = PASTE_OPEN.to_vec();
        bytes.extend_from_slice(text.as_bytes());
        bytes.extend_from_slice(PASTE_CLOSE);
        bytes.extend_from_slice(then);
        self.send(&bytes);
    }

    fn log(&self) -> Option<Value> {
        serde_json::from_slice(&std::fs::read(&self.log).ok()?).ok()
    }

    /// The first run log `done` accepts, within the patience.
    fn wait_for(&self, what: &str, done: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + PATIENCE;
        loop {
            let log = self.log();
            if let Some(log) = &log
                && done(log)
            {
                return log.clone();
            }
            assert!(
                Instant::now() < deadline,
                "{}: no {what} within {PATIENCE:?}; last log: {log:?}",
                self.fake.name
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for Run {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn lines(log: &Value, field: &str) -> Vec<String> {
    log[field]
        .as_array()
        .unwrap_or_else(|| panic!("{field} is a list in {log}"))
        .iter()
        .map(|line| line.as_str().expect("text").to_owned())
        .collect()
}

fn has(log: &Value, field: &str, count: usize) -> bool {
    log[field]
        .as_array()
        .is_some_and(|list| list.len() == count)
}

fn each_fake(check: impl Fn(&'static Fake, &TestDirs)) {
    for fake in &FAKES {
        let dirs = TestDirs::new();
        check(fake, &dirs);
    }
}

#[test]
fn a_paste_is_one_block_with_its_newlines_and_submits_nothing_until_the_submit_key_comes_apart_from_it()
 {
    each_fake(|fake, dirs| {
        let text = "first line\nsecond line\n\nfourth line";
        let mut run = Run::start(fake, dirs);
        run.paste(text, b"");
        let log = run.wait_for("the paste", |log| has(log, "pastes", 1));
        assert_eq!(
            log["pastes"][0],
            json!({ "text": text, "withSubmit": false }),
            "{}",
            fake.name
        );

        run.send(fake.submit);
        let log = run.wait_for("the turn", |log| has(log, "prompts", 1));
        // The one line that was submitted is the whole block: no newline in
        // the paste submitted a line of its own.
        assert_eq!(lines(&log, "received"), [text], "{}", fake.name);
        assert_eq!(lines(&log, "prompts"), [text], "{}", fake.name);
        assert_eq!(
            lines(&log, "submitKeys"),
            [String::from_utf8(fake.submit.to_vec()).unwrap()],
            "{} is submitted by its own key",
            fake.name
        );
    });
}

#[test]
fn a_submit_key_in_the_same_read_as_the_pastes_end_is_part_of_the_paste_and_submits_nothing() {
    each_fake(|fake, dirs| {
        let text = "do the thing";
        let mut run = Run::start(fake, dirs);
        run.paste(text, fake.submit);
        let log = run.wait_for("the paste", |log| has(log, "pastes", 1));
        assert_eq!(
            log["pastes"][0],
            json!({ "text": text, "withSubmit": true }),
            "{}",
            fake.name
        );

        // Pressed apart from the paste, the key submits it, with the line
        // break the first one became: had that one submitted, this would be
        // an empty line and `received` would hold two.
        run.send(fake.submit);
        let log = run.wait_for("the turn", |log| has(log, "prompts", 1));
        assert_eq!(
            lines(&log, "received"),
            [format!("{text}\n")],
            "{}",
            fake.name
        );
    });
}

#[test]
fn text_submitted_while_a_turn_runs_is_queued_and_taken_as_the_next_turn_once_it_ends() {
    each_fake(|fake, dirs| {
        let mut run = Run::start(fake, dirs);
        run.type_line("/busy hold");
        run.wait_for("the turn", |log| has(log, "received", 1));

        run.paste("next task\nwith two lines", b"");
        run.wait_for("the paste", |log| has(log, "pastes", 1));
        run.send(fake.submit);
        let log = run.wait_for("the queued text", |log| has(log, "queued", 1));
        assert_eq!(
            lines(&log, "queued"),
            ["next task\nwith two lines"],
            "{}",
            fake.name
        );
        assert!(
            has(&log, "prompts", 0),
            "{} took it while the turn ran: {log}",
            fake.name
        );

        run.type_line("/idle");
        let log = run.wait_for("the next turn", |log| has(log, "prompts", 1));
        assert_eq!(
            lines(&log, "prompts"),
            ["next task\nwith two lines"],
            "{}",
            fake.name
        );
    });
}

#[test]
fn the_agents_own_stop_key_ends_a_running_turn_and_another_key_does_not() {
    each_fake(|fake, dirs| {
        let mut run = Run::start(fake, dirs);
        run.type_line("/busy hold");
        run.wait_for("the turn", |log| has(log, "received", 1));

        // A key that is not its stop key does nothing here: the line typed after
        // it is queued behind the turn, which had it ended would have taken
        // the line at once.
        run.send(fake.other_stop);
        run.type_line("probe");
        let log = run.wait_for("the probe", |log| has(log, "queued", 1));
        assert_eq!(lines(&log, "queued"), ["probe"], "{}", fake.name);
        assert_eq!(log["interrupts"], 0, "{}", fake.name);

        run.send(fake.stop);
        let log = run.wait_for("the interrupt", |log| has(log, "prompts", 1));
        assert_eq!(log["interrupts"], 1, "{}", fake.name);
        assert_eq!(lines(&log, "prompts"), ["probe"], "{}", fake.name);
    });
}

#[test]
fn a_fake_at_its_permission_prompt_takes_nothing_but_y_or_n_and_goes_on_after() {
    each_fake(|fake, dirs| {
        let mut run = Run::start(fake, dirs);
        run.type_line("/wait");
        run.wait_for("the prompt", |log| has(log, "received", 1));

        // Pasted text, a submit key, the stop key and typed letters other
        // than y and n are all ignored (a typed line has no y or n in it).
        run.paste("not for you", fake.submit);
        run.send(fake.stop);
        run.type_line("else");
        run.send(b"y");
        let log = run.wait_for("the answer", |log| has(log, "answers", 1));
        assert_eq!(lines(&log, "answers"), ["y"], "{}", fake.name);
        assert_eq!(
            lines(&log, "received"),
            ["/wait"],
            "{} took a line at its prompt",
            fake.name
        );
        assert!(has(&log, "prompts", 0), "{}", fake.name);

        run.type_line("after");
        let log = run.wait_for("the turn", |log| has(log, "prompts", 1));
        assert_eq!(lines(&log, "prompts"), ["after"], "{}", fake.name);
    });
}
