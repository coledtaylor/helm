//! Reaching a host on another computer, end to end: `floti connect` carrying
//! the protocol between its standard input and output and a real host's
//! local socket, and `floti bridge` running a transport (the fake `ssh`, or
//! a custom command) with `floti connect` as its last argument, the handshake
//! crossing it, and pairing through it.
//!
//! No test reaches another computer or a real ssh: the fake transports in
//! `test/fake-ssh/` run the line they are given on this computer, in the
//! test's own folders, with `floti` mapped to the binary built here. Nothing
//! reads or writes `~/.ssh`. Every folder is in the test's temporary tree, a
//! host is a [`RunningHost`] the test stops, and a bridge ends when the
//! test's pipe to its standard input closes, which takes its transport and
//! the `floti connect` behind it along: each sees its standard input close.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use floti_host::agent::AgentBackend;
use floti_host::bridge::{CONNECT_LINE, HOST_KEY_LINE, PAIRING_LINE_PREFIX};
use floti_host::client::{ClientError, ClientKeys, DEVICE_KEY_FILE, PINNED_HOST_FILE, duplex};
use floti_host::connect::NO_HOST_LINE;
use floti_host::devices::{DeviceRegistry, Role};
use floti_host::fake_agent;
use floti_host::platform::folders::{CONFIG_DIR_VAR, DATA_DIR_VAR, LOG_DIR_VAR, RUNTIME_DIR_VAR};
use floti_host::platform::socket::{
    Endpoint, LocalListener, LocalSocket, LocalStream, Native as NativeSocket,
};
use floti_host::server::{HostConfig, host_public_key, local_endpoint, relay_endpoint};
use floti_host::testkit::{FakeAgent, PATIENCE, RunningHost, TestDirs, run_floti};
use floti_protocol::channel::{RequestChannel, from_payload, to_payload};
use floti_protocol::channels::common::SessionRecord;
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::sessions::{
    SessionList, SessionStart, SessionStreamOpen, SessionTerminal, StartSessionRequest,
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

    /// A client folder named `name` whose device the host has paired, as an
    /// operator, and which has pinned the host's key.
    fn paired_folder(&self, name: &str) -> PathBuf {
        let folder = self.dirs.folder(name);
        let mut keys = ClientKeys::open(&folder).expect("set up the client's keys");
        DeviceRegistry::in_data_folder(&self.dirs.data)
            .pair(keys.device_key(), name, Role::Operator)
            .expect("pair the device");
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

/// `floti bridge <folder> [--pair <name>] -- <transport>...`.
fn bridge_through(
    dirs: &TestDirs,
    runtime: &Path,
    folder: &Path,
    pair: Option<&str>,
    transport: &[String],
) -> Command {
    let mut command = floti_command(dirs, runtime);
    command.arg("bridge").arg(folder);
    if let Some(name) = pair {
        command.args(["--pair", name]);
    }
    command.arg("--").args(transport);
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

    /// The first line on the bridge's standard error that `wanted` accepts,
    /// once it has written it.
    async fn stderr_line_where(&self, wanted: impl Fn(&str) -> bool) -> String {
        let deadline = Instant::now() + PATIENCE;
        loop {
            let said = String::from_utf8_lossy(&self.stderr.lock().unwrap()).into_owned();
            if let Some(line) = said.lines().find(|line| wanted(line)) {
                return line.to_owned();
            }
            assert!(
                Instant::now() < deadline,
                "the bridge wrote no such line within {PATIENCE:?}: {said:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
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
    let folder = world.paired_folder("a laptop");
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
    let folder = world.paired_folder("a laptop");
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
// S3, S4: a paired device through ssh and through a custom command
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s3_through_the_users_ssh_the_device_lists_sessions_gets_a_screen_and_types_into_it() {
    let world = World::start();
    let dirs = &world.dirs;
    let folder = world.paired_folder("a laptop");
    let mut bridge = Bridge::spawn(bridge_through(
        dirs,
        &dirs.runtime,
        &folder,
        None,
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
    let folder = world.paired_folder("a laptop");
    let mut bridge = Bridge::spawn(bridge_through(
        dirs,
        &dirs.runtime,
        &folder,
        None,
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
// S5: pairing through a transport
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s5_a_device_pairs_through_ssh_once_floti_devices_approve_runs_on_the_host_then_connects_as_itself()
 {
    let world = World::start();
    let dirs = &world.dirs;
    let folder = dirs.root().join("a laptop");
    let mut bridge = Bridge::spawn(bridge_through(
        dirs,
        &dirs.runtime,
        &folder,
        Some("a laptop"),
        &ssh_transport(),
    ));

    // The code, and how long it waits, on one line for the desktop to show.
    let line = bridge
        .stderr_line_where(|line| line.starts_with(PAIRING_LINE_PREFIX))
        .await;
    let rest = &line[PAIRING_LINE_PREFIX.len()..];
    let code = rest.split(',').next().unwrap().to_owned();
    assert!(
        rest.contains(", expires in ")
            && line.ends_with(&format!(
                "run \"floti devices approve {code}\" on the host."
            )),
        "{line}"
    );
    assert!(
        !folder.join(PINNED_HOST_FILE).exists(),
        "nothing is pinned before approval"
    );

    // Someone runs `floti devices approve <code>` in a terminal on the host.
    let mut approve = floti_command(dirs, &dirs.runtime);
    approve
        .args(["devices", "approve", &code])
        .stdin(Stdio::null());
    let approved = run_floti(approve).await;
    assert!(approved.status.success(), "{approved:?}");

    // The bridge pins the key it learned through ssh, connects as itself and
    // relays.
    list_attach_and_type(&mut bridge, &dirs.folder("a project")).await;
    let keys = ClientKeys::open(&folder).unwrap();
    assert_eq!(keys.pinned_host(), Some(world.host_key()));
    let paired = DeviceRegistry::in_data_folder(&dirs.data)
        .devices()
        .unwrap()
        .into_iter()
        .find(|device| device.key == keys.device_key())
        .expect("the device is paired");
    assert_eq!(paired.name, "a laptop");
    bridge.close_stdin();
    let ended = bridge.ended().await;
    assert_eq!(ended.code, Some(0), "{ended:?}");
    assert_eq!(ended.stderr.lines().collect::<Vec<_>>(), [line.as_str()]);

    // From then on it connects as itself, with no --pair and no code.
    let mut again = Bridge::spawn(bridge_through(
        dirs,
        &dirs.runtime,
        &folder,
        None,
        &ssh_transport(),
    ));
    again.welcomed().await;
    let listed = again.request::<SessionList>(1, &()).await;
    assert_eq!(listed.len(), 1, "{listed:?}");
    again.close_stdin();
    let second = again.ended().await;
    assert_eq!(second.code, Some(0), "{second:?}");
    assert_eq!(second.stderr, "", "{second:?}");

    // Through ssh it learned the key, asked, then connected twice as itself.
    let lines: Vec<String> = transport_runs(dirs)
        .iter()
        .map(|run| run["line"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        lines,
        [HOST_KEY_LINE, CONNECT_LINE, CONNECT_LINE, CONNECT_LINE]
    );
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s5_a_request_to_pair_through_a_transport_that_expires_pins_nothing_and_exits_9() {
    let world = World::start();
    let dirs = &world.dirs;
    let folder = dirs.root().join("a laptop");
    let bridge = Bridge::spawn(bridge_through(
        dirs,
        &dirs.runtime,
        &folder,
        Some("a laptop"),
        &custom_transport(),
    ));
    bridge
        .stderr_line_where(|line| line.starts_with(PAIRING_LINE_PREFIX))
        .await;

    // The host's clock is stepped past the request's life, then the
    // host is asked, which drops what has expired as it answers.
    dirs.step_host_clock(floti_host::server::PAIRING_LIFETIME + Duration::from_secs(1));
    let mut list = floti_command(dirs, &dirs.runtime);
    list.arg("devices").stdin(Stdio::null());
    let listed = run_floti(list).await;
    assert!(listed.status.success(), "{listed:?}");

    let ended = bridge.ended().await;
    assert_eq!(ended.code, Some(9), "{ended:?}");
    let lines: Vec<&str> = ended.stderr.lines().collect();
    assert_eq!(lines.len(), 2, "{ended:?}");
    assert!(
        lines[1].starts_with("floti bridge: nobody approved"),
        "{ended:?}"
    );
    assert!(!folder.join(PINNED_HOST_FILE).exists());
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s5_a_host_that_does_not_prove_the_pinned_key_through_ssh_gets_only_the_first_message_and_the_bridge_exits_5()
 {
    let world = World::start();
    let dirs = &world.dirs;
    let folder = world.paired_folder("a laptop");
    let pinned = KeyPair::generate().unwrap().public();
    ClientKeys::open(&folder).unwrap().pin_host(pinned).unwrap();
    let (runtime, relay) = tapped_runtime(dirs);

    let ended = Bridge::spawn(bridge_through(
        dirs,
        &runtime,
        &folder,
        None,
        &ssh_transport(),
    ))
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
    let paired = world.paired_folder("a laptop");
    let unpaired = dirs.root().join("a new laptop");
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
        for (folder, pair) in [(&paired, None), (&unpaired, Some("a new laptop"))] {
            let mut command = bridge_through(dirs, &dirs.runtime, folder, pair, &ssh_transport());
            command.env("FAKE_SSH_FAIL", failure);
            let ended = Bridge::spawn(command).ended().await;
            assert_ended_with_line(&ended, 8, &says);
        }
    }
    assert!(!unpaired.join(PINNED_HOST_FILE).exists());
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
    let unpaired = dirs.root().join("a new laptop");
    for (folder, pair) in [(&folder, None), (&unpaired, Some("a new laptop"))] {
        let ended = Bridge::spawn(bridge_through(
            &dirs,
            &dirs.runtime,
            folder,
            pair,
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
        None,
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

#[tokio::test(flavor = "multi_thread")]
async fn an_unpaired_client_given_no_pair_name_exits_4_without_running_the_transport() {
    let dirs = TestDirs::new();
    let folder = dirs.root().join("a laptop");
    let ended = Bridge::spawn(bridge_through(
        &dirs,
        &dirs.runtime,
        &folder,
        None,
        &ssh_transport(),
    ))
    .ended()
    .await;
    assert_eq!(ended.code, Some(4), "{ended:?}");
    assert!(transport_runs(&dirs).is_empty());
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

/// Pairs a new client folder through `transport` the way Helm does, with
/// `--pair` on every run, approves it on the host, then connects again with
/// `--pair` still given and the key pinned, and returns the folder.
async fn pair_and_reconnect_as_helm_does(
    world: &World,
    name: &str,
    transport: &[String],
) -> PathBuf {
    let dirs = &world.dirs;
    let folder = dirs.root().join(name);
    let mut pairing = Bridge::spawn(bridge_through(
        dirs,
        &dirs.runtime,
        &folder,
        Some(name),
        transport,
    ));
    let line = pairing
        .stderr_line_where(|line| line.starts_with(PAIRING_LINE_PREFIX))
        .await;
    let code = line[PAIRING_LINE_PREFIX.len()..]
        .split(',')
        .next()
        .unwrap()
        .to_owned();
    let mut approve = floti_command(dirs, &dirs.runtime);
    approve
        .args(["devices", "approve", &code])
        .stdin(Stdio::null());
    let approved = run_floti(approve).await;
    assert!(approved.status.success(), "{approved:?}");
    pairing.welcomed().await;
    pairing.close_stdin();
    let paired = pairing.ended().await;
    assert_eq!(paired.code, Some(0), "{paired:?}");

    let mut again = Bridge::spawn(bridge_through(
        dirs,
        &dirs.runtime,
        &folder,
        Some(name),
        transport,
    ));
    again.welcomed().await;
    let listed = again.request::<SessionList>(1, &()).await;
    assert!(listed.is_empty(), "{listed:?}");
    again.close_stdin();
    let ended = again.ended().await;
    assert_eq!(ended.code, Some(0), "{ended:?}");
    assert_eq!(
        ended.stderr, "",
        "a paired device asks nothing again: {ended:?}"
    );
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

    let through_ssh = pair_and_reconnect_as_helm_does(&world, "a laptop", &ssh_transport()).await;
    let through_command =
        pair_and_reconnect_as_helm_does(&world, "a desktop", &custom_transport()).await;

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
