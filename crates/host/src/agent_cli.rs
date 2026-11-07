//! `floti agent`: the agents family from a session's own shell.
//!
//! `floti agent start --task <text>` starts an agent of the session's own and
//! prints its name; `floti agent send <name> <text>` types a turn into it;
//! `floti agent read <name>` prints its screen as plain text;
//! `floti agent stop <name>` ends it; `floti agent wait` prints the news its
//! agents have for the session. Each is the `agents_start`, `agents_send`,
//! `agents_read`, `agents_stop` or `agents_wait` tool called over the same
//! endpoint a session's agent tools use, so the host answers one way whoever
//! asks and the same limits, folder rule and own-children rule apply. The session is
//! known by the bearer token in `FLOTI_AGENT_TOKEN` and the address in
//! `FLOTI_AGENT_URL`, which the host puts in the environment of every session
//! it gave the agents family. Nothing here names a session: the token is the
//! whole of who is asking.
//!
//! `floti agent run [--name <name>] [--wait] -- <command...>` is the one
//! subcommand with no tool in the family's list: it runs a command for the
//! user to watch, in the session's folder, as a command child, and only a
//! call from a shell reaches it. With `--wait` it returns once the command
//! exits and ends with the command's own exit status.
//!
//! **A wait is a command that stays.** `floti agent wait` and
//! `floti agent start --wait` and `floti agent run --wait` hold until there is news where the session's
//! agent is woken by a finished background command (the host decides: a
//! request says only that it comes from a shell, by the `x-floti-shell`
//! header), and the host keeps the connection alive with an event each minute.
//! The command prints what the tool returned and exits; one that is cut off
//! (the host restarted, the connection went) says so and exits 1, and runs
//! again to get the news, which the host keeps until an answer has reached
//! its caller.
//!
//! The token goes only to a loopback address and is never printed or put in
//! an error. A refusal is printed to standard error and the exit status is 1,
//! so a script and a model both see it; with `--json` the answer is the
//! tool's JSON.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

use serde_json::{Value, json};

use crate::agent_tools::SHELL_HEADER;

/// The variable that carries the family's address.
pub const URL_VAR: &str = "FLOTI_AGENT_URL";

/// The variable that carries the session's token.
pub const TOKEN_VAR: &str = "FLOTI_AGENT_TOKEN";

/// What `floti agent` accepts.
pub const USAGE: &str = "usage: floti agent start --task <text> [--role <name>] [--backend <id>] [--folder <path>] [--profile <name>] [--name <name>] [--worktree <name>] [--outlive] [--can-start] [--wait] [--json]\n       floti agent start --resume <name> --task <text> [--wait] [--json]\n       floti agent send [--interrupt] [--wait] [--json] <name> [--] <text>\n       floti agent read [--lines <n>] [--json] <name>\n       floti agent run [--name <name>] [--wait] [--json] -- <command...>\n       floti agent wait [--all] [--json] [<name>...]\n       floti agent stop <name> [--json]";

/// How long a connection waits to be made.
const CONNECT_WAIT: Duration = Duration::from_secs(10);

/// How long the host may say nothing before it is taken as gone: a start
/// composes a launch and a stop waits for each process to end, and a wait
/// that holds is answered with an event each minute.
const ANSWER_WAIT: Duration = Duration::from_secs(120);

/// A subcommand, as parsed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Start(Start),
    Send(SendText),
    Read(ReadScreen),
    Run(Run),
    Stop(Stop),
    Wait(Wait),
}

/// `floti agent read`: a child's screen and the lines above it, as text.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReadScreen {
    pub child: String,
    /// How many lines above the screen at most (`--lines`); the host's most
    /// when none.
    pub lines: Option<u32>,
    pub json: bool,
}

/// `floti agent run`: a command the user watches run, as a child of the
/// session.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Run {
    /// The command: a program and its arguments, or one word that is the
    /// whole command line.
    pub command: Vec<String>,
    /// What the child is called; the program's file name when none.
    pub name: Option<String>,
    /// Whether `--wait` was given: the command then returns once the command
    /// exits, with its exit code and last lines, and exits with that code.
    pub wait: bool,
    pub json: bool,
}

/// `floti agent send`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SendText {
    pub child: String,
    pub text: String,
    /// Whether `--interrupt` was given: the agent's stop key is pressed
    /// before the text.
    pub interrupt: bool,
    /// Whether `--wait` was given: the command then also prints the agent's
    /// next news.
    pub wait: bool,
    pub json: bool,
}

/// `floti agent start`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Start {
    pub task: String,
    pub role: Option<String>,
    pub backend: Option<String>,
    pub folder: Option<String>,
    pub profile: Option<String>,
    pub name: Option<String>,
    /// The one-word name of the git worktree to make for it.
    pub worktree: Option<String>,
    /// The name of one of the caller's ended agents to reopen; `task` is then
    /// its next turn.
    pub resume: Option<String>,
    pub outlive: bool,
    /// Whether `--can-start` was given; without it the role chooses.
    pub can_start: bool,
    /// Whether `--wait` was given: the command then also prints the child's
    /// next news.
    pub wait: bool,
    pub json: bool,
}

/// `floti agent wait`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Wait {
    /// Whether `--all` was given: wait until none of the agents is working,
    /// not for the first news.
    pub all: bool,
    /// The agents to wait on; none for all of the session's.
    pub children: Vec<String>,
    pub json: bool,
}

/// `floti agent stop`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Stop {
    pub child: String,
    pub json: bool,
}

/// What a command printed and how it ended.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Outcome {
    /// For standard output.
    pub out: Option<String>,
    /// For standard error.
    pub err: Option<String>,
    /// The exit status: 0 done, 1 refused or not reached.
    pub code: u8,
}

impl Outcome {
    fn done(out: String) -> Self {
        Self {
            out: Some(out),
            err: None,
            code: 0,
        }
    }

    fn refused(err: impl Into<String>) -> Self {
        Self {
            out: None,
            err: Some(err.into()),
            code: 1,
        }
    }
}

