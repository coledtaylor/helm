//! Pairing a device by code against the `floti host` executable: a device
//! the host does not know asks in its handshake, shows the code the host
//! answers with, and is paired once `floti devices approve <code>` is run in
//! a shell on the host's computer. `floti devices` runs as its own process,
//! with the same folders as the host.
//!
//! Expiry is tested by stepping the host's clock (a marker in its
//! data folder, read at every check) and then asking the host, which drops
//! what has expired as it answers; no test waits ten minutes out.

use std::path::Path;
use std::process::{Command, Output};
use std::time::{Duration, Instant};

use floti_host::client::{
    self, ClientError, ClientKeys, Connection, DEVICE_KEY_FILE, PairingOutcome, PairingRequest,
};
use floti_host::devices::{Device, DeviceRegistry, Role};
use floti_host::fake_agent;
use floti_host::keys::read_key_pair;
use floti_host::platform::socket::Endpoint;
use floti_host::server::audit::AUDIT_FILE;
use floti_host::server::{FIRST_ADMIN_NAME, HOST_KEY_FILE, PAIRING_LIFETIME, read_enrolment};
use floti_host::testkit::{
    HostProcess, PATIENCE, TEST_DEVICE_NAME, TestClient, TestDirs, host_key_when_made,
    pair_test_device, raw_connection, read_until_closed, run_floti,
};
use floti_protocol::channels::devices::{
    ApproveDevice, AuditActor, AuditDevice, AuditEntry, AuditEvent, DeviceRole, DevicesApprove,
    DevicesList,
};
use floti_protocol::channels::sessions::{SessionList, SessionStart, StartSessionRequest};
use floti_protocol::message::{ClientKind, Message};
use floti_protocol::noise::{Initiator, KeyPair, PAIRING_CODE_ALPHABET, PAIRING_CODE_LEN};
use tokio::io::AsyncWriteExt;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// The `floti` executable over `dirs`.
fn floti(dirs: &TestDirs) -> Command {
    dirs.floti_command(env!("CARGO_BIN_EXE_floti"))
}

/// `floti host` over `dirs`, with the testkit's device paired as its admin.
fn start_host(dirs: &TestDirs) -> HostProcess {
    pair_test_device(&dirs.floti_endpoint(), &dirs.data);
    start_unpaired_host(dirs)
}

/// `floti host` over `dirs` with nothing paired by the test.
fn start_unpaired_host(dirs: &TestDirs) -> HostProcess {
    let mut command = floti(dirs);
    command.arg("host");
    HostProcess::spawn(command)
}

