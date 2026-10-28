use std::collections::HashSet;

use floti_protocol::BackendId;
use floti_protocol::channels::sessions::{
    LiveSession, SessionActivity, SessionPort, SessionProcess, SessionResources, SessionsOverview,
};

use super::{
    HostedSessionFacts, SessionDetailInput, describe_duration, describe_session_detail,
    describe_session_gone, describe_session_listing, held_by,
};

const READ_AT: u64 = 1_787_280_000_000;

/// Every status the agent publishes.
const ACTIVITIES: [SessionActivity; 4] = [
    SessionActivity::Busy,
    SessionActivity::Shell,
    SessionActivity::Idle,
    SessionActivity::Waiting,
];

fn live() -> LiveSession {
    LiveSession {
        host_session_id: None,
        backend: BackendId::claude_code(),
        pid: 4242,
        registered: true,
        cwd: Some(r"C:\repos\api".to_owned()),
        name: Some("api".to_owned()),
        activity: Some(SessionActivity::Idle),
        waiting_for: None,
        status_since_ms: Some(READ_AT - 90_000),
        version: Some("2.1.238".to_owned()),
        entrypoint: Some("cli".to_owned()),
        started_at_ms: Some(READ_AT - 600_000),
        conversation_id: Some("fcbc98b5-5d39-41eb-aa14-e2379c06d662".to_owned()),
    }
}

fn hosted_live(pid: u32, id: u64, name: &str) -> LiveSession {
    LiveSession {
        pid,
        host_session_id: Some(id),
        name: Some(name.to_owned()),
        ..live()
    }
}

fn facts() -> HostedSessionFacts {
    HostedSessionFacts {
        host_session_id: 7,
        branch: Some("main".to_owned()),
        profile: None,
        overlays: Vec::new(),
        started_at_ms: Some(READ_AT - 600_000),
    }
}

fn overview(sessions: Vec<LiveSession>) -> SessionsOverview {
    SessionsOverview {
        sessions,
        read_at_ms: READ_AT,
    }
}

fn process(
    pid: u32,
    parent_pid: u32,
    name: &str,
    command_line: &str,
    depth: u32,
    ports: Option<Vec<u16>>,
) -> SessionProcess {
    SessionProcess {
        pid,
        parent_pid,
        name: name.to_owned(),
        command_line: Some(command_line.to_owned()),
        depth,
        ports,
    }
}

fn detail_of_hosted(resources: &SessionResources) -> String {
    let session = hosted_live(4242, 7, "api");
    let facts = facts();
    let holding = held_by(resources);
    describe_session_detail(SessionDetailInput {
        session: &session,
        hosted: Some(&facts),
        holding: Some(&holding),
        read_at_ms: READ_AT,
        is_caller: false,
    })
}

fn status_line(text: &str) -> Option<String> {
    text.lines()
        .find(|line| line.contains("status"))
        .map(str::to_owned)
}

// The listing.

#[test]
fn the_listing_marks_the_caller_from_the_id_it_was_given_and_marks_nothing_else() {
    let text = describe_session_listing(
        &overview(vec![
            hosted_live(100, 7, "mine"),
            hosted_live(200, 8, "theirs"),
        ]),
        Some(7),
    );

    assert!(text.contains("#100  \"mine\"  (this session)"), "{text}");
    assert!(text.contains("#200  \"theirs\""), "{text}");
    assert!(!text.contains("#200  \"theirs\"  (this session)"), "{text}");
    // Exactly one, whatever else is in the listing: the marking comes from the
    // bearer token upstream, and two of them would mean it had come from
    // something the caller said.
    assert_eq!(text.matches("(this session)").count(), 1, "{text}");
}

#[test]
fn the_listing_marks_nothing_when_the_caller_has_no_session_of_its_own() {
    let text = describe_session_listing(&overview(vec![hosted_live(100, 7, "api")]), None);
    assert!(!text.contains("(this session)"), "{text}");
}

#[test]
fn the_listing_lists_a_session_the_host_did_not_start_and_says_that_is_what_it_is() {
    let outside = LiveSession {
        pid: 200,
        host_session_id: None,
        name: Some("in a terminal".to_owned()),
        ..live()
    };
    let text = describe_session_listing(
        &overview(vec![hosted_live(100, 7, "hosted"), outside]),
        Some(7),
    );
    assert!(
        text.contains("2 Claude Code sessions running on this machine, 1 of them hosted by Floti."),
        "{text}"
    );
    assert!(text.contains("\"in a terminal\""), "{text}");
    assert!(
        text.contains("started somewhere else on this machine"),
        "{text}"
    );
}

#[test]
fn the_listing_says_so_rather_than_nothing_when_there_is_nothing_running() {
    let text = describe_session_listing(&overview(Vec::new()), Some(1));
    assert!(
        text.contains("No Claude Code sessions are running"),
        "{text}"
    );
}

