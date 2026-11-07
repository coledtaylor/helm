//! A client can watch a running session through a watch-only attach
//! (`session:data` opened with `watch`): it is sent the session's screen and
//! live output, but the keys it sends reach nothing and a size it reports
//! changes nothing. Each test runs a host in this process over a temporary
//! tree, with the fake agent behind it.

use std::sync::Arc;

use floti_host::agent::AgentBackend;
use floti_host::fake_agent;
use floti_host::server::HostConfig;
use floti_host::testkit::{RunningHost, TestClient, TestDirs};
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::sessions::{
    SessionList, SessionResize, SessionResizeRequest, SessionSize, SessionSizeRequest,
    SessionStart, StartSessionRequest,
};

const TERMINAL: &[&str] = &["terminal"];

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_watching_client_gets_the_screen_and_live_output_but_types_nothing_and_resizes_nothing() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = RunningHost::start(HostConfig {
        run: Default::default(),
        folders: dirs.folders(),
        endpoint: endpoint.clone(),
        backends: vec![Arc::new(agent.backend(Vec::<&str>::new())) as Arc<dyn AgentBackend>],
        inherited_env: std::env::vars_os().collect(),
    });
    let mut typist = TestClient::connect(&endpoint, TERMINAL).await;
    let mut watcher = TestClient::connect(&endpoint, TERMINAL).await;
    let session = typist
        .request::<SessionStart>(&StartSessionRequest {
            cwd: dirs.folder("a project").to_string_lossy().into_owned(),
            cols: 80,
            rows: 24,
            ..StartSessionRequest::default()
        })
        .await
        .unwrap();

    // The typist has the session its way first, so the screen the watcher is
    // given has something on it.
    typist.attach(1, session.id).await;
    typist.type_into(1, b"first\r").await;
    typist
        .read_stream_until(1, |bytes| text(bytes).contains("echo: first"))
        .await;

    // The watcher is given the current screen.
    watcher.watch(1, session.id).await;
    watcher
        .read_stream_until(1, |bytes| text(bytes).contains("echo: first"))
        .await;

    // It sends keys and a new size. The two requests after the keys are
    // answered only once the host has taken the keys, so what follows cannot
    // be ahead of them.
    watcher.type_into(1, b"stolen\r").await;
    watcher
        .request::<SessionResize>(&SessionResizeRequest {
            id: session.id,
            cols: 40,
            rows: 10,
        })
        .await
        .expect("a watcher's size is taken in and ignored");
    watcher.request::<SessionList>(&()).await.unwrap();

    // The typist attaches afresh, which gives its attachment the size the
    // session has now, and types on: the session still has its size, and
    // nothing of the watcher's keys is on its screen or in its output.
    typist.attach(2, session.id).await;
    typist.type_into(2, b"/size\r").await;
    let typed = typist
        .read_stream_until(2, |bytes| text(bytes).contains("size: "))
        .await;
    assert!(
        text(&typed).contains("size: 80x24"),
        "the session kept its size: {}",
        text(&typed)
    );
    assert!(
        !text(&typed).contains("echo: stolen"),
        "the watcher's keys reached the session: {}",
        text(&typed)
    );
    // What the session writes after reaches the watcher live.
    let seen = watcher
        .read_stream_until(1, |bytes| text(bytes).contains("size: 80x24"))
        .await;
    assert!(
        !text(&seen).contains("echo: stolen"),
        "the watcher's keys reached the session: {}",
        text(&seen)
    );

    drop(watcher);
    drop(typist);
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_that_watches_is_told_the_grid_the_session_has_and_not_one_that_is_not_running() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = RunningHost::start(HostConfig {
        run: Default::default(),
        folders: dirs.folders(),
        endpoint: endpoint.clone(),
        backends: vec![Arc::new(agent.backend(Vec::<&str>::new())) as Arc<dyn AgentBackend>],
        inherited_env: std::env::vars_os().collect(),
    });
    let mut typist = TestClient::connect(&endpoint, TERMINAL).await;
    let mut watcher = TestClient::connect(&endpoint, TERMINAL).await;
    let session = typist
        .request::<SessionStart>(&StartSessionRequest {
            cwd: dirs.folder("a project").to_string_lossy().into_owned(),
            cols: 100,
            rows: 30,
            ..StartSessionRequest::default()
        })
        .await
        .unwrap();

    let size = watcher
        .request::<SessionSize>(&SessionSizeRequest { id: session.id })
        .await
        .expect("a running session has a grid");
    assert_eq!((size.cols, size.rows), (100, 30));

    // The typist resizes its terminal: the grid the watcher is told follows.
    typist.attach(1, session.id).await;
    typist
        .request::<SessionResize>(&SessionResizeRequest {
            id: session.id,
            cols: 90,
            rows: 20,
        })
        .await
        .unwrap();
    let size = watcher
        .request::<SessionSize>(&SessionSizeRequest { id: session.id })
        .await
        .unwrap();
    assert_eq!((size.cols, size.rows), (90, 20));

    let unknown = watcher
        .request::<SessionSize>(&SessionSizeRequest {
            id: session.id + 1000,
        })
        .await;
    assert!(unknown.is_err(), "{unknown:?}");

    drop(watcher);
    drop(typist);
    host.stop(HostStopReason::Stop).await;
}
