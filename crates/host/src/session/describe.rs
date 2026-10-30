//! What one session may be told about the others, in words.
//!
//! The shaping half of the host's session-awareness tools: the helm-sessions
//! family defines them and holds the token, and this decides what an answer
//! says. It is apart from the family so that it can be unit tested on plain
//! values - the tools themselves need two real sessions to say anything.
//!
//! # The rule this module exists to make structural
//!
//! **No answer may carry any part of another session's conversation** - not
//! its transcript, not its prompts, not its output. That is the direct
//! analogue of "a tool drives only the tabs its own session opened": a tool
//! that could read somebody else's conversation would be "Floti renders
//! nothing for a live session" defeated sideways, the same way a screenshot of
//! somebody else's tab would have defeated the credential rule through a
//! picture.
//!
//! A promise in a comment is not a mechanism, so the mechanism is the input
//! type. [`HostedSessionFacts`] and [`HeldProcess`] are deliberately narrow,
//! and the three fields they do **not** have are the ones a reasonable person
//! would have added - the third, a child process's command line, is argued at
//! [`HeldProcess`] itself:
//!
//! - **No argv.** `SessionRecord.argv` is right there and the sessions pane
//!   prints it, so leaving it out looks like an oversight. Two independent
//!   reasons it is not. A review session's argv carries its opening prompt
//!   verbatim - the launch puts it in as the last positional - which is
//!   another session's first user message. And every argv carries
//!   `--mcp-config <file>`, and that file holds **that session's bearer token
//!   for this very endpoint**: handing it over would hand one session the
//!   credential of another, which is the whole attribution rule undone. The
//!   pane may print argv because the pane is the user looking at their own
//!   machine. A tool is a different audience.
//! - **No conversation id.** `conversation_id` is an identifier rather than
//!   content, which is exactly why it is tempting. It is also the *filename*
//!   of the transcript under `~/.claude/projects/<slug>/`, so answering with
//!   it is handing over the map to the thing the rule forbids. It buys nothing
//!   for the question these tools exist for - who is working where, so I can
//!   stay out of their way - and resuming or addressing another session is
//!   coordination, which is explicitly out of scope.
//!
//! A future change that wanted either would have to widen this type, which is
//! where this comment is.
//!
//! # And the rule it inherits
//!
//! "Paint nothing rather than a wrong number" applies to a tool result too,
//! with the sharper edge the sessions pane already has: **a status the host
//! could not read is reported as unknown, never omitted and never guessed**,
//! because an agent told nothing will conclude there is nothing there - and
//! "nothing is running in this directory" is precisely what somebody checks
//! before starting a second agent in it.

use floti_protocol::channels::sessions::{
    LiveSession, SessionActivity, SessionPort, SessionResources, SessionsOverview,
};

#[cfg(test)]
mod tests;

/// What the host knows about one of its own sessions, beyond the registry
/// record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedSessionFacts {
    /// The host's own session row id. The session, for a user reading the
    /// answer.
    pub host_session_id: u64,
    /// The branch the working tree was on when the host spawned it.
    ///
    /// Captured at spawn and never followed, so it is what this session
    /// started on rather than what is checked out now. Said in those words in
    /// the answer, because "branch: main" that is quietly four checkouts old
    /// is worse than no branch at all.
    pub branch: Option<String>,
    /// The profile it was launched from, by name, or `None` for a direct
    /// start.
    pub profile: Option<String>,
    /// The overlay directories that profile composes. Empty when there are
    /// none.
    pub overlays: Vec<String>,
    /// When the host's own row says it started, epoch ms.
    pub started_at_ms: Option<u64>,
}

