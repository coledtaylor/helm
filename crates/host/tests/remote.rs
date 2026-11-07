//! Reaching a host on another computer, end to end: `floti connect` carrying
//! the protocol between its standard input and output and a real host's
//! local socket, and `floti bridge` running a transport (the fake `ssh`, or
//! a custom command) with `floti connect` as its last argument, the handshake
//! crossing it, and a client with nothing pinned learning the host's key
//! through it.
//!
//! No test reaches another computer or a real ssh: the fake transports in
//! `test/fake-ssh/` run the line they are given on this computer, in the
//! test's own folders, with `floti` mapped to the binary built here. Nothing
//! reads or writes `~/.ssh`. Every folder is in the test's temporary tree, a
//! host is a [`RunningHost`] the test stops, or the `floti host` executable
//! run as a server's user unit runs it, which the test stops or kills and
//! starts again as systemd would, and a bridge ends when the
//! test's pipe to its standard input closes, which takes its transport and
//! the `floti connect` behind it along: each sees its standard input close.

use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use floti_host::agent::AgentBackend;
use floti_host::bridge::{CONNECT_LINE, HOST_KEY_LINE, Transport, remote_floti_problem};
use floti_host::client::{ClientError, ClientKeys, DEVICE_KEY_FILE, PINNED_HOST_FILE, duplex};
use floti_host::connect::NO_HOST_LINE;
use floti_host::fake_agent;
use floti_host::keys::load_or_create_key_pair;
use floti_host::platform::folders::{CONFIG_DIR_VAR, DATA_DIR_VAR, LOG_DIR_VAR, RUNTIME_DIR_VAR};
use floti_host::platform::socket::{
    Endpoint, LocalListener, LocalSocket, LocalStream, Native as NativeSocket,
};
use floti_host::platform::startup;
use floti_host::server::{
    HOST_KEY_FILE, HostConfig, LOCK_FILE, host_public_key, local_endpoint, relay_endpoint,
};
use floti_host::setup::{START_ON_CONNECT_FILE, START_ON_CONNECT_LINE};
use floti_host::testkit::{
    FakeAgent, PATIENCE, RunningHost, TestClient, TestDirs, record_test_host, run_floti,
};
use floti_protocol::channel::{RequestChannel, from_payload, to_payload};
use floti_protocol::channels::common::SessionRecord;
use floti_protocol::channels::host::{
    HostQuit, HostQuitRequest, HostStop, HostStopReason, HostStopRequest,
};
use floti_protocol::channels::sessions::{
    CloseSessionRequest, SessionClose, SessionList, SessionRestorable, SessionStart,
    SessionStreamOpen, SessionTerminal, StartSessionRequest,
};
use floti_protocol::message::{ClientInfo, ClientKind, Hello, Request, StreamData, StreamOpen};
use floti_protocol::noise::{KeyPair, PublicKey};
use floti_protocol::{Bytes, FrameDecoder, Message, PROTOCOL_VERSION, StreamChannel, encode_frame};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

/// The first handshake message on the stream: its 2-byte length, then the
/// 96 bytes of an `IK` first message.
const MESSAGE_1: usize = 2 + 96;

/// The ssh target the tests add a host by, exactly as a user would type it.
const TARGET: &str = "me@build box";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// A host on `dirs`' folders, at the endpoint `floti connect` finds from
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

/// A host running on `dirs`, with the fake agent behind it.
struct World {
    host: RunningHost,
    agent: FakeAgent,
    dirs: TestDirs,
}

impl World {
    fn start() -> Self {
        let dirs = TestDirs::new();
        let agent = fake_agent!(&dirs);
        let host = RunningHost::start(config(&dirs, &agent));
        Self { host, agent, dirs }
    }

    /// The host's public key.
    fn host_key(&self) -> PublicKey {
        host_public_key(&self.dirs.data)
            .unwrap()
            .expect("the host made its key")
    }

    /// A client folder named `name`, with a device key the host has never
    /// seen, which has pinned the host's key.
    fn pinned_folder(&self, name: &str) -> PathBuf {
        let folder = self.dirs.folder(name);
        let mut keys = ClientKeys::open(&folder).expect("set up the client's keys");
        keys.pin_host(self.host_key()).expect("pin the host key");
        folder
    }

    async fn stop(self) {
        self.host.stop(HostStopReason::Stop).await;
        drop(self.agent);
        drop(self.dirs);
    }
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

/// A fake transport in `test/fake-ssh/`.
fn fake_transport(file: &str) -> PathBuf {
    repo_root().join("test").join("fake-ssh").join(file)
}

/// The Node running these tests: the first `node` on `PATH`.
fn node_on_path() -> PathBuf {
    let path = std::env::var_os("PATH").expect("PATH is set");
    std::env::split_paths(&path)
        .flat_map(|dir| [dir.join("node.exe"), dir.join("node")])
        .find(|candidate| candidate.is_file())
        .expect("the tests run with Node on PATH")
}

/// The JSON-lines file the fake transports record each run in.
fn transport_log(dirs: &TestDirs) -> PathBuf {
    dirs.root().join("transport runs.jsonl")
}

/// Every run of a fake transport recorded so far, in order.
fn transport_runs(dirs: &TestDirs) -> Vec<Value> {
    std::fs::read_to_string(transport_log(dirs))
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).expect("a transport run record"))
        .collect()
}

/// `run`'s argv, as strings.
fn argv_of(run: &Value) -> Vec<String> {
    run["argv"]
        .as_array()
        .expect("an argv")
        .iter()
        .map(|arg| arg.as_str().expect("a string").to_owned())
        .collect()
}

