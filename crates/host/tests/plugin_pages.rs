//! Plugin pages through the host: a client frames a plugin's pages and
//! relays their bridge calls on `plugins:call`, and the host answers them,
//! asks on `plugins:ui` and delivers on `plugins:deliver`.
//!
//! Each test runs a host over its own folders, with the fake agent as its
//! only backend, and connects clients to it as Helm's window would: with
//! `pluginPages`, listening on `plugins:deliver` and `plugins:ui`. The plugin
//! is a version 1 one written into the test's folder, whose program is the
//! fake in `testkit/fake_program.rs`.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use floti_host::agent::AgentBackend;
use floti_host::devices::Role;
use floti_host::fake_agent;
use floti_host::platform::process_tree::{self, ProcessTree};
use floti_host::platform::socket::Endpoint;
use floti_host::plugins::call::{
    ExecResult, FetchRedirect, PluginFetchRequest, PluginFetchResponse,
};
use floti_host::server::HostConfig;
use floti_host::testkit::{FakeAgent, PATIENCE, RunningHost, TestClient, TestDirs};
use floti_protocol::channel::{EventChannel, RequestChannel, from_payload, to_payload};
use floti_protocol::channels::common::SessionRecord;
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::plugins::{PLUGIN_CHANNEL_POST, PluginSession};
use floti_protocol::channels::plugins::{
    PluginAddRequest, PluginCallOutcome, PluginCallRequest, PluginCancelRequest, PluginDelivery,
    PluginDeliveryTarget, PluginErrorCode, PluginInfo, PluginSessionAnswer, PluginSessionState,
    PluginSetSettingRequest, PluginSettingValue, PluginSurfaceKind, PluginSwitchRequest,
    PluginUiRequest, PluginsAdd, PluginsCall, PluginsCancel, PluginsChanged, PluginsDeliver,
    PluginsSession, PluginsSetEnabled, PluginsSetSetting, PluginsUi,
};
use floti_protocol::channels::sessions::{
    CloseSessionRequest, SessionClose, SessionList, SessionStart, StartSessionRequest,
};
use floti_protocol::{Knowable, Message, Payload};
use serde_json::{Value, json};

/// What a window subscribes to.
const DELIVER: u64 = 10;
const UI: u64 = 11;
const CHANGED: u64 = 12;

/// What Helm's window says it can do.
const WINDOW: &[&str] = &["pluginPages", "terminal"];

const PLUGIN: &str = "board";

fn fake_program() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_floti-fake-program"))
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn payload<T: serde::Serialize>(value: &T) -> Payload {
    Payload::serialized(value).unwrap()
}

// ---------------------------------------------------------------------------
// The world each test runs in
// ---------------------------------------------------------------------------

struct World {
    host: Option<RunningHost>,
    endpoint: Endpoint,
    agent: FakeAgent,
    /// Last: the folder goes only once the host has let go of it.
    dirs: TestDirs,
}

impl World {
    fn new() -> Self {
        let dirs = TestDirs::new();
        let agent = fake_agent!(&dirs);
        let endpoint = dirs.endpoint();
        let host = RunningHost::start(HostConfig {
            run: Default::default(),
            folders: dirs.folders(),
            endpoint: endpoint.clone(),
            backends: vec![Arc::new(agent.backend(Vec::<String>::new())) as Arc<dyn AgentBackend>],
            inherited_env: std::env::vars_os().collect(),
        });
        Self {
            host: Some(host),
            endpoint,
            agent,
            dirs,
        }
    }

    /// Helm's window on the testkit's admin device, listening for what the
    /// host sends plugin pages.
    async fn window(&self) -> TestClient {
        listening(TestClient::connect(&self.endpoint, WINDOW).await).await
    }

    /// A window on a device of its own, paired as `role`.
    async fn window_as(&self, name: &str, role: Role) -> TestClient {
        listening(TestClient::connect_as(&self.endpoint, name, role, WINDOW).await).await
    }

