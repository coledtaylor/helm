//! The login is the access: any device key that completes the Noise
//! handshake is welcomed and served every channel, with nothing asked of it,
//! and the host keeps no record of devices. What it shows instead is who is
//! attached now (`devices:attached`), and it can close every connection of
//! one device (`devices:disconnect`) without ending any of its sessions.
//!
//! Each test runs a host in this process ([`RunningHost`]) over a temporary
//! tree, with the fake agent behind it; every client is a device of its own,
//! made by the test, which the host has never seen.

use std::path::Path;
use std::sync::Arc;

use floti_host::agent::AgentBackend;
use floti_host::fake_agent;
use floti_host::platform::socket::Endpoint;
use floti_host::server::{HostConfig, RETIRED_FILES};
use floti_host::testkit::{FakeAgent, PATIENCE, RunningHost, TestClient, TestDirs};
use floti_protocol::Message;
use floti_protocol::channel::{EventChannel, from_payload, to_payload};
use floti_protocol::channels::common::{SessionRecord, SessionStatus};
use floti_protocol::channels::devices::{
    AttachedDevice, AttachedDevices, DevicesAttached, DevicesDisconnect, DisconnectDevice,
};
use floti_protocol::channels::host::{
    HostDeviceSessions, HostQuit, HostQuitRequest, HostStop, HostStopReason, HostStopRequest,
};
use floti_protocol::channels::plugins::PluginsList;
use floti_protocol::channels::sessions::{
    SessionExit, SessionList, SessionStart, StartSessionRequest,
};
use floti_protocol::message::ErrorCode;
use floti_protocol::noise::KeyPair;

const TERMINAL: &[&str] = &["terminal"];

fn config(dirs: &TestDirs, endpoint: &Endpoint, agent: &FakeAgent) -> HostConfig {
    HostConfig {
        run: Default::default(),
        folders: dirs.folders(),
        endpoint: endpoint.clone(),
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

/// The attached list a `devices:attached` subscription starts with.
fn snapshot_of(message: Message) -> AttachedDevices {
    match message {
        Message::Snapshot(snapshot) => from_payload(&snapshot.state).unwrap(),
        other => panic!("expected the attached devices, got {other:?}"),
    }
}

/// Waits on `subscription` for an attached list that `wanted` accepts.
async fn attached_where(
    client: &mut TestClient,
    subscription: u64,
    what: &str,
    wanted: impl Fn(&[AttachedDevice]) -> bool,
) -> Vec<AttachedDevice> {
    client
        .event_on::<AttachedDevices>(subscription, what, |list| wanted(&list.devices))
        .await
        .devices
}

fn entry_of<'a>(devices: &'a [AttachedDevice], key: &KeyPair) -> Option<&'a AttachedDevice> {
    devices
        .iter()
        .find(|device| device.fingerprint == key.public().fingerprint())
}

// ---------------------------------------------------------------------------
// Any key that completes the handshake is served
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s1_a_device_key_the_host_has_never_seen_is_welcomed_and_served_every_request() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = RunningHost::start(config(&dirs, &endpoint, &agent));
    // Up before the stranger knocks.
    drop(TestClient::connect(&endpoint, TERMINAL).await);

    let stranger = TestClient::new_device();
    let mut client = TestClient::connect_device(&endpoint, &stranger, TERMINAL).await;
    assert_eq!(client.welcome.device, Some(stranger.public().fingerprint()));
    assert!(!client.welcome.away);

    let session = client
        .request::<SessionStart>(&start_request(&dirs.folder("a project")))
        .await
        .expect("a session started");
    assert_eq!(
        client.request::<SessionList>(&()).await.unwrap()[0].id,
        session.id
    );
    assert_eq!(
        client
            .request::<HostDeviceSessions>(&())
            .await
            .unwrap()
            .iter()
            .map(|mine| mine.id)
            .collect::<Vec<_>>(),
        [session.id]
    );
    client
        .request::<PluginsList>(&())
        .await
        .expect("plugins listed");
    let attached = snapshot_of(client.subscribe_on(1, DevicesAttached::NAME).await);
    assert!(
        entry_of(&attached.devices, &stranger).is_some(),
        "{attached:?}"
    );
    // Stopping the host is served to it too.
    client
        .request::<HostStop>(&HostStopRequest {
            reason: HostStopReason::Stop,
        })
        .await
        .expect("the stop is taken");
    drop(client);
    assert_eq!(host.stopped().await, HostStopReason::Stop);
}

