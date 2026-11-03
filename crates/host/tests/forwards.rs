//! Forwarded ports as a client of the host sees them: `sessions:port` carries
//! bytes both ways between the client and a port one of a session's own
//! processes listens on at this host's loopback address, refuses every other
//! port in a sentence without opening a connection, and closes when the
//! session ends. Driven against the fake agent, whose `/serve` child serves
//! HTTP on 127.0.0.1, never a real agent.

use std::ffi::OsString;
use std::net::TcpListener;
use std::path::Path;
use std::sync::Arc;

use floti_host::agent::AgentBackend;
use floti_host::fake_agent;
use floti_host::platform::socket::Endpoint;
use floti_host::server::HostConfig;
use floti_host::testkit::{FakeAgent, RunningHost, TestClient, TestDirs};
use floti_protocol::channel::to_payload;
use floti_protocol::channels::common::SessionRecord;
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::sessions::{
    CloseSessionRequest, SessionClose, SessionPortOpen, SessionStart, StartSessionRequest,
};

const TERMINAL: &[&str] = &["terminal"];
const SCREEN: u64 = 1;
const PORT_CHANNEL: &str = "sessions:port";
const EXITS: u64 = 4;

/// A host whose one backend is the fake agent.
fn fake_config(dirs: &TestDirs, endpoint: &Endpoint, agent: &FakeAgent) -> HostConfig {
    HostConfig {
        run: Default::default(),
        folders: dirs.folders(),
        endpoint: endpoint.clone(),
        backends: vec![Arc::new(agent.backend(std::iter::empty::<&str>())) as Arc<dyn AgentBackend>],
        inherited_env: std::env::vars_os()
            .filter(|(key, _)| key != "SHELL")
            .chain([(OsString::from("SHELL"), OsString::from("/bin/sh"))])
            .collect(),
    }
}

async fn start_session(client: &mut TestClient, folder: &Path) -> u64 {
    client.subscribe_quietly(EXITS, "session:exit").await;
    let session: SessionRecord = client
        .request::<SessionStart>(&StartSessionRequest {
            cwd: folder.to_string_lossy().into_owned(),
            cols: 80,
            rows: 24,
            ..StartSessionRequest::default()
        })
        .await
        .expect("the session starts");
    session.id
}

/// Ends session `id` and waits until the host has noted its exit.
async fn end_session(client: &mut TestClient, id: u64) {
    client
        .request::<SessionClose>(&CloseSessionRequest { id, force: true })
        .await
        .unwrap();
    client
        .event_on(EXITS, "the session's exit", |ended: &SessionRecord| {
            ended.id == id
        })
        .await;
}

/// The port `serving <port>` names in `bytes`, once the line is whole.
fn served_port(bytes: &[u8]) -> Option<u16> {
    let text = String::from_utf8_lossy(bytes);
    text.match_indices("serving ").find_map(|(at, said)| {
        let rest = &text[at + said.len()..];
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        rest[digits.len()..]
            .starts_with('\r')
            .then(|| digits.parse().ok())
            .flatten()
    })
}

/// Has session `id`'s program serve HTTP, and the port it serves on.
async fn serve_in(client: &mut TestClient, id: u64) -> u16 {
    client.attach(SCREEN, id).await;
    client.type_into(SCREEN, b"/serve 0\r").await;
    let bytes = client
        .read_stream_until(SCREEN, |bytes| served_port(bytes).is_some())
        .await;
    served_port(&bytes).expect("the port it serves on")
}

async fn open_forward(client: &mut TestClient, stream: u64, id: u64, port: u16) {
    client
        .open_on(
            stream,
            PORT_CHANNEL,
            to_payload(&SessionPortOpen { id, port }).expect("encode the open"),
        )
        .await;
}

/// The whole HTTP answer on `stream`: its body, once the host has closed the
/// stream after the server closed its connection.
async fn answer_body(client: &mut TestClient, stream: u64) -> Vec<u8> {
    let reason = client.wait_stream_closed(stream).await;
    assert_eq!(
        reason, None,
        "the server closed its connection, nothing failed"
    );
    let bytes = client.stream_bytes(stream);
    let head_end = bytes
        .windows(4)
        .position(|four| four == b"\r\n\r\n")
        .unwrap_or_else(|| panic!("no HTTP answer: {:?}", String::from_utf8_lossy(bytes)))
        + 4;
    assert!(
        bytes.starts_with(b"HTTP/1.1 200 OK"),
        "{:?}",
        String::from_utf8_lossy(bytes)
    );
    bytes[head_end..].to_vec()
}

/// A port nothing listens on: one the OS gave this test, let go of again.
fn free_port() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind a port");
    listener.local_addr().expect("its address").port()
}

