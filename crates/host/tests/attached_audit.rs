//! Who is attached, connection notices, role changes and the audit log,
//! against a real host: the attached list each role sees and how it
//! changes, `devices:connected` told to the other clients only, the
//! notification a device attaching from another computer shows on the
//! host's (recorded, in a test build, never shown), a role change holding
//! for a device's open connections at once, and every kind of entry the
//! audit log records, kept across a restart, with no request's contents in
//! it.
//!
//! Presence's window is crossed by stepping the host's clock; no test waits
//! on time. Away connections come through the relay endpoint `floti connect`
//! opens; no test reaches another computer.

use std::sync::Arc;
use std::time::Instant;

use floti_host::agent::AgentBackend;
use floti_host::client::{self, ClientKeys, PairingOutcome};
use floti_host::devices::Role;
use floti_host::fake_agent;
use floti_host::platform::private_files::{Native as NativeFiles, PrivateFiles};
use floti_host::platform::socket::Endpoint;
use floti_host::server::audit::AUDIT_FILE;
use floti_host::server::notices::recorded_notices;
use floti_host::server::{HostConfig, host_public_key, local_endpoint};
use floti_host::testkit::{
    FakeAgent, PATIENCE, RunningHost, TEST_DEVICE_NAME, TestClient, TestDirs, run_floti,
    test_device_key,
};
use floti_protocol::channel::{EventChannel, from_payload, to_payload};
use floti_protocol::channels::carry::CarryStatusRead;
use floti_protocol::channels::devices::{
    AdminOutcome, AttachedDevices, AuditActor, AuditEvent, AuditPage, AuditQuery, ChangeDeviceRole,
    DeviceConnected, DeviceRole, DevicesAttached, DevicesAudit, DevicesConnected, DevicesList,
    DevicesPresence, DevicesRevoke, DevicesRole, PairingEnd, RevokeDevice,
};
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::sessions::{SessionList, SessionStart, StartSessionRequest};
use floti_protocol::message::{ClientKind, ErrorCode, ErrorReply, Message};
use floti_protocol::noise::KeyPair;

const TERMINAL: &[&str] = &["terminal"];
const ATTACHED: &str = <DevicesAttached as EventChannel>::NAME;
const CONNECTED: &str = <DevicesConnected as EventChannel>::NAME;

/// Text a request carries that must never reach the audit log.
const PAYLOAD_TEXT: &str = "payload text the audit log never holds";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// A host running in this process on `dirs`' folders, at the endpoint
/// `floti devices` finds from them, whose one backend is the fake agent.
struct World {
    host: RunningHost,
    agent: FakeAgent,
    endpoint: Endpoint,
    dirs: TestDirs,
}

impl World {
    fn start() -> Self {
        let dirs = TestDirs::new();
        let agent = fake_agent!(&dirs);
        let endpoint = local_endpoint(&dirs.folders());
        let host = start_host(&dirs, &agent, &endpoint);
        Self {
            host,
            agent,
            endpoint,
            dirs,
        }
    }

    /// The host stopped and started again on the same folders.
    async fn restart(self) -> Self {
        self.host.stop(HostStopReason::Stop).await;
        let host = start_host(&self.dirs, &self.agent, &self.endpoint);
        Self { host, ..self }
    }

    /// The testkit's device, an admin, on this computer.
    async fn admin(&self) -> TestClient {
        TestClient::connect(&self.endpoint, TERMINAL).await
    }

    /// A new device paired as `name` with `role`, and its connection on
    /// this computer.
    async fn local(&self, name: &str, role: Role) -> (KeyPair, TestClient) {
        let device = TestClient::pair_device(&self.endpoint, name, role);
        let client = TestClient::connect_device(&self.endpoint, &device, TERMINAL).await;
        (device, client)
    }

    /// A new device paired as `name` with `role`, and its connection from
    /// another computer.
    async fn away(&self, name: &str, role: Role) -> (KeyPair, TestClient) {
        let device = TestClient::pair_device(&self.endpoint, name, role);
        let client = TestClient::connect_device_away(&self.endpoint, &device, TERMINAL).await;
        (device, client)
    }