#[tokio::test(flavor = "multi_thread")]
async fn s11_the_retired_device_channels_are_unknown_and_no_welcome_carries_a_role() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = RunningHost::start(config(&dirs, &endpoint, &agent));
    let mut client = TestClient::connect_as(&endpoint, "a laptop", TERMINAL).await;

    let welcome = serde_json::to_value(&client.welcome).unwrap();
    let fields: Vec<&str> = welcome
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    for gone in ["role", "pairing", "code", "presence"] {
        assert!(!fields.contains(&gone), "{welcome}");
    }

    for channel in [
        "devices:list",
        "devices:approve",
        "devices:revoke",
        "devices:presence",
    ] {
        let refused = client
            .request_on(channel, to_payload(&serde_json::json!({})).unwrap())
            .await
            .expect_err(channel);
        assert_eq!(refused.code, ErrorCode::UnknownChannel, "{channel}");
        let said = refused.message.replace(channel, "").to_lowercase();
        for gone in ["role", "admin", "pair", "presence", "approve"] {
            assert!(!said.contains(gone), "{channel}: {}", refused.message);
        }
    }
    drop(client);
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s9_the_files_an_earlier_version_kept_go_at_start_and_paired_revoked_and_new_devices_are_served_alike()
 {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let paired = KeyPair::generate().unwrap();
    let revoked = KeyPair::generate().unwrap();
    let never_seen = KeyPair::generate().unwrap();
    std::fs::write(
        dirs.data.join("devices.json"),
        format!(
            r#"{{"format":1,"devices":[{{"key":"{}","name":"a laptop","role":"operator"}},{{"key":"{}","name":"a lost phone","role":"viewer","revoked":true}}]}}"#,
            paired.public().to_hex(),
            revoked.public().to_hex()
        ),
    )
    .unwrap();
    std::fs::write(
        dirs.data.join("enrolment.json"),
        r#"{"format":1,"hostKey":"00","code":"00"}"#,
    )
    .unwrap();

    let host = RunningHost::start(config(&dirs, &endpoint, &agent));
    for retired in RETIRED_FILES {
        assert!(
            !dirs.data.join(retired).exists(),
            "{retired} is still there"
        );
    }
    for device in [&paired, &revoked, &never_seen] {
        let mut client = TestClient::connect_device(&endpoint, device, TERMINAL).await;
        assert!(client.request::<SessionList>(&()).await.is_ok());
        assert!(client.request::<PluginsList>(&()).await.is_ok());
    }
    host.stop(HostStopReason::Stop).await;
    for retired in RETIRED_FILES {
        assert!(!dirs.data.join(retired).exists(), "{retired} came back");
    }
}

