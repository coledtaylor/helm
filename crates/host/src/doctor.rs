//! `floti doctor`: whether each host this device uses answers.
//!
//! It checks this computer's host through its local socket and each host on
//! another computer this device added through that host's own transport
//! (the user's `ssh -o BatchMode=yes <target>`, or the command the user
//! gave), exactly as a client reaches it: the Noise handshake, `hello`, and
//! one `host:ping`, timed. It prints one line per host, this computer's
//! first: that it answers, with its floti version and the round trip, or
//! why not. For a transport that failed, that is the last line ssh or the
//! command wrote on standard error, unedited, and the line to try by hand
//! in a terminal (`ssh build-box floti connect`, or the command followed by
//! `floti connect`). It exits with [`DoctorExit::NotAnswering`] when any host
//! does not answer.
//!
//! It starts no host, pins and pairs nothing, retries nothing, and reads or
//! writes nothing of ssh's own setup: a host on another computer is reached
//! with the device key and pinned host key in the client folder kept for it,
//! read only, and one whose folder holds no pinned key is reported as not
//! added yet. This computer's host is reached with a key made for the one
//! check and kept nowhere.
//!
//! `floti doctor --record` is how it learns the hosts on other computers:
//! the desktop runs it whenever its hosts change, with them as JSON on
//! standard input ([`RecordedHost`]), and it writes them, owner-only, as
//! [`HOSTS_FILE`] in the data folder. Nothing in it is secret: a name, how
//! the host is reached, the full path of floti there when one was given, and
//! the client folder kept for it. The host process never reads it.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use floti_protocol::channels::host::HostPing;
use floti_protocol::message::ClientKind;
use floti_protocol::noise::KeyPair;
use serde::{Deserialize, Serialize};
use tokio::task::JoinSet;

use crate::bridge::{Transport, reach_through, remote_floti_problem};
use crate::client::{self, ClientError, ClientKeys, Connection, TRANSPORT_HANDSHAKE_DEADLINE};
use crate::platform::folders::{self, Folders, UserEnv};
use crate::platform::private_files::{Native as NativeFiles, PrivateFiles};
use crate::server::{host_public_key, local_endpoint};

/// The hosts on other computers `floti doctor` checks, in the data folder.
pub const HOSTS_FILE: &str = "hosts.json";

/// What every line about this computer's host starts with.
pub const THIS_PC: &str = "This PC";

/// The name `floti doctor` says `hello` with.
const CLIENT_NAME: &str = "floti doctor";

/// How long a host on this computer has to answer.
const LOCAL_DEADLINE: Duration = Duration::from_secs(10);

/// How `floti doctor` ended, which is its exit status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DoctorExit {
    /// Every host answered, or the hosts were recorded.
    Answered,
    /// A host did not answer.
    NotAnswering,
    /// The command line was not `floti doctor [--record]`.
    Usage,
    /// The hosts could not be recorded or read: standard input that is not
    /// the hosts, a folder that does not resolve, a file that could not be
    /// written.
    Failed,
}

impl DoctorExit {
    pub fn code(self) -> u8 {
        match self {
            Self::Answered => 0,
            Self::NotAnswering => 1,
            Self::Usage => 2,
            Self::Failed => 3,
        }
    }
}

/// A host on another computer this device added, as the desktop keeps it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedHost {
    pub id: String,
    /// What every surface calls it.
    pub name: String,
    pub transport: RecordedTransport,
    /// The full path of floti on that computer, for a login whose `PATH`
    /// does not have it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub floti: Option<String>,
    /// The client folder this device keeps for it: its device key and the
    /// host key it pinned.
    pub folder: PathBuf,
}

/// How a host on another computer is reached.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RecordedTransport {
    /// The user's own `ssh`, given the target exactly as typed.
    Ssh { target: String },
    /// A command that carries bytes unchanged, as its words.
    Command {
        program: String,
        #[serde(default)]
        args: Vec<String>,
    },
}

