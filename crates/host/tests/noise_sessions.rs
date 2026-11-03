//! Every connection a Noise session: a client proves its device key, and the
//! host the key the client holds it to, before anything else crosses the
//! local socket. Any device key that completes the handshake is served, one
//! the host has never seen included; a connection that does not complete it
//! is closed without a byte and logged, naming no key.
//!
//! The tests run hosts in this process ([`RunningHost`]) and the `floti host`
//! executable, whose log is its file in the test's logs folder. What crosses
//! the socket is read through a tap that relays one endpoint to another and
//! keeps every byte; clients that misbehave are raw sockets driven by the
//! protocol's own Noise layer.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use floti_host::agent::AgentBackend;
use floti_host::client::{ClientError, ClientKeys, DEVICE_KEY_FILE, PINNED_HOST_FILE};
use floti_host::fake_agent;
use floti_host::host_log::LOG_FILE;
use floti_host::platform::folders::{CONFIG_DIR_VAR, DATA_DIR_VAR, LOG_DIR_VAR, RUNTIME_DIR_VAR};
use floti_host::platform::private_files::{Native as NativeFiles, PrivateFiles};
use floti_host::platform::socket::{
    Endpoint, LocalListener, LocalSocket, LocalStream, Native as NativeSocket,
};
use floti_host::platform::startup;
use floti_host::server::{HOST_KEY_FILE, HostConfig, RETIRED_FILES, SOCKET_NAME, host_public_key};
use floti_host::testkit::{
    FakeAgent, PATIENCE, RunningHost, TestClient, TestDirs, record_test_host,
};
use floti_protocol::channel::{EventChannel, RequestChannel};
use floti_protocol::channels::host::{HostStop, HostStopReason, HostStopRequest};
use floti_protocol::channels::sessions::{SessionList, SessionStart, StartSessionRequest};
use floti_protocol::channels::workspace::{FilesPathRequest, ReadFile, ScanStatusChanged};
use floti_protocol::message::{ClientInfo, ClientKind, Hello};
use floti_protocol::noise::{Initiator, KeyPair, PublicKey};
use floti_protocol::{Message, PROTOCOL_VERSION, encode_frame};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::task::JoinHandle;

const CAPABILITIES: &[&str] = &["files", "terminal"];

/// The handshake deadline the stalled-handshake test gives its host.
const STALL_DEADLINE: Duration = Duration::from_secs(2);

/// Both IK handshake messages on the wire: a 2-byte length, then 96 bytes
/// from the device and 48 from the host.
const MESSAGE_1: usize = 2 + 96;
const MESSAGE_2: usize = 2 + 48;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// A host whose one backend is the fake agent printing a tick every 100 ms,
/// running sessions under `/bin/sh` rather than the user's shell.
fn config(dirs: &TestDirs, endpoint: &Endpoint, agent: &FakeAgent) -> HostConfig {
    HostConfig {
        run: Default::default(),
        folders: dirs.folders(),
        endpoint: endpoint.clone(),
        backends: vec![Arc::new(agent.backend(["--fake-tick=100"])) as Arc<dyn AgentBackend>],
        inherited_env: std::env::vars_os()
            .filter(|(key, _)| key != "SHELL")
            .chain([(OsString::from("SHELL"), OsString::from("/bin/sh"))])
            .collect(),
    }
}

fn start_request(folder: &Path) -> StartSessionRequest {
    StartSessionRequest {
        cwd: folder.to_string_lossy().into_owned(),
        cols: 80,
        rows: 24,
        ..StartSessionRequest::default()
    }
}

/// The `floti host` executable with every folder in `dirs` and its stdout
/// piped, recorded so a [`TestClient`] holds it to its key. Its standard
/// error is its log file.
fn floti_host_command(dirs: &TestDirs) -> Command {
    record_test_host(&binary_endpoint(dirs), &dirs.data);
    let mut command = Command::new(env!("CARGO_BIN_EXE_floti"));
    command
        .arg("host")
        .env(DATA_DIR_VAR, &dirs.data)
        .env(LOG_DIR_VAR, &dirs.logs)
        .env(CONFIG_DIR_VAR, &dirs.config)
        .env(RUNTIME_DIR_VAR, &dirs.runtime)
        .env("HOME", &dirs.home)
        .env("USERPROFILE", &dirs.home)
        .env_remove("CLAUDE_CONFIG_DIR")
        .env_remove("SSH_CONNECTION")
        .env_remove("SSH_CLIENT")
        .env_remove("SSH_TTY")
        .env("SHELL", "/bin/sh")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    startup::stoppable(&mut command);
    command
}