/// The rule the whole surface inherits: a status the host could not read is
/// reported as unknown, never omitted and never guessed. An agent told
/// nothing concludes there is nothing there, and "nothing is running in this
/// directory" is exactly what somebody checks before starting a second agent.
#[test]
fn the_listing_reports_an_unreadable_status_as_unknown_rather_than_as_idle() {
    let unregistered = describe_session_listing(
        &overview(vec![LiveSession {
            host_session_id: Some(3),
            registered: false,
            activity: None,
            ..live()
        }]),
        None,
    );
    assert!(unregistered.contains("unknown"), "{unregistered}");
    assert!(
        unregistered.contains("has not written a record for it yet"),
        "{unregistered}"
    );
    assert!(!unregistered.contains("idle"), "{unregistered}");

    let no_status = describe_session_listing(
        &overview(vec![LiveSession {
            registered: true,
            activity: None,
            ..live()
        }]),
        None,
    );
    assert!(
        no_status.contains("published no status the host recognises"),
        "{no_status}"
    );
    assert!(!no_status.contains("idle"), "{no_status}");
}

/// Four statuses, four different sentences - none of them collapses onto
/// another.
#[test]
fn the_listing_gives_every_status_the_agent_publishes_its_own_words() {
    let sentences: Vec<Option<String>> = ACTIVITIES
        .iter()
        .map(|&activity| {
            let waiting_for =
                (activity == SessionActivity::Waiting).then(|| "permission prompt".to_owned());
            status_line(&describe_session_listing(
                &overview(vec![LiveSession {
                    activity: Some(activity),
                    waiting_for,
                    ..live()
                }]),
                None,
            ))
        })
        .collect();
    let distinct: HashSet<&Option<String>> = sentences.iter().collect();
    assert_eq!(distinct.len(), ACTIVITIES.len(), "{sentences:?}");
    assert!(
        sentences
            .iter()
            .flatten()
            .any(|line| line.contains("permission prompt")),
        "{sentences:?}"
    );
}

/// How long a status has held is a fact; how old the record is says nothing
/// about liveness. The first is what this prints, measured against the moment
/// the registry was read rather than against the clock now, so the number
/// belongs to the pass it came from.
#[test]
fn the_listing_says_how_long_the_status_has_held_from_the_read_that_produced_it() {
    let text = describe_session_listing(
        &overview(vec![LiveSession {
            activity: Some(SessionActivity::Busy),
            status_since_ms: Some(READ_AT - 4 * 60_000),
            ..live()
        }]),
        None,
    );
    assert!(
        text.contains("busy - the model is working, for 4m"),
        "{text}"
    );
}

#[test]
fn the_listing_leaves_the_duration_off_a_record_that_carries_no_transition_time() {
    let text = describe_session_listing(
        &overview(vec![LiveSession {
            activity: Some(SessionActivity::Busy),
            status_since_ms: None,
            ..live()
        }]),
        None,
    );
    assert!(text.contains("busy - the model is working"), "{text}");
    assert!(!text.contains(", for "), "{text}");
}

// One session in detail.

fn has_line_starting(text: &str, prefix: &str) -> bool {
    text.lines().any(|line| line.starts_with(prefix))
}

#[test]
fn detail_says_what_is_knowable_about_a_session_the_host_did_not_start_and_no_more() {
    let session = live();
    let text = describe_session_detail(SessionDetailInput {
        session: &session,
        hosted: None,
        holding: None,
        read_at_ms: READ_AT,
        is_caller: false,
    });
    assert!(text.contains("Floti did not start this session"), "{text}");
    assert!(text.contains(r"C:\repos\api"), "{text}");
    // The sentence names what is missing; what must not appear is a *field*
    // claiming to know it.
    assert!(!has_line_starting(&text, "branch "), "{text}");
    assert!(!has_line_starting(&text, "profile "), "{text}");
    assert!(!has_line_starting(&text, "host session "), "{text}");
    assert!(!has_line_starting(&text, "Holding"), "{text}");
}

#[test]
fn detail_carries_the_branch_as_the_branch_at_spawn_not_as_the_branch_now() {
    let session = hosted_live(4242, 7, "api");
    let facts = HostedSessionFacts {
        branch: Some("feat/cart".to_owned()),
        profile: Some("reviewer".to_owned()),
        overlays: vec![r"C:\repos\helm".to_owned()],
        ..facts()
    };
    let text = describe_session_detail(SessionDetailInput {
        session: &session,
        hosted: Some(&facts),
        holding: None,
        read_at_ms: READ_AT,
        is_caller: true,
    });
    assert!(text.contains("(this session)"), "{text}");
    assert!(text.contains("feat/cart (the branch at spawn"), "{text}");
    assert!(text.contains("captured and never followed"), "{text}");
    assert!(text.contains("reviewer"), "{text}");
    assert!(text.contains(r"C:\repos\helm"), "{text}");
}