#[tokio::test(flavor = "multi_thread")]
async fn s1_a_forward_carries_a_request_to_the_sessions_own_port_and_its_answer_back() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = RunningHost::start(fake_config(&dirs, &endpoint, &agent));
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    let id = start_session(&mut client, &dirs.folder("a project")).await;
    let port = serve_in(&mut client, id).await;

    open_forward(&mut client, 10, id, port).await;
    client
        .type_into(10, b"GET /index.html HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .await;
    assert_eq!(
        answer_body(&mut client, 10).await,
        b"fake dev server: GET /index.html"
    );

    // Every byte value, both ways, more than one chunk of each.
    let body: Vec<u8> = (0..100 * 1024).map(|n| (n % 251) as u8).collect();
    open_forward(&mut client, 11, id, port).await;
    let mut request = format!(
        "POST /echo HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\n\r\n",
        body.len()
    )
    .into_bytes();
    request.extend_from_slice(&body);
    for part in request.chunks(16 * 1024) {
        client.type_into(11, part).await;
    }
    assert_eq!(answer_body(&mut client, 11).await, body);

    // A second client forwards the same port beside the first.
    let mut other = TestClient::connect(&endpoint, TERMINAL).await;
    open_forward(&mut other, 10, id, port).await;
    other
        .type_into(10, b"GET /other HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .await;
    assert_eq!(
        answer_body(&mut other, 10).await,
        b"fake dev server: GET /other"
    );

    client
        .request::<SessionClose>(&CloseSessionRequest { id, force: true })
        .await
        .unwrap();
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s2_a_port_the_session_does_not_listen_on_is_refused_in_a_sentence_and_opens_no_connection()
{
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = RunningHost::start(fake_config(&dirs, &endpoint, &agent));
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    let id = start_session(&mut client, &dirs.folder("a project")).await;
    let port = serve_in(&mut client, id).await;

    // A port nothing listens on.
    let nothing = free_port();
    open_forward(&mut client, 20, id, nothing).await;
    let reason = client.wait_stream_closed(20).await.expect("a sentence");
    assert_eq!(
        reason,
        format!("No process of session {id} listens on port {nothing}, so it is not forwarded.")
    );

    // A port this host's computer listens on, but not the session: this
    // test's own. Nothing connects to it.
    let outside = TcpListener::bind(("127.0.0.1", 0)).expect("bind a port");
    outside.set_nonblocking(true).unwrap();
    let outside_port = outside.local_addr().unwrap().port();
    open_forward(&mut client, 21, id, outside_port).await;
    let reason = client.wait_stream_closed(21).await.expect("a sentence");
    assert_eq!(
        reason,
        format!(
            "No process of session {id} listens on port {outside_port}, so it is not forwarded."
        )
    );
    assert_eq!(
        outside.accept().map(|_| ()).unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock,
        "a refused forward opened a connection"
    );

    // A session this host does not run.
    let unknown = id + 1000;
    open_forward(&mut client, 22, unknown, port).await;
    let reason = client.wait_stream_closed(22).await.expect("a sentence");
    assert_eq!(
        reason,
        format!(
            "Session {unknown} is not running on this Floti host, so its port {port} is not forwarded."
        )
    );

    // The session's own port, once it has ended.
    end_session(&mut client, id).await;
    open_forward(&mut client, 23, id, port).await;
    let reason = client.wait_stream_closed(23).await.expect("a sentence");
    assert_eq!(
        reason,
        format!(
            "Session {id} is not running on this Floti host, so its port {port} is not forwarded."
        )
    );
    assert!(client.stream_bytes(23).is_empty());

    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s3_a_forward_closes_when_its_session_ends_and_is_not_opened_again() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = RunningHost::start(fake_config(&dirs, &endpoint, &agent));
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    let id = start_session(&mut client, &dirs.folder("a project")).await;
    let port = serve_in(&mut client, id).await;

    // Half a request: the server waits for the rest, so the connection
    // stays open until something ends it.
    open_forward(&mut client, 30, id, port).await;
    client.type_into(30, b"GET /slow HTTP/1.1\r\n").await;
    // The forward is carried: a request on a second one is answered.
    open_forward(&mut client, 31, id, port).await;
    client
        .type_into(31, b"GET /ready HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .await;
    assert_eq!(
        answer_body(&mut client, 31).await,
        b"fake dev server: GET /ready"
    );
    assert!(client.stream_closed(30).is_none(), "still open");

    end_session(&mut client, id).await;
    // Closed, whichever the host saw first: the session's end, or its
    // server's connection ending with it.
    if let Some(reason) = client.wait_stream_closed(30).await {
        assert!(
            reason == format!("Session {id} has ended, so its forwarded connection is closed.")
                || reason.starts_with("The forwarded connection failed"),
            "{reason}"
        );
    }

    open_forward(&mut client, 32, id, port).await;
    let reason = client.wait_stream_closed(32).await.expect("a sentence");
    assert_eq!(
        reason,
        format!(
            "Session {id} is not running on this Floti host, so its port {port} is not forwarded."
        )
    );

    host.stop(HostStopReason::Stop).await;
}