/// One process under a session, as another session may be told about it.
///
/// **Deliberately not `SessionProcess`, and the missing field is
/// `command_line`.** That is the argv decision one level down, and it took
/// the same shape for the same reasons rather than by inheritance from the
/// pane:
///
/// - A child process's command line can be **another conversation**. A
///   subagent is `claude -p "<prompt>"`, and that prompt is on the process
///   table. The rule says no prompts, and it does not stop applying because
///   the prompt arrived via the operating system.
/// - It can be a **credential**: a key passed as an argument, or a nested
///   session's own `--mcp-config` path, which is the argv trap exactly.
/// - And it is **more than the question asked for**. What this tool exists
///   to answer is "is somebody holding this tree" - a container up, a dev
///   server on 5173. `docker.exe` and the port say that. Which compose
///   project it is does not change whether an agent should stay out of the
///   way.
///
/// The counter-argument is real and was weighed: the calling agent can read
/// the process table itself, so withholding buys no absolute protection. It
/// buys the thing that matters anyway - Floti is not the one handing it over,
/// and there is no field here for a later convenience to fill. The sessions
/// **pane** prints command lines and is right to: that is a user looking at
/// their own machine. A tool is a different audience, and same data,
/// different audience, different answer is the general rule this surface
/// follows.
///
/// The other consequence is worth stating because it is a *reason* rather
/// than a cost: an unelevated process query withholds a large share of
/// command lines (roughly 58% on one Windows machine measured), so a tool
/// that returned them would be arbitrarily inconsistent about it - present
/// for some processes, absent for others, and an agent could draw nothing
/// systematic from either.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldProcess {
    pub pid: u32,
    /// The image name, such as `docker.exe`.
    pub name: String,
    /// How far below the session's own process this sits. The root is 0.
    pub depth: u32,
    /// Ports it is listening on, or `None` where the socket query could not
    /// run.
    pub ports: Option<Vec<u16>>,
}

/// What a session is holding, as another session may be told about it.
///
/// The same three states [`SessionResources`] keeps apart - could not look,
/// was not there, has nothing - because merging any two of them is how an
/// agent gets told a tree is free at the moment the host failed to ask.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionHolding {
    /// The terminal's pid: the root of the tree, and provably the host's own
    /// child.
    pub root_pid: u32,
    /// The tree under it, or `None` where the machine could not be asked at
    /// all.
    pub processes: Option<Vec<HeldProcess>>,
    /// Whether `root_pid` was in the enumeration at all.
    pub root_seen: bool,
    /// Listening sockets anywhere in the tree, or `None` where the socket
    /// query could not run.
    pub ports: Option<Vec<SessionPort>>,
    /// When the pass that produced this ran, epoch ms.
    pub at_ms: u64,
}

/// A resource pass, narrowed to what a tool may say.
///
/// The one place `SessionProcess::command_line` is dropped, so that the
/// shaping below cannot print a field it never receives. A change that wanted
/// command lines in a tool answer has to widen [`HeldProcess`] and pass them
/// through here, which is where the reasoning is.
pub fn held_by(resources: &SessionResources) -> SessionHolding {
    SessionHolding {
        root_pid: resources.root_pid,
        root_seen: resources.root_seen,
        ports: resources.ports.clone(),
        at_ms: resources.at_ms,
        processes: resources.processes.as_ref().map(|rows| {
            rows.iter()
                .map(|row| HeldProcess {
                    pid: row.pid,
                    name: row.name.clone(),
                    depth: row.depth,
                    ports: row.ports.clone(),
                })
                .collect()
        }),
    }
}

/// One session to describe in detail.
#[derive(Debug, Clone, Copy)]
pub struct SessionDetailInput<'a> {
    pub session: &'a LiveSession,
    /// The host's own facts, or `None` for a session the host did not start.
    pub hosted: Option<&'a HostedSessionFacts>,
    /// The most recent resource pass for it, or `None` where none was taken.
    ///
    /// `None` and a pass that could not look are different answers and both
    /// are said out loud; so is a pass that ran and found the session
    /// childless. See [`SessionResources`] for why those three are three.
    pub holding: Option<&'a SessionHolding>,
    /// When the registry was read, epoch ms.
    pub read_at_ms: u64,
    /// Whether this is the caller's own session, as its bearer token
    /// identifies it.
    pub is_caller: bool,
}