/// `floti devices` with `args`, run to its end.
async fn devices(dirs: &TestDirs, args: &[&str]) -> Output {
    let mut command = floti(dirs);
    command.arg("devices").args(args);
    run_floti(command).await
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// `floti devices approve <code>`, and `--role <role>` when one is named,
/// succeeding.
async fn approve(dirs: &TestDirs, code: &str, role: Option<&str>) -> String {
    let mut args = vec!["approve", code];
    if let Some(role) = role {
        args.extend(["--role", role]);
    }
    let output = devices(dirs, &args).await;
    assert!(
        output.status.success(),
        "approving failed: {}",
        stderr(&output)
    );
    stdout(&output)
}

/// `floti devices approve <code>` failing because no request waits under it.
async fn approve_fails(dirs: &TestDirs, code: &str) {
    let output = devices(dirs, &["approve", code]).await;
    assert_eq!(output.status.code(), Some(1), "{}", stderr(&output));
    assert_eq!(
        stderr(&output).trim(),
        "floti devices: No device is waiting to pair with that code."
    );
    assert!(stdout(&output).is_empty());
}

/// What `floti devices` prints, succeeding.
async fn listing(dirs: &TestDirs) -> String {
    let output = devices(dirs, &[]).await;
    assert!(output.status.success(), "{}", stderr(&output));
    stdout(&output)
}

/// The admin the testkit pairs, to stop the host with.
async fn admin(dirs: &TestDirs) -> TestClient {
    TestClient::connect(&dirs.floti_endpoint(), &[]).await
}

/// A device's keys in a folder of their own under `dirs`.
fn device(dirs: &TestDirs, name: &str) -> ClientKeys {
    ClientKeys::open(&dirs.folder(name)).expect("set up a device's folder")
}

/// The devices paired with the host over `dirs`, but the testkit's.
fn paired(dirs: &TestDirs) -> Vec<Device> {
    DeviceRegistry::in_data_folder(&dirs.data)
        .devices()
        .expect("read the device registry")
        .into_iter()
        .filter(|device| device.name != TEST_DEVICE_NAME)
        .collect()
}

/// Fails the test when `text` holds `code`, as shown or in lower case.
fn assert_code_absent(code: &str, text: &str, what: &str) {
    assert!(!text.contains(code), "the code is in {what}: {text}");
    assert!(
        !text.contains(&code.to_lowercase()),
        "the code is in {what}: {text}"
    );
}

/// Fails the test when `text` holds `key` in hex.
fn assert_key_absent(key: &floti_protocol::noise::PublicKey, text: &str, what: &str) {
    assert!(!text.contains(&key.to_hex()), "a key is in {what}: {text}");
}

/// Waits until `floti devices` no longer lists `fingerprint` as waiting.
async fn until_not_waiting(dirs: &TestDirs, fingerprint: &str) -> String {
    let deadline = Instant::now() + PATIENCE;
    loop {
        let listed = listing(dirs).await;
        if !waiting_part(&listed).contains(fingerprint) {
            return listed;
        }
        assert!(
            Instant::now() < deadline,
            "the request is still listed after {PATIENCE:?}: {listed}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// The part of `floti devices`'s output about requests waiting.
fn waiting_part(listed: &str) -> &str {
    listed
        .find("Waiting to pair")
        .or_else(|| listed.find("No device is waiting"))
        .map_or("", |at| &listed[at..])
}

/// Asks to pair with the host on this computer, retrying while it starts:
/// for a host the testkit did not pair, which [`TestClient::ask_to_pair`]
/// does not know.
async fn ask_when_up(keys: &ClientKeys, endpoint: &Endpoint, data: &Path) -> PairingRequest {
    let deadline = Instant::now() + PATIENCE;
    loop {
        match keys
            .ask_local_to_pair(endpoint, data, "a laptop", ClientKind::Desktop)
            .await
        {
            Ok(request) => return request,
            Err(err @ ClientError::Unreachable { .. }) => assert!(
                Instant::now() < deadline,
                "nothing answered at {endpoint}: {err}"
            ),
            Err(err) => panic!("the host did not take the request to pair: {err}"),
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// `keys`, paired, connected as themselves, retrying while the host starts.
async fn connect_when_up(keys: &ClientKeys, endpoint: &Endpoint) -> Connection {
    let deadline = Instant::now() + PATIENCE;
    loop {
        match keys.connect(endpoint).await {
            Ok(connection) => return connection,
            Err(err @ ClientError::Unreachable { .. }) => assert!(
                Instant::now() < deadline,
                "nothing answered at {endpoint}: {err}"
            ),
            Err(err) => panic!("the host did not let the device in: {err}"),
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s1_s3_s6_s8_a_device_asks_shows_its_code_is_approved_as_an_operator_and_comes_back_as_itself()
 {
    let dirs = TestDirs::new();
    let host = start_host(&dirs);
    let endpoint = dirs.floti_endpoint();
    let mut keys = device(&dirs, "laptop");
    let fingerprint = keys.device_key().fingerprint();

    // S1: the device is told a code to show, from the alphabet.
    let request = TestClient::ask_to_pair(&keys, &endpoint, "a laptop", ClientKind::Desktop).await;
    let code = request.code().to_owned();
    assert_eq!(code.len(), PAIRING_CODE_LEN);
    assert!(
        code.bytes().all(|c| PAIRING_CODE_ALPHABET.contains(&c)),
        "{code}"
    );
    assert_eq!(request.expires_in_seconds(), PAIRING_LIFETIME.as_secs());
    assert_eq!(keys.pinned_host(), None);

    // S6: the request is listed by fingerprint with its time left, beside
    // the paired admin; no key, no code.
    let listed = listing(&dirs).await;
    assert!(listed.contains(&fingerprint), "{listed}");
    assert!(listed.contains("\"a laptop\""), "{listed}");
    assert!(listed.contains("left"), "{listed}");
    assert!(listed.contains(TEST_DEVICE_NAME), "{listed}");
    assert!(listed.contains("admin"), "{listed}");
    assert_code_absent(&code, &listed, "the list");
    assert_key_absent(&keys.device_key(), &listed, "the list");

    // S3: approved as an operator; the device is told, and pins the host.
    let said = approve(&dirs, &code, None).await;
    assert_eq!(
        said,
        format!("Paired \"a laptop\" ({fingerprint}) as an operator.\n")
    );
    assert_key_absent(&keys.device_key(), &said, "what approving printed");
    assert_eq!(
        keys.finish_pairing(request).await.unwrap(),
        PairingOutcome::Approved(DeviceRole::Operator)
    );
    let host_key = host_key_when_made(&dirs.data).await;
    assert_eq!(keys.pinned_host(), Some(host_key));
    let devices = paired(&dirs);
    assert_eq!(devices.len(), 1, "{devices:?}");
    assert_eq!(devices[0].key, keys.device_key());
    assert_eq!(devices[0].name, "a laptop");
    assert_eq!(devices[0].role, Role::Operator);
    let listed = listing(&dirs).await;
    assert!(listed.contains("No device is waiting to pair."), "{listed}");
    assert!(listed.contains("operator"), "{listed}");

    // S8: it comes back as itself, welcomed without asking.
    let mut laptop = TestClient::over(keys.connect(&endpoint).await.unwrap(), &[]).await;
    assert!(laptop.request::<SessionList>(&()).await.is_ok());
    drop(laptop);

    let (out, log) = host.stop(admin(&dirs).await).await;
    assert!(
        log.contains(&format!("device {fingerprint} asks to pair")),
        "{log}"
    );
    assert!(
        log.contains(&format!("paired device {fingerprint} as an operator")),
        "{log}"
    );
    assert_code_absent(&code, &log, "the host's log");
    assert_code_absent(&code, &out, "the host's output");

    // S8, after the host starts again: still itself, with its role.
    let host = start_host(&dirs);
    let keys = ClientKeys::open(&dirs.folder("laptop")).unwrap();
    let mut laptop = TestClient::over(connect_when_up(&keys, &endpoint).await, &[]).await;
    assert!(laptop.request::<SessionList>(&()).await.is_ok());
    drop(laptop);
    host.stop(admin(&dirs).await).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s4_a_named_role_pairs_with_that_role_and_any_other_is_refused_with_the_usage() {
    let dirs = TestDirs::new();
    let host = start_host(&dirs);
    let endpoint = dirs.floti_endpoint();
    let mut phone = device(&dirs, "phone");
    let mut desk = device(&dirs, "desk");
    let phone_asks = TestClient::ask_to_pair(&phone, &endpoint, "a phone", ClientKind::Other).await;
    let desk_asks = TestClient::ask_to_pair(&desk, &endpoint, "a desk", ClientKind::Desktop).await;

    let refused = devices(&dirs, &["approve", phone_asks.code(), "--role", "owner"]).await;
    assert_eq!(refused.status.code(), Some(2));
    assert!(
        stderr(&refused).contains("usage: floti"),
        "{}",
        stderr(&refused)
    );
    assert!(paired(&dirs).is_empty());
    assert!(
        listing(&dirs)
            .await
            .contains(&phone.device_key().fingerprint())
    );

    let said = approve(&dirs, phone_asks.code(), Some("viewer")).await;
    assert!(said.ends_with("as a viewer.\n"), "{said}");
    let said = approve(&dirs, desk_asks.code(), Some("admin")).await;
    assert!(said.ends_with("as an admin.\n"), "{said}");
    assert_eq!(
        phone.finish_pairing(phone_asks).await.unwrap(),
        PairingOutcome::Approved(DeviceRole::Viewer)
    );
    assert_eq!(
        desk.finish_pairing(desk_asks).await.unwrap(),
        PairingOutcome::Approved(DeviceRole::Admin)
    );
    let roles: Vec<(String, Role)> = paired(&dirs)
        .into_iter()
        .map(|device| (device.name, device.role))
        .collect();
    assert_eq!(
        roles,
        [
            ("a phone".to_owned(), Role::Viewer),
            ("a desk".to_owned(), Role::Admin)
        ]
    );
    host.stop(admin(&dirs).await).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s5_a_code_no_request_waits_under_pairs_nothing_and_with_no_host_running_says_so() {
    let dirs = TestDirs::new();

    // No host has ever run here.
    let output = devices(&dirs, &[]).await;
    assert_eq!(output.status.code(), Some(3), "{}", stderr(&output));
    assert_eq!(
        stderr(&output).trim(),
        "floti devices: no host is running on this computer."
    );

    let host = start_host(&dirs);
    let endpoint = dirs.floti_endpoint();
    let mut keys = device(&dirs, "laptop");
    let request = TestClient::ask_to_pair(&keys, &endpoint, "a laptop", ClientKind::Desktop).await;
    let code = request.code().to_owned();

    // Mistyped: one character changed.
    let mistyped: String = code
        .chars()
        .enumerate()
        .map(|(at, c)| {
            if at == 0 {
                if c == '2' { '3' } else { '2' }
            } else {
                c
            }
        })
        .collect();
    approve_fails(&dirs, &mistyped).await;
    assert!(paired(&dirs).is_empty());

    // Approved already.
    approve(&dirs, &code, None).await;
    keys.finish_pairing(request).await.unwrap();
    approve_fails(&dirs, &code).await;
    assert_eq!(paired(&dirs).len(), 1);

    // Withdrawn.
    let other = device(&dirs, "other");
    let request = TestClient::ask_to_pair(&other, &endpoint, "another", ClientKind::Desktop).await;
    let withdrawn = request.code().to_owned();
    drop(request);
    until_not_waiting(&dirs, &other.device_key().fingerprint()).await;
    approve_fails(&dirs, &withdrawn).await;
    assert_eq!(paired(&dirs).len(), 1);

    // The host stopped: its key is there, but nothing answers.
    host.stop(admin(&dirs).await).await;
    let output = devices(&dirs, &["approve", &withdrawn]).await;
    assert_eq!(output.status.code(), Some(3), "{}", stderr(&output));
    assert_eq!(
        stderr(&output).trim(),
        "floti devices: no host is running on this computer."
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn s7_an_admin_device_lists_and_approves_and_an_operator_is_refused_naming_its_role() {
    let dirs = TestDirs::new();
    let host = start_host(&dirs);
    let endpoint = dirs.floti_endpoint();
    let mut admin_client = admin(&dirs).await;
    let mut keys = device(&dirs, "laptop");
    let request = TestClient::ask_to_pair(&keys, &endpoint, "a laptop", ClientKind::Desktop).await;

    let mut operator = TestClient::connect_as(&endpoint, "an operator", Role::Operator, &[]).await;
    let refusal = operator
        .request::<DevicesApprove>(&ApproveDevice {
            code: request.code().to_owned(),
            role: DeviceRole::Admin,
        })
        .await
        .expect_err("an operator approved a request");
    assert_eq!(
        refusal.message,
        "Listing, approving or revoking devices takes an admin device, and this device is paired as an operator."
    );
    assert!(operator.request::<DevicesList>(&()).await.is_err());

    let listed = admin_client.request::<DevicesList>(&()).await.unwrap();
    assert_eq!(listed.waiting.len(), 1, "{listed:?}");
    let approved = admin_client
        .request::<DevicesApprove>(&ApproveDevice {
            code: request.code().to_owned(),
            role: DeviceRole::Viewer,
        })
        .await
        .expect("an admin device approves");
    assert_eq!(approved.fingerprint, keys.device_key().fingerprint());
    assert_eq!(
        keys.finish_pairing(request).await.unwrap(),
        PairingOutcome::Approved(DeviceRole::Viewer)
    );
    let mut names: Vec<String> = paired(&dirs)
        .into_iter()
        .map(|device| device.name)
        .collect();
    names.sort();
    assert_eq!(names, ["a laptop", "an operator"]);
    drop(operator);
    host.stop(admin_client).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s9_a_request_ten_minutes_old_is_told_it_expired_and_is_gone_and_pairs_nothing() {
    let dirs = TestDirs::new();
    let host = start_host(&dirs);
    let endpoint = dirs.floti_endpoint();
    let mut keys = device(&dirs, "laptop");
    let fingerprint = keys.device_key().fingerprint();
    let request = TestClient::ask_to_pair(&keys, &endpoint, "a laptop", ClientKind::Desktop).await;
    let code = request.code().to_owned();

    dirs.step_host_clock(PAIRING_LIFETIME);
    let listed = listing(&dirs).await;
    assert!(!listed.contains(&fingerprint), "{listed}");
    assert_eq!(
        keys.finish_pairing(request).await.unwrap(),
        PairingOutcome::Expired
    );
    assert_eq!(keys.pinned_host(), None);
    approve_fails(&dirs, &code).await;
    assert!(paired(&dirs).is_empty());

    let (_, log) = host.stop(admin(&dirs).await).await;
    assert!(
        log.contains(&format!(
            "the request to pair from device {fingerprint} expired"
        )),
        "{log}"
    );
    assert_code_absent(&code, &log, "the host's log");
}

#[tokio::test(flavor = "multi_thread")]
async fn s9_a_request_just_short_of_ten_minutes_still_waits_and_is_approved() {
    let dirs = TestDirs::new();
    let host = start_host(&dirs);
    let endpoint = dirs.floti_endpoint();
    let mut keys = device(&dirs, "laptop");
    let request = TestClient::ask_to_pair(&keys, &endpoint, "a laptop", ClientKind::Desktop).await;

    dirs.step_host_clock(PAIRING_LIFETIME - Duration::from_secs(10));
    let listed = listing(&dirs).await;
    assert!(
        listed.contains(&keys.device_key().fingerprint()),
        "{listed}"
    );
    assert!(listed.contains("0m "), "{listed}");
    approve(&dirs, request.code(), None).await;
    assert_eq!(
        keys.finish_pairing(request).await.unwrap(),
        PairingOutcome::Approved(DeviceRole::Operator)
    );
    assert_eq!(paired(&dirs).len(), 1);
    host.stop(admin(&dirs).await).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s10_a_device_that_goes_away_withdraws_its_request_and_its_code_pairs_nothing() {
    let dirs = TestDirs::new();
    let host = start_host(&dirs);
    let endpoint = dirs.floti_endpoint();
    let keys = device(&dirs, "laptop");
    let fingerprint = keys.device_key().fingerprint();
    let request = TestClient::ask_to_pair(&keys, &endpoint, "a laptop", ClientKind::Desktop).await;
    let code = request.code().to_owned();

    drop(request);
    until_not_waiting(&dirs, &fingerprint).await;
    approve_fails(&dirs, &code).await;
    assert!(paired(&dirs).is_empty());

    let (_, log) = host.stop(admin(&dirs).await).await;
    assert!(
        log.contains(&format!(
            "device {fingerprint} withdrew its request to pair"
        )),
        "{log}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn s2_a_waiting_device_that_sends_anything_or_connects_again_without_asking_is_withdrawn() {
    let dirs = TestDirs::new();
    let host = start_host(&dirs);
    let endpoint = dirs.floti_endpoint();
    let host_key = host_key_when_made(&dirs.data).await;

    // Sending anything while it waits.
    let mut keys = device(&dirs, "laptop");
    let mut request =
        TestClient::ask_to_pair(&keys, &endpoint, "a laptop", ClientKind::Desktop).await;
    let code = request.code().to_owned();
    request
        .send(&Message::Hello(floti_protocol::message::Hello {
            protocol: floti_protocol::PROTOCOL_VERSION,
            client: floti_protocol::message::ClientInfo {
                name: "a laptop".to_owned(),
                kind: ClientKind::Desktop,
            },
            capabilities: Vec::new(),
        }))
        .await
        .unwrap();
    assert!(matches!(
        keys.finish_pairing(request).await,
        Err(ClientError::PairingEnded)
    ));
    until_not_waiting(&dirs, &keys.device_key().fingerprint()).await;
    approve_fails(&dirs, &code).await;

    // Connecting again, plainly, while the first connection waits.
    let phone_folder = dirs.folder("phone");
    let mut phone = ClientKeys::open(&phone_folder).unwrap();
    let request = TestClient::ask_to_pair(&phone, &endpoint, "a phone", ClientKind::Other).await;
    let code = request.code().to_owned();
    let phone_key = read_key_pair(&phone_folder.join(DEVICE_KEY_FILE))
        .unwrap()
        .expect("the phone's key");
    let again = client::connect(&endpoint, &phone_key, &host_key).await;
    assert!(again.is_err(), "a waiting key was let in without asking");
    assert!(matches!(
        phone.finish_pairing(request).await,
        Err(ClientError::PairingEnded)
    ));
    approve_fails(&dirs, &code).await;
    assert!(paired(&dirs).is_empty());
    host.stop(admin(&dirs).await).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s11_an_unknown_key_not_asking_and_a_revoked_key_asking_are_closed_without_a_byte() {
    let dirs = TestDirs::new();
    let registry = DeviceRegistry::in_data_folder(&dirs.data);
    let revoked = KeyPair::generate().unwrap();
    registry
        .pair(revoked.public(), "a lost phone", Role::Operator)
        .unwrap();
    registry.revoke(&revoked.public()).unwrap();
    let host = start_host(&dirs);
    let endpoint = dirs.floti_endpoint();
    let mut stream = raw_connection(&endpoint).await;
    let host_key = host_key_when_made(&dirs.data).await;

    let stranger = KeyPair::generate().unwrap();
    let (_, plain) = Initiator::start(&stranger, &host_key).unwrap();
    stream.write_all(&plain).await.unwrap();
    assert!(read_until_closed(&mut stream, PATIENCE).await.is_empty());

    let mut stream = raw_connection(&endpoint).await;
    let (_, asking) = Initiator::start_pairing(&revoked, &host_key).unwrap();
    stream.write_all(&asking).await.unwrap();
    assert!(read_until_closed(&mut stream, PATIENCE).await.is_empty());

    assert!(
        paired(&dirs)
            .iter()
            .all(|device| device.key != stranger.public())
    );
    let listed = listing(&dirs).await;
    assert!(listed.contains("No device is waiting to pair."), "{listed}");

    let (_, log) = host.stop(admin(&dirs).await).await;
    assert!(
        log.contains(&format!(
            "unknown device {}",
            stranger.public().fingerprint()
        )),
        "{log}"
    );
    assert!(
        log.contains(&format!(
            "revoked device {}",
            revoked.public().fingerprint()
        )),
        "{log}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn s12_pairing_on_a_host_waiting_for_its_first_admin_leaves_the_enrolment_code_to_the_desktop()
 {
    let dirs = TestDirs::new();
    let host = start_unpaired_host(&dirs);
    let endpoint = dirs.floti_endpoint();
    let mut keys = device(&dirs, "laptop");
    let request = ask_when_up(&keys, &endpoint, &dirs.data).await;
    let enrolment = read_enrolment(&dirs.data)
        .unwrap()
        .expect("the host waits for its first admin");

    let said = approve(&dirs, request.code(), None).await;
    assert!(said.ends_with("as an operator.\n"), "{said}");
    assert_eq!(
        keys.finish_pairing(request).await.unwrap(),
        PairingOutcome::Approved(DeviceRole::Operator)
    );
    let kept = read_enrolment(&dirs.data)
        .unwrap()
        .expect("the enrolment code is still there");
    assert!(kept.code.matches(&enrolment.code), "the code changed");
    let listed = listing(&dirs).await;
    assert!(
        !listed.contains(enrolment.code.expose_hex().as_str()),
        "{listed}"
    );

    // The desktop still enrols as the first admin with that code.
    let mut desk = device(&dirs, "desk");
    let connection = desk
        .connect_local(&endpoint, &dirs.data)
        .await
        .expect("enrol");
    // Enrolled once it has said hello.
    let desk_client = TestClient::over(connection, &[]).await;
    let devices = DeviceRegistry::in_data_folder(&dirs.data)
        .devices()
        .unwrap();
    let roles: Vec<(String, Role)> = devices
        .iter()
        .map(|device| (device.name.clone(), device.role))
        .collect();
    assert_eq!(
        roles,
        [
            ("a laptop".to_owned(), Role::Operator),
            (FIRST_ADMIN_NAME.to_owned(), Role::Admin)
        ]
    );
    assert_eq!(devices[1].key, desk.device_key());
    host.stop(desk_client).await;
}

// ---------------------------------------------------------------------------
// What the host's log holds
// ---------------------------------------------------------------------------

/// What the session is told, which nothing but the session may see.
const PROMPT: &str = "a prompt only the session sees";

/// Fails the test when `text` holds the key file at `path`: as it is kept,
/// or its bytes in hex, in either case.
fn assert_key_file_absent(path: &Path, text: &str, what: &str) {
    let kept = std::fs::read(path).expect("read a key file");
    let as_kept = String::from_utf8_lossy(&kept);
    assert!(
        !text.contains(as_kept.trim()),
        "{} is in {what}: {text}",
        path.display()
    );
    let hex: String = kept.iter().map(|byte| format!("{byte:02x}")).collect();
    for hex in [hex.clone(), hex.to_uppercase()] {
        assert!(
            !text.contains(&hex),
            "{} is in {what}: {text}",
            path.display()
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_host_that_enrols_pairs_and_runs_a_session_logs_no_key_code_prompt_or_output_and_names_keys_by_fingerprint()
 {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let host = start_unpaired_host(&dirs);
    let endpoint = dirs.floti_endpoint();

    // A laptop asks to pair while the host waits for its first admin.
    let mut laptop = device(&dirs, "laptop");
    let request = ask_when_up(&laptop, &endpoint, &dirs.data).await;
    let pairing_code = request.code().to_owned();
    let enrolment = read_enrolment(&dirs.data)
        .unwrap()
        .expect("the host waits for its first admin");

    // The desktop enrols as the first admin with the one-time code.
    let mut desk = device(&dirs, "desk");
    let connection = desk
        .connect_local(&endpoint, &dirs.data)
        .await
        .expect("enrol");
    let mut admin = TestClient::over(connection, &["terminal"]).await;

    // The laptop is paired under its code.
    approve(&dirs, &pairing_code, None).await;
    assert_eq!(
        laptop.finish_pairing(request).await.unwrap(),
        PairingOutcome::Approved(DeviceRole::Operator)
    );

    // A session runs the fake agent, which answers a prompt.
    let folder = dirs.folder("a project");
    let session = admin
        .request::<SessionStart>(&StartSessionRequest {
            cwd: folder.to_string_lossy().into_owned(),
            cols: 80,
            rows: 24,
            ..StartSessionRequest::default()
        })
        .await
        .expect("start a session");
    admin.attach(1, session.id).await;
    admin.read_stream_until(1, |bytes| !bytes.is_empty()).await;
    let run_agent = format!("\"{}\" --fake-tick=100\r", agent.exe().display());
    admin.type_into(1, run_agent.as_bytes()).await;
    admin
        .read_stream_until(1, |bytes| String::from_utf8_lossy(bytes).contains("tick 1"))
        .await;
    admin.type_into(1, format!("{PROMPT}\r").as_bytes()).await;
    let answer = format!("echo: {PROMPT}");
    admin
        .read_stream_until(1, |bytes| String::from_utf8_lossy(bytes).contains(&answer))
        .await;

    let (out, log) = host.stop(admin).await;
    for named in [
        format!(
            "enrolled device {} as the first admin",
            desk.device_key().fingerprint()
        ),
        format!(
            "paired device {} as an operator",
            laptop.device_key().fingerprint()
        ),
    ] {
        assert!(log.contains(&named), "{named:?} is not in the log: {log}");
    }
    let enrolment_code = enrolment.code.expose_hex();
    let key_files = [
        dirs.data.join(HOST_KEY_FILE),
        desk.folder().join(DEVICE_KEY_FILE),
        laptop.folder().join(DEVICE_KEY_FILE),
    ];
    for (text, what) in [(&log, "the host's log"), (&out, "the host's output")] {
        assert_code_absent(&pairing_code, text, what);
        assert_code_absent(enrolment_code.as_str(), text, what);
        for key in [enrolment.host_key, desk.device_key(), laptop.device_key()] {
            assert_key_absent(&key, text, what);
        }
        for file in &key_files {
            assert_key_file_absent(file, text, what);
        }
        assert!(!text.contains(PROMPT), "the prompt is in {what}: {text}");
        assert!(
            !text.contains("tick 1"),
            "the session's output is in {what}: {text}"
        );
    }
}

/// The audit log's entries' events in `dirs`' data folder, oldest first.
fn audited_events(dirs: &TestDirs) -> (Vec<AuditEvent>, String) {
    let text = std::fs::read_to_string(dirs.data.join(AUDIT_FILE)).unwrap_or_default();
    let events = text
        .lines()
        .map(|line| {
            serde_json::from_str::<AuditEntry>(line)
                .unwrap_or_else(|err| panic!("an audit line does not read ({err}): {line}"))
                .event
        })
        .collect();
    (events, text)
}

#[tokio::test(flavor = "multi_thread")]
async fn s9_a_request_approved_in_the_shell_and_the_first_admins_enrolment_are_recorded_and_never_their_codes()
 {
    let dirs = TestDirs::new();
    let host = start_unpaired_host(&dirs);
    let endpoint = dirs.floti_endpoint();
    let mut keys = device(&dirs, "laptop");
    let request = ask_when_up(&keys, &endpoint, &dirs.data).await;
    let pairing_code = request.code().to_owned();
    let enrolment = read_enrolment(&dirs.data)
        .unwrap()
        .expect("the host waits for its first admin");
    approve(&dirs, &pairing_code, Some("operator")).await;
    assert_eq!(
        keys.finish_pairing(request).await.unwrap(),
        PairingOutcome::Approved(DeviceRole::Operator)
    );

    let mut desk = device(&dirs, "desk");
    let connection = desk
        .connect_local(&endpoint, &dirs.data)
        .await
        .expect("enrol");
    let desk_client = TestClient::over(connection, &[]).await;

    let laptop = keys.device_key().fingerprint();
    let wanted = [
        AuditEvent::PairingAsked {
            device: AuditDevice {
                fingerprint: laptop.clone(),
                name: Some("a laptop".to_owned()),
                role: None,
            },
            away: false,
        },
        AuditEvent::PairingApproved {
            device: AuditDevice {
                fingerprint: laptop,
                name: Some("a laptop".to_owned()),
                role: Some(DeviceRole::Operator),
            },
            by: AuditActor::HostShell,
            away: false,
        },
        AuditEvent::Enrolled {
            device: AuditDevice {
                fingerprint: desk.device_key().fingerprint(),
                name: Some(FIRST_ADMIN_NAME.to_owned()),
                role: Some(DeviceRole::Admin),
            },
        },
    ];
    // The enrolment is written as the desk's hello is read; wait for it.
    let deadline = Instant::now() + PATIENCE;
    let (pairings, text) = loop {
        let (events, text) = audited_events(&dirs);
        let pairings: Vec<AuditEvent> = events
            .into_iter()
            .filter(|event| {
                matches!(
                    event,
                    AuditEvent::PairingAsked { .. }
                        | AuditEvent::PairingApproved { .. }
                        | AuditEvent::Enrolled { .. }
                )
            })
            .collect();
        if pairings.len() >= wanted.len() || Instant::now() >= deadline {
            break (pairings, text);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert_eq!(pairings, wanted, "{text}");
    assert_code_absent(&pairing_code, &text, "the audit log");
    assert_code_absent(enrolment.code.expose_hex().as_str(), &text, "the audit log");
    host.stop(desk_client).await;
}
