//! Roles, presence and revoking against a real host: what a viewer, an
//! operator and an admin device are each answered and refused, presence for
//! an admin on another computer (through the relay endpoint `floti connect`
//! opens), revoking a device from an admin device and from `floti devices
//! revoke`, and pairing in one step through a transport.
//!
//! Presence's five minutes are crossed by stepping the host's clock (a
//! marker in its data folder, read at every check); no test waits them out.
//! No test reaches another computer or a real ssh: the fake transports in
//! `test/fake-ssh/` run the line they are given here, in the test's folders.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use floti_host::agent::AgentBackend;
use floti_host::bridge::{CONNECT_LINE, HOST_KEY_LINE, PAIRING_LINE_PREFIX, approve_line};
use floti_host::client::{self, ClientKeys, PINNED_HOST_FILE, PairingOutcome};
use floti_host::devices::{DeviceRegistry, Role};
use floti_host::fake_agent;
use floti_host::platform::socket::Endpoint;
use floti_host::server::{
    HostConfig, PRESENCE_NEEDED, PRESENCE_WINDOW, host_public_key, local_endpoint,
};
use floti_host::testkit::{
    FakeAgent, HostProcess, PATIENCE, RunningHost, TestClient, TestDirs, pair_test_device,
    run_floti,
};
use floti_protocol::channel::to_payload;
use floti_protocol::channels::common::{SessionRecord, SessionStatus};
use floti_protocol::channels::devices::{
    ApproveDevice, DeviceRole, DevicesApprove, DevicesList, DevicesPresence, DevicesRevoke,
    PairedDevice, RevokeDevice,
};
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::sessions::{SessionList, SessionStart, StartSessionRequest};
use floti_protocol::message::{ClientKind, ErrorCode, ErrorReply};
use floti_protocol::noise::KeyPair;
use serde_json::Value;