impl RecordedHost {
    /// The transport that reaches it: `ssh -o BatchMode=yes <target>`, so
    /// ssh never asks for a password, or the command as given.
    pub fn transport(&self) -> Transport {
        let (program, args): (String, Vec<String>) = match &self.transport {
            RecordedTransport::Ssh { target } => (
                "ssh".to_owned(),
                vec!["-o".to_owned(), "BatchMode=yes".to_owned(), target.clone()],
            ),
            RecordedTransport::Command { program, args } => (program.clone(), args.clone()),
        };
        Transport {
            program: program.into(),
            args: args.into_iter().map(Into::into).collect(),
            floti: self.floti.clone(),
        }
    }

    /// The line to try by hand in a terminal: the transport as typed, then
    /// the line it runs there (`ssh build-box floti connect`, or the command
    /// followed by `floti connect`).
    pub fn line_to_try(&self) -> String {
        let words: Vec<&str> = match &self.transport {
            RecordedTransport::Ssh { target } => vec!["ssh", target],
            RecordedTransport::Command { program, args } => std::iter::once(program.as_str())
                .chain(args.iter().map(String::as_str))
                .collect(),
        };
        let typed: Vec<String> = words.into_iter().map(shell_word).collect();
        format!("{} {}", typed.join(" "), self.transport().line("connect"))
    }

    /// Why it cannot be recorded, or `None`.
    fn problem(&self) -> Option<String> {
        if self.name.trim().is_empty() {
            return Some(format!("host {} has no name", self.id));
        }
        if !self.folder.is_absolute() {
            return Some(format!(
                "{}'s client folder, {}, is not a full path",
                self.name,
                self.folder.display()
            ));
        }
        let empty = match &self.transport {
            RecordedTransport::Ssh { target } => target.trim().is_empty(),
            RecordedTransport::Command { program, .. } => program.trim().is_empty(),
        };
        if empty {
            return Some(format!("{} has no ssh target or command", self.name));
        }
        self.floti
            .as_deref()
            .and_then(remote_floti_problem)
            .map(|problem| format!("{}: {problem}", self.name))
    }
}

/// `word` as a terminal would read it back as one word: as it is, or in
/// double quotes when it holds a blank or a quote.
fn shell_word(word: &str) -> String {
    if !word.is_empty() && !word.contains(|c: char| c.is_whitespace() || c == '"' || c == '\'') {
        return word.to_owned();
    }
    format!("\"{}\"", word.replace('"', "\\\""))
}

/// What `floti doctor` was asked to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DoctorStep {
    /// Check every host and print one line for each.
    Check,
    /// Record the hosts on standard input.
    Record,
}

/// Runs `floti doctor` for `step` and says how it ended.
pub fn run_doctor(step: DoctorStep) -> DoctorExit {
    let folders = match folders::resolve(&UserEnv::from_process()) {
        Ok(folders) => folders,
        Err(err) => return fail(&err.to_string()),
    };
    match step {
        DoctorStep::Record => {
            let mut input = Vec::new();
            if let Err(err) = std::io::stdin().lock().read_to_end(&mut input) {
                return fail(&format!("could not read standard input: {err}"));
            }
            match record(&folders.data, &input) {
                Ok(()) => DoctorExit::Answered,
                Err(why) => fail(&why),
            }
        }
        DoctorStep::Check => {
            let hosts = match recorded(&folders.data) {
                Ok(hosts) => hosts,
                Err(why) => return fail(&why),
            };
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(err) => return fail(&format!("could not start: {err}")),
            };
            let lines = runtime.block_on(check(folders, hosts));
            runtime.shutdown_background();
            let mut out = std::io::stdout().lock();
            let mut answered = true;
            for line in &lines {
                answered &= line.answered;
                let _ = writeln!(out, "{}", line.text);
            }
            let _ = out.flush();
            if answered {
                DoctorExit::Answered
            } else {
                DoctorExit::NotAnswering
            }
        }
    }
}

