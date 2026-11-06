//! `floti agent`: the agents family from a session's own shell.
//!
//! `floti agent start --task <text>` starts an agent of the session's own and
//! prints its name; `floti agent stop <name>` ends it. Both are the
//! `agents_start` and `agents_stop` tools called over the same endpoint a
//! session's agent tools use, so the host answers one way whoever asks and
//! the same limits, folder rule and own-children rule apply. The session is
//! known by the bearer token in `FLOTI_AGENT_TOKEN` and the address in
//! `FLOTI_AGENT_URL`, which the host puts in the environment of every session
//! it gave the agents family. Nothing here names a session: the token is the
//! whole of who is asking.
//!
//! The token goes only to a loopback address and is never printed or put in
//! an error. A refusal is printed to standard error and the exit status is 1,
//! so a script and a model both see it; with `--json` the answer is the
//! tool's JSON.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

use serde_json::{Value, json};

/// The variable that carries the family's address.
pub const URL_VAR: &str = "FLOTI_AGENT_URL";

/// The variable that carries the session's token.
pub const TOKEN_VAR: &str = "FLOTI_AGENT_TOKEN";

/// What `floti agent` accepts.
pub const USAGE: &str = "usage: floti agent start --task <text> [--role <name>] [--backend <id>] [--folder <path>] [--profile <name>] [--name <name>] [--outlive] [--can-start] [--json]\n       floti agent stop <name> [--json]";

/// How long a connection waits to be made.
const CONNECT_WAIT: Duration = Duration::from_secs(10);

/// How long an answer is waited for: a start composes a launch and a stop
/// waits for each process to end.
const ANSWER_WAIT: Duration = Duration::from_secs(120);

/// A subcommand, as parsed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Start(Start),
    Stop(Stop),
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
    pub outlive: bool,
    /// Whether `--can-start` was given; without it the role chooses.
    pub can_start: bool,
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
        return Err("Say what to do: start or stop.".to_owned());
    };
    match subcommand.as_str() {
        "start" => parse_start(rest).map(Command::Start),
        "stop" => parse_stop(rest).map(Command::Stop),
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
            "--outlive" if inline.is_none() => start.outlive = true,
            "--can-start" if inline.is_none() => start.can_start = true,
            "--json" if inline.is_none() => start.json = true,
            other => return Err(format!("`{other}` is not a floti agent start option.")),
        }
    }
    start.task = task
        .filter(|task| !task.trim().is_empty())
        .ok_or_else(|| "--task is what the agent is to do, and is required.".to_owned())?;
    Ok(start)
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
        Command::Stop(stop) => ("agents_stop", json!({ "child": stop.child }), stop.json),
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
    if json {
        return Outcome::done(structured.cloned().unwrap_or(first));
    }
    match command {
        // The child's name alone, so a script can keep it.
        Command::Start(_) => {
            let name = structured
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                .and_then(|value| value["name"].as_str().map(str::to_owned));
            Outcome::done(name.unwrap_or(first))
        }
        Command::Stop(_) => Outcome::done(first),
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
    let answer = json_of(&reply.body)?;
    if let Some(error) = answer.get("error") {
        let message = error["message"].as_str().unwrap_or("it gave no reason");
        return Err(format!("The Floti host refused {method}: {message}"));
    }
    Ok(answer["result"].clone())
}

/// The JSON a body holds: itself, or the last `data:` line of an event
/// stream.
fn json_of(body: &[u8]) -> Result<Value, String> {
    let text = String::from_utf8_lossy(body);
    if let Ok(value) = serde_json::from_str::<Value>(text.trim()) {
        return Ok(value);
    }
    text.lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .filter_map(|data| serde_json::from_str::<Value>(data.trim()).ok())
        .next_back()
        .ok_or_else(|| "The Floti host's answer was not understood.".to_owned())
}

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
         Authorization: Bearer {token}\r\nContent-Length: {length}\r\n\r\n",
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
    let malformed = || "The Floti host's answer was not understood.".to_owned();
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
                outlive: true,
                can_start: true,
                json: true,
            })
        );
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
        let stream = json_of(b"event: message\ndata: {\"result\":{\"ok\":1}}\n\n").expect("data");
        assert_eq!(stream["result"]["ok"], 1);
        assert!(parse_reply(b"HTTP/1.1 200 OK").is_err());
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