/// The subcommand in `args` (what follows `floti agent`), or why there is
/// none.
///
/// # Errors
///
/// A sentence naming what is missing or not understood.
pub fn parse(args: &[String]) -> Result<Command, String> {
    let Some((subcommand, rest)) = args.split_first() else {
        return Err("Say what to do: start, send, read, run, wait or stop.".to_owned());
    };
    match subcommand.as_str() {
        "start" => parse_start(rest).map(Command::Start),
        "send" => parse_send(rest).map(Command::Send),
        "read" => parse_read(rest).map(Command::Read),
        "run" => parse_run(rest).map(Command::Run),
        "stop" => parse_stop(rest).map(Command::Stop),
        "wait" => parse_wait(rest).map(Command::Wait),
        other => Err(format!("`{other}` is not a floti agent command.")),
    }
}

fn parse_start(args: &[String]) -> Result<Start, String> {
    let mut start = Start::default();
    let mut task = None;
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) if flag.starts_with("--") => (flag, Some(value.to_owned())),
            _ => (arg.as_str(), None),
        };
        let mut value = |flag: &str| -> Result<String, String> {
            inline
                .clone()
                .or_else(|| args.next().cloned())
                .ok_or_else(|| format!("{flag} needs a value."))
        };
        match flag {
            "--task" => task = Some(value(flag)?),
            "--role" => start.role = Some(value(flag)?),
            "--backend" => start.backend = Some(value(flag)?),
            "--folder" => start.folder = Some(value(flag)?),
            "--profile" => start.profile = Some(value(flag)?),
            "--name" => start.name = Some(value(flag)?),
            "--worktree" => start.worktree = Some(value(flag)?),
            "--resume" => start.resume = Some(value(flag)?),
            "--outlive" if inline.is_none() => start.outlive = true,
            "--can-start" if inline.is_none() => start.can_start = true,
            "--wait" if inline.is_none() => start.wait = true,
            "--json" if inline.is_none() => start.json = true,
            other => return Err(format!("`{other}` is not a floti agent start option.")),
        }
    }
    start.task = task
        .filter(|task| !task.trim().is_empty())
        .ok_or_else(|| "--task is what the agent is to do, and is required.".to_owned())?;
    Ok(start)
}

/// The agent's name, then its text as one argument. Options come before the
/// text; after `--` everything is the text, so it may begin with dashes.
fn parse_send(args: &[String]) -> Result<SendText, String> {
    let mut send = SendText::default();
    let mut child: Option<String> = None;
    let mut text: Option<String> = None;
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--interrupt" => send.interrupt = true,
            "--wait" => send.wait = true,
            "--json" => send.json = true,
            "--" => {
                let rest: Vec<&String> = args.by_ref().collect();
                match (rest.as_slice(), &text) {
                    ([only], None) => text = Some((*only).clone()),
                    _ => return Err(SEND_SHAPE.to_owned()),
                }
            }
            flag if flag.starts_with("--") => {
                return Err(format!("`{flag}` is not a floti agent send option."));
            }
            word if child.is_none() => child = Some(word.to_owned()),
            word if text.is_none() => text = Some(word.to_owned()),
            _ => return Err(SEND_SHAPE.to_owned()),
        }
    }
    send.child = child
        .filter(|child| !child.trim().is_empty())
        .ok_or_else(|| "Name the agent to send to, as floti agent start printed it.".to_owned())?;
    send.text = text
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| "Give the text to send as one argument, in quotes.".to_owned())?;
    Ok(send)
}

/// The child's name, with `--lines <n>` and `--json` in any order.
fn parse_read(args: &[String]) -> Result<ReadScreen, String> {
    let mut read = ReadScreen::default();
    let mut child = None;
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) if flag.starts_with("--") => (flag, Some(value.to_owned())),
            _ => (arg.as_str(), None),
        };
        match flag {
            "--lines" => {
                let value = inline
                    .or_else(|| args.next().cloned())
                    .ok_or_else(|| "--lines needs a number.".to_owned())?;
                read.lines = Some(value.trim().parse().map_err(|_| {
                    format!("--lines is a whole number of lines above the screen, not `{value}`.")
                })?);
            }
            "--json" if inline.is_none() => read.json = true,
            flag if flag.starts_with("--") => {
                return Err(format!("`{flag}` is not a floti agent read option."));
            }
            name if child.is_none() => child = Some(name.to_owned()),
            _ => return Err("Name one agent to read.".to_owned()),
        }
    }
    read.child = child
        .filter(|child| !child.trim().is_empty())
        .ok_or_else(|| "Name the agent to read, as floti agent start printed it.".to_owned())?;
    Ok(read)
}

/// Options, then `--`, then the command: everything after `--` is the
/// command, whatever it begins with.
fn parse_run(args: &[String]) -> Result<Run, String> {
    let mut run = Run::default();
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) if flag.starts_with("--") => (flag, Some(value.to_owned())),
            _ => (arg.as_str(), None),
        };
        match flag {
            "--" if inline.is_none() => {
                run.command = args.by_ref().cloned().collect();
            }
            "--name" => {
                run.name = Some(
                    inline
                        .or_else(|| args.next().cloned())
                        .ok_or_else(|| "--name needs a value.".to_owned())?,
                );
            }
            "--wait" if inline.is_none() => run.wait = true,
            "--json" if inline.is_none() => run.json = true,
            other => return Err(format!("`{other}` is not a floti agent run option.")),
        }
    }
    if run.command.iter().all(|word| word.trim().is_empty()) {
        return Err(RUN_SHAPE.to_owned());
    }
    Ok(run)
}

/// What a run is: options, then `--`, then the command.
const RUN_SHAPE: &str =
    "Give the command after --, such as floti agent run --name tests -- pnpm test.";

/// What a send is: a name and one text.
const SEND_SHAPE: &str =
    "Give the agent's name and then the text to send as one argument, in quotes.";

fn parse_wait(args: &[String]) -> Result<Wait, String> {
    let mut wait = Wait::default();
    for arg in args {
        match arg.as_str() {
            "--all" => wait.all = true,
            "--json" => wait.json = true,
            flag if flag.starts_with("--") => {
                return Err(format!("`{flag}` is not a floti agent wait option."));
            }
            name if !name.trim().is_empty() => wait.children.push(name.trim().to_owned()),
            _ => return Err("An agent's name is not blank.".to_owned()),
        }
    }
    Ok(wait)
}