/// Writes `input`, the hosts as JSON, to [`HOSTS_FILE`] in `data`,
/// owner-only, or says why not.
pub fn record(data: &Path, input: &[u8]) -> Result<(), String> {
    let hosts: Vec<RecordedHost> = serde_json::from_slice(input)
        .map_err(|err| format!("standard input is not a list of hosts: {err}"))?;
    if let Some(problem) = hosts.iter().find_map(RecordedHost::problem) {
        return Err(problem);
    }
    let text = serde_json::to_vec_pretty(&hosts).map_err(|err| err.to_string())?;
    std::fs::create_dir_all(data)
        .map_err(|err| format!("could not make {}: {err}", data.display()))?;
    NativeFiles
        .write(&data.join(HOSTS_FILE), &text)
        .map_err(|err| err.to_string())
}

/// The hosts recorded in `data`; none before the first record.
pub fn recorded(data: &Path) -> Result<Vec<RecordedHost>, String> {
    let path = data.join(HOSTS_FILE);
    match NativeFiles.read(&path).map_err(|err| err.to_string())? {
        None => Ok(Vec::new()),
        Some(bytes) => serde_json::from_slice(&bytes)
            .map_err(|err| format!("{} does not hold the hosts: {err}", path.display())),
    }
}

/// One host's line.
#[derive(Debug, Clone)]
struct Line {
    text: String,
    answered: bool,
}

/// Checks this computer's host and each of `hosts` at once, and gives their
/// lines in that order.
async fn check(folders: Folders, hosts: Vec<RecordedHost>) -> Vec<Line> {
    let mut checks = JoinSet::new();
    checks.spawn(async move { (0, check_local(&folders).await) });
    for (at, host) in hosts.into_iter().enumerate() {
        checks.spawn(async move { (at + 1, check_remote(&host).await) });
    }
    let mut lines: Vec<(usize, Line)> = Vec::new();
    while let Some(done) = checks.join_next().await {
        if let Ok(line) = done {
            lines.push(line);
        }
    }
    lines.sort_by_key(|(at, _)| *at);
    lines.into_iter().map(|(_, line)| line).collect()
}

async fn check_local(folders: &Folders) -> Line {
    let not_answering = |why: &str| Line {
        text: format!("{THIS_PC}: does not answer: {why}"),
        answered: false,
    };
    let host = match host_public_key(&folders.data) {
        Ok(Some(host)) => host,
        Ok(None) => return not_answering("no Floti host has started on this computer yet."),
        Err(err) => return not_answering(&err.to_string()),
    };
    let device = match KeyPair::generate() {
        Ok(device) => device,
        Err(err) => return not_answering(&err.to_string()),
    };
    let endpoint = local_endpoint(folders);
    let reached = tokio::time::timeout(LOCAL_DEADLINE, async {
        let connection = client::connect(&endpoint, &device, &host).await?;
        ping(connection).await
    })
    .await;
    match reached {
        Ok(Ok(answer)) => answer.line(THIS_PC),
        Ok(Err(ClientError::Unreachable { .. })) => {
            not_answering("no Floti host is running on this computer.")
        }
        Ok(Err(err)) => not_answering(&err.to_string()),
        Err(_) => not_answering(&format!("it did not answer within {LOCAL_DEADLINE:?}.")),
    }
}

async fn check_remote(host: &RecordedHost) -> Line {
    let keys = match ClientKeys::open_pinned(&host.folder) {
        Ok(Some(keys)) => keys,
        Ok(None) => {
            return Line {
                text: format!(
                    "{}: not added yet: this device has not connected to it, so it holds no key to check it by.",
                    host.name
                ),
                answered: false,
            };
        }
        Err(err) => {
            return Line {
                text: format!("{}: does not answer: {err}", host.name),
                answered: false,
            };
        }
    };
    let not_answering = |said: &str| Line {
        text: format!(
            "{}: does not answer: {said} | try by hand: {}",
            host.name,
            host.line_to_try()
        ),
        answered: false,
    };
    let (connection, running) = match reach_through(&keys, &host.transport()).await {
        Ok(reached) => reached,
        Err(said) => return not_answering(&said),
    };
    let answer = tokio::time::timeout(TRANSPORT_HANDSHAKE_DEADLINE, ping(connection)).await;
    running.finish().await;
    match answer {
        Ok(Ok(answer)) => answer.line(&host.name),
        Ok(Err(err)) => not_answering(&err.to_string()),
        Err(_) => not_answering(&format!(
            "it did not answer within {TRANSPORT_HANDSHAKE_DEADLINE:?}."
        )),
    }
}