    /// `floti devices` with `args`, run to its end as a shell on the host's
    /// computer would.
    async fn devices(&self, args: &[&str]) -> std::process::Output {
        let mut command = self.dirs.floti_command(env!("CARGO_BIN_EXE_floti"));
        command.arg("devices").args(args);
        run_floti(command).await
    }

    fn audit_text(&self) -> String {
        std::fs::read_to_string(self.dirs.data.join(AUDIT_FILE)).unwrap_or_default()
    }

    async fn stop(self) {
        self.host.stop(HostStopReason::Stop).await;
        drop(self.agent);
        drop(self.dirs);
    }
}

fn start_host(dirs: &TestDirs, agent: &FakeAgent, endpoint: &Endpoint) -> RunningHost {
    RunningHost::start(HostConfig {
        run: Default::default(),
        folders: dirs.folders(),
        endpoint: endpoint.clone(),
        backends: vec![Arc::new(agent.backend(Vec::<&str>::new())) as Arc<dyn AgentBackend>],
        inherited_env: std::env::vars_os().collect(),
    })
}

fn start_request(folder: &std::path::Path) -> StartSessionRequest {
    StartSessionRequest {
        cwd: folder.to_string_lossy().into_owned(),
        cols: 80,
        rows: 24,
        ..StartSessionRequest::default()
    }
}

fn refused<T: std::fmt::Debug>(answer: Result<T, ErrorReply>, what: &str) -> ErrorReply {
    match answer {
        Ok(answered) => panic!("{what} was answered: {answered:?}"),
        Err(refusal) => refusal,
    }
}

fn stdout(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// Who is attached, as `client`'s subscription `subscription` to
/// `devices:attached` starts.
async fn attached_snapshot(client: &mut TestClient, subscription: u64) -> AttachedDevices {
    match client.subscribe_on(subscription, ATTACHED).await {
        Message::Snapshot(snapshot) => {
            from_payload(&snapshot.state).expect("decode who is attached")
        }
        other => panic!("`{ATTACHED}` was not started with a snapshot: {other:?}"),
    }
}

/// Subscribes `client` to `devices:connected` as `subscription`, in place
/// once this returns: a request answered after it was read.
async fn told_of_connections(client: &mut TestClient, subscription: u64) {
    client.subscribe_quietly(subscription, CONNECTED).await;
    client.request::<SessionList>(&()).await.unwrap();
}

/// `state`'s devices as (name, role, away, connections).
fn rows(state: &AttachedDevices) -> Vec<(String, DeviceRole, bool, u32)> {
    let mut rows: Vec<_> = state
        .devices
        .iter()
        .map(|device| {
            (
                device.name.clone(),
                device.role,
                device.away,
                device.connections,
            )
        })
        .collect();
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    rows
}

fn row(
    name: &str,
    role: DeviceRole,
    away: bool,
    connections: u32,
) -> (String, DeviceRole, bool, u32) {
    (name.to_owned(), role, away, connections)
}

/// The next `devices:attached` update on `subscription` that `wanted`
/// accepts.
async fn attached_update(
    client: &mut TestClient,
    subscription: u64,
    what: &str,
    wanted: impl Fn(&AttachedDevices) -> bool,
) -> AttachedDevices {
    client.event_on(subscription, what, wanted).await
}

/// Every audit entry, newest first, read a page at a time as `client`.
async fn audit_entries(
    client: &mut TestClient,
) -> Vec<floti_protocol::channels::devices::AuditEntry> {
    let mut entries = Vec::new();
    let mut before = None;
    loop {
        let page: AuditPage = client
            .request::<DevicesAudit>(&AuditQuery {
                before,
                limit: Some(200),
            })
            .await
            .expect("an admin reads the audit log");
        before = page.entries.last().map(|entry| entry.number);
        entries.extend(page.entries);
        if !page.more {
            return entries;
        }
    }
}

/// The audit log's events, oldest first.
async fn audit_events(client: &mut TestClient) -> Vec<AuditEvent> {
    let mut events: Vec<_> = audit_entries(client)
        .await
        .into_iter()
        .map(|entry| entry.event)
        .collect();
    events.reverse();
    events
}

/// Waits, bounded by [`PATIENCE`], until `client`'s audit log holds an
/// event `wanted` accepts: for an entry a closing connection writes after
/// the test has moved on.
async fn until_audited(client: &mut TestClient, what: &str, wanted: impl Fn(&AuditEvent) -> bool) {
    let deadline = Instant::now() + PATIENCE;
    loop {
        if audit_events(client).await.iter().any(&wanted) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "no {what} in the audit log within {PATIENCE:?}"
        );
        tokio::task::yield_now().await;
    }
}