fn parse_stop(args: &[String]) -> Result<Stop, String> {
    let mut stop = Stop::default();
    let mut child = None;
    for arg in args {
        match arg.as_str() {
            "--json" => stop.json = true,
            flag if flag.starts_with("--") => {
                return Err(format!("`{flag}` is not a floti agent stop option."));
            }
            name if child.is_none() => child = Some(name.to_owned()),
            _ => return Err("Name one agent to stop.".to_owned()),
        }
    }
    stop.child = child
        .filter(|child| !child.trim().is_empty())
        .ok_or_else(|| "Name the agent to stop, as floti agent start printed it.".to_owned())?;
    Ok(stop)
}

/// Runs `command` against the family at `FLOTI_AGENT_URL` with the token in
/// `FLOTI_AGENT_TOKEN`, printing its outcome. Returns the exit status.
pub fn run(command: &Command) -> u8 {
    let url = std::env::var(URL_VAR).ok();
    let token = std::env::var(TOKEN_VAR).ok();
    let outcome = match (url, token) {
        (Some(url), Some(token)) if !url.is_empty() && !token.is_empty() => {
            execute(command, &url, &token)
        }
        _ => Outcome::refused(
            "floti agent runs inside a Floti session that was given agents: FLOTI_AGENT_URL and FLOTI_AGENT_TOKEN are not set here.",
        ),
    };
    if let Some(out) = &outcome.out {
        println!("{out}");
    }
    if let Some(err) = &outcome.err {
        eprintln!("{err}");
    }
    outcome.code
}

/// Calls the tool `command` stands for at `url`, as the session `token`
/// names.
pub fn execute(command: &Command, url: &str, token: &str) -> Outcome {
    let (tool, arguments, json) = match command {
        Command::Start(start) => ("agents_start", start_arguments(start), start.json),
        Command::Send(send) => ("agents_send", send_arguments(send), send.json),
        Command::Read(read) => ("agents_read", read_arguments(read), read.json),
        Command::Run(run) => ("agents_run", run_arguments(run), run.json),
        Command::Stop(stop) => ("agents_stop", json!({ "child": stop.child }), stop.json),
        Command::Wait(wait) => ("agents_wait", wait_arguments(wait), wait.json),
    };
    match call(url, token, tool, arguments) {
        Ok(answer) => present(command, &answer, json),
        Err(problem) => Outcome::refused(problem),
    }
}

fn start_arguments(start: &Start) -> Value {
    let mut arguments = json!({ "task": start.task });
    let map = arguments.as_object_mut().expect("an object");
    for (key, value) in [
        ("role", &start.role),
        ("backend", &start.backend),
        ("folder", &start.folder),
        ("profile", &start.profile),
        ("name", &start.name),
        ("worktree", &start.worktree),
        ("resume", &start.resume),
    ] {
        if let Some(value) = value {
            map.insert(key.to_owned(), json!(value));
        }
    }
    if start.outlive {
        map.insert("outlive".to_owned(), json!(true));
    }
    if start.can_start {
        map.insert("can_start".to_owned(), json!(true));
    }
    if start.wait {
        map.insert("wait".to_owned(), json!(true));
    }
    arguments
}

fn send_arguments(send: &SendText) -> Value {
    let mut arguments = json!({ "child": send.child, "text": send.text });
    if send.interrupt {
        arguments["interrupt"] = json!(true);
    }
    if send.wait {
        arguments["wait"] = json!(true);
    }
    arguments
}

fn read_arguments(read: &ReadScreen) -> Value {
    let mut arguments = json!({ "child": read.child });
    if let Some(lines) = read.lines {
        arguments["lines"] = json!(lines);
    }
    arguments
}

fn run_arguments(run: &Run) -> Value {
    let mut arguments = json!({ "command": run.command });
    if let Some(name) = &run.name {
        arguments["name"] = json!(name);
    }
    if run.wait {
        arguments["wait"] = json!(true);
    }
    arguments
}

/// The exit status `run --wait` ends with: the command's own when it exited,
/// and 1 when it was stopped or has not ended.
fn exit_of_run(structured: Option<&str>) -> u8 {
    let code = structured
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .and_then(|value| {
            value["news"].as_array().and_then(|news| {
                news.iter()
                    .find(|item| item["event"] == "ended")
                    .and_then(|item| item["exitCode"].as_i64())
            })
        });
    match code {
        Some(0) => 0,
        Some(code) => u8::try_from(code)
            .ok()
            .filter(|code| *code != 0)
            .unwrap_or(1),
        None => 1,
    }
}

fn wait_arguments(wait: &Wait) -> Value {
    let mut arguments = json!({ "for": if wait.all { "all" } else { "any" } });
    if !wait.children.is_empty() {
        arguments["children"] = json!(wait.children);
    }
    arguments
}

/// A tool's answer: whether it failed, and its content blocks' text.
#[derive(Debug)]
struct Answer {
    failed: bool,
    blocks: Vec<String>,
}

/// What to print for `answer`.
fn present(command: &Command, answer: &Answer, json: bool) -> Outcome {
    let first = answer.blocks.first().cloned().unwrap_or_default();
    if answer.failed {
        return Outcome::refused(first);
    }
    let structured = answer.blocks.get(1);
    // A command that was waited on ends this one as it ended.
    let code = match command {
        Command::Run(run) if run.wait => exit_of_run(structured.map(String::as_str)),
        _ => 0,
    };
    if json {
        return Outcome {
            out: Some(structured.cloned().unwrap_or(first)),
            err: None,
            code,
        };
    }
    match command {
        // The command's name, then, with --wait, what the command left: the
        // news the host gave.
        Command::Run(run) => {
            let name = structured
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                .and_then(|value| value["name"].as_str().map(str::to_owned));
            let out = match (run.wait, name) {
                (true, Some(name)) => match first.split_once("\n\n") {
                    Some((_, news)) => format!("{name}\n{news}"),
                    None => name,
                },
                (_, name) => name.unwrap_or(first),
            };
            Outcome {
                out: Some(out),
                err: None,
                code,
            }
        }
        // The child's name alone, so a script can keep it; with --wait, the
        // name and then the news the host gave.
        Command::Start(start) => {
            let name = structured
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                .and_then(|value| value["name"].as_str().map(str::to_owned));
            match (start.wait, name) {
                (true, Some(name)) => match first.split_once("\n\n") {
                    Some((_, news)) => Outcome::done(format!("{name}\n{news}")),
                    None => Outcome::done(name),
                },
                (_, name) => Outcome::done(name.unwrap_or(first)),
            }
        }
        // The screen as text, for a script or a model to read as it is.
        Command::Send(_) | Command::Read(_) | Command::Stop(_) | Command::Wait(_) => {
            Outcome::done(first)
        }
    }
}