/// A duration a person reads, from a millisecond count. Never negative.
///
/// Not the usage reader's age, which is otherwise the same idea: that one
/// starts at minutes, because a usage window is measured in hours and a
/// status bar has no room for a second hand. Here the short end is the
/// interesting end - "waiting on you, for 3s" and "waiting on you, for 40m"
/// are the difference between a prompt somebody is about to answer and one
/// they have walked away from - and both would read "0m" there.
pub fn describe_duration(ms: i64) -> String {
    let seconds = ms.max(0).saturating_add(500) / 1000;
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("{minutes}m");
    }
    let hours = minutes / 60;
    if hours < 24 {
        return format!("{hours}h {}m", minutes % 60);
    }
    format!("{}d {}h", hours / 24, hours % 24)
}

/// How long ago `then` was, as of `now`, both epoch ms.
fn elapsed(now: u64, then: u64) -> String {
    let difference = i128::from(now) - i128::from(then);
    describe_duration(i64::try_from(difference).unwrap_or(if difference < 0 {
        0
    } else {
        i64::MAX
    }))
}

/// What a session is doing, and how long it has been doing it.
///
/// The age is the one thing here that has to be read carefully. The record is
/// written **on transition and never on a timer**, so the time since it was
/// written is exactly how long this status has held - which is the useful
/// half, and the difference between "it is working" and "it has been working
/// for fifty minutes". It says nothing whatever about whether the session is
/// still alive; that was settled before this was called, by the liveness
/// probe, and every entry that reaches here has already been through it.
fn describe_status(session: &LiveSession, read_at_ms: u64) -> String {
    let held = session
        .status_since_ms
        .map(|since| format!(", for {}", elapsed(read_at_ms, since)))
        .unwrap_or_default();

    match session.activity {
        // Two ways into this and they are different sentences, because the
        // first is a session that is fine and the second is the host
        // admitting it cannot read something. Neither is "idle", which is the
        // guess that would make an agent walk into a working tree.
        None if !session.registered => {
            "unknown - Helm started it and Claude Code has not written a record for it yet"
                .to_owned()
        }
        None => "unknown - it has registered but published no status Helm recognises".to_owned(),
        Some(SessionActivity::Waiting) => {
            // The agent's own sentence, verbatim and never matched against: it
            // comes from whatever dialog is on top. Measured values on
            // Claude Code 2.1.238 are "dialog open" and "permission prompt".
            let why = session.waiting_for.as_deref().unwrap_or("something");
            format!("waiting on the user ({why}){held}")
        }
        Some(SessionActivity::Shell) => {
            format!("shell - handed back to the user, with a background task still running{held}")
        }
        Some(SessionActivity::Busy) => format!("busy - the model is working{held}"),
        Some(SessionActivity::Idle) => {
            format!("idle - handed back to the user, nothing running{held}")
        }
    }
}

fn describe_name(session: &LiveSession) -> String {
    match session.name.as_deref() {
        None | Some("") => "(unnamed)".to_owned(),
        Some(name) => format!("\"{name}\""),
    }
}

fn describe_cwd(session: &LiveSession) -> &str {
    session
        .cwd
        .as_deref()
        .unwrap_or("unknown - the record carries no working directory")
}

fn caller_mark(is_caller: bool) -> &'static str {
    if is_caller { "  (this session)" } else { "" }
}

