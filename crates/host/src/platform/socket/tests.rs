//! The local socket's behaviour on every OS, through the trait.
//!
//! A real host process is stood in for by this test binary itself: the
//! ignored test [`child_host`] binds the endpoint it is given, says so on
//! stdout and echoes whatever its clients send, until it is killed.

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::{Endpoint, LocalListener, LocalSocket, LocalStream, Native, network_listeners};
use crate::testkit::TestDirs;

/// The variable that hands [`child_host`] its endpoint.
const CHILD_ENDPOINT_VAR: &str = "FLOTI_SOCKET_TEST_ENDPOINT";
/// What [`child_host`] prints once it is listening.
const CHILD_READY: &str = "floti-socket-test: listening";

/// Stands in for a host process. Run only by [`HostProcess::start`].
#[test]
#[ignore = "a stand-in host process, started by the tests below"]
fn child_host() {
    let Some(endpoint) = std::env::var_os(CHILD_ENDPOINT_VAR) else {
        return;
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("a runtime");
    runtime.block_on(async {
        let mut listener = Native.bind(&Endpoint::new(endpoint)).expect("bind");
        println!("{CHILD_READY}");
        loop {
            let stream = listener.accept().await.expect("accept");
            tokio::spawn(echo(stream));
        }
    });
}

async fn echo(mut stream: LocalStream) {
    let mut buf = [0u8; 1024];
    while let Ok(n) = stream.read(&mut buf).await {
        if n == 0 || stream.write_all(&buf[..n]).await.is_err() {
            break;
        }
    }
}

/// A [`child_host`] process, killed when dropped.
struct HostProcess(Child);

impl HostProcess {
    /// Starts one listening at `endpoint` and waits until it is.
    fn start(endpoint: &Endpoint) -> Self {
        let exe = std::env::current_exe().expect("the test binary");
        let mut child = Command::new(exe)
            .args([
                "--exact",
                "platform::socket::tests::child_host",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(CHILD_ENDPOINT_VAR, endpoint.as_path())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("start the stand-in host");
        let stdout = child.stdout.take().expect("its stdout");
        let (ready_tx, ready_rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                // libtest prints the test's name on the same line first.
                if line.trim_end().ends_with(CHILD_READY) {
                    let _ = ready_tx.send(());
                }
            }
        });
        let host = Self(child);
        ready_rx
            .recv_timeout(Duration::from_secs(60))
            .expect("the stand-in host says it is listening");
        host
    }

    fn pid(&self) -> u32 {
        self.0.id()
    }

    /// Kills it without letting it stop, as a crash or a kill would.
    fn kill(mut self) {
        self.0.kill().expect("kill the stand-in host");
        self.0.wait().expect("reap the stand-in host");
    }
}

impl Drop for HostProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Sends `message` and reads back as many bytes.
async fn round_trip(client: &mut LocalStream, message: &[u8]) -> Vec<u8> {
    client.write_all(message).await.expect("write");
    let mut back = vec![0u8; message.len()];
    client.read_exact(&mut back).await.expect("read");
    back
}

#[tokio::test]
async fn clients_connect_and_bytes_flow_both_ways() {
    let dirs = TestDirs::new();
    let endpoint = dirs.endpoint();
    let mut listener = Native.bind(&endpoint).expect("bind");

    let mut first = Native.connect(&endpoint).await.expect("connect");
    let mut served_first = listener.accept().await.expect("accept");
    let mut second = Native.connect(&endpoint).await.expect("connect again");
    let mut served_second = listener.accept().await.expect("accept again");

    first.write_all(b"one").await.unwrap();
    second.write_all(b"two").await.unwrap();
    let mut buf = [0u8; 3];
    served_first.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"one");
    served_second.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"two");

    served_second.write_all(b"back").await.unwrap();
    let mut buf = [0u8; 4];
    second.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"back");
}

#[tokio::test]
async fn a_second_host_at_the_same_endpoint_is_refused_and_the_first_keeps_serving() {
    let dirs = TestDirs::new();
    let endpoint = dirs.endpoint();
    let mut first = Native.bind(&endpoint).expect("bind");

    let refused = Native.bind(&endpoint).expect_err("the endpoint is taken");
    assert!(refused.to_string().contains("already running"), "{refused}");

    let mut client = Native.connect(&endpoint).await.expect("connect");
    let mut served = first.accept().await.expect("the first host still accepts");
    client.write_all(b"still here").await.unwrap();
    let mut buf = [0u8; 10];
    served.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"still here");
}

#[tokio::test]
async fn a_socket_left_by_a_killed_host_is_replaced_and_accepts_clients() {
    let dirs = TestDirs::new();
    let endpoint = dirs.endpoint();

    let host = HostProcess::start(&endpoint);
    let mut client = Native.connect(&endpoint).await.expect("connect");
    assert_eq!(round_trip(&mut client, b"ping").await, b"ping");
    let refused = Native
        .bind(&endpoint)
        .expect_err("a live host's endpoint is not taken");
    assert!(refused.to_string().contains("already running"), "{refused}");
    drop(client);

    host.kill();

    let mut listener = Native.bind(&endpoint).expect("take over the endpoint");
    let mut client = Native.connect(&endpoint).await.expect("connect");
    let mut served = listener.accept().await.expect("accept");
    client.write_all(b"after").await.unwrap();
    let mut buf = [0u8; 5];
    served.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"after");
}

#[tokio::test]
async fn a_listening_host_has_no_tcp_or_udp_listener() {
    let dirs = TestDirs::new();
    let endpoint = dirs.endpoint();
    let host = HostProcess::start(&endpoint);
    let mut client = Native.connect(&endpoint).await.expect("connect");
    assert_eq!(round_trip(&mut client, b"ping").await, b"ping");

    let listeners = network_listeners(host.pid()).expect("list the host's network sockets");
    assert!(
        listeners.is_empty(),
        "the host listens on no network interface: {listeners:?}"
    );
}

#[test]
fn the_network_listener_check_sees_tcp_and_udp_listeners() {
    // The control for the test above: the check does find a listening TCP
    // socket and a bound UDP one when a process has them.
    let tcp = std::net::TcpListener::bind("127.0.0.1:0").expect("a TCP listener");
    let udp = std::net::UdpSocket::bind("127.0.0.1:0").expect("a UDP socket");
    let listeners = network_listeners(std::process::id()).expect("list this process's sockets");
    assert!(
        listeners.len() >= 2,
        "both sockets are listed: {listeners:?}"
    );
    drop((tcp, udp));
}