    /// The board plugin, reaching `network`, registered by `client`.
    async fn board(&self, client: &mut TestClient, network: &[String]) -> PathBuf {
        let manifest = json!({
            "apiVersion": 1,
            "id": PLUGIN,
            "name": "Board",
            "version": "1.0.0",
            "panels": { "main": { "title": "Board", "entry": "panel.html" } },
            "settings": [{ "key": "limit", "type": "number", "label": "Limit", "default": 5 }],
            "network": network,
            "secrets": ["board-token"],
            "sessions": ["start", "list"],
            "exec": { "tool": { "command": text(&fake_program()) } },
        });
        let folder = self.dirs.plugin_folder(
            "board plugin",
            &manifest.to_string(),
            &[("panel.html", "<p>Board</p>")],
        );
        let added = client
            .request::<PluginsAdd>(&PluginAddRequest {
                path: text(&folder),
            })
            .await
            .expect("the plugin is added");
        assert_eq!(added.error, None, "{added:?}");
        let board = info(&added.plugins);
        assert!(board.enabled && board.error.is_none(), "{board:?}");
        folder
    }

    async fn stop(mut self) {
        if let Some(host) = self.host.take() {
            host.stop(HostStopReason::Stop).await;
        }
    }
}

async fn listening(mut client: TestClient) -> TestClient {
    client
        .subscribe_quietly(DELIVER, PluginsDeliver::NAME)
        .await;
    client.subscribe_quietly(UI, PluginsUi::NAME).await;
    match client.subscribe_on(CHANGED, PluginsChanged::NAME).await {
        Message::Snapshot(_) => {}
        other => panic!("plugins:changed starts with its state, not {other:?}"),
    }
    client
}

fn info(list: &[PluginInfo]) -> &PluginInfo {
    list.iter()
        .find(|plugin| plugin.id.as_deref() == Some(PLUGIN))
        .expect("the board plugin is listed")
}

/// Sends one bridge call from the board's panel without waiting for its
/// answer; the id to wait for it by.
async fn start_call(client: &mut TestClient, call_id: &str, method: &str, args: &[Value]) -> u64 {
    let request = PluginCallRequest {
        plugin: PLUGIN.to_owned(),
        surface: PluginSurfaceKind::Panel,
        method: method.to_owned(),
        args: args.iter().map(payload).collect(),
        call_id: call_id.to_owned(),
    };
    client
        .send_request(PluginsCall::NAME, to_payload(&request).unwrap())
        .await
}

async fn outcome(client: &mut TestClient, id: u64) -> PluginCallOutcome {
    let answer = client
        .answer_to(id, PluginsCall::NAME)
        .await
        .expect("plugins:call answers with an outcome");
    from_payload(&answer).expect("an outcome")
}

async fn call(client: &mut TestClient, method: &str, args: &[Value]) -> PluginCallOutcome {
    let id = start_call(client, &format!("call-{method}-{}", unique()), method, args).await;
    outcome(client, id).await
}

fn unique() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::SeqCst)
}

fn ok(outcome: PluginCallOutcome) -> Payload {
    match outcome {
        PluginCallOutcome::Ok { value, .. } => value,
        PluginCallOutcome::Failed { code, message, .. } => {
            panic!("the call failed: {code:?}: {message}")
        }
    }
}

fn failed(outcome: PluginCallOutcome) -> (PluginErrorCode, String) {
    match outcome {
        PluginCallOutcome::Failed { code, message, .. } => (code, message),
        PluginCallOutcome::Ok { value, .. } => panic!("the call answered {value:?}"),
    }
}