fn actor_named(by: &AuditActor, name: &str) -> bool {
    matches!(by, AuditActor::Device { name: said, .. } if said == name)
}

// ---------------------------------------------------------------------------
// S1, S2, S4: who is attached, and who is told
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s1_s4_every_role_sees_who_is_attached_and_each_new_device_is_told_to_the_others_only() {
    let world = World::start();
    let mut admin = world.admin().await;
    let here = attached_snapshot(&mut admin, 1).await;
    assert_eq!(
        rows(&here),
        [row(TEST_DEVICE_NAME, DeviceRole::Admin, false, 1)]
    );
    // Nothing in it is a key or a code: its fields are these and no others.
    let value = serde_json::to_value(&here).unwrap();
    let mut fields: Vec<_> = value["devices"][0]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    fields.sort();
    assert_eq!(
        fields,
        [
            "away",
            "connections",
            "fingerprint",
            "name",
            "role",
            "since"
        ]
    );
    assert!(!value.to_string().contains(&test_device_key().to_hex()));
    told_of_connections(&mut admin, 2).await;

    let (_, mut viewer) = world.local("a viewer tablet", Role::Viewer).await;
    let told = admin
        .event_on::<DeviceConnected>(2, "the viewer told", |_| true)
        .await;
    assert_eq!(
        (told.name.as_str(), told.role, told.away),
        ("a viewer tablet", DeviceRole::Viewer, false)
    );
    // A viewer sees who is attached too, itself among them.
    let seen = attached_snapshot(&mut viewer, 1).await;
    assert_eq!(
        rows(&seen),
        [
            row("a viewer tablet", DeviceRole::Viewer, false, 1),
            row(TEST_DEVICE_NAME, DeviceRole::Admin, false, 1),
        ]
    );
    told_of_connections(&mut viewer, 2).await;

    // An operator from another computer, with two connections: told once.
    let operator = TestClient::pair_device(&world.endpoint, "an away laptop", Role::Operator);
    let mut first = TestClient::connect_device_away(&world.endpoint, &operator, TERMINAL).await;
    for client in [&mut admin, &mut viewer] {
        let told = client
            .event_on::<DeviceConnected>(2, "the operator told", |_| true)
            .await;
        assert_eq!(
            (told.name.as_str(), told.role, told.away),
            ("an away laptop", DeviceRole::Operator, true)
        );
        assert_eq!(told.fingerprint, operator.public().fingerprint());
    }
    told_of_connections(&mut first, 2).await;
    let _second = TestClient::connect_device_away(&world.endpoint, &operator, &[]).await;
    let both = attached_update(&mut admin, 1, "the operator's second connection", |state| {
        state.devices.iter().any(|device| device.connections == 2)
    })
    .await;
    assert_eq!(
        rows(&both),
        [
            row("a viewer tablet", DeviceRole::Viewer, false, 1),
            row("an away laptop", DeviceRole::Operator, true, 2),
            row(TEST_DEVICE_NAME, DeviceRole::Admin, false, 1),
        ]
    );

    // `floti devices` marks who is attached now; the shell is not a device.
    let listed = world.devices(&[]).await;
    assert!(listed.status.success(), "{}", stderr(&listed));
    let printed = stdout(&listed);
    let line = |name: &str| {
        printed
            .lines()
            .find(|line| line.contains(&format!("\"{name}\"")))
            .unwrap_or_else(|| panic!("{name} is not listed: {printed}"))
            .to_owned()
    };
    assert!(
        line("an away laptop").contains(", from another computer, 2 connections"),
        "{printed}"
    );
    assert!(
        line(TEST_DEVICE_NAME).contains(", on this computer, 1 connection"),
        "{printed}"
    );
    assert!(
        line(TEST_DEVICE_NAME).contains("attached since "),
        "{printed}"
    );

    // A barrier: a device attaching after the operator's second connection.
    // The next device each client is told of is it, never the operator again
    // and never the device itself.
    let (_, _late) = world.local("a late phone", Role::Viewer).await;
    for client in [&mut admin, &mut viewer, &mut first] {
        let told = client
            .event_on::<DeviceConnected>(2, "the late phone told", |_| true)
            .await;
        assert_eq!(told.name, "a late phone");
    }
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s2_the_attached_list_changes_on_attach_role_change_detach_and_revoke() {
    let world = World::start();
    let mut admin = world.admin().await;
    attached_snapshot(&mut admin, 1).await;

    let (phone, phone_client) = world.local("a phone", Role::Operator).await;
    attached_update(&mut admin, 1, "the phone attached", |state| {
        state.devices.iter().any(|device| device.name == "a phone")
    })
    .await;

    admin
        .request::<DevicesRole>(&ChangeDeviceRole {
            fingerprint: phone.public().fingerprint(),
            role: DeviceRole::Viewer,
        })
        .await
        .expect("an admin changes a role");
    attached_update(&mut admin, 1, "the phone a viewer", |state| {
        state
            .devices
            .iter()
            .any(|device| device.name == "a phone" && device.role == DeviceRole::Viewer)
    })
    .await;

    drop(phone_client);
    let gone = attached_update(&mut admin, 1, "the phone detached", |state| {
        state.devices.iter().all(|device| device.name != "a phone")
    })
    .await;
    assert_eq!(
        rows(&gone),
        [row(TEST_DEVICE_NAME, DeviceRole::Admin, false, 1)]
    );

    let (tablet, _tablet_client) = world.local("a tablet", Role::Viewer).await;
    attached_update(&mut admin, 1, "the tablet attached", |state| {
        state.devices.iter().any(|device| device.name == "a tablet")
    })
    .await;
    admin
        .request::<DevicesRevoke>(&RevokeDevice {
            fingerprint: tablet.public().fingerprint(),
        })
        .await
        .expect("an admin revokes");
    attached_update(&mut admin, 1, "the tablet revoked", |state| {
        state.devices.iter().all(|device| device.name != "a tablet")
    })
    .await;
    world.stop().await;
}

// ---------------------------------------------------------------------------
// S6: the host's notification
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s6_a_device_attaching_from_another_computer_is_shown_on_the_host_and_one_here_is_not() {
    let world = World::start();
    let _admin = world.admin().await;
    let (_, _here) = world.local("a laptop here", Role::Admin).await;
    let (_, _away) = world.away("Cole's\u{1b}[2J phone", Role::Operator).await;
    let deadline = Instant::now() + PATIENCE;
    let notices = loop {
        let notices = recorded_notices(&world.dirs.data);
        if !notices.is_empty() {
            break notices;
        }
        assert!(Instant::now() < deadline, "no notice within {PATIENCE:?}");
        tokio::task::yield_now().await;
    };
    // A barrier: a second away device's notice comes after the first.
    let (_, _later) = world.away("a later tablet", Role::Viewer).await;
    let deadline = Instant::now() + PATIENCE;
    let notices = loop {
        let now = recorded_notices(&world.dirs.data);
        if now.len() > notices.len() {
            break now;
        }
        assert!(
            Instant::now() < deadline,
            "no second notice within {PATIENCE:?}"
        );
        tokio::task::yield_now().await;
    };
    assert_eq!(
        notices
            .iter()
            .map(|notice| (notice.title.as_str(), notice.body.as_str()))
            .collect::<Vec<_>>(),
        [
            (
                "\"Cole's[2J phone\" connected from another computer",
                "It is paired as an operator with this computer's Floti host."
            ),
            (
                "\"a later tablet\" connected from another computer",
                "It is paired as a viewer with this computer's Floti host."
            ),
        ]
    );
    world.stop().await;
}

// ---------------------------------------------------------------------------
// S10: role changes
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s10_a_role_change_holds_for_the_devices_open_connections_at_once() {
    let world = World::start();
    let project = world.dirs.folder("a project");
    let mut admin = world.admin().await;
    let session = admin
        .request::<SessionStart>(&start_request(&project))
        .await
        .unwrap();
    let (device, mut worker) = world.local("a laptop", Role::Operator).await;
    worker.attach(1, session.id).await;
    worker.type_into(1, b"typed as an operator\r").await;
    worker
        .read_stream_until(1, |bytes| {
            String::from_utf8_lossy(bytes).contains("echo: typed as an operator")
        })
        .await;

    let made = admin
        .request::<DevicesRole>(&ChangeDeviceRole {
            fingerprint: device.public().fingerprint(),
            role: DeviceRole::Viewer,
        })
        .await
        .unwrap();
    assert_eq!(made.role, DeviceRole::Viewer);
    // The same connection, from its next message: refused as a viewer, and
    // its keys dropped.
    let refusal = refused(
        worker
            .request::<SessionStart>(&start_request(&project))
            .await,
        "a viewer starting a session",
    );
    assert_eq!(refusal.code, ErrorCode::NotPermitted, "{refusal:?}");
    assert!(
        refusal
            .message
            .ends_with("this device is paired as a viewer."),
        "{refusal:?}"
    );
    worker.type_into(1, b"typed as a viewer\r").await;
    admin.attach(1, session.id).await;
    admin.type_into(1, b"typed by the admin\r").await;
    let seen = worker
        .read_stream_until(1, |bytes| {
            String::from_utf8_lossy(bytes).contains("echo: typed by the admin")
        })
        .await;
    assert!(
        !String::from_utf8_lossy(&seen).contains("echo: typed as a viewer"),
        "a viewer's keys reached the session"
    );

    // Made an admin, the same connection lists devices.
    admin
        .request::<DevicesRole>(&ChangeDeviceRole {
            fingerprint: device.public().fingerprint(),
            role: DeviceRole::Admin,
        })
        .await
        .unwrap();
    worker
        .request::<DevicesList>(&())
        .await
        .expect("an admin now");
    // From the shell too.
    let made = world
        .devices(&["role", &device.public().fingerprint(), "operator"])
        .await;
    assert!(made.status.success(), "{}", stderr(&made));
    assert_eq!(
        stdout(&made),
        format!(
            "\"a laptop\" ({}) is an operator now.\n",
            device.public().fingerprint()
        )
    );
    let refusal = refused(
        worker.request::<DevicesList>(&()).await,
        "an operator listing",
    );
    assert!(
        refusal
            .message
            .ends_with("this device is paired as an operator."),
        "{refusal:?}"
    );
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s10_a_role_change_is_refused_for_an_unknown_or_revoked_device_the_last_admin_and_any_role_but_admin()
 {
    let world = World::start();
    let mut admin = world.admin().await;
    let own = test_device_key().fingerprint();

    let last = refused(
        admin
            .request::<DevicesRole>(&ChangeDeviceRole {
                fingerprint: own.clone(),
                role: DeviceRole::Operator,
            })
            .await,
        "the last admin made an operator",
    );
    assert!(
        last.message.contains("a host keeps at least one admin"),
        "{last:?}"
    );
    let unknown = refused(
        admin
            .request::<DevicesRole>(&ChangeDeviceRole {
                fingerprint: "00000000000000000000".to_owned(),
                role: DeviceRole::Viewer,
            })
            .await,
        "an unknown fingerprint",
    );
    assert!(
        unknown.message.starts_with("No device paired"),
        "{unknown:?}"
    );
    let (gone, _) = world.local("a lost phone", Role::Operator).await;
    admin
        .request::<DevicesRevoke>(&RevokeDevice {
            fingerprint: gone.public().fingerprint(),
        })
        .await
        .unwrap();
    let revoked = refused(
        admin
            .request::<DevicesRole>(&ChangeDeviceRole {
                fingerprint: gone.public().fingerprint(),
                role: DeviceRole::Admin,
            })
            .await,
        "a revoked device",
    );
    assert!(revoked.message.contains("is revoked"), "{revoked:?}");
    let shell = world.devices(&["role", &own, "viewer"]).await;
    assert!(!shell.status.success());
    assert!(
        stderr(&shell).contains("a host keeps at least one admin"),
        "{}",
        stderr(&shell)
    );

    // An operator is refused, naming its role; an admin away needs presence.
    let (_, mut operator) = world.local("an operator", Role::Operator).await;
    let refusal = refused(
        operator
            .request::<DevicesRole>(&ChangeDeviceRole {
                fingerprint: own.clone(),
                role: DeviceRole::Viewer,
            })
            .await,
        "an operator changing a role",
    );
    assert_eq!(
        refusal.message,
        "Changing a device's role takes an admin device, and this device is paired as an operator."
    );
    let (_, mut far) = world.away("an admin far away", Role::Admin).await;
    let change = ChangeDeviceRole {
        fingerprint: own.clone(),
        role: DeviceRole::Viewer,
    };
    let refusal = refused(far.request::<DevicesRole>(&change).await, "no presence");
    assert_eq!(refusal.code, ErrorCode::PresenceNeeded, "{refusal:?}");
    far.request::<DevicesPresence>(&()).await.unwrap();
    // With a second admin, the first may be made a viewer.
    far.request::<DevicesRole>(&change).await.expect("present");
    world.stop().await;
}

// ---------------------------------------------------------------------------
// S7 to S13: the audit log
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s7_to_s12_the_audit_log_records_each_kind_by_name_and_no_requests_contents() {
    let world = World::start();
    let mut admin = world.admin().await;
    let admin_fingerprint = test_device_key().fingerprint();

    // S8: a key no device has is refused, and recorded by its fingerprint.
    let stranger = KeyPair::generate().unwrap();
    let host = host_public_key(&world.dirs.data).unwrap().unwrap();
    // Refused in the handshake, or closed before its hello is answered.
    if let Ok(connection) = client::connect(&world.endpoint, &stranger, &host).await {
        connection.close().await;
    }
    until_audited(&mut admin, "the stranger refused", |event| {
        matches!(event, AuditEvent::Refused { fingerprint: Some(fingerprint), .. }
            if *fingerprint == stranger.public().fingerprint())
    })
    .await;

    // S9: asked, approved by the shell with a role; and one withdrawn.
    let mut keys = ClientKeys::open(&world.dirs.folder("a phone keys")).unwrap();
    let request =
        TestClient::ask_to_pair(&keys, &world.endpoint, "a phone", ClientKind::Phone).await;
    let code = request.code().to_owned();
    let approved = world
        .devices(&["approve", &code, "--role", "operator"])
        .await;
    assert!(approved.status.success(), "{}", stderr(&approved));
    assert_eq!(
        keys.finish_pairing(request).await.unwrap(),
        PairingOutcome::Approved(DeviceRole::Operator)
    );
    let quitter = ClientKeys::open(&world.dirs.folder("a quitter keys")).unwrap();
    let withdrawn =
        TestClient::ask_to_pair(&quitter, &world.endpoint, "a quitter", ClientKind::Phone).await;
    let withdrawn_code = withdrawn.code().to_owned();
    drop(withdrawn);
    until_audited(&mut admin, "a withdrawn request", |event| {
        matches!(event, AuditEvent::PairingEnded { device, why: PairingEnd::Withdrawn }
            if device.name.as_deref() == Some("a quitter"))
    })
    .await;

    // S7: an away device attaches and detaches.
    let (away_key, mut away) = world.away("an away admin", Role::Admin).await;
    // S12: refused for presence, with text in its request.
    let refusal = refused(
        away.request_on(
            "roots:remove",
            to_payload(&serde_json::json!({ "path": PAYLOAD_TEXT })).unwrap(),
        )
        .await,
        "an away admin without presence",
    );
    assert_eq!(refusal.code, ErrorCode::PresenceNeeded);
    // S11: presence confirmed, then an admin action done.
    away.request::<DevicesPresence>(&()).await.unwrap();
    away.request::<CarryStatusRead>(&()).await.unwrap();
    drop(away);

    // S12: refused for its role, with text in its request.
    let (operator_key, mut operator) = world.local("an operator", Role::Operator).await;
    let refusal = refused(
        operator
            .request_on(
                "settings:write",
                to_payload(&serde_json::json!({ "anything": PAYLOAD_TEXT })).unwrap(),
            )
            .await,
        "an operator writing settings",
    );
    assert_eq!(refusal.code, ErrorCode::NotPermitted);

    // S10: a role change, by an admin device on this computer.
    admin
        .request::<DevicesRole>(&ChangeDeviceRole {
            fingerprint: operator_key.public().fingerprint(),
            role: DeviceRole::Viewer,
        })
        .await
        .unwrap();
    // S11: a revoke, by the shell.
    let revoked = world
        .devices(&["revoke", &operator_key.public().fingerprint()])
        .await;
    assert!(revoked.status.success(), "{}", stderr(&revoked));
    assert!(operator.wait_closed(PATIENCE).await);

    until_audited(&mut admin, "the away admin detached", |event| {
        matches!(event, AuditEvent::Disconnected { device, away: true }
            if device.name.as_deref() == Some("an away admin"))
    })
    .await;

    // Listing devices and reading the log add nothing.
    let before = audit_entries(&mut admin).await[0].number;
    admin.request::<DevicesList>(&()).await.unwrap();
    let after = audit_entries(&mut admin).await[0].number;
    assert_eq!(before, after, "reading added an entry");

    let events = audit_events(&mut admin).await;
    let has = |what: &str, wanted: &dyn Fn(&AuditEvent) -> bool| {
        assert!(events.iter().any(wanted), "no {what} in {events:#?}");
    };
    has("attach of the admin", &|event| {
        matches!(event, AuditEvent::Connected { device, away: false }
            if device.fingerprint == admin_fingerprint
                && device.name.as_deref() == Some(TEST_DEVICE_NAME)
                && device.role == Some(DeviceRole::Admin))
    });
    has("refused stranger", &|event| {
        matches!(event, AuditEvent::Refused { reason, fingerprint: Some(fingerprint), away: false }
            if reason == "An unknown key" && *fingerprint == stranger.public().fingerprint())
    });
    has("pairing asked", &|event| {
        matches!(event, AuditEvent::PairingAsked { device, away: false }
            if device.name.as_deref() == Some("a phone") && device.role.is_none())
    });
    has("pairing approved by the shell", &|event| {
        matches!(event, AuditEvent::PairingApproved { device, by: AuditActor::HostShell, away: false }
            if device.name.as_deref() == Some("a phone")
                && device.role == Some(DeviceRole::Operator)
                && device.fingerprint == keys.device_key().fingerprint())
    });
    has("away attach", &|event| {
        matches!(event, AuditEvent::Connected { device, away: true }
            if device.fingerprint == away_key.public().fingerprint())
    });
    has("refused for presence", &|event| {
        matches!(event, AuditEvent::AdminAction { channel, doing, by, away: true, outcome: AdminOutcome::RefusedForPresence }
            if channel == "roots:remove" && doing == "Changing the host's scan roots" && actor_named(by, "an away admin"))
    });
    has("presence confirmed", &|event| {
        matches!(event, AuditEvent::PresenceConfirmed { device, away: true }
            if device.name.as_deref() == Some("an away admin"))
    });
    has("admin action done", &|event| {
        matches!(event, AuditEvent::AdminAction { channel, outcome: AdminOutcome::Done, away: true, by, .. }
            if channel == "carry:status" && actor_named(by, "an away admin"))
    });
    has("refused for role", &|event| {
        matches!(event, AuditEvent::AdminAction { channel, by, away: false, outcome: AdminOutcome::RefusedForRole, .. }
            if channel == "settings:write" && actor_named(by, "an operator"))
    });
    has("role change", &|event| {
        matches!(event, AuditEvent::RoleChanged { device, from: DeviceRole::Operator, to: DeviceRole::Viewer, by, away: false }
            if device.name.as_deref() == Some("an operator") && actor_named(by, TEST_DEVICE_NAME))
    });
    has("revoke by the shell", &|event| {
        matches!(event, AuditEvent::Revoked { device, by: AuditActor::HostShell, .. }
            if device.fingerprint == operator_key.public().fingerprint())
    });
    // The handlers that record their own entry add no admin action for it,
    // and reading adds none at all.
    assert!(
        !events.iter().any(|event| matches!(event,
            AuditEvent::AdminAction { channel, .. }
                if ["devices:role", "devices:revoke", "devices:approve", "devices:list", "devices:audit"]
                    .contains(&channel.as_str()))),
        "{events:#?}"
    );

    // No request's contents, no code, no key.
    let text = world.audit_text();
    assert!(
        !text.contains(PAYLOAD_TEXT),
        "a request's contents were recorded"
    );
    for code in [&code, &withdrawn_code] {
        assert!(!text.contains(code.as_str()), "a pairing code was recorded");
    }
    for key in [
        test_device_key().to_hex(),
        stranger.public().to_hex(),
        away_key.public().to_hex(),
    ] {
        assert!(!text.contains(&key), "a key was recorded");
    }
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s13_the_audit_log_is_owner_only_kept_across_a_restart_and_read_newest_first_by_admins_only()
 {
    let world = World::start();
    let admin = world.admin().await;
    drop(admin);
    let world = world.restart().await;
    let mut admin = world.admin().await;
    let entries = audit_entries(&mut admin).await;
    let numbers: Vec<u64> = entries.iter().map(|entry| entry.number).collect();
    // Newest first, numbered on from before the restart with no gap.
    assert_eq!(
        numbers,
        (1..=numbers.len() as u64).rev().collect::<Vec<_>>()
    );
    assert!(numbers.len() >= 2, "{entries:#?}");
    assert!(matches!(
        entries.last().map(|entry| &entry.event),
        Some(AuditEvent::Connected { .. })
    ));
    assert!(
        NativeFiles
            .owner_only(&world.dirs.data.join(AUDIT_FILE))
            .unwrap()
    );

    // A page, then the rest from before it.
    let first = admin
        .request::<DevicesAudit>(&AuditQuery {
            before: None,
            limit: Some(1),
        })
        .await
        .unwrap();
    assert_eq!(first.entries.len(), 1);
    assert!(first.more);
    let rest = admin
        .request::<DevicesAudit>(&AuditQuery {
            before: Some(first.entries[0].number),
            limit: Some(200),
        })
        .await
        .unwrap();
    assert_eq!(rest.entries[0].number, first.entries[0].number - 1);
    assert!(!rest.more);

    // `floti devices audit` prints the same, newest first.
    let printed = world.devices(&["audit"]).await;
    assert!(printed.status.success(), "{}", stderr(&printed));
    let lines: Vec<u64> = stdout(&printed)
        .lines()
        .map(|line| line.split_whitespace().next().unwrap().parse().unwrap())
        .collect();
    assert_eq!(lines[0], numbers[0]);
    assert!(lines.windows(2).all(|pair| pair[0] > pair[1]), "{lines:?}");

    // A viewer and an operator are refused, naming their role.
    for (role, said) in [(Role::Viewer, "a viewer"), (Role::Operator, "an operator")] {
        let (_, mut device) = world.local(&format!("{said} device"), role).await;
        let refusal = refused(
            device.request::<DevicesAudit>(&AuditQuery::default()).await,
            "reading the audit log",
        );
        assert_eq!(
            refusal.message,
            format!(
                "Reading the audit log takes an admin device, and this device is paired as {said}."
            )
        );
    }
    world.stop().await;
}