fn binary_endpoint(dirs: &TestDirs) -> Endpoint {
    NativeSocket.endpoint(&dirs.runtime, SOCKET_NAME)
}

/// A `floti host` executable the test stops; dropped unstopped, it is
/// killed, so a failing test leaves no host running.
struct HostProcess {
    child: Option<Child>,
    /// The folder tree it runs over, whose logs folder holds its log.
    logs: PathBuf,
}

impl HostProcess {
    fn start(dirs: &TestDirs) -> Self {
        Self {
            child: Some(floti_host_command(dirs).spawn().expect("run floti host")),
            logs: dirs.logs.clone(),
        }
    }

    /// Asks the host to stop through `client` and hands back its stdout and
    /// its log once it has exited.
    async fn stop(mut self, mut client: TestClient) -> (String, String) {
        client
            .request::<HostStop>(&HostStopRequest {
                reason: HostStopReason::Stop,
            })
            .await
            .expect("the host takes the stop");
        drop(client);
        let mut child = self.child.take().expect("a host still running");
        let deadline = Instant::now() + PATIENCE;
        while child.try_wait().expect("poll the host").is_none() {
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("the host did not exit within {PATIENCE:?}");
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let output = child.wait_with_output().expect("read the host's output");
        let log = std::fs::read(self.logs.join(LOG_FILE)).expect("read the host's log");
        (
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&log).into_owned(),
        )
    }
}