// ---------------------------------------------------------------------------
// MCP over HTTP
// ---------------------------------------------------------------------------

/// Where the family is: a loopback address and the path on it.
#[derive(Debug, PartialEq, Eq)]
struct Endpoint {
    address: SocketAddr,
    path: String,
}

/// `http://<loopback address>:<port><path>`. The token is sent only to a
/// loopback address, so a URL anywhere else is refused before a byte is sent.
fn endpoint_of(url: &str) -> Result<Endpoint, String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| format!("{URL_VAR} is not an http address."))?;
    let (authority, path) = match rest.find('/') {
        Some(at) => rest.split_at(at),
        None => (rest, "/"),
    };
    let address = authority
        .to_socket_addrs()
        .map_err(|_| format!("{URL_VAR} does not name an address."))?
        .find(|address| address.ip().is_loopback())
        .ok_or_else(|| {
            format!(
                "{URL_VAR} is not a loopback address, so this session's token is not sent there."
            )
        })?;
    Ok(Endpoint {
        address,
        path: path.to_owned(),
    })
}

/// Initialises a connection to the family, then calls `tool` with
/// `arguments`.
fn call(url: &str, token: &str, tool: &str, arguments: Value) -> Result<Answer, String> {
    let endpoint = endpoint_of(url)?;
    rpc(
        &endpoint,
        token,
        1,
        "initialize",
        json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "floti-agent", "version": crate::version::FLOTI_VERSION },
        }),
    )?;
    let result = rpc(
        &endpoint,
        token,
        2,
        "tools/call",
        json!({ "name": tool, "arguments": arguments }),
    )?;
    let blocks = result["content"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| block["text"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    Ok(Answer {
        failed: result["isError"].as_bool().unwrap_or(false),
        blocks,
    })
}

/// One JSON-RPC request and the `result` of its answer.
fn rpc(
    endpoint: &Endpoint,
    token: &str,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let body =
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string();
    let reply = post(endpoint, token, &body)?;
    match reply.status {
        200 => {}
        401 => {
            return Err(
                "Floti does not accept this session's token: the session has ended, or the host was restarted without it."
                    .to_owned(),
            );
        }
        404 => {
            return Err(
                "This session has no agents: they are off for it (Sessions can start agents, or its profile)."
                    .to_owned(),
            );
        }
        other => return Err(format!("The Floti host answered {other}.")),
    }
    let answer = json_of(&reply.body, id)?;
    if let Some(error) = answer.get("error") {
        let message = error["message"].as_str().unwrap_or("it gave no reason");
        return Err(format!("The Floti host refused {method}: {message}"));
    }
    Ok(answer["result"].clone())
}

/// The answer to request `id` that a body holds: the body itself, or the
/// event of an event stream that answers it (the progress events before it
/// answer nothing). A stream that ends without one was cut off.
fn json_of(body: &[u8], id: u64) -> Result<Value, String> {
    let text = String::from_utf8_lossy(body);
    if let Ok(value) = serde_json::from_str::<Value>(text.trim()) {
        return Ok(value);
    }
    text.lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .filter_map(|data| serde_json::from_str::<Value>(data.trim()).ok())
        .find(|event| {
            event["id"] == json!(id)
                && (event.get("result").is_some() || event.get("error").is_some())
        })
        .ok_or_else(|| CUT_OFF.to_owned())
}

/// What is said when the host's answer ended before it was whole.
const CUT_OFF: &str =
    "The Floti host's answer was cut off. Nothing was lost: run the command again.";

#[derive(Debug)]
struct Reply {
    status: u16,
    body: Vec<u8>,
}

/// One POST of `body` to the endpoint, carrying the bearer token.
fn post(endpoint: &Endpoint, token: &str, body: &str) -> Result<Reply, String> {
    let mut stream = TcpStream::connect_timeout(&endpoint.address, CONNECT_WAIT)
        .map_err(|err| format!("Cannot reach the Floti host at {}: {err}", endpoint.address))?;
    let unreachable =
        |err: std::io::Error| format!("Lost the Floti host at {}: {err}", endpoint.address);
    stream
        .set_read_timeout(Some(ANSWER_WAIT))
        .map_err(unreachable)?;
    stream
        .set_write_timeout(Some(CONNECT_WAIT))
        .map_err(unreachable)?;
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\
         Accept: application/json, text/event-stream\r\nContent-Type: application/json\r\n\
         {SHELL_HEADER}: 1\r\nAuthorization: Bearer {token}\r\nContent-Length: {length}\r\n\r\n",
        path = endpoint.path,
        address = endpoint.address,
        length = body.len(),
    );
    stream.write_all(head.as_bytes()).map_err(unreachable)?;
    stream.write_all(body.as_bytes()).map_err(unreachable)?;
    let mut answer = Vec::new();
    stream.read_to_end(&mut answer).map_err(unreachable)?;
    parse_reply(&answer)
}

/// The status and body of an HTTP/1.1 response read to its end.
fn parse_reply(answer: &[u8]) -> Result<Reply, String> {
    let malformed = || CUT_OFF.to_owned();
    let end = answer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(malformed)?;
    let head = String::from_utf8_lossy(&answer[..end]).into_owned();
    let status = head
        .split(' ')
        .nth(1)
        .and_then(|code| code.parse().ok())
        .ok_or_else(malformed)?;
    let chunked = head.lines().any(|line| {
        line.to_ascii_lowercase()
            .starts_with("transfer-encoding: chunked")
    });
    let rest = &answer[end + 4..];
    let body = if chunked {
        unchunk(rest).ok_or_else(malformed)?
    } else {
        rest.to_vec()
    };
    Ok(Reply { status, body })
}

