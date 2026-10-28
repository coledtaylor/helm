//! `floti-fake-program`: the program the plugin tests' manifests name in
//! their `exec`, run through `floti.exec` instead of a real tool.
//!
//! It reads its standard input to the end, then does what its arguments say,
//! in this order, and exits:
//!
//! - `--show-env NAME`: the report includes `NAME`'s value, or null. Repeats.
//! - `--child`: starts a copy of itself that sleeps for ten minutes with no
//!   standard streams, and reports its pid.
//! - `--pid-file PATH`: writes `{"pid": .., "child": ..}` to `PATH` once the
//!   child (if any) is running, for a test that never sees the output.
//! - The report: one line of JSON on stdout with its arguments, its folder,
//!   the variables asked for, what it read and the child's pid.
//! - `--stdout-bytes N` / `--stderr-bytes N`: writes `N` bytes of `x`.
//! - `--sleep MS`: sleeps.
//! - `--exit CODE`: exits with `CODE` (0 otherwise).
//!
//! Every other argument is only reported.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let value_after = |flag: &str| -> Vec<String> {
        args.windows(2)
            .filter(|pair| pair[0] == flag)
            .map(|pair| pair[1].clone())
            .collect()
    };
    let number_after = |flag: &str| -> Option<u64> {
        value_after(flag)
            .last()
            .map(|text| text.parse().expect("a number"))
    };

    let mut stdin = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut stdin);

    let child = args.iter().any(|arg| arg == "--child").then(|| {
        Command::new(std::env::current_exe().expect("its own path"))
            .args(["--sleep", "600000"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("start a child")
            .id()
    });

    if let Some(path) = value_after("--pid-file").last() {
        let ids = serde_json::json!({ "pid": std::process::id(), "child": child });
        // Written whole and then renamed, so a test never reads half of it.
        let partial = format!("{path}.partial");
        std::fs::write(&partial, ids.to_string()).expect("write the pid file");
        std::fs::rename(&partial, path).expect("finish the pid file");
    }

    let env: serde_json::Map<String, serde_json::Value> = value_after("--show-env")
        .into_iter()
        .map(|name| {
            let value = std::env::var(&name).ok();
            (name, serde_json::json!(value))
        })
        .collect();
    let report = serde_json::json!({
        "args": args,
        "cwd": std::env::current_dir().expect("its folder"),
        "env": env,
        "stdin": String::from_utf8_lossy(&stdin),
        "child": child,
    });
    let mut stdout = std::io::stdout().lock();
    writeln!(stdout, "{report}").expect("write the report");
    stdout.flush().expect("flush the report");

    let write_bytes = |count: u64, into: &mut dyn Write| {
        let block = vec![b'x'; 64 * 1024];
        let mut left = count;
        while left > 0 {
            let take = usize::try_from(left.min(block.len() as u64)).expect("a block");
            if into.write_all(&block[..take]).is_err() {
                return;
            }
            left -= take as u64;
        }
        let _ = into.flush();
    };
    if let Some(count) = number_after("--stdout-bytes") {
        write_bytes(count, &mut stdout);
    }
    drop(stdout);
    if let Some(count) = number_after("--stderr-bytes") {
        write_bytes(count, &mut std::io::stderr().lock());
    }
    if let Some(millis) = number_after("--sleep") {
        std::thread::sleep(Duration::from_millis(millis));
    }
    let code = number_after("--exit").unwrap_or(0);
    std::process::exit(i32::try_from(code).expect("an exit code"));
}