/// The pids the fake program wrote to `path`, once it has.
async fn pid_in(path: &Path) -> u32 {
    let started = Instant::now();
    loop {
        if let Ok(text) = std::fs::read_to_string(path)
            && let Ok(ids) = serde_json::from_str::<Value>(&text)
        {
            return u32::try_from(ids["pid"].as_u64().unwrap()).unwrap();
        }
        assert!(
            started.elapsed() < PATIENCE,
            "the program never wrote {}",
            path.display()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Waits for `pid` to have ended.
async fn ended(pid: u32) {
    let started = Instant::now();
    while process_tree::Native.is_alive(pid) != Knowable::Known(false) {
        assert!(started.elapsed() < PATIENCE, "{pid} is still running");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// A program the board runs until it is stopped, writing its pid to `path`.
fn sleeper(path: &Path) -> Vec<Value> {
    vec![
        json!("tool"),
        json!(["--pid-file", text(path), "--sleep", "600000"]),
        json!({}),
    ]
}

// ---------------------------------------------------------------------------
// A server on 127.0.0.1
// ---------------------------------------------------------------------------

/// An HTTP/1.1 server answering each request with what `route` says for its
/// target, and noting every target it was sent.
struct Server {
    port: u16,
    seen: Arc<Mutex<Vec<String>>>,
}

impl Server {
    fn start(
        route: impl Fn(&str) -> (u16, Vec<(String, String)>, String) + Send + Sync + 'static,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let noted = Arc::clone(&seen);
        // Ends with the test's process: it holds nothing but its socket.
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    continue;
                }
                let target = line.split_whitespace().nth(1).unwrap_or("/").to_owned();
                loop {
                    let mut header = String::new();
                    match reader.read_line(&mut header) {
                        Ok(0) | Err(_) => break,
                        Ok(_) if header == "\r\n" => break,
                        Ok(_) => {}
                    }
                }
                noted.lock().unwrap().push(target.clone());
                let (status, headers, body) = route(&target);
                let mut head = format!(
                    "HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\n",
                    body.len()
                );
                for (name, value) in headers {
                    head.push_str(&format!("{name}: {value}\r\n"));
                }
                head.push_str("\r\n");
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(body.as_bytes());
            }
        });
        Self { port, seen }
    }

    fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.origin())
    }

    fn seen(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }
}

fn get(url: &str) -> Value {
    serde_json::to_value(PluginFetchRequest {
        url: url.to_owned(),
        method: "GET".to_owned(),
        headers: Vec::new(),
        body: None,
        redirect: FetchRedirect::Follow,
    })
    .unwrap()
}

