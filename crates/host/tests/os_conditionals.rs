//! What differs by OS sits behind one trait per concern, with one
//! implementation per OS, and nothing else in the host is conditional on the
//! OS.
//!
//! The concerns are the folders under `src/platform`: starting at sign-in
//! (`startup`), the local socket (`socket`), data folders (`folders`),
//! ending a process tree (`process_tree`), the process table and listening
//! sockets (`process_table`), folder links (`links`), starting a program
//! (`launcher`) and files only the user can open (`private_files`). A
//! compile-time OS conditional
//! (`cfg`, `cfg!` or `cfg_attr` naming `windows`, `unix`, `target_os`,
//! `target_family`, `target_vendor` or `target_env`) may appear only in
//! those folders, and in `src/platform/mod.rs`, which refuses any other OS.
//! Anywhere else in the crate's source, its tests or its test tools, this
//! test fails naming the file and line.

use std::path::{Path, PathBuf};

/// The folders whose files are per-OS implementations of a concern.
const CONCERNS: &[&str] = &[
    "startup",
    "socket",
    "folders",
    "process_tree",
    "process_table",
    "links",
    "launcher",
    "private_files",
];

/// The words that make a `cfg` depend on the OS.
const OS_PREDICATES: [&str; 6] = [
    "windows",
    "unix",
    "target_os",
    "target_family",
    "target_vendor",
    "target_env",
];

/// The folders of the crate that hold Rust source.
const SOURCE_FOLDERS: [&str; 3] = ["src", "tests", "testkit"];

/// One OS conditional where none may be.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Misplaced {
    /// Relative to the crate, with `/` separators.
    file: String,
    line: usize,
    text: String,
}

impl std::fmt::Display for Misplaced {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}: {}", self.file, self.line, self.text.trim())
    }
}

/// Every OS conditional under `crate_root` outside the per-OS
/// implementations, in file and line order.
fn misplaced_conditionals(crate_root: &Path) -> Vec<Misplaced> {
    let mut files = Vec::new();
    for folder in SOURCE_FOLDERS {
        rust_files(&crate_root.join(folder), &mut files);
    }
    files.sort();
    let mut found = Vec::new();
    for file in files {
        let relative = file
            .strip_prefix(crate_root)
            .expect("under the crate")
            .components()
            .map(|part| part.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        if allowed(&relative) {
            continue;
        }
        let source = std::fs::read_to_string(&file)
            .unwrap_or_else(|err| panic!("read {}: {err}", file.display()));
        for (line, text) in os_conditionals(&source) {
            found.push(Misplaced {
                file: relative.clone(),
                line,
                text,
            });
        }
    }
    found
}

/// Whether a file may hold OS conditionals: it is in a concern's folder, or
/// it is the guard that refuses any other OS.
fn allowed(relative: &str) -> bool {
    relative == "src/platform/mod.rs"
        || CONCERNS
            .iter()
            .any(|concern| relative.starts_with(&format!("src/platform/{concern}/")))
}

fn rust_files(folder: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

/// Each OS conditional in `source`: the line it starts on and that line.
/// Comments are skipped; a conditional may span lines.
fn os_conditionals(source: &str) -> Vec<(usize, String)> {
    let lines: Vec<&str> = source.lines().collect();
    // The code with comments blanked, line for line.
    let code: Vec<String> = lines.iter().map(|line| strip_comment(line)).collect();
    let text = code.join("\n");
    let starts: Vec<usize> = std::iter::once(0)
        .chain(text.match_indices('\n').map(|(at, _)| at + 1))
        .collect();
    let line_of = |at: usize| starts.partition_point(|start| *start <= at);

    let mut found = Vec::new();
    let mut search = 0;
    while let Some(offset) = text[search..].find("cfg") {
        let at = search + offset;
        search = at + 3;
        let before = text[..at].chars().next_back();
        if before.is_some_and(|c| c.is_alphanumeric() || c == '_') {
            continue;
        }
        let rest = &text[at + 3..];
        let rest = rest
            .strip_prefix('!')
            .or_else(|| rest.strip_prefix("_attr"))
            .unwrap_or(rest)
            .trim_start();
        let Some(inner) = rest.strip_prefix('(').and_then(balanced) else {
            continue;
        };
        if words(inner).any(|word| OS_PREDICATES.contains(&word)) {
            let line = line_of(at);
            found.push((line, lines[line - 1].to_owned()));
        }
    }
    found
}

/// The text up to the `)` that closes an already-opened `(`.
fn balanced(text: &str) -> Option<&str> {
    let mut depth = 1usize;
    for (at, c) in text.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&text[..at]);
                }
            }
            _ => {}
        }
    }
    None
}