impl Drop for HostProcess {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// The public key of the host starting on `dirs`, once it has made it.
async fn host_key_of(dirs: &TestDirs) -> PublicKey {
    let deadline = Instant::now() + PATIENCE;
    loop {
        if let Ok(Some(key)) = host_public_key(&dirs.data) {
            return key;
        }
        assert!(
            Instant::now() < deadline,
            "the host made no key within {PATIENCE:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// A raw connection to `endpoint`, retrying while the host is starting.
async fn raw(endpoint: &Endpoint) -> LocalStream {
    let deadline = Instant::now() + PATIENCE;
    loop {
        match NativeSocket.connect(endpoint).await {
            Ok(stream) => return stream,
            Err(err) => {
                assert!(
                    Instant::now() < deadline,
                    "nothing answered at {endpoint}: {err}"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    }
}

/// Everything the host sends on `stream` until it closes it, failing the
/// test when it is still open after [`PATIENCE`].
async fn read_until_closed(stream: &mut LocalStream) -> Vec<u8> {
    read_until_closed_within(stream, PATIENCE).await
}

/// Everything the host sends on `stream` until it closes it, failing the
/// test when it is still open after `within`.
async fn read_until_closed_within(stream: &mut LocalStream, within: Duration) -> Vec<u8> {
    let mut received = Vec::new();
    let mut buf = [0; 4096];
    let deadline = tokio::time::Instant::now() + within;
    loop {
        match tokio::time::timeout_at(deadline, stream.read(&mut buf)).await {
            Err(_) => panic!("the host did not close the connection within {within:?}"),
            Ok(Ok(0) | Err(_)) => return received,
            Ok(Ok(n)) => received.extend_from_slice(&buf[..n]),
        }
    }
}

/// A device's first handshake message, made for `host`.
fn first_message(device: &KeyPair, host: &PublicKey) -> Vec<u8> {
    Initiator::start(device, host).expect("start a handshake").1
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Whether `haystack` holds `needle` anywhere.
fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

/// A client's keys in `folder`, a device the host whose data is `data` has
/// never seen, pinned to that host's key.
fn pinned_client(folder: &Path, data: &Path) -> ClientKeys {
    let mut keys = ClientKeys::open(folder).expect("set up the client's keys");
    keys.pin_host(
        host_public_key(data)
            .expect("read the host key")
            .expect("the host has a key"),
    )
    .expect("pin the host key");
    keys
}

/// What one connection through a [`Tap`] carried each way.
#[derive(Default)]
struct Carried {
    to_host: Vec<u8>,
    to_client: Vec<u8>,
    /// Whether either end has closed, and with it the other.
    ended: bool,
}

/// Relays connections from its own endpoint to a host's and keeps every byte
/// each one carried. Dropping it stops relaying.
struct Tap {
    endpoint: Endpoint,
    connections: Arc<Mutex<Vec<Arc<Mutex<Carried>>>>>,
    tasks: Arc<Mutex<Vec<JoinHandle<()>>>>,
}

impl Tap {
    /// A tap at a new endpoint of `dirs`, so a [`TestClient`] connecting to
    /// it pins the key of the host whose data is in `dirs`.
    fn start(dirs: &TestDirs, host: &Endpoint) -> Self {
        let endpoint = dirs.endpoint();
        let mut listener = NativeSocket.bind(&endpoint).expect("bind the tap");
        let connections: Arc<Mutex<Vec<Arc<Mutex<Carried>>>>> = Arc::default();
        let tasks: Arc<Mutex<Vec<JoinHandle<()>>>> = Arc::default();
        let host = host.clone();
        let accepted = Arc::clone(&connections);
        let spawned = Arc::clone(&tasks);
        let accepting = tokio::spawn(async move {
            while let Ok(client) = listener.accept().await {
                let Ok(upstream) = NativeSocket.connect(&host).await else {
                    continue;
                };
                let carried = Arc::new(Mutex::new(Carried::default()));
                accepted.lock().unwrap().push(Arc::clone(&carried));
                let (client_read, client_write) = tokio::io::split(client);
                let (host_read, host_write) = tokio::io::split(upstream);
                let up = relay(client_read, host_write, Arc::clone(&carried), true);
                let down = relay(host_read, client_write, Arc::clone(&carried), false);
                // One end closing closes the other, as a direct connection
                // would: a pipe has no half-close to pass on.
                spawned.lock().unwrap().push(tokio::spawn(async move {
                    tokio::select! {
                        () = up => {}
                        () = down => {}
                    }
                    carried.lock().unwrap().ended = true;
                }));
            }
        });
        tasks.lock().unwrap().push(accepting);
        Self {
            endpoint,
            connections,
            tasks,
        }
    }

    /// What connection `n` (from 0) carried once it ended.
    async fn ended(&self, n: usize) -> (Vec<u8>, Vec<u8>) {
        let deadline = Instant::now() + PATIENCE;
        loop {
            if let Some(carried) = self.connections.lock().unwrap().get(n) {
                let carried = carried.lock().unwrap();
                if carried.ended {
                    return (carried.to_host.clone(), carried.to_client.clone());
                }
            }
            assert!(
                Instant::now() < deadline,
                "connection {n} through the tap did not end within {PATIENCE:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// What connection `n` (from 0) has carried so far.
    fn so_far(&self, n: usize) -> (Vec<u8>, Vec<u8>) {
        let connections = self.connections.lock().unwrap();
        let carried = connections[n].lock().unwrap();
        (carried.to_host.clone(), carried.to_client.clone())
    }
}

impl Drop for Tap {
    fn drop(&mut self) {
        for task in self.tasks.lock().unwrap().drain(..) {
            task.abort();
        }
    }
}

async fn relay(
    mut from: tokio::io::ReadHalf<LocalStream>,
    mut to: tokio::io::WriteHalf<LocalStream>,
    carried: Arc<Mutex<Carried>>,
    to_host: bool,
) {
    let mut buf = vec![0; 64 * 1024];
    while let Ok(n) = from.read(&mut buf).await {
        if n == 0 {
            break;
        }
        {
            let mut carried = carried.lock().unwrap();
            let kept = if to_host {
                &mut carried.to_host
            } else {
                &mut carried.to_client
            };
            kept.extend_from_slice(&buf[..n]);
        }
        if to.write_all(&buf[..n]).await.is_err() {
            break;
        }
    }
    let _ = to.shutdown().await;
}

/// The first transport message after the handshake in `bytes` from the
/// device: its length prefix and its ciphertext.
fn first_transport_message(to_host: &[u8]) -> &[u8] {
    let rest = &to_host[MESSAGE_1..];
    let len = usize::from(u16::from_be_bytes([rest[0], rest[1]]));
    &rest[..2 + len]
}

// ---------------------------------------------------------------------------
// S1, S2: the handshake comes first and everything after it is sealed
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s1_a_pinned_client_completes_the_handshake_before_anything_else_and_is_served_as_before() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = RunningHost::start(config(&dirs, &endpoint, &agent));
    let tap = Tap::start(&dirs, &endpoint);

    let mut client = TestClient::connect(&tap.endpoint, CAPABILITIES).await;
    assert_eq!(client.welcome.protocol, PROTOCOL_VERSION);
    // The first bytes each way are the two handshake messages, exactly.
    let (to_host, to_client) = tap.so_far(0);
    assert_eq!(&to_host[..2], &[0x00, 0x60], "message 1 is 96 bytes");
    assert_eq!(&to_client[..2], &[0x00, 0x30], "message 2 is 48 bytes");
    assert!(to_host.len() > MESSAGE_1 && to_client.len() > MESSAGE_2);

    // Requests, subscriptions and a session terminal, as before.
    assert!(client.request::<SessionList>(&()).await.is_ok());
    match client.subscribe_on(1, ScanStatusChanged::NAME).await {
        Message::Snapshot(_) => {}
        other => panic!("the subscription did not start with a snapshot: {other:?}"),
    }
    let folder = dirs.folder("a project");
    let session = client
        .request::<SessionStart>(&start_request(&folder))
        .await
        .unwrap();
    client.attach(7, session.id).await;
    let screen = client
        .read_stream_until(7, |bytes| String::from_utf8_lossy(bytes).contains("tick 2"))
        .await;
    assert!(!screen.is_empty());

    drop(client);
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s2_everything_after_the_handshake_crosses_the_socket_encrypted_under_keys_of_its_own_connection()
 {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = RunningHost::start(config(&dirs, &endpoint, &agent));
    let tap = Tap::start(&dirs, &endpoint);

    let mut client = TestClient::connect(&tap.endpoint, CAPABILITIES).await;
    let host_version = client.welcome.host_version.clone();
    let folder = dirs.folder("a project named plainly");
    let session = client
        .request::<SessionStart>(&start_request(&folder))
        .await
        .unwrap();
    client.attach(7, session.id).await;
    let screen = client
        .read_stream_until(7, |bytes| String::from_utf8_lossy(bytes).contains("tick 3"))
        .await;
    assert!(String::from_utf8_lossy(&screen).contains("tick 1"));
    drop(client);
    let second = TestClient::connect(&tap.endpoint, CAPABILITIES).await;
    drop(second);
    let (to_host, to_client) = tap.ended(0).await;
    let (second_to_host, _) = tap.ended(1).await;

    // Nothing the client said or was sent crosses in the clear: not the
    // hello, a request's channel or folder, the welcome, nor a terminal byte.
    for plain in [
        "floti host tests",
        SessionStart::NAME,
        "a project named plainly",
        host_version.as_str(),
        "tick 1",
        "tick 2",
    ] {
        assert!(
            !contains(&to_host, plain.as_bytes()) && !contains(&to_client, plain.as_bytes()),
            "`{plain}` crossed the socket in the clear"
        );
    }

    // The same hello from the same device, first on each connection, is
    // sealed differently: each connection has keys of its own.
    let first = first_transport_message(&to_host);
    let again = first_transport_message(&second_to_host);
    assert_eq!(first.len(), again.len(), "the same hello both times");
    assert_ne!(first, again);
    assert_ne!(&to_host[..MESSAGE_1], &second_to_host[..MESSAGE_1]);

    drop(tap);
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S3, S4: the pinned key
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s3_a_client_that_pinned_another_key_sends_no_hello_and_says_the_host_did_not_prove_it() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = RunningHost::start(config(&dirs, &endpoint, &agent));
    let tap = Tap::start(&dirs, &endpoint);
    let mut keys = pinned_client(&dirs.folder("client"), &dirs.data);
    let another_host = KeyPair::generate().unwrap().public();
    keys.pin_host(another_host).unwrap();

    let refused = keys
        .connect(&tap.endpoint)
        .await
        .expect_err("a host holding another key is not trusted");
    assert!(
        matches!(
            refused,
            ClientError::HostNotProven { .. } | ClientError::HostClosed { .. }
        ),
        "{refused:?}"
    );
    let said = refused.to_string();
    assert!(
        said.contains("did not prove the key this client pinned"),
        "{said}"
    );
    assert!(said.contains(&another_host.fingerprint()), "{said}");

    // The first handshake message went, and nothing after it.
    let (to_host, to_client) = tap.ended(0).await;
    assert_eq!(
        to_host.len(),
        MESSAGE_1,
        "the client sent more than message 1"
    );
    assert!(to_client.is_empty());

    drop(tap);
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s4_a_host_started_again_on_its_data_folder_proves_the_same_key_to_a_client_pinned_before()
{
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let client_folder = dirs.folder("client");

    let host = RunningHost::start(config(&dirs, &endpoint, &agent));
    let before = host_public_key(&dirs.data).unwrap().unwrap();
    let keys = pinned_client(&client_folder, &dirs.data);
    let connection = keys.connect(&endpoint).await.expect("connect");
    assert_eq!(connection.host_key(), before);
    let mut client = TestClient::over(connection, CAPABILITIES).await;
    assert!(client.request::<SessionList>(&()).await.is_ok());
    drop(client);
    host.stop(HostStopReason::Stop).await;

    let again = RunningHost::start(config(&dirs, &endpoint, &agent));
    assert_eq!(host_public_key(&dirs.data).unwrap(), Some(before));
    // The client starts again from its folder, and is asked nothing.
    let keys = ClientKeys::open(&client_folder).unwrap();
    let connection = keys.connect(&endpoint).await.expect("connect again");
    assert_eq!(connection.host_key(), before);
    let mut client = TestClient::over(connection, CAPABILITIES).await;
    assert!(client.request::<SessionList>(&()).await.is_ok());
    drop(client);
    again.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S5: the host key
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s5_a_new_host_makes_its_key_owner_only_before_it_accepts_anyone_and_prints_no_private_key()
{
    let dirs = TestDirs::new();
    let key_file = dirs.data.join(HOST_KEY_FILE);
    assert!(!key_file.exists());
    let host = HostProcess::start(&dirs);
    let endpoint = binary_endpoint(&dirs);

    // The moment the socket answers, the key is there and the user's alone.
    let first = raw(&endpoint).await;
    assert!(
        key_file.exists(),
        "the host accepted a client before it had a key"
    );
    assert!(NativeFiles.owner_only(&key_file).unwrap());
    drop(first);

    // A device it has never seen, served and stopping the host.
    let mut stranger = ClientKeys::open(&dirs.folder("stranger")).unwrap();
    stranger
        .pin_host(host_public_key(&dirs.data).unwrap().unwrap())
        .unwrap();
    let client = TestClient::over(stranger.connect(&endpoint).await.unwrap(), CAPABILITIES).await;
    let (stdout, log) = host.stop(client).await;

    let host_private = std::fs::read(&key_file).unwrap();
    let device_private = std::fs::read(stranger.folder().join(DEVICE_KEY_FILE)).unwrap();
    assert!(!log.contains(&stranger.device_key().to_hex()), "{log}");
    for private in [&host_private, &device_private] {
        let lower = hex(private);
        for printed in [&stdout, &log] {
            assert!(!printed.contains(&lower), "a private key was printed");
            assert!(
                !printed.contains(&lower.to_uppercase()),
                "a private key was printed"
            );
            assert!(
                !contains(printed.as_bytes(), private),
                "a private key was printed"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// S6: the testkit's client
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s6_a_test_connecting_as_tests_do_is_let_in_as_the_testkit_device_and_nothing_is_recorded()
{
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = RunningHost::start(config(&dirs, &endpoint, &agent));

    let mut client = TestClient::connect(&endpoint, CAPABILITIES).await;
    assert!(client.request::<SessionList>(&()).await.is_ok());
    assert_eq!(
        Some(client.host_key()),
        host_public_key(&dirs.data).unwrap()
    );
    // The host keeps no record of the devices it has served.
    for retired in RETIRED_FILES {
        assert!(!dirs.data.join(retired).exists(), "{retired}");
    }

    drop(client);
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S7: any device key is served; S8 to S10: refusals, closed without a byte
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s7_a_device_key_the_host_has_never_seen_is_welcomed_and_served_with_nothing_asked() {
    let dirs = TestDirs::new();
    let host = HostProcess::start(&dirs);
    let endpoint = binary_endpoint(&dirs);
    // Up, and serving the testkit's device.
    drop(TestClient::connect(&endpoint, CAPABILITIES).await);
    let stranger = KeyPair::generate().unwrap();

    let mut client = TestClient::connect_device(&endpoint, &stranger, CAPABILITIES).await;
    assert!(client.request::<SessionList>(&()).await.is_ok());
    // It is the one that stops the host: host:stop is served to it too.
    let (_, log) = host.stop(client).await;
    assert!(!log.contains("refused client"), "{log}");
    assert!(!log.contains(&stranger.public().to_hex()), "{log}");
}

#[tokio::test(flavor = "multi_thread")]
async fn s9_a_connection_that_does_not_speak_the_handshake_or_holds_the_host_to_another_key_is_closed_unanswered_and_logged_naming_no_key()
 {
    let dirs = TestDirs::new();
    let host = HostProcess::start(&dirs);
    let endpoint = binary_endpoint(&dirs);
    let host_key = host_key_of(&dirs).await;

    let plain_hello = encode_frame(&Message::Hello(Hello {
        protocol: PROTOCOL_VERSION,
        client: ClientInfo {
            name: "a client from before".to_owned(),
            kind: ClientKind::Tui,
            device_name: None,
        },
        capabilities: vec!["terminal".to_owned()],
    }))
    .unwrap();
    let noise: Vec<u8> = (0..200_u32).map(|n| (n * 37 + 90) as u8).collect();
    // Made for another host's key, so this one cannot decrypt it.
    let another_host = KeyPair::generate().unwrap().public();
    let device = KeyPair::generate().unwrap();
    let undecryptable = first_message(&device, &another_host);
    assert_ne!(another_host, host_key);

    for opening in [plain_hello, noise, undecryptable] {
        let mut stream = raw(&endpoint).await;
        let _ = stream.write_all(&opening).await;
        assert!(read_until_closed(&mut stream).await.is_empty());
        let mut client = TestClient::connect(&endpoint, CAPABILITIES).await;
        assert!(client.request::<SessionList>(&()).await.is_ok());
    }

    let client = TestClient::connect(&endpoint, CAPABILITIES).await;
    let (_, log) = host.stop(client).await;
    let failed = log
        .lines()
        .filter(|line| line.contains("refused client") && line.contains("failed handshake"))
        .count();
    assert_eq!(failed, 3, "{log}");
    for key in [device.public(), another_host, host_key] {
        assert!(!log.contains(&key.to_hex()), "{log}");
        assert!(!log.contains(&key.fingerprint()), "{log}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn s10_a_connection_that_stalls_before_or_inside_the_handshake_is_closed_at_the_deadline_and_logged()
 {
    let dirs = TestDirs::new();
    // A deadline of the test's own: the real one's length is stepped in the
    // connection's unit tests, and this one only shows the refusals happen,
    // and are logged, while another client is served. It still leaves the
    // served client's handshake, a few milliseconds, far inside it.
    dirs.with_handshake_deadline(STALL_DEADLINE);
    let host = HostProcess::start(&dirs);
    let endpoint = binary_endpoint(&dirs);
    let host_key = host_key_of(&dirs).await;
    let device = KeyPair::generate().unwrap();

    let mut silent = raw(&endpoint).await;
    let mut partway = raw(&endpoint).await;
    partway
        .write_all(&first_message(&device, &host_key)[..40])
        .await
        .unwrap();
    // Another client is served while they wait.
    let mut client = TestClient::connect(&endpoint, CAPABILITIES).await;
    assert!(client.request::<SessionList>(&()).await.is_ok());

    let (to_silent, to_partway) = tokio::join!(
        read_until_closed_within(&mut silent, PATIENCE),
        read_until_closed_within(&mut partway, PATIENCE)
    );
    assert!(to_silent.is_empty() && to_partway.is_empty());

    let (_, log) = host.stop(client).await;
    let timed_out = log
        .lines()
        .filter(|line| line.contains("refused client") && line.contains("did not finish in time"))
        .count();
    assert_eq!(timed_out, 2, "{log}");
}

#[tokio::test(flavor = "multi_thread")]
async fn s5_connections_that_say_no_hello_are_closed_at_the_deadline_by_fingerprint() {
    let dirs = TestDirs::new();
    // A deadline of the test's own, for the hello as for the handshake: the
    // real one's length is stepped in the connection's unit tests, and this
    // one only shows the closes happen, and are logged, while another client
    // is served.
    dirs.with_handshake_deadline(STALL_DEADLINE);
    let host = HostProcess::start(&dirs);
    let endpoint = binary_endpoint(&dirs);
    // Another client is served while they wait.
    let mut served = TestClient::connect(&endpoint, CAPABILITIES).await;
    assert!(served.request::<SessionList>(&()).await.is_ok());

    // Two devices finish their handshakes, then say nothing.
    let desk = pinned_client(&dirs.folder("desk"), &dirs.data);
    let quiet = pinned_client(&dirs.folder("quiet"), &dirs.data);
    let mut silent = Vec::new();
    for keys in [&desk, &quiet] {
        silent.push(keys.connect(&endpoint).await.expect("let in"));
    }
    for connection in &mut silent {
        match tokio::time::timeout(PATIENCE, connection.next()).await {
            Err(_) => panic!("the host kept a silent connection open past {PATIENCE:?}"),
            Ok(Ok(Some(message))) => panic!("the host wrote to a silent connection: {message:?}"),
            Ok(Ok(None) | Err(_)) => {}
        }
    }
    assert!(served.request::<SessionList>(&()).await.is_ok());

    let (_, log) = host.stop(served).await;
    let no_hello: Vec<&str> = log
        .lines()
        .filter(|line| {
            line.contains("refused client") && line.contains("did not say hello in time")
        })
        .collect();
    assert_eq!(no_hello.len(), 2, "{log}");
    for key in [desk.device_key(), quiet.device_key()] {
        assert!(
            no_hello
                .iter()
                .any(|line| line.contains(&format!("device {}", key.fingerprint()))),
            "{log}"
        );
        assert!(!log.contains(&key.to_hex()), "{log}");
    }
}

// ---------------------------------------------------------------------------
// S11, S12: what a client keeps on disk
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s11_a_client_that_used_a_host_keeps_its_device_key_and_the_pinned_host_key_and_nothing_else()
 {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = RunningHost::start(config(&dirs, &endpoint, &agent));
    let client_folder = dirs.folder("client");
    let keys = pinned_client(&client_folder, &dirs.data);

    let mut client = TestClient::over(keys.connect(&endpoint).await.unwrap(), CAPABILITIES).await;
    let project = dirs.folder("a project");
    std::fs::write(project.join("notes.md"), "# Notes\n").unwrap();
    let session = client
        .request::<SessionStart>(&start_request(&project))
        .await
        .unwrap();
    client.attach(3, session.id).await;
    client
        .read_stream_until(3, |bytes| String::from_utf8_lossy(bytes).contains("tick 1"))
        .await;
    client
        .request::<ReadFile>(&FilesPathRequest {
            root: project.to_string_lossy().into_owned(),
            path: project.join("notes.md").to_string_lossy().into_owned(),
        })
        .await
        .expect("read a file");
    drop(client);
    host.stop(HostStopReason::Stop).await;

    let mut kept: Vec<PathBuf> = std::fs::read_dir(&client_folder)
        .unwrap()
        .map(|entry| PathBuf::from(entry.unwrap().file_name()))
        .collect();
    kept.sort();
    assert_eq!(
        kept,
        [
            PathBuf::from(DEVICE_KEY_FILE),
            PathBuf::from(PINNED_HOST_FILE)
        ]
    );
    assert!(
        NativeFiles
            .owner_only(&client_folder.join(DEVICE_KEY_FILE))
            .unwrap()
    );
}

#[test]
fn s11_a_new_file_a_killed_key_write_left_goes_when_the_client_opens_its_folder() {
    let dirs = TestDirs::new();
    let folder = dirs.folder("client");
    // A process that has ended, standing for one killed while it wrote.
    let mut gone = Command::new(std::env::current_exe().unwrap())
        .arg("--list")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let gone_pid = gone.id();
    gone.wait().unwrap();
    let left = folder.join(format!(".{DEVICE_KEY_FILE}.{gone_pid}-0.tmp"));
    std::fs::write(&left, [7u8; 32]).unwrap();
    let pinned_left = folder.join(format!(".{PINNED_HOST_FILE}.{gone_pid}-1.tmp"));
    std::fs::write(&pinned_left, b"part of a pin").unwrap();

    ClientKeys::open(&folder).expect("set up the client's keys");

    let mut kept: Vec<PathBuf> = std::fs::read_dir(&folder)
        .unwrap()
        .map(|entry| PathBuf::from(entry.unwrap().file_name()))
        .collect();
    kept.sort();
    assert_eq!(kept, [PathBuf::from(DEVICE_KEY_FILE)]);
}

#[test]
fn s12_clients_setting_up_one_empty_folder_at_the_same_moment_present_the_key_on_disk() {
    const CLIENTS: usize = 8;
    let dirs = TestDirs::new();
    let folder = dirs.root().join("an empty client folder");
    let start = std::sync::Barrier::new(CLIENTS);
    let keys: Vec<PublicKey> = std::thread::scope(|scope| {
        let clients: Vec<_> = (0..CLIENTS)
            .map(|_| {
                scope.spawn(|| {
                    start.wait();
                    ClientKeys::open(&folder).unwrap().device_key()
                })
            })
            .collect();
        clients
            .into_iter()
            .map(|client| client.join().unwrap())
            .collect()
    });

    let on_disk = ClientKeys::open(&folder).unwrap().device_key();
    assert!(
        keys.iter().all(|key| *key == on_disk),
        "{keys:?} vs {on_disk:?}"
    );
    let kept: Vec<PathBuf> = std::fs::read_dir(&folder)
        .unwrap()
        .map(|entry| PathBuf::from(entry.unwrap().file_name()))
        .collect();
    assert_eq!(kept, [PathBuf::from(DEVICE_KEY_FILE)]);
}

#[tokio::test(flavor = "multi_thread")]
async fn s12_a_client_set_up_again_from_its_folder_presents_the_same_device_key_and_never_prints_it()
 {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = RunningHost::start(config(&dirs, &endpoint, &agent));
    let folder = dirs.root().join("an empty client folder");

    let keys = pinned_client(&folder, &dirs.data);
    let private = std::fs::read(folder.join(DEVICE_KEY_FILE)).unwrap();
    drop(keys.connect(&endpoint).await.expect("connect"));

    let again = ClientKeys::open(&folder).unwrap();
    assert_eq!(again.device_key(), keys.device_key());
    assert_eq!(
        std::fs::read(folder.join(DEVICE_KEY_FILE)).unwrap(),
        private
    );
    let mut client = TestClient::over(again.connect(&endpoint).await.unwrap(), CAPABILITIES).await;
    assert!(client.request::<SessionList>(&()).await.is_ok());

    let printed = format!("{keys:?} {again:?} {:?}", again.device_key());
    assert!(
        printed.contains(&again.device_key().fingerprint()),
        "{printed}"
    );
    assert!(!printed.contains(&hex(&private)), "{printed}");
    assert!(
        !printed.contains(&hex(&private).to_uppercase()),
        "{printed}"
    );

    drop(client);
    host.stop(HostStopReason::Stop).await;
}