// ---------------------------------------------------------------------------
// S2: a page's fetch goes through the host
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s2_a_page_fetch_reaches_a_listed_origin_through_the_host_and_an_unlisted_one_or_a_redirect_leaving_the_list_is_refused()
 {
    let unlisted = Server::start(|_| (200, Vec::new(), "not for the board".to_owned()));
    let away = unlisted.url("/stolen");
    let listed = Server::start(move |target| match target {
        "/away" => (
            302,
            vec![("location".to_owned(), away.clone())],
            String::new(),
        ),
        _ => (200, Vec::new(), "hello".to_owned()),
    });
    let world = World::new();
    let mut window = world.window().await;
    world.board(&mut window, &[listed.origin()]).await;

    let fetched = ok(call(&mut window, "fetch", &[get(&listed.url("/ok"))]).await);
    let response: PluginFetchResponse = fetched.deserialized().unwrap();
    assert_eq!(
        (response.status, response.body.as_slice()),
        (200, b"hello".as_slice())
    );

    let (code, message) = failed(call(&mut window, "fetch", &[get(&unlisted.url("/"))]).await);
    assert_eq!(code, PluginErrorCode::NotDeclared);
    assert_eq!(
        message,
        format!(
            "{} is not one of the origins the manifest's network lists",
            unlisted.origin()
        )
    );

    let (code, message) = failed(call(&mut window, "fetch", &[get(&listed.url("/away"))]).await);
    assert_eq!(code, PluginErrorCode::NotDeclared);
    assert_eq!(
        message,
        format!(
            "{} (a redirect) is not one of the origins the manifest's network lists",
            unlisted.origin()
        )
    );
    assert!(unlisted.seen().is_empty(), "{:?}", unlisted.seen());
    assert_eq!(listed.seen(), ["/ok", "/away"]);
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_version_1_page_calling_what_the_bridge_lacks_is_told_in_helm_terms() {
    let world = World::new();
    let mut window = world.window().await;
    world.board(&mut window, &[]).await;
    let (code, message) = failed(call(&mut window, "nothing.here", &[]).await);
    assert_eq!(code, PluginErrorCode::Invalid);
    assert_eq!(message, "helm.nothing.here is not part of the bridge");
    world.stop().await;
}

// ---------------------------------------------------------------------------
// S3: a page runs a declared program
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s3_a_page_runs_a_declared_program_with_no_shell_and_gets_its_exit_code_and_output_and_an_undeclared_one_is_refused()
 {
    let world = World::new();
    let mut window = world.window().await;
    world.board(&mut window, &[]).await;

    let args = ["two words", "a&b|c", "$HOME", "\"quoted\""];
    let ran: ExecResult = ok(call(
        &mut window,
        "exec",
        &[json!("tool"), json!(args), json!({})],
    )
    .await)
    .deserialized()
    .unwrap();
    assert_eq!(ran.exit_code, Some(0), "{ran:?}");
    let report: Value = serde_json::from_str(ran.stdout.lines().next().unwrap()).unwrap();
    assert_eq!(report["args"], json!(args), "each argument as it is");

    let exits: ExecResult = ok(call(
        &mut window,
        "exec",
        &[
            json!("tool"),
            json!(["--stderr-bytes", "5", "--exit", "3"]),
            json!({}),
        ],
    )
    .await)
    .deserialized()
    .unwrap();
    assert_eq!((exits.exit_code, exits.stderr.as_str()), (Some(3), "xxxxx"));

    let (code, message) =
        failed(call(&mut window, "exec", &[json!("nope"), json!([]), json!({})]).await);
    assert_eq!(code, PluginErrorCode::NotDeclared);
    assert_eq!(
        message,
        "\"nope\" is not one of the programs the manifest's exec lists"
    );
    world.stop().await;
}

// ---------------------------------------------------------------------------
// S4: a call ends when its page or plugin goes
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s4_a_call_its_page_aborts_whose_plugin_is_switched_off_or_whose_client_leaves_ends_and_its_program_with_it()
 {
    let world = World::new();
    let mut window = world.window().await;
    let folder = world.board(&mut window, &[]).await;

    // The page aborts it.
    let first = world.dirs.root().join("first pid.json");
    let calling = start_call(&mut window, "first", "exec", &sleeper(&first)).await;
    let pid = pid_in(&first).await;
    window
        .request::<PluginsCancel>(&PluginCancelRequest {
            call_id: "first".to_owned(),
        })
        .await
        .expect("the cancel is taken");
    assert_eq!(
        failed(outcome(&mut window, calling).await).0,
        PluginErrorCode::Aborted
    );
    ended(pid).await;

    // The plugin is switched off.
    let second = world.dirs.root().join("second pid.json");
    let calling = start_call(&mut window, "second", "exec", &sleeper(&second)).await;
    let pid = pid_in(&second).await;
    let switch = |enabled| PluginSwitchRequest {
        path: text(&folder),
        enabled,
    };
    window
        .request::<PluginsSetEnabled>(&switch(false))
        .await
        .expect("an admin switches it off");
    assert_eq!(
        failed(outcome(&mut window, calling).await).0,
        PluginErrorCode::Aborted
    );
    ended(pid).await;
    window
        .request::<PluginsSetEnabled>(&switch(true))
        .await
        .expect("an admin switches it on");

    // The client framing the page leaves.
    let third = world.dirs.root().join("third pid.json");
    let mut leaving = world.window().await;
    start_call(&mut leaving, "third", "exec", &sleeper(&third)).await;
    let pid = pid_in(&third).await;
    drop(leaving);
    ended(pid).await;
    world.stop().await;
}

// ---------------------------------------------------------------------------
// S5: a settings change reaches every page
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s5_a_settings_change_is_delivered_to_the_plugins_pages_on_every_client_and_settings_get_answers_it()
 {
    let world = World::new();
    let mut window = world.window().await;
    let mut other = world.window().await;
    world.board(&mut window, &[]).await;

    window
        .request::<PluginsSetSetting>(&PluginSetSettingRequest {
            plugin: PLUGIN.to_owned(),
            key: "limit".to_owned(),
            value: PluginSettingValue::Number(9.0),
        })
        .await
        .expect("the setting is saved");
    for client in [&mut window, &mut other] {
        let delivered: PluginDelivery = client
            .event_on(
                DELIVER,
                "the board's settings",
                |delivery: &PluginDelivery| matches!(delivery, PluginDelivery::Settings { .. }),
            )
            .await;
        let PluginDelivery::Settings { plugin, data, to } = delivered else {
            unreachable!()
        };
        assert_eq!(plugin, PLUGIN);
        assert_eq!(
            to,
            PluginDeliveryTarget::All,
            "the panel and the background"
        );
        assert_eq!(data.get("limit"), Some(&PluginSettingValue::Number(9.0)));
    }
    let settings: Value = ok(call(&mut other, "settings.get", &[]).await)
        .deserialized()
        .unwrap();
    assert_eq!(settings["limit"], 9.0, "{settings}");
    world.stop().await;
}

// ---------------------------------------------------------------------------
// S7: what a plugin paints, and its clearing
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s7_the_status_and_badge_a_page_sets_are_listed_and_cleared_when_the_plugin_is_switched_off()
 {
    let world = World::new();
    let mut window = world.window().await;
    let folder = world.board(&mut window, &[]).await;

    ok(call(
        &mut window,
        "status.set",
        &[json!({ "text": "3 open", "tone": "accent" })],
    )
    .await);
    ok(call(&mut window, "badge.set", &[json!(4)]).await);
    let painted: Vec<PluginInfo> = window
        .event_on(
            CHANGED,
            "the board's status and badge",
            |list: &Vec<PluginInfo>| {
                let board = info(list);
                board.status.is_some() && board.badge.is_some()
            },
        )
        .await;
    let board = info(&painted);
    assert_eq!(board.status.as_ref().unwrap().text, "3 open");
    assert_eq!(board.badge, Some(4));

    let off = window
        .request::<PluginsSetEnabled>(&PluginSwitchRequest {
            path: text(&folder),
            enabled: false,
        })
        .await
        .unwrap();
    let board = info(&off);
    assert_eq!((board.status.clone(), board.badge), (None, None));
    world.stop().await;
}

// ---------------------------------------------------------------------------
// S8: the sessions a plugin sees
// ---------------------------------------------------------------------------

/// The next sessions delivery to the board that `wanted` accepts.
async fn sessions_delivered(
    client: &mut TestClient,
    what: &str,
    wanted: impl Fn(&[PluginSession]) -> bool,
) -> (Vec<PluginSession>, String) {
    let delivered: PluginDelivery = client
        .event_on(DELIVER, what, |delivery: &PluginDelivery| match delivery {
            PluginDelivery::Sessions { plugin, data, .. } => plugin == PLUGIN && wanted(data),
            _ => false,
        })
        .await;
    let shown = serde_json::to_string(&delivered).unwrap();
    let PluginDelivery::Sessions { data, .. } = delivered else {
        unreachable!()
    };
    (data, shown)
}

#[tokio::test(flavor = "multi_thread")]
async fn s8_a_plugin_that_lists_sessions_hears_each_start_and_end_and_lists_them_with_nothing_of_the_conversation()
 {
    let world = World::new();
    let mut window = world.window().await;
    world.board(&mut window, &[]).await;
    let folder = world.dirs.folder("a project");
    let record: SessionRecord = window
        .request::<SessionStart>(&StartSessionRequest {
            cwd: text(&folder),
            name: Some("release notes".to_owned()),
            opening_prompt: Some("the private first message".to_owned()),
            cols: 80,
            rows: 24,
            ..StartSessionRequest::default()
        })
        .await
        .expect("the session starts");

    let (started, shown) = sessions_delivered(&mut window, "the session's start", |sessions| {
        sessions
            .iter()
            .any(|session| session.state == PluginSessionState::Running)
    })
    .await;
    let session = &started[0];
    assert_eq!(session.name, "release notes");
    assert_eq!(session.cwd, record.cwd);
    assert_ne!(session.id, record.id.to_string(), "never the row id");
    for private in [
        "the private first message",
        record
            .conversation_id
            .as_deref()
            .unwrap_or("no conversation"),
        "argv",
        "waitingFor",
    ] {
        assert!(
            !shown.contains(private),
            "{private} reached the plugin: {shown}"
        );
    }

    let listed: Vec<PluginSession> = ok(call(&mut window, "sessions.list", &[]).await)
        .deserialized()
        .unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, session.id);

    window
        .request::<SessionClose>(&CloseSessionRequest {
            id: record.id,
            force: true,
        })
        .await
        .expect("the session closes");
    let (ended_now, _) = sessions_delivered(&mut window, "the session's end", |sessions| {
        sessions
            .iter()
            .any(|session| session.state == PluginSessionState::Ended)
    })
    .await;
    assert_eq!(ended_now[0].id, session.id, "the same id from start to end");
    assert!(ended_now[0].ended_at.is_some());
    world.stop().await;
}