fn words(text: &str) -> impl Iterator<Item = &str> {
    text.split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|word| !word.is_empty())
}

/// `line` as code only: a `//` comment dropped and the inside of string
/// literals blanked, so neither can look like a conditional.
fn strip_comment(line: &str) -> String {
    let mut code = String::with_capacity(line.len());
    let mut in_string = false;
    let mut previous = ' ';
    for c in line.chars() {
        if in_string {
            if c == '"' && previous != '\\' {
                in_string = false;
                code.push(c);
            } else {
                code.push(' ');
            }
        } else if c == '"' {
            in_string = true;
            code.push(c);
        } else if c == '/' && previous == '/' {
            code.pop();
            return code;
        } else {
            code.push(c);
        }
        previous = c;
    }
    code
}

#[test]
fn s14_os_conditionals_appear_only_in_the_per_os_implementations_of_the_concerns() {
    let misplaced = misplaced_conditionals(Path::new(env!("CARGO_MANIFEST_DIR")));
    assert!(
        misplaced.is_empty(),
        "OS conditionals outside the per-OS implementations under src/platform/<concern>/:\n{}",
        misplaced
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n")
    );
}

#[test]
fn s14_the_scan_sees_the_conditionals_the_concerns_do_hold() {
    // A control: the scan finds what the platform folders legitimately hold,
    // so an empty result above is not a scan that sees nothing.
    let source = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("src/platform/socket/mod.rs"),
    )
    .unwrap();
    assert!(os_conditionals(&source).len() >= 4);
}

#[test]
fn s14_a_conditional_anywhere_else_fails_naming_its_file_and_line() {
    let dirs = floti_host::testkit::TestDirs::new();
    let root = dirs.root();
    let write = |relative: &str, text: &str| {
        let path = root.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    };
    write(
        "src/server/mod.rs",
        "//! #[cfg(windows)] in a comment is not code.\nuse std::io;\n#[cfg(windows)]\nfn a() {}\n#[cfg(test)]\nmod tests;\n#[cfg(feature = \"testkit\")]\nfn b() {}\nlet s = \"cfg(unix)\"; // cfg(unix)\n",
    );
    write(
        "src/session/live.rs",
        "fn f() {\n    if cfg!(target_os = \"macos\") {}\n}\n#[cfg_attr(\n    all(test, unix),\n    allow(dead_code)\n)]\nfn g() {}\n",
    );
    write(
        "tests/host.rs",
        "#[cfg(not(windows))]\n#[test]\nfn t() {}\n",
    );
    write(
        "testkit/fake_agent.rs",
        "fn main() { let _ = cfg!(target_family = \"unix\"); }\n",
    );
    // Allowed: a concern's per-OS files and the platform guard.
    write(
        "src/platform/socket/windows.rs",
        "#[cfg(windows)]\nfn w() {}\n",
    );
    write(
        "src/platform/socket/mod.rs",
        "#[cfg(target_os = \"linux\")]\nmod linux;\n",
    );
    write(
        "src/platform/mod.rs",
        "#[cfg(not(any(windows, unix)))]\ncompile_error!(\"x\");\n",
    );
    // Not a concern: a platform file outside the concerns' folders is caught.
    write("src/platform/clipboard.rs", "#[cfg(unix)]\nfn c() {}\n");

    let found: Vec<String> = misplaced_conditionals(root)
        .iter()
        .map(|misplaced| format!("{}:{}", misplaced.file, misplaced.line))
        .collect();
    assert_eq!(
        found,
        [
            "src/platform/clipboard.rs:1",
            "src/server/mod.rs:3",
            "src/session/live.rs:2",
            "src/session/live.rs:4",
            "testkit/fake_agent.rs:1",
            "tests/host.rs:1",
        ]
    );
    let message = misplaced_conditionals(root)[1].to_string();
    assert_eq!(message, "src/server/mod.rs:3: #[cfg(windows)]");
}