/// Every live session on the machine, one block each.
///
/// `caller_host_session_id` is the caller's own host session row id, or
/// `None` when it has none. It is **established from the bearer token that
/// arrived**, never from anything the caller said. That is what makes "this
/// session" a comparison rather than an honour system, and it is why no tool
/// here takes a session id at all.
///
/// **Machine-wide, and that is a decision rather than a free win.** A
/// `claude` somebody started in a terminal holds a working tree exactly as
/// hard as a hosted session does, and the argument against - that it tells
/// an agent about work the user never brought into Floti - does not survive
/// contact with the machine. **Any Claude Code session can already read
/// `~/.claude/sessions/*.json` itself**, so withholding here buys nothing
/// real; what it would buy is two surfaces of the same app contradicting each
/// other about what is running on one machine, which is worse than either
/// answer on its own. Both halves are worth keeping written down, because
/// without the first somebody re-proposes the restriction and without the
/// second it looks like laziness.
///
/// What is withheld instead is the half that is the host's to withhold:
/// nothing about a session the host did not start is invented, and nothing
/// about any session's conversation is ever returned.
///
/// It is the same rule `browser_tabs` established, arrived at from the other
/// side: listing is not driving.
pub fn describe_session_listing(
    overview: &SessionsOverview,
    caller_host_session_id: Option<u64>,
) -> String {
    let sessions = &overview.sessions;
    if sessions.is_empty() {
        // Not an empty string, and not an error. "Nothing is running" is a
        // real answer and it is the one that decides whether to start
        // something.
        return "No Claude Code sessions are running on this machine - not even this one, which means Helm read the registry and found nothing in it.".to_owned();
    }

    let hosted = sessions
        .iter()
        .filter(|session| session.host_session_id.is_some())
        .count();
    let head = format!(
        "{} Claude Code session{} running on this machine, {hosted} of them hosted by Helm.",
        sessions.len(),
        if sessions.len() == 1 { "" } else { "s" },
    );

    let blocks: Vec<String> = sessions
        .iter()
        .map(|session| {
            let is_caller =
                caller_host_session_id.is_some() && session.host_session_id == caller_host_session_id;
            let hosted = match session.host_session_id {
                None => "no - started somewhere else on this machine, so Helm knows only what Claude Code publishes about it".to_owned(),
                Some(id) => format!("yes, in Helm tab {id}"),
            };
            [
                format!(
                    "#{}  {}{}",
                    session.pid,
                    describe_name(session),
                    caller_mark(is_caller)
                ),
                format!("    working in   {}", describe_cwd(session)),
                format!("    status       {}", describe_status(session, overview.read_at_ms)),
                format!("    hosted       {hosted}"),
            ]
            .join("\n")
        })
        .collect();

    [
        head,
        "Read-only. Nothing here sends a session anything, and no tool returns any part of another session’s conversation.".to_owned(),
        String::new(),
        // A blank line between blocks: this is read by a model in one lump of
        // text, and four sessions run together are four sessions somebody has
        // to parse.
        blocks.join("\n\n"),
        String::new(),
        "session_detail takes one of the pids above.".to_owned(),
    ]
    .join("\n")
}

