//! Nothing types into a session but a client's own keys and a parent's send to
//! its own child.
//!
//! A session's input has two doors: `Session::input`, which a client's
//! terminal reaches through the connection, and `Session::type_for_parent`,
//! which `agents_send` alone calls on a child its caller started. This test
//! reads the host's sources and fails naming each place that reaches either
//! door from anywhere else, or writes to a session's terminal some other way.
//! A new way to type into a session is a decision to take in this test.

use std::fs;
use std::path::{Path, PathBuf};

/// A source line that reaches a session's input where it should not.
#[derive(Debug, PartialEq, Eq)]
struct Offender {
    file: String,
    line: usize,
    what: &'static str,
}

/// One door and who may use it: the files (paths under `src`) that may hold a
/// call of it.
struct Door {
    what: &'static str,
    /// A call is the pattern followed by something other than a closing
    /// parenthesis, so `.input()` on a backend is not one.
    pattern: &'static str,
    allowed: &'static [&'static str],
}

const DOORS: &[Door] = &[
    Door {
        what: "types into a session as a parent (type_for_parent)",
        pattern: "type_for_parent(",
        allowed: &["session/live.rs", "server/hosted/children/send.rs"],
    },
    Door {
        what: "sends a parent's text to a child (send_to_child)",
        pattern: "send_to_child(",
        allowed: &["server/hosted/children/send.rs", "server/floti_agents.rs"],
    },
    Door {
        what: "types into a session as a client (Session::input)",
        pattern: ".input(",
        allowed: &["server/connection.rs", "keeper/serve.rs", "session/live.rs"],
    },
    Door {
        what: "opens a session's terminal for writing (take_writer)",
        pattern: "take_writer(",
        allowed: &["session/live.rs"],
    },
];

/// The functions of `session/live.rs` that may write to a session's terminal:
/// a client's keys, a parent's send and the host's answer to the program's
/// cursor request.
const WRITERS: &[&str] = &["input", "type_for_parent", "opening_request"];

fn offenders(files: &[(String, String)]) -> Vec<Offender> {
    let mut found = Vec::new();
    for (file, source) in files {
        for (number, line) in production_lines(source) {
            for door in DOORS {
                let mut rest = line;
                while let Some(at) = rest.find(door.pattern) {
                    rest = &rest[at + door.pattern.len()..];
                    let is_a_call = !rest.trim_start().starts_with(')');
                    // A definition names the function after `fn`, not a call.
                    let defines = line.trim_start().contains("fn ")
                        && line.contains(&format!("fn {}", door.pattern.trim_start_matches('.')));
                    if is_a_call && !defines && !door.allowed.contains(&file.as_str()) {
                        found.push(Offender {
                            file: file.clone(),
                            line: number,
                            what: door.what,
                        });
                    }
                }
            }
        }
        if file == "session/live.rs" {
            found.extend(unlisted_writes(source));
        }
    }
    found
}

/// The lines of `source` that are not comments and not in a test module, which
/// closes the file by this repository's convention.
fn production_lines(source: &str) -> impl Iterator<Item = (usize, &str)> {
    source
        .lines()
        .enumerate()
        .map(|(at, line)| (at + 1, line))
        .take_while(|(_, line)| line.trim() != "#[cfg(test)]")
        .filter(|(_, line)| !line.trim_start().starts_with("//"))
}

/// Writes to a terminal in `session/live.rs` made by a function that is not
/// one of [`WRITERS`].
fn unlisted_writes(source: &str) -> Vec<Offender> {
    let mut inside = String::new();
    let mut found = Vec::new();
    for (number, line) in production_lines(source) {
        if let Some(at) = line.find("fn ") {
            let name: String = line[at + 3..]
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            if !name.is_empty() {
                inside = name;
            }
        }
        let writes = line.contains("pty.write(") || line.contains("writer.write");
        // `Pty::write` is the one place the terminal is written to; every
        // caller of it is checked here.
        if writes && inside != "write" && !WRITERS.contains(&inside.as_str()) {
            found.push(Offender {
                file: "session/live.rs".to_owned(),
                line: number,
                what: "writes to a session's terminal outside its three doors",
            });
        }
    }
    found
}

fn sources(root: &Path) -> Vec<(String, String)> {
    let mut found = Vec::new();
    let mut folders = vec![root.to_path_buf()];
    while let Some(folder) = folders.pop() {
        for entry in fs::read_dir(&folder).expect("read a source folder") {
            let path: PathBuf = entry.expect("a source entry").path();
            if path.is_dir() {
                folders.push(path);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                let name = relative(root, &path);
                // Test code types as it likes: the fakes and harnesses are not
                // the host.
                let is_test = name.ends_with("/tests.rs")
                    || name == "tests.rs"
                    || name.contains("/tests/")
                    || name.starts_with("testkit");
                if !is_test {
                    found.push((name, fs::read_to_string(&path).expect("read a source")));
                }
            }
        }
    }
    found.sort();
    found
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .expect("under the source folder")
        .to_string_lossy()
        .replace('\\', "/")
}

#[test]
fn nothing_types_into_a_session_but_a_clients_keys_and_a_parents_send_to_its_own_child() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let files = sources(&root);
    assert!(
        files.iter().any(|(name, _)| name == "session/live.rs")
            && files
                .iter()
                .any(|(name, _)| name == "server/hosted/children/send.rs"),
        "the scan found the host's sources"
    );
    let offenders = offenders(&files);
    assert!(
        offenders.is_empty(),
        "these places type into a session, and only a client's keys and agents_send may:\n{}",
        offenders
            .iter()
            .map(|offender| format!(
                "  crates/host/src/{}:{} {}",
                offender.file, offender.line, offender.what
            ))
            .collect::<Vec<_>>()
            .join("\n")
    );
}

#[test]
fn the_scan_names_a_caller_of_either_door_and_a_write_outside_the_three() {
    let files = vec![
        (
            "server/hosted/children/read.rs".to_owned(),
            "fn peek(session: &Session) {\n    session.type_for_parent(b\"x\");\n}\n".to_owned(),
        ),
        (
            "server/features/sessions.rs".to_owned(),
            "fn nudge(session: &Session) {\n    let _ = session.input(client, b\"\\r\");\n}\n"
                .to_owned(),
        ),
        (
            "server/connection.rs".to_owned(),
            "fn type_it(session: &Session) {\n    let _ = session.input(client, b\"a\");\n}\n"
                .to_owned(),
        ),
        (
            "agent/other.rs".to_owned(),
            "fn spec(&self) {\n    let _ = backend.input();\n}\n#[cfg(test)]\nmod tests {\n    fn t() { s.type_for_parent(b\"x\"); }\n}\n"
                .to_owned(),
        ),
        (
            "session/live.rs".to_owned(),
            "fn input() {\n    pty.write(b);\n}\nfn sneak() {\n    pty.write(b);\n}\n".to_owned(),
        ),
    ];
    assert_eq!(
        offenders(&files),
        [
            Offender {
                file: "server/hosted/children/read.rs".to_owned(),
                line: 2,
                what: "types into a session as a parent (type_for_parent)",
            },
            Offender {
                file: "server/features/sessions.rs".to_owned(),
                line: 2,
                what: "types into a session as a client (Session::input)",
            },
            Offender {
                file: "session/live.rs".to_owned(),
                line: 5,
                what: "writes to a session's terminal outside its three doors",
            },
        ]
    );
}
