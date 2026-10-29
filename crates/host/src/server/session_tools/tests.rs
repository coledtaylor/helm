//! The family on a world made here. What it says about real sessions, over
//! the listener, is `tests/agent_tools.rs`'s.

use std::sync::Mutex;

use floti_protocol::BackendId;
use floti_protocol::channels::sessions::SessionActivity;

use super::*;
use crate::session::SessionId;

/// A machine with one hosted session, 5150, whose listing is ready only once
/// the test says so.
struct World {
    ready: Mutex<bool>,
}

impl World {
    fn session() -> LiveSession {
        LiveSession {
            host_session_id: Some(7),
            backend: BackendId::claude_code(),
            pid: 5150,
            registered: true,
            cwd: Some("/work/alpha".into()),
            name: Some("alpha".into()),
            activity: Some(SessionActivity::Idle),
            waiting_for: None,
            status_since_ms: Some(1_000),
            version: Some("2.1.300".into()),
            entrypoint: Some("cli".into()),
            started_at_ms: Some(1_000),
            conversation_id: Some("conversation-of-alpha".into()),
        }
    }
}

impl SessionsWorld for World {
    fn overview(&self) -> Option<SessionsOverview> {
        lock(&self.ready).then(|| SessionsOverview {
            sessions: vec![Self::session()],
            read_at_ms: 2_000,
        })
    }

    fn facts_for(&self, host_session_id: u64) -> Option<HostedSessionFacts> {
        (host_session_id == 7).then(|| HostedSessionFacts {
            host_session_id,
            branch: Some("main".into()),
            profile: None,
            overlays: Vec::new(),
            started_at_ms: Some(1_000),
        })
    }

    fn measure(&self) -> PassFuture<'_> {
        Box::pin(async { Vec::new() })
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// What a call answered: whether it failed, and its text.
async fn ask(
    tools: &SessionTools,
    session: Option<i64>,
    tool: &str,
    arguments: Value,
) -> (bool, String) {
    let caller = Caller {
        grant: crate::agent_tools::GrantId::for_tests(0),
        session: session.map(SessionId),
    };
    let Value::Object(arguments) = arguments else {
        panic!("arguments are an object");
    };
    let result = tools.call(caller, tool, arguments).await;
    let text = result
        .content
        .iter()
        .filter_map(|block| block.as_text().map(|text| text.text.clone()))
        .collect::<Vec<_>>()
        .join("\n");
    (result.is_error.unwrap_or(false), text)
}

#[tokio::test(flavor = "multi_thread")]
async fn s24_a_tool_called_before_the_listing_is_ready_says_to_try_again_and_works_once_it_is() {
    let tools = SessionTools::new();
    // Before the host has given it anything to read.
    for tool in [SESSIONS_LIST, SESSION_DETAIL] {
        let (failed, text) = ask(&tools, Some(7), tool, json!({})).await;
        assert!(failed, "{text}");
        assert!(
            text.contains("still starting up. Try again in a moment."),
            "{text}"
        );
    }

    // Given a world whose listing cannot be read yet.
    let world = Arc::new(World {
        ready: Mutex::new(false),
    });
    tools.answer_from(Arc::clone(&world) as Arc<dyn SessionsWorld>);
    for (tool, arguments) in [
        (SESSIONS_LIST, json!({})),
        (SESSION_DETAIL, json!({})),
        (SESSION_DETAIL, json!({ "pid": 5150 })),
    ] {
        let (failed, text) = ask(&tools, Some(7), tool, arguments).await;
        assert!(failed, "{text}");
        assert!(text.contains("Try again in a moment."), "{text}");
    }

    // Once it is, the same session's tools answer.
    *lock(&world.ready) = true;
    let (failed, listing) = ask(&tools, Some(7), SESSIONS_LIST, json!({})).await;
    assert!(!failed, "{listing}");
    assert!(
        listing.starts_with(
            "1 Claude Code session running on this machine, 1 of them hosted by Floti."
        ),
        "{listing}"
    );
    assert!(
        listing.contains("#5150  \"alpha\"  (this session)"),
        "{listing}"
    );
    let (failed, detail) = ask(&tools, Some(7), SESSION_DETAIL, json!({})).await;
    assert!(!failed, "{detail}");
    assert!(
        detail.starts_with("#5150  \"alpha\"  (this session)"),
        "{detail}"
    );
    assert!(!detail.contains("conversation-of-alpha"), "{detail}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pid_that_is_not_a_whole_number_is_a_failed_call_and_one_that_is_no_number_is_the_callers()
 {
    let tools = SessionTools::new();
    tools.answer_from(Arc::new(World {
        ready: Mutex::new(true),
    }));
    let (failed, text) = ask(&tools, Some(7), SESSION_DETAIL, json!({ "pid": 51.5 })).await;
    assert!(failed && text.contains("whole number"), "{text}");
    let (failed, text) = ask(&tools, Some(7), SESSION_DETAIL, json!({ "pid": -3 })).await;
    assert!(failed && text.contains("whole number"), "{text}");
    let (failed, text) = ask(&tools, Some(7), SESSION_DETAIL, json!({ "pid": "5150" })).await;
    assert!(
        !failed && text.starts_with("#5150  \"alpha\"  (this session)"),
        "{text}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn s20_a_token_whose_session_is_not_live_marks_no_session_and_has_no_own_detail() {
    let tools = SessionTools::new();
    tools.answer_from(Arc::new(World {
        ready: Mutex::new(true),
    }));
    // A session the listing does not have, and a token not tied to one yet.
    for session in [Some(99), None] {
        let (failed, listing) = ask(&tools, session, SESSIONS_LIST, json!({})).await;
        assert!(!failed, "{listing}");
        assert!(listing.contains("#5150  \"alpha\""), "{listing}");
        assert!(!listing.contains("(this session)"), "{listing}");

        let (failed, detail) = ask(&tools, session, SESSION_DETAIL, json!({})).await;
        assert!(failed, "{detail}");
        assert_eq!(detail, NO_LIVE_SESSION);

        // Another session is still answered by its pid, unmarked.
        let (failed, other) = ask(&tools, session, SESSION_DETAIL, json!({ "pid": 5150 })).await;
        assert!(!failed, "{other}");
        assert!(other.starts_with("#5150  \"alpha\"\n"), "{other}");
    }
}

#[test]
fn the_family_is_floti_sessions_at_its_route_with_two_read_only_tools_and_off_until_switched() {
    let tools = SessionTools::new();
    assert_eq!(tools.name(), "floti-sessions");
    assert_eq!(tools.route(), "/mcp/sessions");
    assert!(tools.instructions().contains("read-only"));
    assert!(!tools.is_on());
    tools.switch(true);
    assert!(tools.is_on());
    let listed: Vec<(String, Option<bool>)> = tools
        .tools()
        .iter()
        .map(|tool| {
            (
                tool.name.to_string(),
                tool.annotations
                    .as_ref()
                    .and_then(|notes| notes.read_only_hint),
            )
        })
        .collect();
    assert_eq!(
        listed,
        [
            ("sessions_list".to_owned(), Some(true)),
            ("session_detail".to_owned(), Some(true)),
        ]
    );
}