/// The tree and the ports, or the reason there is nothing to print.
fn describe_resources(holding: Option<&SessionHolding>, read_at_ms: u64) -> Vec<String> {
    let Some(holding) = holding else {
        return vec![
            "Holding      unknown - Helm has not looked at this machine’s processes for this session.".to_owned(),
        ];
    };

    let looked = format!(
        "Helm last looked {} ago",
        elapsed(read_at_ms, holding.at_ms)
    );

    let Some(processes) = holding.processes.as_ref() else {
        // The distinction the whole `SessionResources` shape is built around,
        // in words: this is the host failing to ask, not the machine
        // answering "nothing".
        return vec![format!(
            "Holding      unknown - the process enumeration could not run ({looked}), so this says nothing about what the session is holding rather than that it is holding nothing."
        )];
    };
    if !holding.root_seen {
        return vec![format!(
            "Holding      unknown - the pass ran but this session’s own process was not in it ({looked}), which is what a session that has just ended looks like."
        )];
    }

    let children: Vec<&HeldProcess> = processes
        .iter()
        .filter(|row| row.pid != holding.root_pid)
        .collect();
    let mut out = Vec::new();

    if children.is_empty() {
        out.push(format!(
            "Holding      nothing but the session itself - no child processes ({looked})."
        ));
    } else {
        out.push(format!(
            "Holding      {} process{} under it ({looked}):",
            children.len(),
            if children.len() == 1 { "" } else { "es" },
        ));
        // The image name, the pid and what it is listening on. No command
        // line - see `HeldProcess`, which has no field for one.
        for row in children {
            let ports = match row.ports.as_deref() {
                None | Some([]) => String::new(),
                Some(ports) => format!(
                    "  listening on {}",
                    ports
                        .iter()
                        .map(u16::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            };
            out.push(format!(
                "    {}{} #{}{ports}",
                "  ".repeat(row.depth.saturating_sub(1) as usize),
                row.name,
                row.pid,
            ));
        }
    }

    match holding.ports.as_deref() {
        None => out.push(
            "    ports        unknown - the socket query could not run, which is a separate query from the one above and fails separately.".to_owned(),
        ),
        Some([]) => {
            out.push("    ports        none - nothing in this session’s tree is listening.".to_owned());
        }
        Some(ports) => {
            for port in ports {
                let addresses = if port.addresses.is_empty() {
                    "an address Helm could not read".to_owned()
                } else {
                    port.addresses.join(", ")
                };
                out.push(format!(
                    "    port {}    {} #{} on {addresses}",
                    port.port, port.process, port.pid
                ));
            }
        }
    }
    out
}

/// One session, in as much detail as the host honestly has.
///
/// **Listing is machine-wide; detail is the host's own**, and the degradation
/// needs no special case because it is simply what is knowable: the host did
/// not spawn the other sessions, so it has no branch, no profile and no
/// process tree for them, and says so in a sentence rather than by leaving
/// fields out.
pub fn describe_session_detail(input: SessionDetailInput<'_>) -> String {
    let SessionDetailInput {
        session,
        hosted,
        holding,
        read_at_ms,
        is_caller,
    } = input;

    let mut lines = vec![
        format!(
            "#{}  {}{}",
            session.pid,
            describe_name(session),
            caller_mark(is_caller)
        ),
        String::new(),
        format!("working in   {}", describe_cwd(session)),
        format!("status       {}", describe_status(session, read_at_ms)),
    ];

    let Some(hosted) = hosted else {
        let entrypoint = session
            .entrypoint
            .as_deref()
            .map(|entrypoint| format!(", entrypoint {entrypoint}"))
            .unwrap_or_default();
        lines.push(format!(
            "Claude Code  {}{entrypoint}",
            session
                .version
                .as_deref()
                .unwrap_or("version not published")
        ));
        lines.push(String::new());
        lines.push("Helm did not start this session, so there is nothing else to know about it: no branch, no profile, no overlays, no process tree and no ports. Everything above comes from the record Claude Code writes for every session on this machine.".to_owned());
        return lines.join("\n");
    };

    let branch = match hosted.branch.as_deref() {
        None => "none - not a repository, a detached HEAD, or a read that failed".to_owned(),
        Some(branch) => format!(
            "{branch} (the branch at spawn, captured and never followed - the tree may have been checked out since)"
        ),
    };
    let overlays = if hosted.overlays.is_empty() {
        "none".to_owned()
    } else {
        hosted.overlays.join(", ")
    };
    let started = match hosted.started_at_ms {
        None => "unknown".to_owned(),
        Some(at) => format!("{} ago", elapsed(read_at_ms, at)),
    };

    lines.push(format!("Helm tab     {}", hosted.host_session_id));
    lines.push(format!("branch       {branch}"));
    lines.push(format!(
        "profile      {}",
        hosted
            .profile
            .as_deref()
            .unwrap_or("none - started straight from the project")
    ));
    lines.push(format!("overlays     {overlays}"));
    lines.push(format!("started      {started}"));
    lines.push(String::new());
    lines.extend(describe_resources(holding, read_at_ms));
    lines.join("\n")
}

/// The answer for a pid nothing on this machine is running under any more.
pub fn describe_session_gone(pid: u32) -> String {
    format!(
        "No Claude Code session with pid {pid} is running on this machine.\n\n\
         It may have ended since you listed - a session that exits removes its own record, and the host drops one whose process it cannot prove is alive. Call sessions_list again for what is running now."
    )
}
