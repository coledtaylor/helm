//! `floti bridge`, end to end: the `floti` executable connecting a client
//! from its folder to a real host on a real local socket, relaying the
//! protocol over its standard input and output, with the fake agent in a real
//! pty behind it.
//!
//! Every folder and socket is in a temporary tree. A bridge ends when the
//! test's pipe to its standard input closes, which dropping it does, so none
//! outlives its test; a host is a [`RunningHost`] the test stops.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use floti_host::agent::AgentBackend;
use floti_host::client::{ClientKeys, DEVICE_KEY_FILE, PINNED_HOST_FILE};
use floti_host::devices::{DeviceRegistry, Role};
use floti_host::fake_agent;
use floti_host::platform::folders::{CONFIG_DIR_VAR, DATA_DIR_VAR, LOG_DIR_VAR, RUNTIME_DIR_VAR};
use floti_host::platform::private_files::{Native as NativeFiles, PrivateFiles};
use floti_host::platform::process_tree::{Native as NativeTree, ProcessTree};
use floti_host::platform::socket::{
    Endpoint, LocalListener, LocalSocket, LocalStream, Native as NativeSocket,
};
use floti_host::server::{
    ENROLMENT_FILE, FIRST_ADMIN_NAME, HostConfig, local_endpoint, read_enrolment,
};
use floti_host::testkit::{FakeAgent, PATIENCE, RunningHost, TestClient, TestDirs};
use floti_protocol::channel::{RequestChannel, from_payload, to_payload};
use floti_protocol::channels::common::{SessionRecord, SessionStatus};
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::sessions::{
    SessionList, SessionStart, SessionStreamOpen, SessionTerminal, StartSessionRequest,
};
use floti_protocol::message::{ClientInfo, ClientKind, Hello, Request, StreamData, StreamOpen};
use floti_protocol::noise::{ENROLMENT_CODE_LEN, EnrolmentCode, KeyPair, PublicKey};
use floti_protocol::{
    Bytes, FrameDecoder, Knowable, Message, PROTOCOL_VERSION, StreamChannel, encode_frame,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

/// The first handshake message on the stream: its 2-byte length, then the
/// 96 bytes of an `IK` first message.
const MESSAGE_1: usize = 2 + 96;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// A host on `dirs`' folders, at the endpoint `floti bridge` finds from
/// them, whose one backend is the fake agent answering each line it reads.
fn config(dirs: &TestDirs, agent: &FakeAgent) -> HostConfig {
    HostConfig {
        run: Default::default(),
        folders: dirs.folders(),
        endpoint: local_endpoint(&dirs.folders()),
        backends: vec![Arc::new(agent.backend(Vec::<&str>::new())) as Arc<dyn AgentBackend>],
        inherited_env: std::env::vars_os().collect(),
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

/// A `floti bridge` for the client in `folder`, finding the host from
/// `dirs`' folders, with `runtime` as its runtime folder.
fn bridge_command(dirs: &TestDirs, runtime: &Path, folder: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_floti"));
    command
        .arg("bridge")
        .arg(folder)
        .env(DATA_DIR_VAR, &dirs.data)
        .env(LOG_DIR_VAR, &dirs.logs)
        .env(CONFIG_DIR_VAR, &dirs.config)
        .env(RUNTIME_DIR_VAR, runtime)
        .env("HOME", &dirs.home)
        .env("USERPROFILE", &dirs.home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

/// A running `floti bridge`: frames go in on its standard input and come
/// out of its standard output, decoded on a thread of their own. Dropping it
/// closes its standard input, which ends it; one still running after
/// [`PATIENCE`] is killed.
struct Bridge {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    messages: mpsc::UnboundedReceiver<Message>,
    /// Every byte the bridge wrote to standard output.
    stdout: Arc<std::sync::Mutex<Vec<u8>>>,
    stderr: Option<std::thread::JoinHandle<Vec<u8>>>,
}

/// How a bridge ended.
#[derive(Debug)]
struct Ended {
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: String,
}

impl Bridge {
    fn spawn(mut command: Command) -> Self {
        let mut child = command.spawn().expect("run floti bridge");
        let stdin = child.stdin.take();
        let mut out = child.stdout.take().expect("the bridge's stdout");
        let mut err = child.stderr.take().expect("the bridge's stderr");
        let (tx, messages) = mpsc::unbounded_channel();
        let stdout = Arc::new(std::sync::Mutex::new(Vec::new()));
        let written = Arc::clone(&stdout);
        std::thread::spawn(move || {
            let mut decoder = FrameDecoder::new();
            let mut buf = [0; 64 * 1024];
            while let Ok(n @ 1..) = out.read(&mut buf) {
                written.lock().unwrap().extend_from_slice(&buf[..n]);
                decoder.push(&buf[..n]);
                for message in decoder.drain().expect("the bridge writes only frames") {
                    if tx.send(message).is_err() {
                        return;
                    }
                }
            }
        });
        let stderr = std::thread::spawn(move || {
            let mut text = Vec::new();
            let _ = err.read_to_end(&mut text);
            text
        });
        Self {
            child: Some(child),
            stdin,
            messages,
            stdout,
            stderr: Some(stderr),
        }
    }

    /// Writes `bytes` to the bridge's standard input.
    fn write(&mut self, bytes: &[u8]) {
        let stdin = self.stdin.as_mut().expect("the bridge's stdin is open");
        stdin.write_all(bytes).expect("write to the bridge");
        stdin.flush().expect("flush the bridge's stdin");
    }

    fn send(&mut self, message: &Message) {
        self.write(&encode_frame(message).expect("encode a frame"));
    }

    /// The next message the bridge relayed from the host.
    async fn next(&mut self) -> Message {
        match tokio::time::timeout(PATIENCE, self.messages.recv()).await {
            Ok(Some(message)) => message,
            Ok(None) => panic!("the bridge's output ended"),
            Err(_) => panic!("the bridge relayed nothing within {PATIENCE:?}"),
        }
    }

    /// The first relayed message `wanted` accepts, skipping the others.
    async fn next_where(&mut self, wanted: impl Fn(&Message) -> bool) -> Message {
        let deadline = Instant::now() + PATIENCE;
        loop {
            assert!(
                Instant::now() < deadline,
                "no such message within {PATIENCE:?}"
            );
            let message = self.next().await;
            if wanted(&message) {
                return message;
            }
        }
    }

    fn hello(&mut self) {
        self.send(&Message::Hello(Hello {
            protocol: PROTOCOL_VERSION,
            client: ClientInfo {
                name: "a bridge test".to_owned(),
                kind: ClientKind::Desktop,
            },
            capabilities: vec!["terminal".to_owned()],
        }));
    }

    async fn welcomed(&mut self) {
        self.hello();
        match self.next().await {
            Message::Welcome(_) => {}
            other => panic!("the host did not welcome the bridge's client: {other:?}"),
        }
    }

    async fn request<C: RequestChannel>(&mut self, id: u64, request: &C::Request) -> C::Response {
        self.send(&Message::Request(Request {
            id,
            channel: C::NAME.to_owned(),
            payload: to_payload(request).expect("encode a request"),
        }));
        match self
            .next_where(|message| match message {
                Message::Response(response) => response.id == id,
                Message::Error(error) => error.id == id,
                _ => false,
            })
            .await
        {
            Message::Response(response) => from_payload(&response.payload).expect("decode"),
            other => panic!("`{}` was refused: {other:?}", C::NAME),
        }
    }

    /// Everything stream `stream` carried once `done` accepts it.
    async fn read_stream_until(&mut self, stream: u64, done: impl Fn(&str) -> bool) -> String {
        let deadline = Instant::now() + PATIENCE;
        let mut bytes = Vec::new();
        loop {
            let text = String::from_utf8_lossy(&bytes).into_owned();
            if done(&text) {
                return text;
            }
            assert!(
                Instant::now() < deadline,
                "stream {stream} did not show what was expected within {PATIENCE:?}: {text:?}"
            );
            if let Message::StreamData(data) = self.next().await
                && data.stream == stream
            {
                bytes.extend_from_slice(&data.data.0);
            }
        }
    }

    /// Closes the bridge's standard input.
    fn close_stdin(&mut self) {
        self.stdin = None;
    }

    /// Waits for the bridge to exit on its own.
    async fn ended(mut self) -> Ended {
        let mut child = self.child.take().expect("the bridge's process");
        let deadline = Instant::now() + PATIENCE;
        let status = loop {
            if let Some(status) = child.try_wait().expect("poll the bridge") {
                break status;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("the bridge did not exit within {PATIENCE:?}");
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        let stderr = self
            .stderr
            .take()
            .expect("the bridge's stderr")
            .join()
            .expect("read the bridge's stderr");
        Ended {
            code: status.code(),
            stdout: self.stdout.lock().unwrap().clone(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        }
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.stdin = None;
        if let Some(mut child) = self.child.take() {
            let deadline = Instant::now() + PATIENCE;
            while matches!(child.try_wait(), Ok(None)) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(20));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Asserts `ended` is one line on stderr holding `says`, with `code`.
fn assert_ended(ended: &Ended, code: i32, says: &str) {
    assert_eq!(ended.code, Some(code), "{ended:?}");
    let lines: Vec<&str> = ended.stderr.lines().collect();
    assert_eq!(lines.len(), 1, "{ended:?}");
    assert!(lines[0].starts_with("floti bridge: "), "{ended:?}");
    assert!(lines[0].contains(says), "{ended:?}");
}

fn names_in(folder: &Path) -> Vec<PathBuf> {
    let mut names: Vec<PathBuf> = std::fs::read_dir(folder)
        .unwrap()
        .map(|entry| PathBuf::from(entry.unwrap().file_name()))
        .collect();
    names.sort();
    names
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

/// Fails the test when `printed` holds `code` in any form it could be
/// printed in.
fn assert_code_absent(code: &EnrolmentCode, printed: &[u8], what: &str) {
    let lower = code.expose_hex();
    for form in [
        lower.as_bytes(),
        lower.to_uppercase().as_bytes(),
        code.expose_secret(),
    ] {
        assert!(!contains(printed, form), "the code is in {what}");
    }
}

/// Fails the test when `printed` holds any of `keys` whole, in hex. A key
/// is named by its fingerprint, which is shorter.
fn assert_keys_absent(keys: &[PublicKey], printed: &[u8], what: &str) {
    for key in keys {
        let hex = key.to_hex();
        assert!(
            !contains(printed, hex.as_bytes()) && !contains(printed, hex.to_uppercase().as_bytes()),
            "a key is in {what}"
        );
    }
}

/// A client folder pinned to `host`, with a device key of its own.
fn pinned_folder(dirs: &TestDirs, name: &str, host: PublicKey) -> PathBuf {
    let folder = dirs.folder(name);
    ClientKeys::open(&folder)
        .expect("set up the client's keys")
        .pin_host(host)
        .expect("pin the host key");
    folder
}

/// A relay at `endpoint` to the host at `host` for one connection, keeping
/// every byte it carried each way: to the host, then to the client. One end
/// closing closes the other.
fn tap(endpoint: &Endpoint, host: Endpoint) -> JoinHandle<(Vec<u8>, Vec<u8>)> {
    let mut listener = NativeSocket.bind(endpoint).expect("bind the tap");
    tokio::spawn(async move {
        let mut client = listener.accept().await.expect("accept the bridge");
        let mut upstream: LocalStream = NativeSocket.connect(&host).await.expect("reach the host");
        let (mut to_host, mut to_client) = (Vec::new(), Vec::new());
        let (mut up, mut down) = ([0; 4096], [0; 4096]);
        loop {
            tokio::select! {
                read = client.read(&mut up) => match read {
                    Ok(n @ 1..) => {
                        to_host.extend_from_slice(&up[..n]);
                        if upstream.write_all(&up[..n]).await.is_err() {
                            break;
                        }
                    }
                    _ => break,
                },
                read = upstream.read(&mut down) => match read {
                    Ok(n @ 1..) => {
                        to_client.extend_from_slice(&down[..n]);
                        if client.write_all(&down[..n]).await.is_err() {
                            break;
                        }
                    }
                    _ => break,
                },
            }
        }
        (to_host, to_client)
    })
}

async fn tapped(tap: JoinHandle<(Vec<u8>, Vec<u8>)>) -> (Vec<u8>, Vec<u8>) {
    tokio::time::timeout(PATIENCE, tap)
        .await
        .expect("the tapped connection ended")
        .expect("the tap ran")
}

// ---------------------------------------------------------------------------
// S13: enrol or connect pinned, then relay frames unchanged and in order
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s13_the_bridge_enrols_as_first_admin_then_connects_pinned_and_relays_frames_in_order() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let host = RunningHost::start_unpaired(config(&dirs, &agent));
    let written = read_enrolment(&dirs.data)
        .unwrap()
        .expect("the host waits for its first admin");
    let folder = dirs.root().join("desk client");

    let mut bridge = Bridge::spawn(bridge_command(&dirs, &dirs.runtime, &folder));
    bridge.welcomed().await;
    let project = dirs.folder("a project");
    let session: SessionRecord = bridge
        .request::<SessionStart>(1, &start_request(&project))
        .await;
    bridge.send(&Message::StreamOpen(StreamOpen {
        stream: 1,
        channel: SessionTerminal::NAME.to_owned(),
        params: to_payload(&SessionStreamOpen { id: session.id }).unwrap(),
    }));
    // Three frames in one write, each a line typed into the agent.
    let typed: Vec<u8> = ["one\r", "two\r", "three\r"]
        .iter()
        .flat_map(|line| {
            encode_frame(&Message::StreamData(StreamData {
                stream: 1,
                data: Bytes(line.as_bytes().to_vec()),
            }))
            .unwrap()
        })
        .collect();
    bridge.write(&typed);
    let screen = bridge
        .read_stream_until(1, |text| text.contains("echo: three"))
        .await;
    let at = |line: &str| {
        screen
            .find(line)
            .unwrap_or_else(|| panic!("{line:?} in {screen:?}"))
    };
    assert!(
        at("echo: one") < at("echo: two") && at("echo: two") < at("echo: three"),
        "{screen:?}"
    );

    // Enrolled as the first admin, and the code was used.
    let keys = ClientKeys::open(&folder).unwrap();
    assert_eq!(keys.pinned_host(), Some(written.host_key));
    let devices = DeviceRegistry::in_data_folder(&dirs.data)
        .devices()
        .unwrap();
    assert_eq!(devices.len(), 1, "{devices:?}");
    assert_eq!(devices[0].key, keys.device_key());
    assert_eq!(devices[0].role, Role::Admin);
    assert_eq!(devices[0].name, FIRST_ADMIN_NAME);
    assert!(!dirs.data.join(ENROLMENT_FILE).exists());

    bridge.close_stdin();
    let first = bridge.ended().await;
    assert_eq!(first.code, Some(0), "{first:?}");
    assert_eq!(first.stderr, "", "{first:?}");

    // With the code gone, the same folder connects pinned and is served.
    let mut again = Bridge::spawn(bridge_command(&dirs, &dirs.runtime, &folder));
    again.welcomed().await;
    let listed = again.request::<SessionList>(1, &()).await;
    assert_eq!(
        listed.iter().map(|row| row.id).collect::<Vec<_>>(),
        [session.id]
    );
    again.close_stdin();
    let second = again.ended().await;
    assert_eq!(second.code, Some(0), "{second:?}");

    assert_eq!(
        names_in(&folder),
        [
            PathBuf::from(DEVICE_KEY_FILE),
            PathBuf::from(PINNED_HOST_FILE)
        ]
    );
    assert!(
        NativeFiles
            .owner_only(&folder.join(DEVICE_KEY_FILE))
            .unwrap()
    );
    for ended in [&first, &second] {
        assert_code_absent(&written.code, ended.stderr.as_bytes(), "the bridge's log");
        assert_code_absent(&written.code, &ended.stdout, "the bridge's output");
        assert_keys_absent(
            &[written.host_key, keys.device_key()],
            ended.stderr.as_bytes(),
            "the bridge's log",
        );
    }
    let kept: Vec<u8> = std::fs::read(folder.join(PINNED_HOST_FILE)).unwrap();
    assert_code_absent(&written.code, &kept, "the client's folder");
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S14: each way of not getting in has a status and one line of its own
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s14_with_no_host_answering_the_bridge_exits_3_saying_none_answered() {
    let dirs = TestDirs::new();
    let host_key = KeyPair::generate().unwrap().public();
    let folder = pinned_folder(&dirs, "desk client", host_key);
    let ended = Bridge::spawn(bridge_command(&dirs, &dirs.runtime, &folder))
        .ended()
        .await;
    assert_ended(&ended, 3, "no host answered");
    assert!(ended.stdout.is_empty(), "{ended:?}");
    assert_keys_absent(&[host_key], ended.stderr.as_bytes(), "the bridge's log");
}

#[tokio::test(flavor = "multi_thread")]
async fn s14_with_no_pinned_key_and_no_code_file_the_bridge_exits_4_saying_it_must_be_paired() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    // A host with an admin keeps no code file.
    let host = RunningHost::start(config(&dirs, &agent));
    assert!(!dirs.data.join(ENROLMENT_FILE).exists());
    let folder = dirs.root().join("desk client");
    let ended = Bridge::spawn(bridge_command(&dirs, &dirs.runtime, &folder))
        .ended()
        .await;
    assert_ended(&ended, 4, "pair it with a host first");
    assert!(ended.stdout.is_empty(), "{ended:?}");
    assert_eq!(names_in(&folder), [PathBuf::from(DEVICE_KEY_FILE)]);
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s14_a_host_that_does_not_prove_the_pinned_key_gets_only_the_first_message_and_the_bridge_exits_5()
 {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let host = RunningHost::start(config(&dirs, &agent));
    let pinned = KeyPair::generate().unwrap().public();
    let folder = pinned_folder(&dirs, "desk client", pinned);
    let tap_runtime = dirs.folder("tap");
    let tapped_at = local_endpoint(&floti_host::platform::folders::Folders {
        runtime: tap_runtime.clone(),
        ..dirs.folders()
    });
    let relay = tap(&tapped_at, local_endpoint(&dirs.folders()));

    let ended = Bridge::spawn(bridge_command(&dirs, &tap_runtime, &folder))
        .ended()
        .await;
    assert_ended(&ended, 5, "did not prove the key this client pinned");
    assert!(ended.stderr.contains(&pinned.fingerprint()), "{ended:?}");
    assert!(ended.stdout.is_empty(), "{ended:?}");
    let (to_host, to_client) = tapped(relay).await;
    assert_eq!(to_host.len(), MESSAGE_1, "only the first handshake message");
    assert!(to_client.is_empty());
    assert_keys_absent(&[pinned], ended.stderr.as_bytes(), "the bridge's log");
    assert_eq!(
        ClientKeys::open(&folder).unwrap().pinned_host(),
        Some(pinned)
    );
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s14_a_host_that_does_not_prove_the_code_files_key_gets_only_the_first_message_and_the_bridge_exits_5()
 {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let host = RunningHost::start_unpaired(config(&dirs, &agent));
    let genuine = read_enrolment(&dirs.data).unwrap().expect("a code file");
    let impostor = KeyPair::generate().unwrap().public();
    NativeFiles
        .write(
            &dirs.data.join(ENROLMENT_FILE),
            format!(
                r#"{{"format":1,"hostKey":"{}","code":"{}"}}"#,
                impostor.to_hex(),
                genuine.code.expose_hex().as_str()
            )
            .as_bytes(),
        )
        .unwrap();
    let folder = dirs.root().join("desk client");
    let tap_runtime = dirs.folder("tap");
    let tapped_at = local_endpoint(&floti_host::platform::folders::Folders {
        runtime: tap_runtime.clone(),
        ..dirs.folders()
    });
    let relay = tap(&tapped_at, local_endpoint(&dirs.folders()));

    let ended = Bridge::spawn(bridge_command(&dirs, &tap_runtime, &folder))
        .ended()
        .await;
    assert_ended(&ended, 5, "did not prove the key its enrolment file names");
    assert!(ended.stdout.is_empty(), "{ended:?}");
    let (to_host, to_client) = tapped(relay).await;
    assert_eq!(
        to_host.len(),
        MESSAGE_1 + ENROLMENT_CODE_LEN,
        "only the first handshake message"
    );
    assert!(to_client.is_empty());
    assert_code_absent(&genuine.code, ended.stderr.as_bytes(), "the bridge's log");
    assert_keys_absent(
        &[impostor, genuine.host_key],
        ended.stderr.as_bytes(),
        "the bridge's log",
    );
    assert_eq!(names_in(&folder), [PathBuf::from(DEVICE_KEY_FILE)]);
    assert!(
        DeviceRegistry::in_data_folder(&dirs.data)
            .devices()
            .unwrap()
            .is_empty()
    );
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S15: how a connected bridge ends
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s15_closing_the_bridges_stdin_exits_0_and_the_host_ends_none_of_its_sessions() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let host = RunningHost::start_unpaired(config(&dirs, &agent));
    let folder = dirs.root().join("desk client");
    let mut bridge = Bridge::spawn(bridge_command(&dirs, &dirs.runtime, &folder));
    bridge.welcomed().await;
    let project = dirs.folder("a project");
    let session: SessionRecord = bridge
        .request::<SessionStart>(1, &start_request(&project))
        .await;
    bridge.send(&Message::StreamOpen(StreamOpen {
        stream: 1,
        channel: SessionTerminal::NAME.to_owned(),
        params: to_payload(&SessionStreamOpen { id: session.id }).unwrap(),
    }));
    bridge.write(
        &encode_frame(&Message::StreamData(StreamData {
            stream: 1,
            data: Bytes(b"still here\r".to_vec()),
        }))
        .unwrap(),
    );
    bridge
        .read_stream_until(1, |text| text.contains("echo: still here"))
        .await;

    bridge.close_stdin();
    let ended = bridge.ended().await;
    assert_eq!(ended.code, Some(0), "{ended:?}");
    assert_eq!(ended.stderr, "", "{ended:?}");

    // The session runs on, and another client attaches to it.
    let pid = agent
        .records()
        .first()
        .map(|record| record.pid)
        .expect("the session's agent ran");
    assert_eq!(NativeTree.is_alive(pid), Knowable::Known(true));
    let mut client = TestClient::connect(&local_endpoint(&dirs.folders()), &["terminal"]).await;
    let listed = client.request::<SessionList>(&()).await.unwrap();
    assert_eq!(listed.len(), 1, "{listed:?}");
    assert_eq!(listed[0].id, session.id);
    assert_eq!(listed[0].status, SessionStatus::Running);
    client.attach(1, session.id).await;
    client.type_into(1, b"and on\r").await;
    client
        .read_stream_until(1, |bytes| {
            String::from_utf8_lossy(bytes).contains("echo: and on")
        })
        .await;
    drop(client);
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s15_the_host_closing_the_connection_ends_the_bridge_with_6_and_one_line() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let host = RunningHost::start_unpaired(config(&dirs, &agent));
    let folder = dirs.root().join("desk client");
    let mut bridge = Bridge::spawn(bridge_command(&dirs, &dirs.runtime, &folder));
    bridge.welcomed().await;

    host.stop(HostStopReason::Stop).await;
    let ended = bridge.ended().await;
    assert_ended(&ended, 6, "the host closed the connection");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_frame_on_the_bridges_stdin_that_does_not_decode_ends_it_with_1_and_one_line() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let host = RunningHost::start_unpaired(config(&dirs, &agent));
    let folder = dirs.root().join("desk client");
    let mut bridge = Bridge::spawn(bridge_command(&dirs, &dirs.runtime, &folder));
    bridge.welcomed().await;

    let mut garbage = 3u32.to_be_bytes().to_vec();
    garbage.extend_from_slice(&[0xff, 0xff, 0xff]);
    bridge.write(&garbage);
    let ended = bridge.ended().await;
    assert_ended(&ended, 1, "does not decode");
    assert!(!ended.stderr.contains("ffffff"), "{ended:?}");
    host.stop(HostStopReason::Stop).await;
}

#[test]
fn a_bridge_given_no_client_folder_exits_2_with_the_usage() {
    let output = Command::new(env!("CARGO_BIN_EXE_floti"))
        .arg("bridge")
        .stdin(Stdio::null())
        .output()
        .expect("run floti bridge");
    assert_eq!(output.status.code(), Some(2));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("floti bridge <client folder>"),
        "{output:?}"
    );
}
