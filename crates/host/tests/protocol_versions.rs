//! A client and a host one release apart, through a real host on a real
//! local socket: each side on either version, the host's through
//! [`TEST_HOST_PROTOCOL`] in its data folder. The client connects only where
//! `negotiate` allows it, and is otherwise refused with both versions and the
//! side to update, which is what the desktop's window says.
//!
//! Every folder and socket is in a [`TestDirs`] tree, and every host is a
//! [`RunningHost`] the test stops.

use std::time::Duration;

use floti_host::client::{self, ClientError, Connection};
use floti_host::platform::socket::Endpoint;
use floti_host::server::{
    HostConfig, HostRun, TEST_HOST_PROTOCOL, TEST_HOST_VERSION, backends, host_public_key,
};
use floti_host::testkit::{PATIENCE, RunningHost, TestClient, TestDirs};
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::workspace::AppMode;
use floti_protocol::message::{ClientInfo, ClientKind, Hello, Refused};
use floti_protocol::{Message, PROTOCOL_VERSION, ProtocolVersion, UpdateSide};

/// A running host that greets as protocol `on`, over folders of its own.
struct Host {
    on: ProtocolVersion,
    endpoint: Endpoint,
    running: RunningHost,
    /// Last: its folders go once the host has stopped.
    dirs: TestDirs,
}

impl Host {
    async fn stop(self) {
        self.running.stop(HostStopReason::Stop).await;
        drop(self.dirs);
    }
}

/// A host over a [`TestDirs`] tree of its own that greets as protocol `on`.
fn start_host(on: ProtocolVersion) -> Host {
    start_host_naming(on, None)
}

/// A host like [`start_host`]'s that names floti `version`, when given, in
/// place of its own.
fn start_host_naming(on: ProtocolVersion, version: Option<&str>) -> Host {
    let dirs = TestDirs::new();
    std::fs::write(dirs.data.join(TEST_HOST_PROTOCOL), on.to_string())
        .expect("write the host's test protocol");
    if let Some(version) = version {
        std::fs::write(
            dirs.data.join(TEST_HOST_VERSION),
            format!(
                "{version}
"
            ),
        )
        .expect("write the host's test floti version");
    }
    let endpoint = dirs.endpoint();
    let running = RunningHost::start(HostConfig {
        folders: dirs.folders(),
        endpoint: endpoint.clone(),
        backends: backends(&dirs.user_env(), None),
        inherited_env: std::env::vars_os().collect(),
        run: HostRun {
            mode: AppMode::Dev,
            home: Some(dirs.home.clone()),
            node: None,
            desktop: false,
            keeper: None,
            wsl: None,
        },
    });
    Host {
        on,
        endpoint,
        running,
        dirs,
    }
}

/// The handshake with the host over `dirs`' folders as a new device,
/// polled until the host answers, for at most [`PATIENCE`].
async fn handshake(host: &Host) -> Connection {
    let endpoint = &host.endpoint;
    let device = TestClient::new_device();
    let deadline = tokio::time::Instant::now() + PATIENCE;
    loop {
        let waited = match host_public_key(&host.dirs.data) {
            Ok(Some(key)) => match client::connect(endpoint, &device, &key).await {
                Ok(connection) => return connection,
                Err(err @ ClientError::Unreachable { .. }) => err.to_string(),
                Err(err) => panic!("the host at {endpoint} did not let the device in: {err}"),
            },
            Ok(None) => "the host has no key yet".to_owned(),
            Err(err) => err.to_string(),
        };
        assert!(
            tokio::time::Instant::now() < deadline,
            "no host answered at {endpoint} within {PATIENCE:?}: {waited}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// What the host answers a desktop's hello at protocol `client`.
async fn greet(host: &Host, client: ProtocolVersion) -> Message {
    let mut connection = handshake(host).await;
    connection
        .send(&Message::Hello(Hello {
            protocol: client,
            client: ClientInfo {
                name: "Helm (protocol version tests)".to_owned(),
                kind: ClientKind::Desktop,
                device_name: None,
            },
            capabilities: vec!["terminal".to_owned()],
        }))
        .await
        .expect("send the hello");
    match tokio::time::timeout(PATIENCE, connection.next()).await {
        Ok(Ok(Some(message))) => message,
        other => panic!("the host did not answer a hello at {client}: {other:?}"),
    }
}

/// The refusal of a hello at `client`, which names both versions.
async fn refused(host: &Host, client: ProtocolVersion) -> UpdateSide {
    let on = host.on;
    match greet(host, client).await {
        Message::Refused(Refused {
            host,
            client: said,
            update,
            message,
        }) => {
            assert_eq!((host, said), (on, client));
            assert!(
                message.contains(&on.to_string()) && message.contains(&client.to_string()),
                "the refusal names both versions: {message}"
            );
            update
        }
        other => panic!("a hello at {client} to a host on {on} was not refused: {other:?}"),
    }
}

/// The welcome of a hello at `client`, which speaks the version both agree
/// on: the client's.
async fn welcomed(host: &Host, client: ProtocolVersion) {
    match greet(host, client).await {
        Message::Welcome(welcome) => assert_eq!(welcome.protocol, client),
        other => panic!(
            "a hello at {client} to a host on {} was not welcomed: {other:?}",
            host.on
        ),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn s6_a_desktop_on_the_hosts_version_or_one_minor_behind_connects() {
    assert_eq!(PROTOCOL_VERSION, ProtocolVersion::new(2, 0));
    let host = start_host(ProtocolVersion::new(2, 0));
    welcomed(&host, ProtocolVersion::new(2, 0)).await;
    host.stop().await;

    let host = start_host(ProtocolVersion::new(2, 1));
    welcomed(&host, ProtocolVersion::new(2, 0)).await;
    host.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s7_a_desktop_a_minor_or_a_major_ahead_of_its_host_is_refused_saying_to_update_the_host() {
    let host = start_host(ProtocolVersion::new(2, 0));
    for client in [ProtocolVersion::new(2, 1), ProtocolVersion::new(3, 0)] {
        assert_eq!(refused(&host, client).await, UpdateSide::Host);
    }
    host.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s8_a_desktop_more_than_one_minor_behind_or_on_an_older_major_is_refused_saying_to_update_it()
 {
    let host = start_host(ProtocolVersion::new(2, 2));
    assert_eq!(
        refused(&host, ProtocolVersion::new(2, 0)).await,
        UpdateSide::Client
    );
    host.stop().await;

    let host = start_host(ProtocolVersion::new(2, 0));
    assert_eq!(
        refused(&host, ProtocolVersion::new(1, 9)).await,
        UpdateSide::Client
    );
    host.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s9_a_test_host_names_the_older_floti_its_data_folder_says_so_a_window_can_meet_one() {
    let host = start_host_naming(PROTOCOL_VERSION, Some("2.4.0"));
    let named = match greet(&host, PROTOCOL_VERSION).await {
        Message::Welcome(welcome) => welcome.host_version,
        other => panic!("a hello at {PROTOCOL_VERSION} was not welcomed: {other:?}"),
    };
    host.stop().await;
    assert_eq!(named, "2.4.0");
}