// ---------------------------------------------------------------------------
// devices:attached and devices:disconnect
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_device_with_several_connections_is_one_entry_named_by_its_hello_and_leaves_with_its_last()
 {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = RunningHost::start(config(&dirs, &endpoint, &agent));
    let mut watcher = TestClient::connect(&endpoint, &[]).await;
    let first = snapshot_of(watcher.subscribe_on(1, DevicesAttached::NAME).await);
    assert_eq!(first.devices.len(), 1, "only the watcher: {first:?}");

    let laptop = TestClient::new_device();
    let window = TestClient::over_named(
        TestClient::handshake(&endpoint, &laptop).await,
        Some("build laptop"),
        TERMINAL,
    )
    .await;
    let listed = attached_where(&mut watcher, 1, "the laptop attached", |devices| {
        entry_of(devices, &laptop).is_some()
    })
    .await;
    let entry = entry_of(&listed, &laptop).unwrap().clone();
    assert_eq!(entry.name, "build laptop");
    assert!(!entry.away);
    assert_eq!(entry.connections, 1);
    assert!(
        entry.since.parse::<jiff::Timestamp>().is_ok(),
        "{}",
        entry.since
    );

    // A second connection of the same device changes only its count.
    let page = TestClient::connect_device(&endpoint, &laptop, &[]).await;
    let listed = attached_where(&mut watcher, 1, "a second connection", |devices| {
        entry_of(devices, &laptop).is_some_and(|entry| entry.connections == 2)
    })
    .await;
    assert_eq!(listed.len(), 2, "{listed:?}");
    let again = entry_of(&listed, &laptop).unwrap();
    assert_eq!((&again.name, &again.since), (&entry.name, &entry.since));

    drop(window);
    attached_where(&mut watcher, 1, "one connection left", |devices| {
        entry_of(devices, &laptop).is_some_and(|entry| entry.connections == 1)
    })
    .await;
    drop(page);
    attached_where(&mut watcher, 1, "the laptop detached", |devices| {
        entry_of(devices, &laptop).is_none()
    })
    .await;
    drop(watcher);
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn disconnecting_a_device_closes_every_connection_of_it_and_its_sessions_keep_running() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = RunningHost::start(config(&dirs, &endpoint, &agent));
    let mut desktop = TestClient::connect(&endpoint, TERMINAL).await;
    snapshot_of(desktop.subscribe_on(1, DevicesAttached::NAME).await);
    desktop.subscribe_quietly(2, SessionExit::NAME).await;

    let phone = TestClient::new_device();
    let mut window = TestClient::connect_device(&endpoint, &phone, TERMINAL).await;
    let mut page = TestClient::connect_device(&endpoint, &phone, &[]).await;
    let session = window
        .request::<SessionStart>(&start_request(&dirs.folder("a project")))
        .await
        .unwrap();
    attached_where(
        &mut desktop,
        1,
        "both of the phone's connections",
        |devices| entry_of(devices, &phone).is_some_and(|entry| entry.connections == 2),
    )
    .await;

    // Any case and stray blanks: the fingerprint as a person might paste it.
    let fingerprint = format!(" {} ", phone.public().fingerprint().to_uppercase());
    desktop
        .request::<DevicesDisconnect>(&DisconnectDevice { fingerprint })
        .await
        .expect("the phone is disconnected");
    assert!(window.wait_closed(PATIENCE).await, "the window stayed open");
    assert!(page.wait_closed(PATIENCE).await, "the page stayed open");
    attached_where(&mut desktop, 1, "the phone gone from the list", |devices| {
        entry_of(devices, &phone).is_none()
    })
    .await;

    // Its session runs on, and answers what is typed into it.
    let listed: Vec<SessionRecord> = desktop.request::<SessionList>(&()).await.unwrap();
    assert_eq!(
        listed
            .iter()
            .map(|row| (row.id, row.status))
            .collect::<Vec<_>>(),
        [(session.id, SessionStatus::Running)]
    );
    desktop.attach(3, session.id).await;
    desktop.type_into(3, b"still here\r").await;
    desktop
        .read_stream_until(3, |bytes| {
            String::from_utf8_lossy(bytes).contains("echo: still here")
        })
        .await;

    // Nothing is remembered: it connects again and is served.
    let mut back = TestClient::connect_device(&endpoint, &phone, TERMINAL).await;
    assert_eq!(back.request::<SessionList>(&()).await.unwrap().len(), 1);

    // A device not attached: refused, and nothing closes.
    let refused = desktop
        .request::<DevicesDisconnect>(&DisconnectDevice {
            fingerprint: KeyPair::generate().unwrap().public().fingerprint(),
        })
        .await
        .expect_err("no such device");
    assert!(
        refused.message.contains("nothing was closed"),
        "{}",
        refused.message
    );
    assert!(back.request::<SessionList>(&()).await.is_ok());
    drop(back);
    drop(desktop);
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// A quit ends only what the quitting device started
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s15_of_two_desktops_one_quitting_with_keep_ends_nothing_and_with_end_ends_only_its_own() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = RunningHost::start(config(&dirs, &endpoint, &agent));
    let mut watcher = TestClient::connect(&endpoint, &[]).await;
    watcher.subscribe_quietly(1, SessionExit::NAME).await;

    let mut home = TestClient::connect_as(&endpoint, "home desktop", TERMINAL).await;
    let mut work = TestClient::connect_as(&endpoint, "work desktop", TERMINAL).await;
    let home_session = home
        .request::<SessionStart>(&start_request(&dirs.folder("home project")))
        .await
        .unwrap();
    let work_session = work
        .request::<SessionStart>(&start_request(&dirs.folder("work project")))
        .await
        .unwrap();

    // Keep: the work desktop quits, and nothing ends.
    work.request::<HostQuit>(&HostQuitRequest { end: false })
        .await
        .unwrap();
    let running = |rows: Vec<SessionRecord>| -> Vec<u64> {
        rows.iter()
            .filter(|row| row.status == SessionStatus::Running)
            .map(|row| row.id)
            .collect()
    };
    let mut both = vec![home_session.id, work_session.id];
    both.sort_unstable();
    let mut listed = running(watcher.request::<SessionList>(&()).await.unwrap());
    listed.sort_unstable();
    assert_eq!(listed, both);
    drop(work);

    // End: the home desktop quits, and only its session ends.
    home.request::<HostQuit>(&HostQuitRequest { end: true })
        .await
        .unwrap();
    watcher
        .event_on::<SessionRecord>(1, "the home session's exit", |row| {
            row.id == home_session.id
        })
        .await;
    assert_eq!(
        running(watcher.request::<SessionList>(&()).await.unwrap()),
        [work_session.id]
    );
    drop(home);
    drop(watcher);
    host.stop(HostStopReason::Stop).await;
}