/// The body a chunked transfer carries.
fn unchunk(mut rest: &[u8]) -> Option<Vec<u8>> {
    let mut body = Vec::new();
    loop {
        let at = rest.windows(2).position(|window| window == b"\r\n")?;
        let size_line = std::str::from_utf8(&rest[..at]).ok()?;
        // A chunk extension, if any, follows a semicolon.
        let size = usize::from_str_radix(size_line.split(';').next()?.trim(), 16).ok()?;
        if size == 0 {
            return Some(body);
        }
        let data = rest.get(at + 2..at + 2 + size)?;
        body.extend_from_slice(data);
        rest = rest.get(at + 2 + size + 2..)?;
    }
}

#[cfg(test)]
mod tests {
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    use super::*;

    fn args(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| (*word).to_owned()).collect()
    }

    #[test]
    fn start_takes_its_task_and_every_choice_by_flag_or_equals() {
        let parsed = parse(&args(&[
            "start",
            "--task",
            "review the diff",
            "--role=reviewer",
            "--backend",
            "other-agent",
            "--folder",
            "src",
            "--profile",
            "Acme",
            "--name",
            "rev",
            "--worktree=ledger-store",
            "--resume",
            "rev",
            "--outlive",
            "--can-start",
            "--json",
        ]))
        .expect("a start");
        assert_eq!(
            parsed,
            Command::Start(Start {
                task: "review the diff".to_owned(),
                role: Some("reviewer".to_owned()),
                backend: Some("other-agent".to_owned()),
                folder: Some("src".to_owned()),
                profile: Some("Acme".to_owned()),
                name: Some("rev".to_owned()),
                worktree: Some("ledger-store".to_owned()),
                resume: Some("rev".to_owned()),
                outlive: true,
                can_start: true,
                wait: false,
                json: true,
            })
        );
    }

    #[test]
    fn start_takes_wait_and_wait_takes_all_json_and_names() {
        let Ok(Command::Start(start)) = parse(&args(&["start", "--task", "x", "--wait"])) else {
            panic!("a start");
        };
        assert!(start.wait);
        assert!(parse(&args(&["start", "--task", "x", "--wait=yes"])).is_err());

        assert_eq!(parse(&args(&["wait"])), Ok(Command::Wait(Wait::default())));
        assert_eq!(
            parse(&args(&[
                "wait",
                "--all",
                "--json",
                "reviewer",
                "reviewer-2"
            ])),
            Ok(Command::Wait(Wait {
                all: true,
                children: vec!["reviewer".to_owned(), "reviewer-2".to_owned()],
                json: true,
            }))
        );
        assert!(parse(&args(&["wait", "--any"])).is_err());
        assert!(parse(&args(&["wait", " "])).is_err());
    }

    #[test]
    fn a_wait_asks_for_any_or_all_and_names_only_the_children_given() {
        assert_eq!(wait_arguments(&Wait::default()), json!({ "for": "any" }));
        assert_eq!(
            wait_arguments(&Wait {
                all: true,
                children: vec!["a".to_owned(), "b".to_owned()],
                json: false,
            }),
            json!({ "for": "all", "children": ["a", "b"] })
        );
        let start = Start {
            task: "t".to_owned(),
            wait: true,
            ..Start::default()
        };
        assert_eq!(start_arguments(&start)["wait"], json!(true));
        assert!(start_arguments(&Start::default()).get("wait").is_none());
    }

    #[test]
    fn start_without_a_task_or_with_an_unknown_option_is_a_usage_error() {
        assert!(parse(&args(&["start"])).is_err());
        assert!(parse(&args(&["start", "--task", "  "])).is_err());
        assert!(parse(&args(&["start", "--task"])).is_err());
        assert!(parse(&args(&["start", "--task", "x", "--session", "3"])).is_err());
        assert!(parse(&args(&["start", "--task", "x", "--outlive=yes"])).is_err());
        assert!(parse(&args(&[])).is_err());
        assert!(parse(&args(&["list"])).is_err());
    }

    #[test]
    fn send_takes_a_name_and_one_text_with_interrupt_and_json_before_it() {
        assert_eq!(
            parse(&args(&["send", "worker", "do this\nand that"])),
            Ok(Command::Send(SendText {
                child: "worker".to_owned(),
                text: "do this\nand that".to_owned(),
                interrupt: false,
                wait: false,
                json: false,
            }))
        );
        assert_eq!(
            parse(&args(&["send", "--interrupt", "--json", "worker", "stop"])),
            Ok(Command::Send(SendText {
                child: "worker".to_owned(),
                text: "stop".to_owned(),
                interrupt: true,
                wait: false,
                json: true,
            }))
        );
        // After `--` the text is the text, dashes and all.
        assert_eq!(
            parse(&args(&["send", "worker", "--", "--interrupt is a flag"])),
            Ok(Command::Send(SendText {
                child: "worker".to_owned(),
                text: "--interrupt is a flag".to_owned(),
                interrupt: false,
                wait: false,
                json: false,
            }))
        );
    }

    #[test]
    fn send_without_a_name_or_a_text_or_with_a_second_text_or_an_unknown_option_is_a_usage_error() {
        for bad in [
            vec!["send"],
            vec!["send", "worker"],
            vec!["send", "worker", "  "],
            vec!["send", "worker", "one", "two"],
            vec!["send", "worker", "--", "one", "two"],
            vec!["send", "worker", "one", "--", "two"],
            vec!["send", "--wait=yes", "worker", "text"],
            vec!["send", "--force", "worker", "text"],
        ] {
            assert!(parse(&args(&bad)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn send_takes_wait_and_asks_for_it_only_when_given() {
        let Ok(Command::Send(send)) = parse(&args(&["send", "--wait", "worker", "text"])) else {
            panic!("send --wait parses");
        };
        assert!(send.wait);
        assert_eq!(
            send_arguments(&send),
            json!({ "child": "worker", "text": "text", "wait": true })
        );
        assert!(send_arguments(&SendText::default()).get("wait").is_none());
    }

    #[test]
    fn send_calls_the_send_tool_with_the_name_the_text_and_interrupt_only_when_asked() {
        let sent = SendText {
            child: "worker".to_owned(),
            text: "hello".to_owned(),
            interrupt: false,
            wait: false,
            json: false,
        };
        assert_eq!(
            send_arguments(&sent),
            json!({ "child": "worker", "text": "hello" })
        );
        assert_eq!(
            send_arguments(&SendText {
                interrupt: true,
                wait: false,
                ..sent.clone()
            }),
            json!({ "child": "worker", "text": "hello", "interrupt": true })
        );
        let host = host(vec![
            rpc_result(json!({})),
            tool_answer(
                false,
                &[
                    "Sent to worker.",
                    r#"{"sent":"worker","interrupted":false}"#,
                ],
            ),
        ]);
        assert_eq!(
            execute(&Command::Send(sent), &host.url, "t"),
            Outcome::done("Sent to worker.".to_owned())
        );
    }

    #[test]
    fn read_takes_a_name_with_lines_and_json_in_any_order() {
        assert_eq!(
            parse(&args(&["read", "worker"])),
            Ok(Command::Read(ReadScreen {
                child: "worker".to_owned(),
                lines: None,
                json: false,
            }))
        );
        assert_eq!(
            parse(&args(&["read", "--lines", "120", "worker", "--json"])),
            Ok(Command::Read(ReadScreen {
                child: "worker".to_owned(),
                lines: Some(120),
                json: true,
            }))
        );
        assert_eq!(
            parse(&args(&["read", "worker", "--lines=0"])),
            Ok(Command::Read(ReadScreen {
                child: "worker".to_owned(),
                lines: Some(0),
                json: false,
            }))
        );
    }

    #[test]
    fn read_without_a_name_or_with_a_bad_number_or_a_second_name_is_a_usage_error() {
        for bad in [
            vec!["read"],
            vec!["read", "  "],
            vec!["read", "a", "b"],
            vec!["read", "--lines", "worker"],
            vec!["read", "--lines", "-3", "worker"],
            vec!["read", "worker", "--lines"],
            vec!["read", "--json=1", "worker"],
            vec!["read", "--all", "worker"],
        ] {
            assert!(parse(&args(&bad)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn read_calls_the_read_tool_with_lines_only_when_asked_and_prints_the_screen_as_it_is() {
        let read = ReadScreen {
            child: "worker".to_owned(),
            lines: None,
            json: false,
        };
        assert_eq!(read_arguments(&read), json!({ "child": "worker" }));
        assert_eq!(
            read_arguments(&ReadScreen {
                lines: Some(5),
                ..read.clone()
            }),
            json!({ "child": "worker", "lines": 5 })
        );
        let host = host(vec![
            rpc_result(json!({})),
            tool_answer(
                false,
                &["one\ntwo", r#"{"name":"worker","lines":["one","two"]}"#],
            ),
        ]);
        assert_eq!(
            execute(&Command::Read(read), &host.url, "t"),
            Outcome::done("one\ntwo".to_owned())
        );
    }

    #[test]
    fn stop_takes_one_name_and_a_json_flag() {
        assert_eq!(
            parse(&args(&["stop", "agent-2", "--json"])),
            Ok(Command::Stop(Stop {
                child: "agent-2".to_owned(),
                json: true
            }))
        );
        assert!(parse(&args(&["stop"])).is_err());
        assert!(parse(&args(&["stop", "a", "b"])).is_err());
        assert!(parse(&args(&["stop", "--force", "a"])).is_err());
    }

    #[test]
    fn the_token_goes_only_to_a_loopback_address() {
        let ok = endpoint_of("http://127.0.0.1:4321/mcp/agents").expect("loopback");
        assert_eq!(ok.address, "127.0.0.1:4321".parse().unwrap());
        assert_eq!(ok.path, "/mcp/agents");
        assert!(endpoint_of("http://[::1]:4321/mcp/agents").is_ok());
        for refused in [
            "http://192.0.2.7:4321/mcp/agents",
            "https://127.0.0.1:4321/mcp/agents",
            "127.0.0.1:4321/mcp/agents",
            "http://127.0.0.1/mcp/agents",
        ] {
            assert!(endpoint_of(refused).is_err(), "{refused}");
        }
    }

    #[test]
    fn a_chunked_answer_and_an_event_stream_are_read() {
        let chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n\
            5\r\nhello\r\n6;ext=1\r\n world\r\n0\r\n\r\n";
        let reply = parse_reply(chunked).expect("a reply");
        assert_eq!(
            (reply.status, reply.body.as_slice()),
            (200, &b"hello world"[..])
        );
        let stream = json_of(
            b"event: message\ndata: {\"id\":2,\"result\":{\"ok\":1}}\n\n",
            2,
        )
        .expect("data");
        assert_eq!(stream["result"]["ok"], 1);
        assert!(parse_reply(b"HTTP/1.1 200 OK").is_err());
    }

    #[test]
    fn the_answer_in_an_event_stream_is_the_event_for_this_request_not_a_progress_event() {
        let progress =
            "data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\",\"params\":{}}\n\n";
        let result = "data: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"ok\":1}}\n\n";
        let stream = format!("{progress}{result}");
        assert_eq!(
            json_of(stream.as_bytes(), 2).expect("the result")["result"]["ok"],
            1
        );

        // A stream cut off after its progress events has no answer, and says
        // that the command can be run again, never an empty success.
        assert_eq!(json_of(progress.as_bytes(), 2), Err(CUT_OFF.to_owned()));
        // An answer to another request is not this one's.
        assert_eq!(json_of(result.as_bytes(), 3), Err(CUT_OFF.to_owned()));
    }

    /// A host that answers `answers` in turn over loopback and records what it
    /// was sent.
    struct Host {
        url: String,
        seen: Arc<Mutex<Vec<String>>>,
    }

    fn host(answers: Vec<(u16, String)>) -> Host {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let url = format!("http://{}/mcp/agents", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = Arc::clone(&seen);
        std::thread::spawn(move || {
            for (status, body) in answers {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let mut request = Vec::new();
                let mut buffer = [0u8; 4096];
                loop {
                    let read = stream.read(&mut buffer).unwrap_or(0);
                    request.extend_from_slice(&buffer[..read]);
                    let text = String::from_utf8_lossy(&request).into_owned();
                    let Some(at) = text.find("\r\n\r\n") else {
                        if read == 0 {
                            break;
                        }
                        continue;
                    };
                    let length = text
                        .lines()
                        .find_map(|line| line.strip_prefix("Content-Length: "))
                        .and_then(|value| value.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if request.len() >= at + 4 + length || read == 0 {
                        break;
                    }
                }
                record
                    .lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&request).into_owned());
                let reply = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(reply.as_bytes());
            }
        });
        Host { url, seen }
    }

    fn rpc_result(result: Value) -> (u16, String) {
        (
            200,
            json!({ "jsonrpc": "2.0", "id": 1, "result": result }).to_string(),
        )
    }

    fn tool_answer(failed: bool, texts: &[&str]) -> (u16, String) {
        rpc_result(json!({
            "isError": failed,
            "content": texts.iter().map(|text| json!({ "type": "text", "text": text })).collect::<Vec<_>>(),
        }))
    }

    fn start_command(json: bool) -> Command {
        Command::Start(Start {
            task: "do it".to_owned(),
            json,
            ..Start::default()
        })
    }

    #[test]
    fn start_prints_the_childs_name_or_with_json_the_tools_answer_and_sends_the_token() {
        let reply = r#"{"name":"agent","backend":"b"}"#;
        let host = host(vec![
            rpc_result(json!({})),
            tool_answer(false, &["Started agent.", reply]),
            rpc_result(json!({})),
            tool_answer(false, &["Started agent.", reply]),
        ]);
        let text = execute(&start_command(false), &host.url, "secret-token");
        assert_eq!(text, Outcome::done("agent".to_owned()));
        let json = execute(&start_command(true), &host.url, "secret-token");
        assert_eq!(json, Outcome::done(reply.to_owned()));
        let seen = host.seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 4);
        assert!(
            seen.iter()
                .all(|request| request.contains("Authorization: Bearer secret-token"))
        );
        assert!(seen[1].contains("\"agents_start\"") && seen[1].contains("\"do it\""));
    }

    fn wait_command(all: bool, json: bool) -> Command {
        Command::Wait(Wait {
            all,
            children: vec!["reviewer".to_owned()],
            json,
        })
    }

    #[test]
    fn wait_prints_the_news_or_with_json_the_tools_answer_and_marks_the_request_as_from_a_shell() {
        let news = "reviewer reported done: Fixed both bugs.";
        let structured = r#"{"news":[{"child":"reviewer","event":"report","state":"done","text":"Fixed both bugs."}],"working":[],"ended":"news"}"#;
        let host = host(vec![
            rpc_result(json!({})),
            tool_answer(false, &[news, structured]),
            rpc_result(json!({})),
            tool_answer(false, &[news, structured]),
        ]);
        assert_eq!(
            execute(&wait_command(true, false), &host.url, "t"),
            Outcome::done(news.to_owned())
        );
        assert_eq!(
            execute(&wait_command(false, true), &host.url, "t"),
            Outcome::done(structured.to_owned())
        );
        let seen = host.seen.lock().unwrap().clone();
        assert!(seen[1].contains("\"agents_wait\""));
        assert!(seen[1].contains("\"for\":\"all\"") && seen[1].contains("\"reviewer\""));
        assert!(seen[3].contains("\"for\":\"any\""));
        assert!(
            seen.iter()
                .all(|request| request.contains("x-floti-shell: 1")),
            "{seen:?}"
        );
    }

    #[test]
    fn a_refused_wait_exits_non_zero_with_the_reason() {
        let host = host(vec![
            rpc_result(json!({})),
            tool_answer(
                true,
                &["ghost is not one of your agents. Yours are: reviewer."],
            ),
        ]);
        let outcome = execute(&wait_command(false, false), &host.url, "t");
        assert_eq!(outcome.code, 1);
        assert_eq!(outcome.out, None);
        assert_eq!(
            outcome.err.as_deref(),
            Some("ghost is not one of your agents. Yours are: reviewer.")
        );
    }

    #[test]
    fn start_with_wait_prints_the_name_and_then_the_news() {
        let text = "Started reviewer.\nname: reviewer\n\nreviewer reported done: ok";
        let structured = r#"{"name":"reviewer","news":[],"working":[],"ended":"news"}"#;
        let host = host(vec![
            rpc_result(json!({})),
            tool_answer(false, &[text, structured]),
        ]);
        let command = Command::Start(Start {
            task: "t".to_owned(),
            wait: true,
            ..Start::default()
        });
        assert_eq!(
            execute(&command, &host.url, "t"),
            Outcome::done("reviewer\nreviewer reported done: ok".to_owned())
        );
        assert!(host.seen.lock().unwrap()[1].contains("\"wait\":true"));
    }

    #[test]
    fn run_takes_its_options_then_everything_after_the_double_dash_as_the_command() {
        assert_eq!(
            parse(&args(&[
                "run", "--name", "tests", "--wait", "--json", "--", "pnpm", "test", "--name", "x",
            ])),
            Ok(Command::Run(Run {
                command: args(&["pnpm", "test", "--name", "x"]),
                name: Some("tests".to_owned()),
                wait: true,
                json: true,
            }))
        );
        assert_eq!(
            parse(&args(&[
                "run",
                "--name=a b",
                "--",
                "pnpm test && echo done"
            ])),
            Ok(Command::Run(Run {
                command: args(&["pnpm test && echo done"]),
                name: Some("a b".to_owned()),
                ..Run::default()
            }))
        );
    }

    #[test]
    fn run_without_a_command_or_with_an_option_it_does_not_have_is_refused() {
        for bad in [
            vec!["run"],
            vec!["run", "--name", "x"],
            vec!["run", "--"],
            vec!["run", "--", "  "],
            vec!["run", "--name"],
            vec!["run", "--wait=yes", "--", "ls"],
            vec!["run", "--folder", "x", "--", "ls"],
            vec!["run", "pnpm", "test"],
        ] {
            let refused = parse(&args(&bad)).unwrap_err();
            assert!(!refused.is_empty(), "{bad:?}");
        }
        assert!(
            parse(&args(&["run", "--name", "x"]))
                .unwrap_err()
                .contains("Give the command after --")
        );
    }

    #[test]
    fn run_calls_agents_run_with_its_words_name_and_wait() {
        let host = host(vec![
            rpc_result(json!({})),
            tool_answer(false, &["Started tests.", r#"{"name":"tests"}"#]),
        ]);
        let command = Command::Run(Run {
            command: args(&["pnpm", "test"]),
            name: Some("tests".to_owned()),
            wait: false,
            json: false,
        });
        assert_eq!(
            execute(&command, &host.url, "t"),
            Outcome::done("tests".to_owned())
        );
        let seen = host.seen.lock().unwrap().clone();
        assert!(seen[1].contains("\"agents_run\""), "{seen:?}");
        assert!(seen[1].contains(r#""command":["pnpm","test"]"#), "{seen:?}");
        assert!(seen[1].contains(r#""name":"tests""#), "{seen:?}");
        assert!(!seen[1].contains("\"wait\""), "{seen:?}");
        assert!(seen[1].contains("x-floti-shell: 1"), "{seen:?}");
    }

    #[test]
    fn run_with_wait_prints_the_name_and_the_news_and_exits_with_the_commands_code() {
        let text =
            "Started tests.\nname: tests\n\ntests ended with exit code 3. Its last lines:\nline 1";
        let structured = |code: Value| {
            json!({
                "name": "tests",
                "news": [{ "child": "tests", "event": "ended", "exitCode": code, "lastLines": ["line 1"] }],
                "working": [],
                "ended": "news",
            })
            .to_string()
        };
        for (code, wanted) in [
            (json!(0), 0),
            (json!(3), 3),
            (json!(255), 255),
            (json!(256), 1),
            (json!(-1), 1),
        ] {
            let host = host(vec![
                rpc_result(json!({})),
                tool_answer(false, &[text, &structured(code.clone())]),
            ]);
            let command = Command::Run(Run {
                command: args(&["pnpm", "test"]),
                wait: true,
                ..Run::default()
            });
            let outcome = execute(&command, &host.url, "t");
            assert_eq!(outcome.code, wanted, "{code}");
            assert_eq!(
                outcome.out.as_deref(),
                Some("tests\ntests ended with exit code 3. Its last lines:\nline 1")
            );
            assert!(host.seen.lock().unwrap()[1].contains("\"wait\":true"));
        }

        // With --json the answer is the tool's, and the status is the same.
        let as_json = host(vec![
            rpc_result(json!({})),
            tool_answer(false, &[text, &structured(json!(5))]),
        ]);
        let command = Command::Run(Run {
            command: args(&["pnpm"]),
            wait: true,
            json: true,
            ..Run::default()
        });
        let outcome = execute(&command, &as_json.url, "t");
        assert_eq!(outcome.code, 5);
        assert_eq!(outcome.out, Some(structured(json!(5))));

        // A command that was stopped, or not waited out, has no code to give.
        for news in [
            json!([{ "child": "tests", "event": "ended", "state": "stopped" }]),
            json!([]),
        ] {
            let host = host(vec![
                rpc_result(json!({})),
                tool_answer(
                    false,
                    &[
                        "Started tests.\n\nNothing new yet.",
                        &json!({ "name": "tests", "news": news }).to_string(),
                    ],
                ),
            ]);
            let command = Command::Run(Run {
                command: args(&["pnpm"]),
                wait: true,
                ..Run::default()
            });
            assert_eq!(execute(&command, &host.url, "t").code, 1);
        }
    }

    #[test]
    fn run_without_wait_exits_zero_whatever_the_answer_says_of_a_code() {
        let host = host(vec![
            rpc_result(json!({})),
            tool_answer(false, &["Started tests.", r#"{"name":"tests"}"#]),
        ]);
        let command = Command::Run(Run {
            command: args(&["pnpm"]),
            ..Run::default()
        });
        assert_eq!(execute(&command, &host.url, "t").code, 0);
    }

    #[test]
    fn a_refusal_is_printed_to_standard_error_and_exits_non_zero_without_the_token() {
        let host = host(vec![
            rpc_result(json!({})),
            tool_answer(true, &["The limit of 4 running agents per parent holds."]),
        ]);
        let outcome = execute(&start_command(false), &host.url, "secret-token");
        assert_eq!(outcome.code, 1);
        assert_eq!(outcome.out, None);
        assert_eq!(
            outcome.err.as_deref(),
            Some("The limit of 4 running agents per parent holds.")
        );
        assert!(!format!("{outcome:?}").contains("secret-token"));
    }

    #[test]
    fn an_unauthorised_or_missing_route_is_said_plainly_and_names_no_token() {
        for (status, wanted) in [(401, "token"), (404, "no agents")] {
            let host = host(vec![(status, String::new())]);
            let outcome = execute(&start_command(false), &host.url, "secret-token");
            assert_eq!(outcome.code, 1, "{status}");
            let message = outcome.err.expect("a message");
            assert!(message.contains(wanted), "{message}");
            assert!(!message.contains("secret-token"), "{message}");
        }
    }

    #[test]
    fn stop_prints_the_tools_text_and_a_host_that_is_not_there_is_a_refusal() {
        let host = host(vec![
            rpc_result(json!({})),
            tool_answer(
                false,
                &["Stopped agent.", r#"{"stopped":"agent","also":[]}"#],
            ),
        ]);
        let stop = Command::Stop(Stop {
            child: "agent".to_owned(),
            json: false,
        });
        assert_eq!(
            execute(&stop, &host.url, "t"),
            Outcome::done("Stopped agent.".to_owned())
        );
        // Nothing listens there now.
        let gone = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/mcp/agents", gone.local_addr().unwrap());
        drop(gone);
        assert_eq!(execute(&stop, &url, "t").code, 1);
    }
}