/// The three answers `SessionResources` is shaped to keep apart, kept apart
/// in words. A surface that merged them would tell somebody a session is
/// holding nothing at the exact moment the host had failed to ask.
#[test]
fn detail_never_says_nothing_when_it_means_could_not_look() {
    let base = SessionResources {
        id: 7,
        root_pid: 4242,
        processes: None,
        root_seen: false,
        ports: None,
        opaque: 0,
        at_ms: READ_AT,
    };
    let blind = base.clone();
    let gone = SessionResources {
        processes: Some(Vec::new()),
        ports: Some(Vec::new()),
        ..base.clone()
    };
    let empty = SessionResources {
        root_seen: true,
        ports: Some(Vec::new()),
        processes: Some(vec![process(
            4242,
            1,
            "claude.exe",
            "claude",
            0,
            Some(Vec::new()),
        )]),
        ..base
    };

    let blind = detail_of_hosted(&blind);
    assert!(
        blind.contains("the process enumeration could not run"),
        "{blind}"
    );
    assert!(!blind.contains("nothing but the session itself"), "{blind}");
    let gone = detail_of_hosted(&gone);
    assert!(gone.contains("was not in it"), "{gone}");
    assert!(!gone.contains("nothing but the session itself"), "{gone}");
    let empty = detail_of_hosted(&empty);
    assert!(empty.contains("nothing but the session itself"), "{empty}");
    assert!(
        empty.contains("nothing in this session’s tree is listening"),
        "{empty}"
    );
}

#[test]
fn detail_keeps_a_failed_socket_query_apart_from_a_tree_that_is_listening_on_nothing() {
    let without_ports = SessionResources {
        id: 7,
        root_pid: 4242,
        root_seen: true,
        opaque: 0,
        at_ms: READ_AT,
        ports: None,
        processes: Some(vec![process(4242, 1, "claude.exe", "claude", 0, None)]),
    };
    let text = detail_of_hosted(&without_ports);
    assert!(text.contains("the socket query could not run"), "{text}");
    assert!(
        !text.contains("nothing in this session’s tree is listening"),
        "{text}"
    );
}

#[test]
fn detail_prints_the_tree_with_its_ports_and_admits_what_it_could_not_read() {
    let resources = SessionResources {
        id: 7,
        root_pid: 4242,
        root_seen: true,
        opaque: 1,
        at_ms: READ_AT - 2000,
        ports: Some(vec![SessionPort {
            port: 5173,
            pid: 9002,
            process: "node.exe".to_owned(),
            addresses: vec!["127.0.0.1".to_owned()],
        }]),
        processes: Some(vec![
            process(4242, 1, "claude.exe", "claude", 0, Some(Vec::new())),
            process(
                9001,
                4242,
                "docker.exe",
                "docker compose up",
                1,
                Some(Vec::new()),
            ),
            // A prompt on the process table, which is what a subagent looks
            // like from outside and the sharpest reason a tool may not print
            // these.
            process(
                9002,
                9001,
                "node.exe",
                "claude -p \"summarise the vite config\"",
                2,
                Some(vec![5173]),
            ),
        ]),
    };
    let text = detail_of_hosted(&resources);

    assert!(text.contains("2 processes under it"), "{text}");
    assert!(text.contains("docker.exe #9001"), "{text}");
    assert!(text.contains("node.exe #9002"), "{text}");
    assert!(text.contains("listening on 5173"), "{text}");

    // And **no command line**, which is the argv decision one level down.
    //
    // A child process's command line can be another conversation - a
    // subagent is `claude -p "<prompt>"` - or a credential passed as an
    // argument, and it is more than the question this tool answers:
    // `docker.exe` and the port already say "somebody is holding this tree".
    // The mechanism is that `HeldProcess` has no field for one, so this is
    // asserting that `held_by` really is the only route in.
    assert!(!text.contains("docker compose up"), "{text}");
    assert!(!text.contains("summarise the vite config"), "{text}");
    assert!(!text.contains("claude -p"), "{text}");
    // The fixture is discriminating: the pass it was built from does carry
    // those strings, so their absence above is a fact about the shaping.
    assert!(
        resources
            .processes
            .iter()
            .flatten()
            .any(|row| row.command_line.as_deref() == Some("docker compose up"))
    );
    // The root itself is not printed as one of its own children.
    assert!(!text.contains("claude.exe #4242"), "{text}");
    assert!(text.contains("the host last looked 2s ago"), "{text}");
}

#[test]
fn detail_says_a_pid_nothing_is_running_under_is_gone_rather_than_inventing_an_answer() {
    let text = describe_session_gone(1234);
    assert!(
        text.contains("No Claude Code session with pid 1234"),
        "{text}"
    );
    assert!(text.contains("sessions_list"), "{text}");
}

// Durations.

#[test]
fn durations_read_the_way_a_person_would_say_them() {
    assert_eq!(describe_duration(0), "0s");
    assert_eq!(describe_duration(-5000), "0s");
    assert_eq!(describe_duration(45_000), "45s");
    assert_eq!(describe_duration(4 * 60_000), "4m");
    assert_eq!(describe_duration(90 * 60_000), "1h 30m");
    assert_eq!(describe_duration(30 * 60 * 60_000), "1d 6h");
}
