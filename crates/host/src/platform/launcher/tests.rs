use std::ffi::OsString;
use std::path::Path;

use super::*;

fn args(list: &[&str]) -> Vec<OsString> {
    list.iter().map(OsString::from).collect()
}

#[test]
fn an_argument_cmd_would_read_as_structure_is_quoted_and_a_quote_is_dropped() {
    assert_eq!(batch::quote("plain"), "plain");
    assert_eq!(batch::quote("--model"), "--model");
    assert_eq!(batch::quote("two words"), "\"two words\"");
    for special in ["a&b", "a<b", "a>b", "(p)", "@x", "x^y", "a|b"] {
        assert_eq!(batch::quote(special), format!("\"{special}\""));
    }
    assert_eq!(batch::quote(""), "\"\"");
    assert_eq!(batch::quote("say \"hi\""), "\"say hi\"");
}

#[test]
fn the_line_names_the_batch_file_then_each_argument() {
    let line = batch::line(
        Path::new("C:/Program Files/npm/claude.cmd"),
        &args(&["-n", "my session", "--", "fix a&b"]),
    );
    assert_eq!(
        line,
        "\"C:/Program Files/npm/claude.cmd\" -n \"my session\" -- \"fix a&b\""
    );
    assert_eq!(batch::cmd_args(), args(&["/d", "/c", "%FLOTI_BATCH_LINE%"]));
}

#[test]
fn only_cmd_and_bat_files_are_batch_files() {
    assert!(batch::is_batch_file(Path::new("claude.cmd")));
    assert!(batch::is_batch_file(Path::new("C:/x/CLAUDE.BAT")));
    assert!(!batch::is_batch_file(Path::new("claude.exe")));
    assert!(!batch::is_batch_file(Path::new("claude")));
}

#[test]
fn a_program_that_is_not_a_batch_file_runs_as_given() {
    let program = Native.resolve("floti-no-such-program-anywhere".as_ref(), &args(&["a b"]));
    assert_eq!(
        program,
        as_given("floti-no-such-program-anywhere".as_ref(), &args(&["a b"]))
    );
}

/// A batch file in a folder with a space in its name gets every argument
/// whole, specials and all, through `cmd.exe`.
#[cfg(windows)]
#[test]
fn a_batch_file_gets_each_argument_unchanged() {
    let dirs = crate::testkit::TestDirs::new();
    let folder = dirs.folder("npm bin");
    let script = folder.join("show args.cmd");
    let out = folder.join("args.txt");
    std::fs::write(
        &script,
        format!(
            "@node -e \"require('fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))\" \"{}\" %*\r\n",
            out.display()
        ),
    )
    .unwrap();

    let given = args(&[
        "two words",
        "a&b",
        "plain",
        "100%",
        "x^y",
        "(p)",
        "--",
        "end",
    ]);
    let program = Native.resolve(script.as_os_str(), &given);
    assert_ne!(program.program, script.as_os_str());
    let status = std::process::Command::new(&program.program)
        .args(&program.args)
        .envs(program.env.iter().map(|(k, v)| (k, v)))
        .status()
        .unwrap();
    assert!(status.success());
    let seen: Vec<String> = serde_json::from_slice(&std::fs::read(out).unwrap()).unwrap();
    assert_eq!(
        seen,
        [
            "two words",
            "a&b",
            "plain",
            "100%",
            "x^y",
            "(p)",
            "--",
            "end"
        ]
    );
}