/// What a host that answered said.
struct Answer {
    version: String,
    round_trip: Duration,
}

impl Answer {
    fn line(&self, name: &str) -> Line {
        Line {
            text: format!(
                "{name}: answers, floti {}, {} ms round trip",
                self.version,
                self.round_trip.as_millis()
            ),
            answered: true,
        }
    }
}

/// Says `hello` on `connection`, times one `host:ping`, and closes it.
async fn ping(mut connection: Connection) -> Result<Answer, ClientError> {
    let welcome = connection.say_hello(CLIENT_NAME, ClientKind::Tui).await?;
    let sent = Instant::now();
    let answered = connection.request::<HostPing>(1, &()).await?;
    let round_trip = sent.elapsed();
    connection.close().await;
    answered.map_err(|refused| ClientError::Refused(refused.message))?;
    Ok(Answer {
        version: welcome.host_version,
        round_trip,
    })
}

/// Says `why` on standard error, as one line, and fails.
fn fail(why: &str) -> DoctorExit {
    let mut err = std::io::stderr().lock();
    let _ = writeln!(err, "floti doctor: {}", why.replace(['\r', '\n'], " "))
        .and_then(|()| err.flush());
    DoctorExit::Failed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(transport: RecordedTransport, floti: Option<&str>) -> RecordedHost {
        RecordedHost {
            id: "a1".to_owned(),
            name: "build-box".to_owned(),
            transport,
            floti: floti.map(str::to_owned),
            folder: std::env::temp_dir().join("client"),
        }
    }

    #[test]
    fn the_line_to_try_by_hand_is_the_transport_as_typed_then_the_floti_line() {
        let ssh = host(
            RecordedTransport::Ssh {
                target: "build-box".to_owned(),
            },
            None,
        );
        assert_eq!(ssh.line_to_try(), "ssh build-box floti connect");

        let command = host(
            RecordedTransport::Command {
                program: "wsl".to_owned(),
                args: vec!["-d".to_owned(), "My Distro".to_owned()],
            },
            Some("/opt/floti/floti"),
        );
        assert_eq!(
            command.line_to_try(),
            "wsl -d \"My Distro\" /opt/floti/floti connect"
        );
    }

    #[test]
    fn ssh_is_run_in_batch_mode_so_it_never_asks_for_a_password() {
        let ssh = host(
            RecordedTransport::Ssh {
                target: "me@build box".to_owned(),
            },
            None,
        );
        let transport = ssh.transport();
        assert_eq!(transport.program, "ssh");
        assert_eq!(
            transport.args,
            ["-o", "BatchMode=yes", "me@build box"].map(std::ffi::OsString::from)
        );
    }

    #[test]
    fn hosts_are_recorded_as_the_desktop_keeps_them_and_a_bad_one_is_refused() {
        let json = r#"[{"id":"a1","name":"build-box","transport":{"kind":"ssh","target":"build-box"},"folder":"/clients/a1"},
                       {"id":"b2","name":"vm","transport":{"kind":"command","program":"node","args":["carry.mjs"]},"floti":"/opt/floti","folder":"C:\\clients\\b2"}]"#;
        let hosts: Vec<RecordedHost> = serde_json::from_str(json).unwrap();
        assert_eq!(
            hosts[1].transport,
            RecordedTransport::Command {
                program: "node".to_owned(),
                args: vec!["carry.mjs".to_owned()],
            }
        );

        let relative = r#"[{"id":"a1","name":"build-box","transport":{"kind":"ssh","target":"build-box"},"folder":"clients"}]"#;
        let hosts: Vec<RecordedHost> = serde_json::from_str(relative).unwrap();
        assert!(hosts[0].problem().is_some());

        let bad_floti = host(
            RecordedTransport::Ssh {
                target: "build-box".to_owned(),
            },
            Some("floti"),
        );
        assert!(bad_floti.problem().is_some());
    }
}