/// A `floti` command whose environment finds the host over `dirs`, with
/// `runtime` as its runtime folder, and maps `floti` in a fake transport's
/// line to this binary.
fn floti_command(dirs: &TestDirs, runtime: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_floti"));
    command
        .env(DATA_DIR_VAR, &dirs.data)
        .env(LOG_DIR_VAR, &dirs.logs)
        .env(CONFIG_DIR_VAR, &dirs.config)
        .env(RUNTIME_DIR_VAR, runtime)
        .env("HOME", &dirs.home)
        .env("USERPROFILE", &dirs.home)
        .env("FAKE_SSH_FLOTI", env!("CARGO_BIN_EXE_floti"))
        .env("FAKE_SSH_LOG", transport_log(dirs))
        .env_remove("FAKE_SSH_FAIL")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

/// The transport ssh is: `node ssh.mjs -o BatchMode=yes <TARGET>`.
fn ssh_transport() -> Vec<String> {
    vec![
        node_on_path().to_string_lossy().into_owned(),
        fake_transport("ssh.mjs").to_string_lossy().into_owned(),
        "-o".to_owned(),
        "BatchMode=yes".to_owned(),
        TARGET.to_owned(),
    ]
}

/// A custom transport: `node carry.mjs --via "a pipe"`, one argument with a
/// space in it, which a shell would split.
fn custom_transport() -> Vec<String> {
    vec![
        node_on_path().to_string_lossy().into_owned(),
        fake_transport("carry.mjs").to_string_lossy().into_owned(),
        "--via".to_owned(),
        "a pipe".to_owned(),
    ]
}

/// `floti bridge <folder> -- <transport>...`.
fn bridge_through(dirs: &TestDirs, runtime: &Path, folder: &Path, transport: &[String]) -> Command {
    let mut command = floti_command(dirs, runtime);
    command.arg("bridge").arg(folder).arg("--").args(transport);
    command
}

/// A running `floti bridge`: frames go in on its standard input and come
/// out of its standard output, decoded on a thread of their own. Its
/// standard error is kept as it comes. Dropping it closes its standard
/// input, which ends it and its transport; one still running after
/// [`PATIENCE`] is killed.
struct Bridge {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    messages: mpsc::UnboundedReceiver<Message>,
    stdout: Arc<Mutex<Vec<u8>>>,
    stderr: Arc<Mutex<Vec<u8>>>,
    stderr_done: Option<std::thread::JoinHandle<()>>,
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
        let stdout = Arc::new(Mutex::new(Vec::new()));
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
        let stderr = Arc::new(Mutex::new(Vec::new()));
        let said = Arc::clone(&stderr);
        let stderr_done = std::thread::spawn(move || {
            let mut buf = [0; 4096];
            while let Ok(n @ 1..) = err.read(&mut buf) {
                said.lock().unwrap().extend_from_slice(&buf[..n]);
            }
        });
        Self {
            child: Some(child),
            stdin,
            messages,
            stdout,
            stderr,
            stderr_done: Some(stderr_done),
        }
    }

    fn write(&mut self, bytes: &[u8]) {
        let stdin = self.stdin.as_mut().expect("the bridge's stdin is open");
        stdin.write_all(bytes).expect("write to the bridge");
        stdin.flush().expect("flush the bridge's stdin");
    }

    fn send(&mut self, message: &Message) {
        self.write(&encode_frame(message).expect("encode a frame"));
    }

    async fn next(&mut self) -> Message {
        match tokio::time::timeout(PATIENCE, self.messages.recv()).await {
            Ok(Some(message)) => message,
            Ok(None) => panic!(
                "the bridge's output ended; it said: {}",
                String::from_utf8_lossy(&self.stderr.lock().unwrap())
            ),
            Err(_) => panic!("the bridge relayed nothing within {PATIENCE:?}"),
        }
    }

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

    async fn welcomed(&mut self) {
        self.send(&Message::Hello(Hello {
            protocol: PROTOCOL_VERSION,
            client: ClientInfo {
                name: "a remote test".to_owned(),
                kind: ClientKind::Desktop,
                device_name: None,
            },
            capabilities: vec!["terminal".to_owned()],
        }));
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
        if let Some(done) = self.stderr_done.take() {
            done.join().expect("read the bridge's stderr");
        }
        Ended {
            code: status.code(),
            stdout: self.stdout.lock().unwrap().clone(),
            stderr: String::from_utf8_lossy(&self.stderr.lock().unwrap()).into_owned(),
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

/// Asserts `ended` exited with `code` having written exactly `line` on
/// standard error, and nothing on standard output.
fn assert_ended_with_line(ended: &Ended, code: i32, line: &str) {
    assert_eq!(ended.code, Some(code), "{ended:?}");
    assert_eq!(
        ended.stderr.lines().collect::<Vec<_>>(),
        [line],
        "{ended:?}"
    );
    assert!(ended.stdout.is_empty(), "{ended:?}");
}

/// Starts a session through `bridge`, lists it, attaches to its screen and
/// types into it, as a desktop does through any host.
async fn list_attach_and_type(bridge: &mut Bridge, project: &Path) -> SessionRecord {
    bridge.welcomed().await;
    let session: SessionRecord = bridge
        .request::<SessionStart>(1, &start_request(project))
        .await;
    let listed = bridge.request::<SessionList>(2, &()).await;
    assert_eq!(
        listed.iter().map(|row| row.id).collect::<Vec<_>>(),
        [session.id]
    );
    bridge.send(&Message::StreamOpen(StreamOpen {
        stream: 1,
        channel: SessionTerminal::NAME.to_owned(),
        params: to_payload(&SessionStreamOpen { id: session.id }).unwrap(),
    }));
    bridge.send(&Message::StreamData(StreamData {
        stream: 1,
        data: Bytes(b"typed far away\r".to_vec()),
    }));
    bridge
        .read_stream_until(1, |text| text.contains("echo: typed far away"))
        .await;
    session
}

/// A tap's run: once its connection ends, every byte it carried to the host,
/// then every byte it carried to the client.
type Tap = JoinHandle<(Vec<u8>, Vec<u8>)>;

/// A relay at `endpoint` to the host at `host` for one connection, keeping
/// every byte it carried each way: to the host, then to the client. One end
/// closing closes the other.
fn tap(endpoint: &Endpoint, host: Endpoint) -> Tap {
    let mut listener = NativeSocket.bind(endpoint).expect("bind the tap");
    tokio::spawn(async move {
        let mut client = listener.accept().await.expect("accept floti connect");
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

async fn tapped(tap: Tap) -> (Vec<u8>, Vec<u8>) {
    tokio::time::timeout(PATIENCE, tap)
        .await
        .expect("the tapped connection ended")
        .expect("the tap ran")
}

/// A runtime folder of its own under `dirs`, with a tap in it relaying to
/// the host over `dirs`: at the relay endpoint `floti connect` opens there,
/// to the host's own relay endpoint.
fn tapped_runtime(dirs: &TestDirs) -> (PathBuf, Tap) {
    let runtime = dirs.folder("tap");
    let at = relay_endpoint(&floti_host::platform::folders::Folders {
        runtime: runtime.clone(),
        ..dirs.folders()
    });
    let relay = tap(&at, relay_endpoint(&dirs.folders()));
    (runtime, relay)
}

/// A reader or writer that keeps a copy of every byte that crosses it.
struct Recorded<T> {
    inner: T,
    seen: Arc<Mutex<Vec<u8>>>,
}

impl<T: AsyncRead + Unpin> AsyncRead for Recorded<T> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        let before = buf.filled().len();
        let polled = Pin::new(&mut this.inner).poll_read(cx, buf);
        this.seen
            .lock()
            .unwrap()
            .extend_from_slice(&buf.filled()[before..]);
        polled
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for Recorded<T> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let this = self.get_mut();
        let polled = Pin::new(&mut this.inner).poll_write(cx, buf);
        if let Poll::Ready(Ok(n)) = polled {
            this.seen.lock().unwrap().extend_from_slice(&buf[..n]);
        }
        polled
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

/// A running `floti connect`, and its standard output and input as one
/// stream, each byte that crosses it recorded: what the client wrote, then
/// what it read.
struct Connect {
    child: tokio::process::Child,
    stream: Option<LocalStream>,
    wrote: Arc<Mutex<Vec<u8>>>,
    read: Arc<Mutex<Vec<u8>>>,
}

impl Connect {
    fn spawn(mut command: Command) -> Self {
        command.arg("connect");
        let mut child = tokio::process::Command::from(command)
            .kill_on_drop(true)
            .spawn()
            .expect("run floti connect");
        let (wrote, read) = (Arc::default(), Arc::default());
        let stream = duplex(
            Recorded {
                inner: child.stdout.take().unwrap(),
                seen: Arc::clone(&read),
            },
            Recorded {
                inner: child.stdin.take().unwrap(),
                seen: Arc::clone(&wrote),
            },
        );
        Self {
            child,
            stream: Some(stream),
            wrote,
            read,
        }
    }

    fn stream(&mut self) -> LocalStream {
        self.stream.take().expect("the stream is taken once")
    }

    /// Its exit status and what it wrote on standard error, once it exits.
    async fn ended(mut self) -> (Option<i32>, String) {
        let status = tokio::time::timeout(PATIENCE, self.child.wait())
            .await
            .expect("floti connect exited")
            .expect("wait for floti connect");
        let mut stderr = String::new();
        self.child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .await
            .unwrap();
        (status.code(), stderr)
    }
}

// ---------------------------------------------------------------------------
// S1, S2: floti connect
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s1_floti_connect_carries_every_byte_unchanged_and_the_client_across_it_is_held_to_the_host_key()
 {
    let world = World::start();
    let dirs = &world.dirs;
    let folder = world.pinned_folder("a laptop");
    let keys = ClientKeys::open(&folder).unwrap();
    let (runtime, relay) = tapped_runtime(dirs);
    let mut command = floti_command(dirs, &runtime);
    // A data folder with nothing in it: floti connect opens no key file.
    command.env(DATA_DIR_VAR, dirs.root().join("no data here"));
    let mut connect = Connect::spawn(command);

    let mut connection = keys
        .connect_over(connect.stream(), "floti connect")
        .await
        .expect("the client is let in across floti connect");
    assert_eq!(connection.host_key(), world.host_key());
    connection
        .say_hello("a laptop", ClientKind::Desktop)
        .await
        .expect("welcomed");
    let listed = connection
        .request::<SessionList>(1, &())
        .await
        .unwrap()
        .expect("sessions listed");
    assert!(listed.is_empty(), "{listed:?}");

    // Standard input closing closes the connection, and it exits 0, quietly.
    connection.close().await;
    let (wrote, read) = (Arc::clone(&connect.wrote), Arc::clone(&connect.read));
    let (code, stderr) = connect.ended().await;
    assert_eq!(code, Some(0), "{stderr}");
    assert_eq!(stderr, "");
    let (to_host, to_client) = tapped(relay).await;
    assert_eq!(
        *wrote.lock().unwrap(),
        to_host,
        "every byte reached the host"
    );
    // What came out is what the host sent, in order and with nothing added;
    // the host may have sent more that was still in flight as it closed.
    let read = read.lock().unwrap().clone();
    assert!(!read.is_empty());
    assert!(
        to_client.starts_with(&read),
        "every byte that came out is the host's, unchanged and in order"
    );
    assert!(!dirs.root().join("no data here").exists());
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s1_a_host_that_does_not_prove_the_pinned_key_across_floti_connect_gets_only_the_first_message()
 {
    let world = World::start();
    let dirs = &world.dirs;
    let folder = world.pinned_folder("a laptop");
    let mut keys = ClientKeys::open(&folder).unwrap();
    let pinned = KeyPair::generate().unwrap().public();
    keys.pin_host(pinned).unwrap();
    let (runtime, relay) = tapped_runtime(dirs);
    let mut connect = Connect::spawn(floti_command(dirs, &runtime));

    let err = keys
        .connect_over(connect.stream(), "floti connect")
        .await
        .expect_err("a host holding another key is refused");
    assert!(
        matches!(
            err,
            ClientError::HostClosed { .. } | ClientError::HostNotProven { .. }
        ),
        "{err}"
    );
    let (code, stderr) = connect.ended().await;
    assert_eq!(code, Some(0), "{stderr}");
    let (to_host, to_client) = tapped(relay).await;
    assert_eq!(to_host.len(), MESSAGE_1, "only the first handshake message");
    assert!(to_client.is_empty());
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s2_with_no_host_running_floti_connect_writes_nothing_and_exits_3_saying_none_is_running() {
    let dirs = TestDirs::new();
    for args in [&["connect"][..], &["connect", "--host-key"][..]] {
        let mut command = floti_command(&dirs, &dirs.runtime);
        command.args(args).stdin(Stdio::null());
        let output = run_floti(command).await;
        assert_eq!(output.status.code(), Some(3), "{args:?}: {output:?}");
        assert!(output.stdout.is_empty(), "{args:?}: {output:?}");
        assert_eq!(
            String::from_utf8_lossy(&output.stderr)
                .lines()
                .collect::<Vec<_>>(),
            [NO_HOST_LINE],
            "{args:?}"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn floti_connect_host_key_prints_the_hosts_public_key_and_nothing_secret() {
    let world = World::start();
    let mut command = floti_command(&world.dirs, &world.dirs.runtime);
    command.args(["connect", "--host-key"]).stdin(Stdio::null());
    let output = run_floti(command).await;
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        format!("{}\n", world.host_key().to_hex())
    );
    assert!(output.stderr.is_empty(), "{output:?}");
    world.stop().await;
}

// ---------------------------------------------------------------------------
// S3, S4: a device through ssh and through a custom command
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s3_through_the_users_ssh_the_device_lists_sessions_gets_a_screen_and_types_into_it() {
    let world = World::start();
    let dirs = &world.dirs;
    let folder = world.pinned_folder("a laptop");
    let mut bridge = Bridge::spawn(bridge_through(
        dirs,
        &dirs.runtime,
        &folder,
        &ssh_transport(),
    ));
    list_attach_and_type(&mut bridge, &dirs.folder("a project")).await;
    bridge.close_stdin();
    let ended = bridge.ended().await;
    assert_eq!(ended.code, Some(0), "{ended:?}");
    assert_eq!(ended.stderr, "", "{ended:?}");

    // ssh was run with the target exactly as typed, batch mode, and
    // `floti connect` as the line to run there; nothing else.
    let runs = transport_runs(dirs);
    assert_eq!(runs.len(), 1, "{runs:?}");
    assert_eq!(
        argv_of(&runs[0]),
        ["-o", "BatchMode=yes", TARGET, CONNECT_LINE]
    );
    assert_eq!(runs[0]["target"], TARGET);
    assert_eq!(runs[0]["line"], CONNECT_LINE);
    // The client folder holds its device key and the pinned host key only.
    let mut kept: Vec<_> = std::fs::read_dir(&folder)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    kept.sort();
    assert_eq!(kept, [DEVICE_KEY_FILE, PINNED_HOST_FILE]);
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s4_a_custom_command_is_run_as_given_without_a_shell_with_floti_connect_last_and_carries_the_protocol()
 {
    let world = World::start();
    let dirs = &world.dirs;
    let folder = world.pinned_folder("a laptop");
    let mut bridge = Bridge::spawn(bridge_through(
        dirs,
        &dirs.runtime,
        &folder,
        &custom_transport(),
    ));
    list_attach_and_type(&mut bridge, &dirs.folder("a project")).await;
    bridge.close_stdin();
    let ended = bridge.ended().await;
    assert_eq!(ended.code, Some(0), "{ended:?}");
    assert_eq!(ended.stderr, "", "{ended:?}");

    let runs = transport_runs(dirs);
    assert_eq!(runs.len(), 1, "{runs:?}");
    assert_eq!(argv_of(&runs[0]), ["--via", "a pipe", CONNECT_LINE]);
    world.stop().await;
}

// ---------------------------------------------------------------------------
// S5: a new device learns the host's key through a transport
// ---------------------------------------------------------------------------

/// Runs a bridge from a new client folder through `transport` with nothing
/// pinned, starts a session, and connects again from the same folder: each
/// run is served with nothing asked, and the first pins the key it learned.
async fn learn_the_key_and_reconnect(world: &World, name: &str, transport: &[String]) {
    let dirs = &world.dirs;
    let folder = dirs.root().join(name);
    let mut bridge = Bridge::spawn(bridge_through(dirs, &dirs.runtime, &folder, transport));
    list_attach_and_type(&mut bridge, &dirs.folder("a project")).await;
    let keys = ClientKeys::open(&folder).unwrap();
    assert_eq!(keys.pinned_host(), Some(world.host_key()));
    bridge.close_stdin();
    let ended = bridge.ended().await;
    assert_eq!(ended.code, Some(0), "{ended:?}");
    assert_eq!(ended.stderr, "", "{ended:?}");

    let mut again = Bridge::spawn(bridge_through(dirs, &dirs.runtime, &folder, transport));
    again.welcomed().await;
    let listed = again.request::<SessionList>(1, &()).await;
    assert!(!listed.is_empty(), "{listed:?}");
    again.close_stdin();
    let second = again.ended().await;
    assert_eq!(second.code, Some(0), "{second:?}");
    assert_eq!(second.stderr, "", "{second:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn s2_a_new_device_through_ssh_learns_the_host_key_pins_it_once_proven_and_is_served_with_nothing_asked()
 {
    let world = World::start();
    learn_the_key_and_reconnect(&world, "a laptop", &ssh_transport()).await;
    // Through ssh it learned the key once, then connected twice as itself.
    let lines: Vec<String> = transport_runs(&world.dirs)
        .iter()
        .map(|run| run["line"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(lines, [HOST_KEY_LINE, CONNECT_LINE, CONNECT_LINE]);
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s2_a_new_device_through_a_custom_command_learns_the_host_key_and_is_served_with_nothing_asked()
 {
    let world = World::start();
    learn_the_key_and_reconnect(&world, "a desktop", &custom_transport()).await;
    let runs = transport_runs(&world.dirs);
    let argv: Vec<Vec<String>> = runs.iter().map(argv_of).collect();
    assert_eq!(
        argv,
        [
            ["--via", "a pipe", HOST_KEY_LINE],
            ["--via", "a pipe", CONNECT_LINE],
            ["--via", "a pipe", CONNECT_LINE]
        ]
    );
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s5_a_host_that_does_not_prove_the_pinned_key_through_ssh_gets_only_the_first_message_and_the_bridge_exits_5()
 {
    let world = World::start();
    let dirs = &world.dirs;
    let folder = world.pinned_folder("a laptop");
    let pinned = KeyPair::generate().unwrap().public();
    ClientKeys::open(&folder).unwrap().pin_host(pinned).unwrap();
    let (runtime, relay) = tapped_runtime(dirs);

    let ended = Bridge::spawn(bridge_through(dirs, &runtime, &folder, &ssh_transport()))
        .ended()
        .await;
    assert_eq!(ended.code, Some(5), "{ended:?}");
    let lines: Vec<&str> = ended.stderr.lines().collect();
    assert_eq!(lines.len(), 1, "{ended:?}");
    assert!(
        lines[0].starts_with("floti bridge: ")
            && lines[0].contains("did not prove the key this client pinned")
            && lines[0].contains(&pinned.fingerprint()),
        "{ended:?}"
    );
    assert!(!lines[0].contains(&pinned.to_hex()), "{ended:?}");
    assert!(ended.stdout.is_empty(), "{ended:?}");
    let (to_host, to_client) = tapped(relay).await;
    assert_eq!(to_host.len(), MESSAGE_1, "only the first handshake message");
    assert!(to_client.is_empty());
    assert_eq!(
        ClientKeys::open(&folder).unwrap().pinned_host(),
        Some(pinned)
    );
    world.stop().await;
}

// ---------------------------------------------------------------------------
// A transport that fails says ssh's own last line
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_failing_ssh_ends_the_bridge_with_8_and_ssh_s_last_line_unedited() {
    let world = World::start();
    let dirs = &world.dirs;
    let pinned = world.pinned_folder("a laptop");
    let unpinned = dirs.root().join("a new laptop");
    for (failure, says) in [
        (
            "denied",
            format!("{TARGET}: Permission denied (publickey,password)."),
        ),
        (
            "unresolved",
            "ssh: Could not resolve hostname build box: Name or service not known".to_owned(),
        ),
        (
            "timeout",
            "ssh: connect to host build box port 22: Connection timed out".to_owned(),
        ),
        (
            "password",
            format!("{TARGET}: Permission denied (publickey,password)."),
        ),
    ] {
        for folder in [&pinned, &unpinned] {
            let mut command = bridge_through(dirs, &dirs.runtime, folder, &ssh_transport());
            command.env("FAKE_SSH_FAIL", failure);
            let ended = Bridge::spawn(command).ended().await;
            assert_ended_with_line(&ended, 8, &says);
        }
    }
    assert!(!unpinned.join(PINNED_HOST_FILE).exists());
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn with_no_host_running_there_the_bridge_exits_3_with_floti_connects_line() {
    let dirs = TestDirs::new();
    let folder = dirs.root().join("a laptop");
    ClientKeys::open(&folder)
        .unwrap()
        .pin_host(KeyPair::generate().unwrap().public())
        .unwrap();
    let unpinned = dirs.root().join("a new laptop");
    for folder in [&folder, &unpinned] {
        let ended = Bridge::spawn(bridge_through(
            &dirs,
            &dirs.runtime,
            folder,
            &ssh_transport(),
        ))
        .ended()
        .await;
        assert_ended_with_line(&ended, 3, NO_HOST_LINE);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_transport_that_cannot_be_started_ends_the_bridge_with_7() {
    let dirs = TestDirs::new();
    let folder = dirs.root().join("a laptop");
    ClientKeys::open(&folder)
        .unwrap()
        .pin_host(KeyPair::generate().unwrap().public())
        .unwrap();
    let missing = dirs.root().join("no such program");
    let ended = Bridge::spawn(bridge_through(
        &dirs,
        &dirs.runtime,
        &folder,
        &[missing.to_string_lossy().into_owned()],
    ))
    .ended()
    .await;
    assert_eq!(ended.code, Some(7), "{ended:?}");
    let lines: Vec<&str> = ended.stderr.lines().collect();
    assert_eq!(lines.len(), 1, "{ended:?}");
    assert!(
        lines[0].starts_with("floti bridge: could not run "),
        "{ended:?}"
    );
}

// ---------------------------------------------------------------------------
// S7: the user's ssh as it is, and nothing of theirs touched
// ---------------------------------------------------------------------------

/// Every file under `folder`, by its path below it, with its bytes.
fn files_under(folder: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut found = Vec::new();
    let mut pending = vec![folder.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).expect("read a folder") {
            let path = entry.expect("a folder entry").path();
            if path.is_dir() {
                pending.push(path);
            } else {
                let bytes = std::fs::read(&path).expect("read a file");
                found.push((path.strip_prefix(folder).unwrap().to_path_buf(), bytes));
            }
        }
    }
    found.sort();
    found
}

/// Connects a new client folder through `transport` the way Helm does,
/// learning the host's key the first time, then connects again with the key
/// pinned, and returns the folder.
async fn connect_twice_as_helm_does(world: &World, name: &str, transport: &[String]) -> PathBuf {
    let dirs = &world.dirs;
    let folder = dirs.root().join(name);
    for _ in 0..2 {
        let mut bridge = Bridge::spawn(bridge_through(dirs, &dirs.runtime, &folder, transport));
        bridge.welcomed().await;
        let listed = bridge.request::<SessionList>(1, &()).await;
        assert!(listed.is_empty(), "{listed:?}");
        bridge.close_stdin();
        let ended = bridge.ended().await;
        assert_eq!(ended.code, Some(0), "{ended:?}");
        assert_eq!(ended.stderr, "", "nothing is asked: {ended:?}");
    }
    folder
}

#[tokio::test(flavor = "multi_thread")]
async fn s7_through_ssh_and_a_custom_command_nothing_under_the_users_ssh_folder_changes_and_no_host_key_check_is_skipped()
 {
    let world = World::start();
    let dirs = &world.dirs;
    // The user's own ssh setup, in the fake home every floti here is given.
    let ssh = dirs.home.join(".ssh");
    std::fs::create_dir_all(&ssh).unwrap();
    for (file, text) in [
        ("config", "Host build box\n  User me\n"),
        (
            "known_hosts",
            "build-box ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample\n",
        ),
        (
            "authorized_keys",
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOther me@elsewhere\n",
        ),
        (
            "id_ed25519",
            "-----BEGIN OPENSSH PRIVATE KEY-----\nnot a real key\n",
        ),
    ] {
        std::fs::write(ssh.join(file), text).unwrap();
    }
    let before = files_under(&ssh);

    let through_ssh = connect_twice_as_helm_does(&world, "a laptop", &ssh_transport()).await;
    let through_command =
        connect_twice_as_helm_does(&world, "a desktop", &custom_transport()).await;

    // Nothing under ~/.ssh was written, added or removed.
    assert_eq!(files_under(&ssh), before);
    // A client folder holds the device's key and the pinned host key, and nothing else.
    for folder in [&through_ssh, &through_command] {
        let mut names: Vec<String> = std::fs::read_dir(folder)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        let mut expected = vec![DEVICE_KEY_FILE.to_owned(), PINNED_HOST_FILE.to_owned()];
        expected.sort();
        assert_eq!(names, expected, "{}", folder.display());
    }
    // The transports ran with the options they were given, and floti added
    // none that skips a host-key check or names a file of the user's.
    let runs = transport_runs(dirs);
    assert!(!runs.is_empty());
    for run in &runs {
        let argv = argv_of(run).join(" ");
        assert!(
            ![
                "StrictHostKeyChecking",
                "UserKnownHostsFile",
                "known_hosts",
                "IdentityFile",
                ".ssh"
            ]
            .iter()
            .any(|option| argv.contains(option)),
            "{argv}"
        );
    }
    world.stop().await;
}

// ---------------------------------------------------------------------------
// Installing a host: what the desktop asks floti on the host's computer
// through the same login (its version, what an update ends, a stop for the
// update), and the floti it names by full path where the login's PATH does
// not have it
// ---------------------------------------------------------------------------

/// Runs `line` on "the host's computer" through `transport`, as the desktop
/// does, and waits for it to end.
async fn run_line(dirs: &TestDirs, transport: &[String], line: &str) -> std::process::Output {
    let mut command = Command::new(&transport[0]);
    command
        .args(&transport[1..])
        .arg(line)
        .env(DATA_DIR_VAR, &dirs.data)
        .env(LOG_DIR_VAR, &dirs.logs)
        .env(CONFIG_DIR_VAR, &dirs.config)
        .env(RUNTIME_DIR_VAR, &dirs.runtime)
        .env("HOME", &dirs.home)
        .env("USERPROFILE", &dirs.home)
        .env("FAKE_SSH_FLOTI", env!("CARGO_BIN_EXE_floti"))
        .env("FAKE_SSH_LOG", transport_log(dirs))
        .env_remove("FAKE_SSH_FAIL")
        .env_remove("FAKE_SSH_MISSING_LINE")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    run_floti(command).await
}

#[tokio::test(flavor = "multi_thread")]
async fn floti_answers_its_version_protocol_os_and_cpu_on_one_line_through_ssh_and_through_a_command()
 {
    let dirs = TestDirs::new();
    let expected = format!("{}\n", floti_host::version::version_line());
    for transport in [ssh_transport(), custom_transport()] {
        let answered = run_line(&dirs, &transport, "floti version").await;
        assert_eq!(answered.status.code(), Some(0), "{answered:?}");
        let printed = String::from_utf8_lossy(&answered.stdout).replace("\r\n", "\n");
        assert_eq!(printed, expected);
        assert_eq!(printed.lines().count(), 1);
        let words: Vec<&str> = printed.split_whitespace().collect();
        assert_eq!(words[0], "floti");
        assert_eq!(words[1], floti_host::version::FLOTI_VERSION);
        assert_eq!(words[2], "protocol");
        assert_eq!(words[3], PROTOCOL_VERSION.to_string());
        assert_eq!(words[4], floti_host::version::os_name());
        assert_eq!(words[5], floti_host::version::cpu_name());
        assert!(answered.stderr.is_empty(), "{answered:?}");
    }
    // `--version` keeps answering as it did: floti and its version.
    let mut command = Command::new(env!("CARGO_BIN_EXE_floti"));
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let answered = run_floti(command).await;
    assert_eq!(
        String::from_utf8_lossy(&answered.stdout).trim_end(),
        format!("floti {}", floti_host::version::FLOTI_VERSION)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn through_ssh_the_desktop_is_told_how_many_sessions_an_update_ends_and_its_stop_keeps_their_rows_for_the_next_host_to_offer()
 {
    let World { host, agent, dirs } = World::start();
    let endpoint = local_endpoint(&dirs.folders());
    let mut client = TestClient::connect(&endpoint, &["terminal"]).await;
    let mut started = Vec::new();
    for name in ["project one", "project two"] {
        let session: SessionRecord = client
            .request::<SessionStart>(&start_request(&dirs.folder(name)))
            .await
            .expect("start a session");
        started.push(session.id);
    }

    // Asked as the host itself, through the login: the count, on one line.
    let asked = run_line(&dirs, &ssh_transport(), "floti update-stop --ask").await;
    assert_eq!(asked.status.code(), Some(0), "{asked:?}");
    assert_eq!(
        String::from_utf8_lossy(&asked.stdout).replace("\r\n", "\n"),
        "2\n"
    );
    // Asking ends nothing.
    assert_eq!(
        client
            .request::<SessionList>(&())
            .await
            .expect("list the sessions")
            .len(),
        2
    );

    let stopped = run_line(&dirs, &ssh_transport(), "floti update-stop --stop").await;
    assert_eq!(stopped.status.code(), Some(0), "{stopped:?}");
    assert!(stopped.stdout.is_empty(), "{stopped:?}");
    assert_eq!(host.stopped().await, HostStopReason::Update);
    drop(client);

    // The next host offers both back, to be resumed as after a crash.
    let next = RunningHost::start(config(&dirs, &agent));
    let mut client = TestClient::connect(&endpoint, &["terminal"]).await;
    let offer = client
        .request::<SessionRestorable>(&())
        .await
        .expect("ask what is restorable")
        .expect("the sessions the update ended are offered");
    assert_eq!(
        offer
            .sessions
            .iter()
            .map(|lost| lost.id)
            .collect::<Vec<_>>(),
        started
    );
    // ssh ran only those two lines.
    let lines: Vec<Value> = transport_runs(&dirs)
        .iter()
        .map(|run| run["line"].clone())
        .collect();
    assert_eq!(
        lines,
        ["floti update-stop --ask", "floti update-stop --stop"]
    );
    drop(client);
    next.stop(HostStopReason::Stop).await;
    drop(agent);
}

#[tokio::test(flavor = "multi_thread")]
async fn update_stop_on_a_computer_with_no_host_running_says_so_and_asks_nothing() {
    let dirs = TestDirs::new();
    let asked = run_line(&dirs, &ssh_transport(), "floti update-stop --ask").await;
    assert_eq!(asked.status.code(), Some(3), "{asked:?}");
    assert!(asked.stdout.is_empty(), "{asked:?}");
    assert_eq!(
        String::from_utf8_lossy(&asked.stderr).trim_end(),
        "floti update-stop: no host is running on this computer."
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn where_the_login_path_has_no_floti_the_bridge_reaches_the_floti_it_names_by_full_path() {
    let world = World::start();
    let dirs = &world.dirs;
    let folder = world.pinned_folder("a laptop");
    let floti = env!("CARGO_BIN_EXE_floti");
    let bridge_with = |named: Option<&str>| {
        let mut command = floti_command(dirs, &dirs.runtime);
        command.arg("bridge").arg(&folder);
        if let Some(path) = named {
            command.args(["--floti", path]);
        }
        // A login whose PATH has no floti: `floti ...` is not found there.
        command
            .arg("--")
            .args(ssh_transport())
            .env("FAKE_SSH_MISSING_LINE", "floti ");
        command
    };

    // Without its path, the login cannot find floti, and says so.
    let mut bridge = Bridge::spawn(bridge_with(None));
    bridge.close_stdin();
    let ended = bridge.ended().await;
    assert_eq!(ended.code, Some(8), "{ended:?}");
    assert_eq!(ended.stderr.trim_end(), "sh: 1: floti: not found");

    // With it, the line run there names that floti, and the protocol crosses.
    let mut bridge = Bridge::spawn(bridge_with(Some(floti)));
    bridge.welcomed().await;
    assert_eq!(bridge.request::<SessionList>(1, &()).await, vec![]);
    bridge.close_stdin();
    let ended = bridge.ended().await;
    assert_eq!(ended.code, Some(0), "{ended:?}");
    let runs = transport_runs(dirs);
    let line = runs.last().expect("the bridge ran ssh")["line"].clone();
    let expected = Transport {
        program: OsString::from("ssh"),
        args: Vec::new(),
        floti: Some(floti.to_owned()),
        as_written: false,
    }
    .line("connect");
    assert_eq!(line, expected);
    world.stop().await;
}

#[test]
fn the_floti_named_on_the_other_computer_is_quoted_when_it_has_a_blank_and_refused_when_a_shell_would_split_it()
 {
    let through = |floti: Option<&str>| Transport {
        program: OsString::from("ssh"),
        args: Vec::new(),
        floti: floti.map(str::to_owned),
        as_written: false,
    };
    assert_eq!(through(None).line("connect"), CONNECT_LINE);
    assert_eq!(through(None).line("connect --host-key"), HOST_KEY_LINE);
    assert_eq!(
        through(Some("/home/me/.local/bin/floti")).line("connect"),
        "/home/me/.local/bin/floti connect"
    );
    let windows = r"C:\Users\A User\AppData\Local\Programs\Floti\bin\floti.exe";
    assert_eq!(
        through(Some(windows)).line("connect --host-key"),
        format!("\"{windows}\" connect --host-key")
    );
    assert_eq!(remote_floti_problem("/home/me/.local/bin/floti"), None);
    assert_eq!(remote_floti_problem(windows), None);
    assert_eq!(remote_floti_problem("C:/Floti/floti.exe"), None);
    for refused in [
        "floti",
        "bin/floti",
        "/home/me/$HOME/floti",
        "/home/me/`id`/floti",
        "/home/me/\"x\"/floti",
        r"C:\%TEMP%\floti.exe",
        "/home/me/floti\nrm",
    ] {
        assert!(remote_floti_problem(refused).is_some(), "{refused:?}");
    }
}

// ---------------------------------------------------------------------------
// floti doctor
// ---------------------------------------------------------------------------

/// How a run of `floti doctor` ended.
#[derive(Debug)]
struct Doctored {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// Runs `floti doctor` with `args` over `dirs`, giving it `stdin`, with
/// `fail` as the fake ssh's failure, and waits for it to end.
async fn doctor(dirs: &TestDirs, args: &[&str], stdin: &[u8], fail: Option<&str>) -> Doctored {
    let mut command = floti_command(dirs, &dirs.runtime);
    command.arg("doctor").args(args);
    if let Some(fail) = fail {
        command.env("FAKE_SSH_FAIL", fail);
    }
    let stdin = stdin.to_vec();
    let run = tokio::task::spawn_blocking(move || {
        let mut child = command.spawn().expect("run floti doctor");
        child
            .stdin
            .take()
            .expect("its stdin")
            .write_all(&stdin)
            .expect("write its stdin");
        child.wait_with_output().expect("wait for floti doctor")
    });
    let output = tokio::time::timeout(PATIENCE, run)
        .await
        .unwrap_or_else(|_| panic!("floti doctor did not end within {PATIENCE:?}"))
        .expect("floti doctor's run");
    Doctored {
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    }
}

/// A host as the desktop records it: `transport` as its words.
fn recorded(id: &str, name: &str, words: &[String], folder: &Path) -> Value {
    serde_json::json!({
        "id": id,
        "name": name,
        "transport": { "kind": "command", "program": words[0], "args": &words[1..] },
        "folder": folder,
    })
}

/// `words` as a terminal reads them back, then `floti connect`.
fn tried_by_hand(words: &[String]) -> String {
    let typed: Vec<String> = words
        .iter()
        .map(|word| {
            if word.contains(' ') {
                format!("\"{word}\"")
            } else {
                word.clone()
            }
        })
        .collect();
    format!("{} {CONNECT_LINE}", typed.join(" "))
}

/// Whether `line` says `name` answers, with this floti and a round trip.
fn answers(line: &str, name: &str) -> bool {
    let Some(rest) = line.strip_prefix(&format!(
        "{name}: answers, floti {}, ",
        floti_host::version::FLOTI_VERSION
    )) else {
        return false;
    };
    rest.strip_suffix(" ms round trip")
        .is_some_and(|ms| ms.parse::<u128>().is_ok())
}

#[tokio::test(flavor = "multi_thread")]
async fn s6_floti_doctor_prints_one_line_per_host_and_fails_when_any_does_not_answer() {
    let world = World::start();
    let dirs = &world.dirs;
    let reached = world.pinned_folder("reached by a command");
    let refused = world.pinned_folder("refused by ssh");
    let new = dirs.root().join("never connected");
    let hosts = serde_json::json!([
        recorded("a1", "box", &custom_transport(), &reached),
        recorded("b2", "build-box", &ssh_transport(), &refused),
        recorded("c3", "new-box", &custom_transport(), &new),
    ]);

    let recording = doctor(dirs, &["--record"], hosts.to_string().as_bytes(), None).await;
    assert_eq!(recording.code, Some(0), "{recording:?}");
    assert!(dirs.data.join(floti_host::doctor::HOSTS_FILE).is_file());

    let checked = doctor(dirs, &[], b"", Some("denied")).await;
    assert_eq!(checked.code, Some(1), "{checked:?}");
    let lines: Vec<&str> = checked.stdout.lines().collect();
    assert_eq!(lines.len(), 4, "{checked:?}");
    assert!(answers(lines[0], "This PC"), "{checked:?}");
    assert!(answers(lines[1], "box"), "{checked:?}");
    assert_eq!(
        lines[2],
        format!(
            "build-box: does not answer: {TARGET}: Permission denied (publickey,password). | try by hand: {}",
            tried_by_hand(&ssh_transport())
        )
    );
    assert!(
        lines[3].starts_with("new-box: not added yet:"),
        "{checked:?}"
    );
    assert!(checked.stderr.is_empty(), "{checked:?}");

    // Nothing was learned or pinned for the host it had no key for, and no
    // transport was asked for a host key.
    assert!(!new.join(PINNED_HOST_FILE).exists());
    assert!(
        transport_runs(dirs)
            .iter()
            .all(|run| run["line"].as_str() != Some(HOST_KEY_LINE)),
        "{:?}",
        transport_runs(dirs)
    );

    // With every host answering, it succeeds.
    let only_reached = serde_json::json!([recorded("a1", "box", &custom_transport(), &reached)]);
    assert_eq!(
        doctor(
            dirs,
            &["--record"],
            only_reached.to_string().as_bytes(),
            None
        )
        .await
        .code,
        Some(0)
    );
    let checked = doctor(dirs, &[], b"", None).await;
    assert_eq!(checked.code, Some(0), "{checked:?}");
    assert_eq!(checked.stdout.lines().count(), 2, "{checked:?}");
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s6_floti_doctor_starts_no_host_and_says_none_is_running_on_this_computer() {
    let dirs = TestDirs::new();
    let checked = doctor(&dirs, &[], b"", None).await;
    assert_eq!(checked.code, Some(1), "{checked:?}");
    assert_eq!(
        checked.stdout.lines().collect::<Vec<_>>(),
        ["This PC: does not answer: no Floti host has started on this computer yet."]
    );
    // It started none: there is still no host key in the data folder.
    assert!(host_public_key(&dirs.data).unwrap().is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn floti_doctor_record_refuses_what_is_not_a_list_of_hosts_and_records_nothing() {
    let dirs = TestDirs::new();
    let refused = doctor(&dirs, &["--record"], b"{\"not\": \"hosts\"}", None).await;
    assert_eq!(refused.code, Some(3), "{refused:?}");
    assert!(refused.stderr.starts_with("floti doctor: "), "{refused:?}");
    assert!(!dirs.data.join(floti_host::doctor::HOSTS_FILE).exists());
}

// ---------------------------------------------------------------------------
// A headless server: `floti host` as its user unit runs it, reached through
// the user's ssh, its sessions outliving every client (design A10)
// ---------------------------------------------------------------------------

/// `floti host` as a server's user unit runs it: `<floti> host`, with no
/// desktop, started by the user's service manager rather than by a login, so
/// with no SSH variables; every folder in `dirs`. One still running when it
/// is dropped is killed there.
struct UnitHost(Option<Child>);

impl UnitHost {
    fn start(dirs: &TestDirs, agent: &FakeAgent) -> Self {
        record_test_host(&local_endpoint(&dirs.folders()), &dirs.data);
        let (log_var, log_dir) = agent.log_env();
        let mut command = Command::new(env!("CARGO_BIN_EXE_floti"));
        command
            .arg("host")
            .env(DATA_DIR_VAR, &dirs.data)
            .env(LOG_DIR_VAR, &dirs.logs)
            .env(CONFIG_DIR_VAR, &dirs.config)
            .env(RUNTIME_DIR_VAR, &dirs.runtime)
            .env("HOME", &dirs.home)
            .env("USERPROFILE", &dirs.home)
            // The shell sessions run where `%COMSPEC%` is not set, rather
            // than the user's own and whatever its start-up files print.
            .env("SHELL", "/bin/sh")
            .env(log_var, log_dir)
            .env_remove("CLAUDE_CONFIG_DIR")
            .env_remove("SSH_CONNECTION")
            .env_remove("SSH_CLIENT")
            .env_remove("SSH_TTY")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        startup::stoppable(&mut command);
        Self(Some(command.spawn().expect("run floti host")))
    }

    fn id(&self) -> u32 {
        self.0.as_ref().expect("the host's process").id()
    }

    /// Its exit status once it exits by itself, within [`PATIENCE`].
    fn exited(&mut self) -> ExitStatus {
        let child = self.0.as_mut().expect("the host's process");
        let deadline = Instant::now() + PATIENCE;
        loop {
            if let Some(status) = child.try_wait().expect("poll the host") {
                self.0 = None;
                return status;
            }
            assert!(
                Instant::now() < deadline,
                "the host did not exit within {PATIENCE:?}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Kills it alone, as a crash takes a host down: no stop runs.
    fn kill(&mut self) -> ExitStatus {
        let mut child = self.0.take().expect("the host's process");
        let _ = child.kill();
        child.wait().expect("reap the host")
    }
}

impl Drop for UnitHost {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Whether the user unit's `Restart=on-failure` starts the host again after
/// it exited with `status`: after a crash or a kill, never after status 0.
fn restarted_on_failure(status: ExitStatus) -> bool {
    !status.success()
}

impl Bridge {
    /// Ends the bridge as a desktop that crashes takes it down: killed with
    /// nothing said first. Its transport and the `floti connect` behind it
    /// see their input close.
    fn crash(mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// Opens the screen of session `id` on `stream`, and reads it until
    /// `shows` accepts what it drew.
    async fn screen_of(&mut self, stream: u64, id: u64, shows: impl Fn(&str) -> bool) -> String {
        self.send(&Message::StreamOpen(StreamOpen {
            stream,
            channel: SessionTerminal::NAME.to_owned(),
            params: to_payload(&SessionStreamOpen { id }).unwrap(),
        }));
        self.read_stream_until(stream, shows).await
    }

    fn type_into(&mut self, stream: u64, text: &str) {
        self.send(&Message::StreamData(StreamData {
            stream,
            data: Bytes(text.as_bytes().to_vec()),
        }));
    }

    /// The ids of the sessions the host runs.
    async fn listed(&mut self, request: u64) -> Vec<u64> {
        self.request::<SessionList>(request, &())
            .await
            .iter()
            .map(|row| row.id)
            .collect()
    }
}

/// Starts a session in `folder` through `bridge`, runs the fake agent in its
/// shell once the shell has drawn its prompt, and types `said` into it until
/// the agent answers: a user starting a session and working in it.
async fn work_in_a_session(
    bridge: &mut Bridge,
    request: u64,
    stream: u64,
    agent: &FakeAgent,
    folder: &Path,
    said: &str,
) -> SessionRecord {
    let session: SessionRecord = bridge
        .request::<SessionStart>(request, &start_request(folder))
        .await;
    bridge
        .screen_of(stream, session.id, |text| !text.is_empty())
        .await;
    let runs = agent.records().len();
    bridge.type_into(stream, &format!("\"{}\"\r", agent.exe().display()));
    let deadline = Instant::now() + PATIENCE;
    while agent.records().len() == runs {
        assert!(
            Instant::now() < deadline,
            "the fake agent did not start in the session within {PATIENCE:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    bridge.type_into(stream, &format!("{said}\r"));
    let answer = format!("echo: {said}");
    bridge
        .read_stream_until(stream, |text| text.contains(&answer))
        .await;
    session
}

/// The status recorded for session `id` in the host's store.
fn row_status(dirs: &TestDirs, id: u64) -> String {
    let db = rusqlite::Connection::open(dirs.data.join("floti.db")).expect("open floti.db");
    db.query_row(
        "SELECT status FROM sessions WHERE id = ?1",
        [i64::try_from(id).unwrap()],
        |row| row.get(0),
    )
    .expect("the session's row")
}

/// Polls the store until session `id`'s row reads `status`.
async fn row_becomes(dirs: &TestDirs, id: u64, status: &str) {
    let deadline = Instant::now() + PATIENCE;
    loop {
        let now = row_status(dirs, id);
        if now == status {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "session {id} is {now}, not {status}, after {PATIENCE:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_servers_host_as_its_unit_runs_it_serves_the_desktop_through_ssh_and_its_sessions_end_only_when_a_client_ends_them_or_it_stops()
 {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let mut host = UnitHost::start(&dirs, &agent);
    let endpoint = local_endpoint(&dirs.folders());
    // Another device, on the server itself, with a session of its own.
    let mut other = TestClient::connect(&endpoint, &["terminal"]).await;
    let theirs = other
        .request::<SessionStart>(&start_request(&dirs.folder("their project")))
        .await
        .expect("start another device's session");

    // S6: the desktop, which has pinned nothing, reaches it through
    // `ssh <target> floti connect`, learns and pins the host's key with
    // nothing asked there, starts a session, sees its screen and types into
    // it.
    let desktop = dirs.root().join("the desktop");
    let through_ssh = || bridge_through(&dirs, &dirs.runtime, &desktop, &ssh_transport());
    let mut bridge = Bridge::spawn(through_ssh());
    bridge.welcomed().await;
    let mine = work_in_a_session(
        &mut bridge,
        1,
        1,
        &agent,
        &dirs.folder("a project"),
        "typed far away",
    )
    .await;
    assert_eq!(
        ClientKeys::open(&desktop).unwrap().pinned_host(),
        host_public_key(&dirs.data).unwrap()
    );
    let runs = transport_runs(&dirs);
    let lines: Vec<Value> = runs.iter().map(|run| run["line"].clone()).collect();
    assert_eq!(lines, [HOST_KEY_LINE, CONNECT_LINE]);
    for run in &runs {
        assert_eq!(argv_of(run)[..3], ["-o", "BatchMode=yes", TARGET]);
    }

    // S7: the desktop crashes, and nothing there ends; connecting again, it
    // finds both sessions and its screen as it was.
    bridge.crash();
    let mut bridge = Bridge::spawn(through_ssh());
    bridge.welcomed().await;
    assert_eq!(bridge.listed(1).await, [theirs.id, mine.id]);
    bridge
        .screen_of(1, mine.id, |text| text.contains("echo: typed far away"))
        .await;
    bridge.type_into(1, "back again\r");
    bridge
        .read_stream_until(1, |text| text.contains("echo: back again"))
        .await;

    // S8: it quits keeping its sessions running, and a desktop that connects
    // later finds them.
    let kept = work_in_a_session(&mut bridge, 2, 2, &agent, &dirs.folder("kept"), "kept").await;
    bridge
        .request::<HostQuit>(3, &HostQuitRequest { end: false })
        .await;
    bridge.close_stdin();
    assert_eq!(bridge.ended().await.code, Some(0));
    let mut bridge = Bridge::spawn(through_ssh());
    bridge.welcomed().await;
    assert_eq!(bridge.listed(1).await, [theirs.id, mine.id, kept.id]);

    // S10: closing one session's tab, once the window has asked, ends that
    // session alone.
    let closed = work_in_a_session(
        &mut bridge,
        2,
        1,
        &agent,
        &dirs.folder("closed"),
        "close me",
    )
    .await;
    let _ = bridge
        .request::<SessionClose>(
            3,
            &CloseSessionRequest {
                id: closed.id,
                force: true,
            },
        )
        .await;
    row_becomes(&dirs, closed.id, "exited").await;
    assert_eq!(bridge.listed(4).await, [theirs.id, mine.id, kept.id]);

    // S9: it quits ending its sessions: the ones this desktop started end,
    // and the other device's keeps running.
    bridge
        .request::<HostQuit>(5, &HostQuitRequest { end: true })
        .await;
    bridge.close_stdin();
    assert_eq!(bridge.ended().await.code, Some(0));
    row_becomes(&dirs, mine.id, "exited").await;
    row_becomes(&dirs, kept.id, "exited").await;
    let deadline = Instant::now() + PATIENCE;
    loop {
        let still: Vec<u64> = other
            .request::<SessionList>(&())
            .await
            .unwrap()
            .iter()
            .map(|row| row.id)
            .collect();
        if still == [theirs.id] {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "still listed after {PATIENCE:?}: {still:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(row_status(&dirs, theirs.id), "running");
    drop(other);

    // S11: `systemctl --user stop floti.service` sends the host its stop
    // signal: every session there ends with its row recorded, the host exits
    // with status 0, which the unit does not restart, and the next start
    // offers nothing back.
    startup::terminate(host.id()).expect("stop the host");
    let status = host.exited();
    assert!(status.success(), "{status}");
    assert!(!restarted_on_failure(status));
    assert_eq!(row_status(&dirs, theirs.id), "exited");
    let next = RunningHost::start(config(&dirs, &agent));
    let mut client = TestClient::connect(&endpoint, &["terminal"]).await;
    assert_eq!(
        client.request::<SessionRestorable>(&()).await.unwrap(),
        None
    );
    assert!(client.request::<SessionList>(&()).await.unwrap().is_empty());
    drop(client);
    next.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_servers_host_that_is_killed_is_started_again_by_its_unit_and_takes_its_sessions_back_and_one_stopped_for_an_update_is_not()
 {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = local_endpoint(&dirs.folders());
    let mut host = UnitHost::start(&dirs, &agent);
    // `floti connect` says no host is running until the unit's host answers
    // on its socket, so the desktop's bridge starts once it does.
    drop(TestClient::connect(&endpoint, &["terminal"]).await);
    let desktop = dirs.root().join("the desktop");
    let through_ssh = || bridge_through(&dirs, &dirs.runtime, &desktop, &ssh_transport());
    let mut bridge = Bridge::spawn(through_ssh());
    bridge.welcomed().await;
    let session = work_in_a_session(
        &mut bridge,
        1,
        1,
        &agent,
        &dirs.folder("a project"),
        "before",
    )
    .await;

    // S12: killed, the host ends with a failure and the session runs on in
    // the keeper; the unit starts the host again, as systemd does.
    let status = host.kill();
    assert!(restarted_on_failure(status), "{status}");
    drop(bridge);
    assert_eq!(row_status(&dirs, session.id), "running");
    let runs = agent.records().len();
    let mut host = UnitHost::start(&dirs, &agent);

    // The restarted host took the session back from the keeper: the desktop
    // reconnecting finds it, its screen as it was, and types into it, with
    // nothing started anew and nothing offered back.
    let mut client = TestClient::connect(&endpoint, &["terminal"]).await;
    assert_eq!(
        client.request::<SessionRestorable>(&()).await.unwrap(),
        None
    );
    drop(client);
    let mut bridge = Bridge::spawn(through_ssh());
    bridge.welcomed().await;
    assert_eq!(bridge.listed(1).await, [session.id]);
    bridge
        .screen_of(1, session.id, |text| text.contains("echo: before"))
        .await;
    bridge.type_into(1, "after\r");
    bridge
        .read_stream_until(1, |text| text.contains("echo: after"))
        .await;
    assert_eq!(agent.records().len(), runs);
    bridge.close_stdin();
    assert_eq!(bridge.ended().await.code, Some(0));

    // Stopped for an update, through the login as the installer stops it:
    // status 0, so the unit leaves it stopped until setup starts the new one.
    let stopped = run_line(&dirs, &ssh_transport(), "floti update-stop --stop").await;
    assert_eq!(stopped.status.code(), Some(0), "{stopped:?}");
    let status = host.exited();
    assert!(status.success(), "{status}");
    assert!(!restarted_on_failure(status));
    let next = RunningHost::start(config(&dirs, &agent));
    next.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// WSL: a distro reached through this PC's wsl.exe with the line as wsl.exe
// reads it, or through a Windows PC's ssh and its wsl.exe; and a distro with
// no systemd, whose host `floti connect` starts. The fake wsl stands in for
// wsl.exe everywhere.
// ---------------------------------------------------------------------------

/// The distro the fake wsl knows.
const DISTRO: &str = "Debian";

/// `command`, with the fake wsl knowing `distros`.
fn knowing(mut command: Command, distros: &str) -> Command {
    command.env("FAKE_WSL_DISTROS", distros);
    command
}

/// `node wsl.mjs -d <DISTRO> --`: this PC's wsl.exe.
fn wsl_transport() -> Vec<String> {
    vec![
        node_on_path().to_string_lossy().into_owned(),
        fake_transport("wsl.mjs").to_string_lossy().into_owned(),
        "-d".to_owned(),
        DISTRO.to_owned(),
        "--".to_owned(),
    ]
}

/// `ssh -o BatchMode=yes <TARGET> wsl.exe -d <DISTRO> --`: the Windows PC's
/// wsl.exe, through its ssh.
fn wsl_through_ssh() -> Vec<String> {
    let mut words = ssh_transport();
    words.extend(["wsl.exe", "-d", DISTRO, "--"].map(str::to_owned));
    words
}

/// `floti bridge <folder> --as-written -- <transport>...`.
fn bridge_as_written(dirs: &TestDirs, folder: &Path, transport: &[String]) -> Command {
    let mut command = floti_command(dirs, &dirs.runtime);
    command
        .arg("bridge")
        .arg(folder)
        .arg("--as-written")
        .arg("--")
        .args(transport);
    command
}

/// Runs the bridge `bridge` makes for a new client folder, then again: the
/// first learns and pins the host's key, and both are served with nothing
/// asked.
async fn learn_and_reconnect_with(world: &World, name: &str, bridge: impl Fn(&Path) -> Command) {
    let folder = world.dirs.root().join(name);
    let mut first = Bridge::spawn(bridge(&folder));
    list_attach_and_type(&mut first, &world.dirs.folder("a project")).await;
    assert_eq!(
        ClientKeys::open(&folder).unwrap().pinned_host(),
        Some(world.host_key())
    );
    first.close_stdin();
    let ended = first.ended().await;
    assert_eq!(ended.code, Some(0), "{ended:?}");
    let mut again = Bridge::spawn(bridge(&folder));
    again.welcomed().await;
    assert!(!again.request::<SessionList>(1, &()).await.is_empty());
    again.close_stdin();
    assert_eq!(again.ended().await.code, Some(0));
}

/// The fake wsl's runs: the distro each named and the line it ran there.
fn wsl_lines(dirs: &TestDirs) -> Vec<(String, String)> {
    transport_runs(dirs)
        .iter()
        .filter(|run| run["program"] == "wsl")
        .map(|run| {
            (
                run["distro"].as_str().unwrap_or_default().to_owned(),
                run["line"].as_str().unwrap_or_default().to_owned(),
            )
        })
        .collect()
}

/// The lines a client that learns the key and then reconnects runs.
fn learn_and_reconnect_lines() -> [(String, String); 3] {
    [HOST_KEY_LINE, CONNECT_LINE, CONNECT_LINE].map(|line| (DISTRO.to_owned(), line.to_owned()))
}

#[tokio::test(flavor = "multi_thread")]
async fn s4_a_distro_on_this_pc_is_reached_with_wsl_d_and_the_line_as_written_and_pins_its_key_with_nothing_asked()
 {
    let world = World::start();
    learn_and_reconnect_with(&world, "this pc", |folder| {
        knowing(
            bridge_as_written(&world.dirs, folder, &wsl_transport()),
            DISTRO,
        )
    })
    .await;
    assert_eq!(wsl_lines(&world.dirs), learn_and_reconnect_lines());
    assert!(
        transport_runs(&world.dirs)
            .iter()
            .all(|run| run["program"] == "wsl")
    );
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s5_a_distro_on_a_windows_pc_is_reached_through_its_ssh_and_its_wsl_exe() {
    let world = World::start();
    learn_and_reconnect_with(&world, "a laptop", |folder| {
        knowing(
            bridge_through(&world.dirs, &world.dirs.runtime, folder, &wsl_through_ssh()),
            DISTRO,
        )
    })
    .await;
    let runs = transport_runs(&world.dirs);
    let ssh: Vec<&Value> = runs.iter().filter(|run| run["program"] == "ssh").collect();
    for run in &ssh {
        assert_eq!(argv_of(run)[..3], ["-o", "BatchMode=yes", TARGET]);
    }
    assert_eq!(
        ssh.iter()
            .map(|run| run["line"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>(),
        [HOST_KEY_LINE, CONNECT_LINE, CONNECT_LINE]
            .map(|line| format!("wsl.exe -d {DISTRO} -- {line}"))
    );
    assert_eq!(wsl_lines(&world.dirs), learn_and_reconnect_lines());
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s10_a_distro_that_is_not_there_ends_the_bridge_with_wsls_last_line_readable_on_this_pc_and_through_ssh()
 {
    let world = World::start();
    let dirs = &world.dirs;
    let folder = world.pinned_folder("a laptop");
    // On this PC wsl.exe is told WSL_UTF8=1, and writes UTF-8.
    let here = Bridge::spawn(knowing(
        bridge_as_written(dirs, &folder, &wsl_transport()),
        "Ubuntu",
    ))
    .ended()
    .await;
    assert_ended_with_line(&here, 8, "Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND");
    // Through ssh no variable reaches it, and it writes UTF-16LE.
    let there = Bridge::spawn(knowing(
        bridge_through(dirs, &dirs.runtime, &folder, &wsl_through_ssh()),
        "Ubuntu",
    ))
    .ended()
    .await;
    assert_ended_with_line(&there, 8, "Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND");
    world.stop().await;
}

/// Asks the host at `endpoint` to stop, through a client of its own.
async fn ask_to_stop(endpoint: &Endpoint) {
    let mut client = TestClient::connect(endpoint, &[]).await;
    let _ = client
        .request::<HostStop>(&HostStopRequest {
            reason: HostStopReason::Stop,
        })
        .await;
}

/// A host `floti connect` started, whose data folder is `data`: the test
/// stops it, and one a failing test left running is stopped as it unwinds.
struct ConnectStartedHost {
    endpoint: Endpoint,
    data: PathBuf,
    stopped: bool,
}

impl ConnectStartedHost {
    /// Stops it, and waits for it to let go of its lock, which it holds for
    /// as long as it runs.
    async fn stop(mut self) {
        ask_to_stop(&self.endpoint).await;
        self.stopped = true;
        let lock = std::fs::File::options()
            .read(true)
            .open(self.data.join(LOCK_FILE))
            .expect("the host's lock file");
        let deadline = Instant::now() + PATIENCE;
        while lock.try_lock().is_err() {
            assert!(
                Instant::now() < deadline,
                "the host floti connect started had not exited within {PATIENCE:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

impl Drop for ConnectStartedHost {
    fn drop(&mut self) {
        if self.stopped {
            return;
        }
        let endpoint = self.endpoint.clone();
        // On a thread of its own: this may run on the test's runtime.
        let _ = std::thread::spawn(move || {
            if let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                runtime.block_on(ask_to_stop(&endpoint));
            }
        })
        .join();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn s9_in_a_distro_set_to_start_on_connect_floti_connect_starts_the_host_and_its_sessions_outlive_the_connection()
 {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    // What `floti setup` leaves in a distro with no systemd: the host's key
    // and the record that it starts on connect, and no host running.
    std::fs::create_dir_all(&dirs.data).unwrap();
    load_or_create_key_pair(&dirs.data.join(HOST_KEY_FILE)).unwrap();
    std::fs::write(dirs.data.join(START_ON_CONNECT_FILE), START_ON_CONNECT_LINE).unwrap();
    let endpoint = local_endpoint(&dirs.folders());
    record_test_host(&endpoint, &dirs.data);
    let host = ConnectStartedHost {
        endpoint: endpoint.clone(),
        data: dirs.data.clone(),
        stopped: false,
    };
    let folder = dirs.root().join("this pc");
    let (log_var, log_dir) = agent.log_env();
    let bridge = || {
        let mut command = knowing(bridge_as_written(&dirs, &folder, &wsl_transport()), DISTRO);
        command
            // The host it starts runs its shell sessions where `%COMSPEC%`
            // is not set, as no SSH session's.
            .env("SHELL", "/bin/sh")
            .env(&log_var, &log_dir)
            .env_remove("CLAUDE_CONFIG_DIR")
            .env_remove("SSH_CONNECTION")
            .env_remove("SSH_CLIENT")
            .env_remove("SSH_TTY");
        command
    };
    let mut first = Bridge::spawn(bridge());
    first.welcomed().await;
    let session = work_in_a_session(
        &mut first,
        1,
        1,
        &agent,
        &dirs.folder("a project"),
        "in wsl",
    )
    .await;
    assert_eq!(
        ClientKeys::open(&folder).unwrap().pinned_host(),
        host_public_key(&dirs.data).unwrap()
    );
    first.close_stdin();
    assert_eq!(first.ended().await.code, Some(0));

    // The connection has ended, and the host it started still runs the
    // session.
    let mut client = TestClient::connect(&endpoint, &[]).await;
    let listed: Vec<u64> = client
        .request::<SessionList>(&())
        .await
        .unwrap()
        .iter()
        .map(|row| row.id)
        .collect();
    assert_eq!(listed, [session.id]);
    drop(client);

    // The next connection finds it running, and starts no other.
    let mut again = Bridge::spawn(bridge());
    again.welcomed().await;
    assert_eq!(again.listed(1).await, [session.id]);
    again.close_stdin();
    assert_eq!(again.ended().await.code, Some(0));

    host.stop().await;
    drop(agent);
}