const TERMINAL: &[&str] = &["terminal"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// A host running in this process on `dirs`' folders, at the endpoint
/// `floti devices` and `floti connect` find from them, whose one backend is
/// the fake agent answering each line it reads.
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
        let host = RunningHost::start(HostConfig {
            run: Default::default(),
            folders: dirs.folders(),
            endpoint: endpoint.clone(),
            backends: vec![Arc::new(agent.backend(Vec::<&str>::new())) as Arc<dyn AgentBackend>],
            inherited_env: std::env::vars_os().collect(),
        });
        Self {
            host,
            agent,
            endpoint,
            dirs,
        }
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
    /// another computer, through the relay endpoint.
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

    async fn stop(self) {
        self.host.stop(HostStopReason::Stop).await;
        drop(self.agent);
        drop(self.dirs);
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

/// The refusal `answer` is, failing the test when it was answered.
fn refused<T: std::fmt::Debug>(answer: Result<T, ErrorReply>, what: &str) -> ErrorReply {
    match answer {
        Ok(answered) => panic!("{what} was answered: {answered:?}"),
        Err(refusal) => refusal,
    }
}

/// Asserts `refusal` says `doing` takes an admin device or an operator, and
/// what the device is paired as.
fn assert_not_permitted(refusal: &ErrorReply, least: &str, paired_as: &str) {
    assert_eq!(refusal.code, ErrorCode::NotPermitted, "{refusal:?}");
    assert!(
        refusal.message.ends_with(&format!(
            " takes {least}, and this device is paired as {paired_as}."
        )),
        "{refusal:?}"
    );
}

/// Makes a request on `channel` whose payload does not matter: a refusal
/// comes before it is read.
async fn ask(client: &mut TestClient, channel: &str) -> Result<(), ErrorReply> {
    client
        .request_on(channel, to_payload(&()).expect("encode"))
        .await
        .map(drop)
}

fn stdout(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// The device paired with the host over `dirs` with `fingerprint`.
fn registered(dirs: &TestDirs, fingerprint: &str) -> Option<floti_host::devices::Device> {
    DeviceRegistry::in_data_folder(&dirs.data)
        .devices()
        .expect("read the device registry")
        .into_iter()
        .find(|device| device.key.fingerprint() == fingerprint)
}

// ---------------------------------------------------------------------------
// S1, S2, S3: devices from an admin device
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s1_an_admin_device_approves_a_code_with_the_role_chosen_and_neither_answer_nor_log_holds_a_key_or_the_code()
 {
    // The executable, for its log.
    let dirs = TestDirs::new();
    let endpoint = dirs.floti_endpoint();
    pair_test_device(&endpoint, &dirs.data);
    let mut command = dirs.floti_command(env!("CARGO_BIN_EXE_floti"));
    command.arg("host");
    let host = HostProcess::spawn(command);
    let mut admin = TestClient::connect(&endpoint, &[]).await;

    for (name, role) in [
        ("a phone", DeviceRole::Viewer),
        ("a tablet", DeviceRole::Operator),
        ("a laptop", DeviceRole::Admin),
    ] {
        let mut keys = ClientKeys::open(&dirs.folder(name)).unwrap();
        let request = TestClient::ask_to_pair(&keys, &endpoint, name, ClientKind::Desktop).await;
        let code = request.code().to_owned();
        let answer = admin
            .request::<DevicesApprove>(&ApproveDevice {
                code: code.clone(),
                role,
            })
            .await
            .expect("an admin device approves");
        assert_eq!(answer.name, name);
        assert_eq!(answer.role, role);
        assert_eq!(answer.fingerprint, keys.device_key().fingerprint());
        let said = format!("{answer:?}");
        assert!(!said.contains(&code), "{said}");
        assert!(!said.contains(&keys.device_key().to_hex()), "{said}");
        // The device is told, with its role, and pins the host.
        assert_eq!(
            keys.finish_pairing(request).await.unwrap(),
            PairingOutcome::Approved(role)
        );
        assert!(keys.pinned_host().is_some());
        let log = dirs.host_log();
        assert!(!log.contains(&code), "the code is in the host's log");
        assert!(
            !log.contains(&keys.device_key().to_hex()),
            "a key is in the log"
        );
    }
    host.stop(admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s2_an_admin_device_lists_paired_revoked_and_waiting_devices_by_fingerprint_with_no_key_or_code()
 {
    let world = World::start();
    let mut admin = world.admin().await;
    let (tablet, _) = world.local("a tablet", Role::Operator).await;
    let (gone, _) = world.local("a lost phone", Role::Viewer).await;
    admin
        .request::<DevicesRevoke>(&RevokeDevice {
            fingerprint: gone.public().fingerprint(),
        })
        .await
        .expect("revoke the lost phone");
    let keys = ClientKeys::open(&world.dirs.folder("a laptop")).unwrap();
    let request =
        TestClient::ask_to_pair(&keys, &world.endpoint, "a laptop", ClientKind::Desktop).await;

    let listed = admin.request::<DevicesList>(&()).await.unwrap();
    let find = |key: &KeyPair| -> PairedDevice {
        listed
            .paired
            .iter()
            .find(|device| device.fingerprint == key.public().fingerprint())
            .cloned()
            .expect("the device is listed")
    };
    let operator = find(&tablet);
    assert_eq!(
        (operator.name.as_str(), operator.role, operator.revoked_at),
        ("a tablet", DeviceRole::Operator, None)
    );
    assert!(!operator.paired_at.is_empty());
    let revoked = find(&gone);
    assert!(revoked.revoked_at.is_some(), "{revoked:?}");
    let [waiting] = listed.waiting.as_slice() else {
        panic!("one request waits: {listed:?}");
    };
    assert_eq!(waiting.name, "a laptop");
    assert_eq!(waiting.fingerprint, keys.device_key().fingerprint());
    assert!((1..=600).contains(&waiting.seconds_left), "{waiting:?}");
    let said = format!("{listed:?}");
    assert!(!said.contains(request.code()), "{said}");
    for key in [tablet.public(), gone.public(), keys.device_key()] {
        assert!(!said.contains(&key.to_hex()), "{said}");
    }
    drop(request);
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s3_an_operator_or_viewer_is_refused_listing_approving_or_revoking_naming_its_role() {
    let world = World::start();
    let (other, _) = world.local("a desktop", Role::Operator).await;
    let keys = ClientKeys::open(&world.dirs.folder("a laptop")).unwrap();
    let request =
        TestClient::ask_to_pair(&keys, &world.endpoint, "a laptop", ClientKind::Desktop).await;

    for (role, said) in [(Role::Viewer, "a viewer"), (Role::Operator, "an operator")] {
        let (_, mut device) = world.local(&format!("{said} phone"), role).await;
        let listed = refused(device.request::<DevicesList>(&()).await, "listing");
        let approved = refused(
            device
                .request::<DevicesApprove>(&ApproveDevice {
                    code: request.code().to_owned(),
                    role: DeviceRole::Admin,
                })
                .await,
            "approving",
        );
        let revoked = refused(
            device
                .request::<DevicesRevoke>(&RevokeDevice {
                    fingerprint: other.public().fingerprint(),
                })
                .await,
            "revoking another device",
        );
        for refusal in [&listed, &approved, &revoked] {
            assert_not_permitted(refusal, "an admin device", said);
            assert!(
                refusal
                    .message
                    .starts_with("Listing, approving or revoking devices"),
                "{refusal:?}"
            );
        }
    }
    // Nothing was paired or revoked.
    assert!(registered(&world.dirs, &keys.device_key().fingerprint()).is_none());
    let desktop = registered(&world.dirs, &other.public().fingerprint()).unwrap();
    assert_eq!(desktop.revoked_at, None);
    let mut admin = world.admin().await;
    let listed = admin.request::<DevicesList>(&()).await.unwrap();
    assert_eq!(listed.waiting.len(), 1, "{listed:?}");
    drop(request);
    world.stop().await;
}

// ---------------------------------------------------------------------------
// S8, S9, S10: what each role is answered
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s8_a_viewer_sees_sessions_and_screens_and_its_keys_and_changes_are_refused() {
    let world = World::start();
    let project = world.dirs.folder("a project");
    let mut admin = world.admin().await;
    let session = admin
        .request::<SessionStart>(&start_request(&project))
        .await
        .unwrap();

    let (_, mut viewer) = world.local("a viewer phone", Role::Viewer).await;
    assert_eq!(viewer.welcome.role, Some(DeviceRole::Viewer));
    let listed = viewer.request::<SessionList>(&()).await.unwrap();
    assert_eq!(
        listed.iter().map(|row| row.id).collect::<Vec<_>>(),
        [session.id]
    );
    // Its screen, but none of its keys reach the session.
    viewer.attach(1, session.id).await;
    viewer.type_into(1, b"typed by a viewer\r").await;
    admin.attach(1, session.id).await;
    admin.type_into(1, b"typed by an admin\r").await;
    let seen = viewer
        .read_stream_until(1, |bytes| {
            String::from_utf8_lossy(bytes).contains("echo: typed by an admin")
        })
        .await;
    assert!(
        !String::from_utf8_lossy(&seen).contains("echo: typed by a viewer"),
        "a viewer's keys reached the session"
    );

    for (channel, doing) in [
        ("session:start", "Starting, stopping or changing a session"),
        ("session:close", "Starting, stopping or changing a session"),
        ("session:rename", "Starting, stopping or changing a session"),
        ("session:resize", "Starting, stopping or changing a session"),
        (
            "session:restore",
            "Starting, stopping or changing a session",
        ),
        ("history:resume", "Starting, stopping or changing a session"),
        (
            "pterm:open",
            "Opening, resizing or closing a plain terminal",
        ),
        ("content:write", "Writing a note"),
        ("settings:write", "Changing the host's settings"),
    ] {
        let refusal = refused(ask(&mut viewer, channel).await, channel);
        assert_not_permitted(
            &refusal,
            if doing.starts_with("Changing the host") {
                "an admin device"
            } else {
                "an operator or admin device"
            },
            "a viewer",
        );
        assert!(refusal.message.starts_with(doing), "{refusal:?}");
    }
    // Nothing changed: the one session runs, under its own name.
    let after = admin.request::<SessionList>(&()).await.unwrap();
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].name, session.name);
    assert_eq!(after[0].status, SessionStatus::Running);
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s9_an_operator_works_in_sessions_as_an_admin_would_and_is_refused_every_admin_action() {
    let world = World::start();
    let project = world.dirs.folder("a project");
    let (_, mut operator) = world.local("an operator laptop", Role::Operator).await;
    let session = operator
        .request::<SessionStart>(&start_request(&project))
        .await
        .expect("an operator starts a session");
    operator.attach(1, session.id).await;
    operator.type_into(1, b"typed by an operator\r").await;
    operator
        .read_stream_until(1, |bytes| {
            String::from_utf8_lossy(bytes).contains("echo: typed by an operator")
        })
        .await;

    for channel in [
        "devices:list",
        "devices:approve",
        "plugins:add",
        "plugins:setEnabled",
        "secrets:save",
        "settings:write",
        "roots:accept",
        "template:create",
        "config:write",
        "host:stop",
    ] {
        let refusal = refused(ask(&mut operator, channel).await, channel);
        assert_not_permitted(&refusal, "an admin device", "an operator");
    }
    // The host was not stopped and the session runs.
    let listed = operator.request::<SessionList>(&()).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].status, SessionStatus::Running);
    world.stop().await;
}

// ---------------------------------------------------------------------------
// S11, S12: presence
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s11_an_admin_on_another_computer_needs_presence_confirmed_within_five_minutes_on_the_host_clock()
 {
    let world = World::start();
    let (_, mut away) = world.away("a laptop far away", Role::Admin).await;
    assert!(away.welcome.away);
    assert_eq!(away.welcome.role, Some(DeviceRole::Admin));

    let refusal = refused(away.request::<DevicesList>(&()).await, "an admin action");
    assert_eq!(refusal.code, ErrorCode::PresenceNeeded, "{refusal:?}");
    assert_eq!(refusal.message, PRESENCE_NEEDED);
    // What is not an admin action is answered without presence.
    away.request::<SessionList>(&()).await.unwrap();

    away.request::<DevicesPresence>(&()).await.unwrap();
    away.request::<DevicesList>(&()).await.expect("present");
    world
        .dirs
        .step_host_clock(PRESENCE_WINDOW - Duration::from_secs(1));
    away.request::<DevicesList>(&())
        .await
        .expect("still within five minutes");
    world
        .dirs
        .step_host_clock(PRESENCE_WINDOW + Duration::from_secs(1));
    let again = refused(away.request::<DevicesList>(&()).await, "past five minutes");
    assert_eq!(again.code, ErrorCode::PresenceNeeded, "{again:?}");
    away.request::<DevicesPresence>(&()).await.unwrap();
    away.request::<DevicesList>(&())
        .await
        .expect("confirmed anew");
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s12_an_admin_on_the_hosts_computer_and_the_shell_are_never_asked_presence_and_presence_never_raises_a_role()
 {
    let world = World::start();
    let mut local = world.admin().await;
    assert!(!local.welcome.away);
    local
        .request::<DevicesList>(&())
        .await
        .expect("no presence asked");
    let listed = world.devices(&[]).await;
    assert!(listed.status.success(), "{}", stderr(&listed));

    for (role, said) in [(Role::Viewer, "a viewer"), (Role::Operator, "an operator")] {
        let (_, mut away) = world.away(&format!("{said} far away"), role).await;
        away.request::<DevicesPresence>(&()).await.unwrap();
        let refusal = refused(away.request::<DevicesList>(&()).await, "listing");
        assert_not_permitted(&refusal, "an admin device", said);
    }
    world.stop().await;
}

// ---------------------------------------------------------------------------
// S14, S15: revoking
// ---------------------------------------------------------------------------

/// A device's three connections: its window's, a page's, and one holding a
/// session's screen, which it started.
async fn three_connections(world: &World, name: &str) -> (KeyPair, [TestClient; 3], SessionRecord) {
    let device = TestClient::pair_device(&world.endpoint, name, Role::Operator);
    let mut window = TestClient::connect_device(&world.endpoint, &device, TERMINAL).await;
    let page = TestClient::connect_device(&world.endpoint, &device, &[]).await;
    let mut screen = TestClient::connect_device(&world.endpoint, &device, TERMINAL).await;
    let session = window
        .request::<SessionStart>(&start_request(&world.dirs.folder(name)))
        .await
        .unwrap();
    screen.attach(1, session.id).await;
    screen.type_into(1, b"before\r").await;
    screen
        .read_stream_until(1, |bytes| {
            String::from_utf8_lossy(bytes).contains("echo: before")
        })
        .await;
    (device, [window, page, screen], session)
}

/// Asserts every one of `connections` is closed, and `session` still runs.
async fn assert_closed_and_running(
    world: &World,
    connections: &mut [TestClient; 3],
    session: &SessionRecord,
) {
    for connection in connections.iter_mut() {
        assert!(
            connection.wait_closed(PATIENCE).await,
            "a revoked device's connection stayed open"
        );
    }
    let mut admin = world.admin().await;
    let listed = admin.request::<SessionList>(&()).await.unwrap();
    let row = listed
        .iter()
        .find(|row| row.id == session.id)
        .expect("the session is listed");
    assert_eq!(row.status, SessionStatus::Running, "{row:?}");
}

/// Asserts `device` can no longer get in.
async fn assert_shut_out(world: &World, device: &KeyPair) {
    let host = host_public_key(&world.dirs.data).unwrap().unwrap();
    let mut connection = match client::connect(&world.endpoint, device, &host).await {
        Err(_) => return,
        Ok(connection) => connection,
    };
    // Let in by the handshake, it is closed at hello without a byte.
    let _ = connection
        .send(&floti_protocol::Message::Hello(
            floti_protocol::message::Hello {
                protocol: floti_protocol::PROTOCOL_VERSION,
                client: floti_protocol::message::ClientInfo {
                    name: "revoked".to_owned(),
                    kind: ClientKind::Desktop,
                },
                capabilities: Vec::new(),
            },
        ))
        .await;
    assert!(
        !matches!(connection.next().await, Ok(Some(_))),
        "a revoked device was answered"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn s14_an_admin_device_revoking_a_device_closes_every_connection_at_once_and_its_sessions_keep_running()
 {
    let world = World::start();
    let (device, mut connections, session) = three_connections(&world, "a stolen laptop").await;
    let mut admin = world.admin().await;
    let answer = admin
        .request::<DevicesRevoke>(&RevokeDevice {
            fingerprint: device.public().fingerprint(),
        })
        .await
        .expect("an admin device revokes");
    assert_eq!(answer.name, "a stolen laptop");
    assert_eq!(answer.role, DeviceRole::Operator);
    assert!(answer.revoked_at.is_some());
    assert_closed_and_running(&world, &mut connections, &session).await;
    assert_shut_out(&world, &device).await;
    let listed = admin.request::<DevicesList>(&()).await.unwrap();
    let row = listed
        .paired
        .iter()
        .find(|row| row.fingerprint == device.public().fingerprint())
        .unwrap();
    assert!(row.revoked_at.is_some(), "{row:?}");
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s14_floti_devices_revoke_in_a_shell_on_the_host_closes_every_connection_and_prints_the_device()
 {
    let world = World::start();
    let (device, mut connections, session) = three_connections(&world, "a stolen phone").await;
    let fingerprint = device.public().fingerprint();
    let output = world.devices(&["revoke", &fingerprint]).await;
    assert!(output.status.success(), "{}", stderr(&output));
    assert_eq!(
        stdout(&output),
        format!(
            "Revoked \"a stolen phone\" ({fingerprint}), an operator. Its connections are closed; its sessions keep running.\n"
        )
    );
    assert_closed_and_running(&world, &mut connections, &session).await;
    assert_shut_out(&world, &device).await;
    let listed = stdout(&world.devices(&[]).await);
    assert!(listed.contains(&fingerprint), "{listed}");
    assert!(
        registered(&world.dirs, &fingerprint)
            .unwrap()
            .revoked_at
            .is_some()
    );
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s15_revoking_an_unknown_or_already_revoked_fingerprint_fails_saying_so_and_changes_nothing()
 {
    let world = World::start();
    let unknown = KeyPair::generate().unwrap().public().fingerprint();
    let output = world.devices(&["revoke", &unknown]).await;
    assert_eq!(output.status.code(), Some(1), "{}", stderr(&output));
    assert_eq!(
        stderr(&output).trim(),
        format!(
            "floti devices: No device paired with this host has the fingerprint {unknown}; nothing changed."
        )
    );
    assert!(stdout(&output).is_empty());

    let (device, _) = world.local("an old tablet", Role::Viewer).await;
    let fingerprint = device.public().fingerprint();
    assert!(
        world
            .devices(&["revoke", &fingerprint])
            .await
            .status
            .success()
    );
    let before = registered(&world.dirs, &fingerprint).unwrap().revoked_at;
    let again = world.devices(&["revoke", &fingerprint]).await;
    assert_eq!(again.status.code(), Some(1), "{}", stderr(&again));
    assert!(
        stderr(&again).contains("was revoked already")
            && stderr(&again).contains("nothing changed"),
        "{}",
        stderr(&again)
    );
    assert_eq!(
        registered(&world.dirs, &fingerprint).unwrap().revoked_at,
        before
    );
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s15_a_device_of_any_role_revokes_itself_without_presence_and_its_connections_close() {
    let world = World::start();
    for (role, name) in [
        (Role::Viewer, "a viewer far away"),
        (Role::Operator, "an operator far away"),
        (Role::Admin, "an admin far away"),
    ] {
        let (device, mut away) = world.away(name, role).await;
        let mut other = TestClient::connect_device(&world.endpoint, &device, &[]).await;
        let answer = away
            .request::<DevicesRevoke>(&RevokeDevice {
                fingerprint: device.public().fingerprint(),
            })
            .await
            .expect("a device revokes itself with no presence asked");
        assert_eq!(answer.name, name);
        assert!(away.wait_closed(PATIENCE).await);
        assert!(other.wait_closed(PATIENCE).await);
        assert!(
            registered(&world.dirs, &device.public().fingerprint())
                .unwrap()
                .revoked_at
                .is_some()
        );
    }
    world.stop().await;
}

// ---------------------------------------------------------------------------
// S4, S5: pairing in one step through a transport
// ---------------------------------------------------------------------------

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

/// The Node running these tests: the first `node` on `PATH`.
fn node() -> String {
    let path = std::env::var_os("PATH").expect("PATH is set");
    std::env::split_paths(&path)
        .flat_map(|dir| [dir.join("node.exe"), dir.join("node")])
        .find(|candidate| candidate.is_file())
        .expect("the tests run with Node on PATH")
        .to_string_lossy()
        .into_owned()
}

fn fake(file: &str) -> String {
    repo_root()
        .join("test")
        .join("fake-ssh")
        .join(file)
        .to_string_lossy()
        .into_owned()
}

/// `node ssh.mjs -o BatchMode=yes <target>`.
fn ssh() -> Vec<String> {
    vec![
        node(),
        fake("ssh.mjs"),
        "-o".to_owned(),
        "BatchMode=yes".to_owned(),
        "me@build box".to_owned(),
    ]
}

/// `node carry.mjs --via "a pipe"`, a command of the user's choosing.
fn custom() -> Vec<String> {
    vec![
        node(),
        fake("carry.mjs"),
        "--via".to_owned(),
        "a pipe".to_owned(),
    ]
}

fn transport_log(dirs: &TestDirs) -> PathBuf {
    dirs.root().join("transport runs.jsonl")
}

/// The line and argv of every run of a fake transport, in order.
fn transport_runs(dirs: &TestDirs) -> Vec<Value> {
    std::fs::read_to_string(transport_log(dirs))
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).expect("a transport run record"))
        .collect()
}

/// A running `floti bridge <folder> --pair <name> --approve <role> --
/// <transport>`, its standard error kept as it comes. Dropping it closes its
/// standard input, which ends it.
struct Pairing {
    child: Child,
    stdin: Option<std::process::ChildStdin>,
    stderr: Arc<Mutex<String>>,
}

impl Pairing {
    fn spawn(
        world: &World,
        folder: &Path,
        role: &str,
        transport: &[String],
        env: &[(&str, &str)],
    ) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_floti"));
        let dirs = &world.dirs;
        command
            .env(floti_host::platform::folders::DATA_DIR_VAR, &dirs.data)
            .env(floti_host::platform::folders::LOG_DIR_VAR, &dirs.logs)
            .env(floti_host::platform::folders::CONFIG_DIR_VAR, &dirs.config)
            .env(
                floti_host::platform::folders::RUNTIME_DIR_VAR,
                &dirs.runtime,
            )
            .env("HOME", &dirs.home)
            .env("USERPROFILE", &dirs.home)
            .env("FAKE_SSH_FLOTI", env!("CARGO_BIN_EXE_floti"))
            .env("FAKE_SSH_LOG", transport_log(dirs))
            .env_remove("FAKE_SSH_FAIL")
            .env_remove("FAKE_SSH_MISSING_LINE")
            .envs(env.iter().copied())
            .arg("bridge")
            .arg(folder)
            .args(["--pair", "a laptop", "--approve", role, "--"])
            .args(transport)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let mut child = command.spawn().expect("run floti bridge");
        let stdin = child.stdin.take();
        let mut err = child.stderr.take().expect("the bridge's stderr");
        let stderr = Arc::new(Mutex::new(String::new()));
        let said = Arc::clone(&stderr);
        std::thread::spawn(move || {
            let mut buf = [0; 4096];
            while let Ok(n @ 1..) = err.read(&mut buf) {
                said.lock()
                    .unwrap()
                    .push_str(&String::from_utf8_lossy(&buf[..n]));
            }
        });
        Self {
            child,
            stdin,
            stderr,
        }
    }

    /// Its standard error once `done` accepts it.
    async fn said_until(&self, done: impl Fn(&str) -> bool) -> String {
        let deadline = Instant::now() + PATIENCE;
        loop {
            let said = self.stderr.lock().unwrap().clone();
            if done(&said) {
                return said;
            }
            assert!(
                Instant::now() < deadline,
                "the bridge did not say what was expected within {PATIENCE:?}: {said:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Closes its standard input and waits for it to exit.
    async fn ended(mut self) -> Option<i32> {
        self.stdin = None;
        let deadline = Instant::now() + PATIENCE;
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status.code();
            }
            assert!(Instant::now() < deadline, "the bridge did not exit");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

impl Drop for Pairing {
    fn drop(&mut self) {
        self.stdin = None;
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Waits until `folder`'s device is paired with the host over `dirs`.
async fn until_paired(dirs: &TestDirs, folder: &Path) -> floti_host::devices::Device {
    let fingerprint = ClientKeys::open(folder).unwrap().device_key().fingerprint();
    let deadline = Instant::now() + PATIENCE;
    loop {
        if let Some(device) = registered(dirs, &fingerprint)
            && folder.join(PINNED_HOST_FILE).exists()
        {
            return device;
        }
        assert!(Instant::now() < deadline, "the device was not paired");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// The code on the bridge's code line in `said`.
fn code_in(said: &str) -> String {
    let line = said
        .lines()
        .find(|line| line.starts_with(PAIRING_LINE_PREFIX))
        .expect("the code line");
    line[PAIRING_LINE_PREFIX.len()..]
        .split(',')
        .next()
        .unwrap()
        .to_owned()
}

#[tokio::test(flavor = "multi_thread")]
async fn s4_a_device_pairs_in_one_step_through_ssh_or_a_custom_command_with_the_code_in_no_command_line()
 {
    let world = World::start();
    for (transport, role, expected) in [
        (ssh(), "admin", Role::Admin),
        (custom(), "operator", Role::Operator),
    ] {
        let folder = world.dirs.root().join(format!("a laptop {role}"));
        let pairing = Pairing::spawn(&world, &folder, role, &transport, &[]);
        let paired = until_paired(&world.dirs, &folder).await;
        assert_eq!(paired.name, "a laptop");
        assert_eq!(paired.role, expected);
        let said = pairing
            .said_until(|said| said.contains(PAIRING_LINE_PREFIX))
            .await;
        let code = code_in(&said);
        assert_eq!(pairing.ended().await, Some(0));

        // Through the transport: the key, the request, the approval with the
        // role chosen, then itself. The code is in no command line.
        let runs = transport_runs(&world.dirs);
        let lines: Vec<&str> = runs
            .iter()
            .map(|run| run["line"].as_str().unwrap())
            .collect();
        let approve = approve_line(match expected {
            Role::Admin => DeviceRole::Admin,
            _ => DeviceRole::Operator,
        });
        assert_eq!(
            lines,
            [HOST_KEY_LINE, CONNECT_LINE, approve.as_str(), CONNECT_LINE],
            "{runs:?}"
        );
        let recorded = std::fs::read_to_string(transport_log(&world.dirs)).unwrap();
        assert!(!recorded.contains(&code), "the code is in a command line");
        std::fs::remove_file(transport_log(&world.dirs)).unwrap();
    }
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s5_an_approval_that_fails_there_pairs_nothing_and_says_its_last_line_with_the_code_while_the_request_waits()
 {
    let world = World::start();
    let folder = world.dirs.root().join("a laptop");
    let missing = approve_line(DeviceRole::Admin);
    let pairing = Pairing::spawn(
        &world,
        &folder,
        "admin",
        &ssh(),
        &[("FAKE_SSH_MISSING_LINE", missing.as_str())],
    );
    let said = pairing
        .said_until(|said| said.matches(PAIRING_LINE_PREFIX).count() == 2)
        .await;
    let lines: Vec<&str> = said.lines().collect();
    assert_eq!(lines.len(), 3, "{said}");
    assert!(lines[0].starts_with(PAIRING_LINE_PREFIX), "{said}");
    // The command's own last line, unedited, then the code line again.
    assert_eq!(lines[1], "sh: 1: floti: not found");
    assert_eq!(lines[2], lines[0]);
    let code = code_in(&said);
    assert!(lines[2].ends_with(&format!(
        "run \"floti devices approve {code}\" on the host."
    )));
    let fingerprint = ClientKeys::open(&folder)
        .unwrap()
        .device_key()
        .fingerprint();
    assert!(
        registered(&world.dirs, &fingerprint).is_none(),
        "nothing is paired"
    );

    // The request still waits: approved by hand, the bridge goes on.
    let approved = world.devices(&["approve", &code]).await;
    assert!(approved.status.success(), "{}", stderr(&approved));
    let paired = until_paired(&world.dirs, &folder).await;
    assert_eq!(paired.role, Role::Operator);
    assert_eq!(pairing.ended().await, Some(0));
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s5_an_approval_floti_refuses_there_says_floti_s_own_line_with_the_code_and_pairs_nothing()
{
    let world = World::start();
    let folder = world.dirs.root().join("a laptop");
    // The approval's login finds no host there, so `floti devices` refuses.
    let elsewhere = world.dirs.folder("no host here");
    let line = approve_line(DeviceRole::Operator);
    let pairing = Pairing::spawn(
        &world,
        &folder,
        "operator",
        &custom(),
        &[
            ("FAKE_SSH_ELSEWHERE_LINE", line.as_str()),
            ("FAKE_SSH_ELSEWHERE_RUNTIME", &elsewhere.to_string_lossy()),
        ],
    );
    let said = pairing
        .said_until(|said| said.matches(PAIRING_LINE_PREFIX).count() == 2)
        .await;
    let lines: Vec<&str> = said.lines().collect();
    assert_eq!(
        lines[1..],
        [
            "floti devices: no host is running on this computer.",
            lines[0]
        ],
        "{said}"
    );
    let code = code_in(&said);
    let fingerprint = ClientKeys::open(&folder)
        .unwrap()
        .device_key()
        .fingerprint();
    assert!(
        registered(&world.dirs, &fingerprint).is_none(),
        "nothing is paired"
    );
    let mut admin = world.admin().await;
    let listed = admin.request::<DevicesList>(&()).await.unwrap();
    assert_eq!(
        listed
            .waiting
            .iter()
            .map(|waiting| waiting.fingerprint.as_str())
            .collect::<Vec<_>>(),
        [fingerprint.as_str()],
        "the request still waits"
    );
    let recorded = std::fs::read_to_string(transport_log(&world.dirs)).unwrap();
    assert!(!recorded.contains(&code), "the code is in a command line");
    drop(pairing);
    world.stop().await;
}