// ---------------------------------------------------------------------------
// S10: who may start a session a plugin asks for
// ---------------------------------------------------------------------------

fn session_ask(folder: &Path, prompt: &str) -> Vec<Value> {
    vec![json!({ "cwd": text(folder), "prompt": prompt, "name": "From the board" })]
}

#[tokio::test(flavor = "multi_thread")]
async fn s10_a_viewer_is_refused_a_session_naming_operator_or_admin_and_an_operator_is_asked_on_its_own_window_and_starts_what_was_checked()
 {
    let world = World::new();
    let mut admin = world.window().await;
    world.board(&mut admin, &[]).await;
    let folder = world.dirs.folder("a project");

    // A viewer: refused with the sentence, and nothing starts.
    let mut viewer = world.window_as("viewer phone", Role::Viewer).await;
    let (code, message) =
        failed(call(&mut viewer, "sessions.start", &session_ask(&folder, "go")).await);
    assert_eq!(code, PluginErrorCode::NotAllowed);
    assert!(
        message.contains("operator or admin") && message.contains("viewer"),
        "{message}"
    );
    assert_eq!(admin.request::<SessionList>(&()).await.unwrap(), vec![]);

    // An operator: the dialog is put up on its window, and a second ask
    // while it is up is refused.
    let mut operator = world.window_as("operator laptop", Role::Operator).await;
    let asking = start_call(
        &mut operator,
        "ask",
        "sessions.start",
        &session_ask(&folder, "look at the build"),
    )
    .await;
    let asked: PluginUiRequest = operator
        .event_on(UI, "the session dialog", |ui: &PluginUiRequest| {
            matches!(ui, PluginUiRequest::Session { .. })
        })
        .await;
    let PluginUiRequest::Session {
        request_id,
        plugin,
        cwd,
        prompt,
        name,
    } = asked
    else {
        unreachable!()
    };
    assert_eq!(
        (
            plugin.as_str(),
            cwd.as_str(),
            prompt.as_str(),
            name.as_str()
        ),
        (
            PLUGIN,
            text(&folder).as_str(),
            "look at the build",
            "From the board"
        )
    );
    let (code, _) = failed(
        call(
            &mut operator,
            "sessions.start",
            &session_ask(&folder, "again"),
        )
        .await,
    );
    assert_eq!(code, PluginErrorCode::Busy);

    // Only the window it was put up on answers it.
    let refused = admin
        .request::<PluginsSession>(&PluginSessionAnswer {
            request_id: request_id.clone(),
            start: true,
            cols: 80,
            rows: 24,
        })
        .await
        .expect_err("another window cannot answer it");
    assert!(refused.message.contains("another client"), "{refused:?}");

    let started = operator
        .request::<PluginsSession>(&PluginSessionAnswer {
            request_id,
            start: true,
            cols: 100,
            rows: 30,
        })
        .await
        .expect("the operator starts it")
        .expect("a session");
    assert_eq!(
        (started.cwd.as_str(), started.name.as_str()),
        (text(&folder).as_str(), "From the board")
    );
    let answered: String = ok(outcome(&mut operator, asking).await)
        .deserialized()
        .unwrap();
    assert_eq!(answered, "started");
    let started_at = Instant::now();
    while !world
        .agent
        .records()
        .iter()
        .any(|run| run.argv.last().map(String::as_str) == Some("look at the build"))
    {
        assert!(
            started_at.elapsed() < PATIENCE,
            "the agent never ran with the message asked for"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // Said no to, nothing starts; withdrawn when the page aborts.
    let asking = start_call(
        &mut operator,
        "no",
        "sessions.start",
        &session_ask(&folder, "not this"),
    )
    .await;
    let PluginUiRequest::Session { request_id, .. } = operator
        .event_on(UI, "the second dialog", |ui: &PluginUiRequest| {
            matches!(ui, PluginUiRequest::Session { .. })
        })
        .await
    else {
        unreachable!()
    };
    let none = operator
        .request::<PluginsSession>(&PluginSessionAnswer {
            request_id,
            start: false,
            cols: 80,
            rows: 24,
        })
        .await
        .unwrap();
    assert_eq!(none, None);
    let answered: String = ok(outcome(&mut operator, asking).await)
        .deserialized()
        .unwrap();
    assert_eq!(answered, "cancelled");

    let asking = start_call(
        &mut operator,
        "gone",
        "sessions.start",
        &session_ask(&folder, "page closes"),
    )
    .await;
    let PluginUiRequest::Session { request_id, .. } = operator
        .event_on(UI, "the third dialog", |ui: &PluginUiRequest| {
            matches!(ui, PluginUiRequest::Session { .. })
        })
        .await
    else {
        unreachable!()
    };
    operator
        .request::<PluginsCancel>(&PluginCancelRequest {
            call_id: "gone".to_owned(),
        })
        .await
        .unwrap();
    let withdrawn: PluginUiRequest = operator
        .event_on(UI, "the dialog withdrawn", |ui: &PluginUiRequest| {
            matches!(ui, PluginUiRequest::SessionWithdrawn { .. })
        })
        .await;
    assert_eq!(withdrawn, PluginUiRequest::SessionWithdrawn { request_id });
    assert_eq!(
        failed(outcome(&mut operator, asking).await).0,
        PluginErrorCode::Aborted
    );

    admin
        .request::<SessionClose>(&CloseSessionRequest {
            id: started.id,
            force: true,
        })
        .await
        .unwrap();
    world.stop().await;
}

// ---------------------------------------------------------------------------
// S17: a BroadcastChannel across clients
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s17_a_broadcast_channel_post_from_a_page_on_one_client_reaches_the_plugins_pages_on_every_client()
 {
    let world = World::new();
    let mut first = world.window().await;
    let mut second = world.window().await;
    world.board(&mut first, &[]).await;

    let posted = ok(call(
        &mut first,
        PLUGIN_CHANNEL_POST,
        &[json!("updates"), json!({ "n": 1 }), json!("channel-a")],
    )
    .await);
    assert_eq!(posted, Payload::Null);
    for client in [&mut second, &mut first] {
        let delivered: PluginDelivery = client
            .event_on(DELIVER, "the post", |delivery: &PluginDelivery| {
                matches!(delivery, PluginDelivery::Channel { .. })
            })
            .await;
        let PluginDelivery::Channel { plugin, data, to } = delivered else {
            unreachable!()
        };
        // Each client hands it to that plugin's pages only, and the page
        // skips the channel whose token it carries.
        assert_eq!((plugin.as_str(), to), (PLUGIN, PluginDeliveryTarget::All));
        assert_eq!(
            (data.name.as_str(), data.token.as_str()),
            ("updates", "channel-a")
        );
        assert_eq!(
            from_payload::<Value>(&data.message).unwrap(),
            json!({ "n": 1 })
        );
    }

    let (code, _) = failed(call(&mut first, PLUGIN_CHANNEL_POST, &[]).await);
    assert_eq!(code, PluginErrorCode::Invalid);
    world.stop().await;
}
