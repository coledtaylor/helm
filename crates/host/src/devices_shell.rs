//! `floti devices`, `floti devices approve <code> [--role <role>]`,
//! `floti devices revoke <fingerprint>`, `floti devices role <fingerprint>
//! <role>` and `floti devices audit`: the devices paired with the host on
//! this computer, approving a device that asks to pair, revoking one,
//! changing one's role, and the host's audit log.
//!
//! Run in a shell on the host's computer as the host's own OS user (over ssh
//! included), it connects to the host on the local socket as the host
//! itself: it reads the host's key from the owner-only key file in the
//! host's data folder (never printing it) and proves it in the handshake.
//! Only that user can read the file, so the host takes the connection as its
//! own user at its own computer: it serves it the devices channels and never
//! asks it for presence. An admin device is served the same channels.
//!
//! - `floti devices` prints each paired device with its role, when it was
//!   paired and, once it is, revoked, and whether it is attached now, since
//!   when and from where; and each request to pair still waiting with the
//!   name the device gave and the time it has left. Each is named by its
//!   key's fingerprint; no key and no code is printed.
//! - `floti devices approve <code>` pairs the device whose request waits
//!   under the code it shows, as an operator, or with the role `--role`
//!   names (`viewer`, `operator` or `admin`), and prints which device it
//!   paired and its role. With `-` for the code, it reads the code from its
//!   standard input, one line, so the code is in no command line: what a
//!   device pairing itself through ssh or a command runs here.
//! - `floti devices revoke <fingerprint>` revokes the device with the
//!   fingerprint `floti devices` printed: every live connection of its key
//!   closes at once, its sessions keep running, and it prints which device
//!   it revoked and its role. A fingerprint no device has, or one already
//!   revoked, fails saying so and changes nothing.
//! - `floti devices role <fingerprint> viewer|operator|admin` gives the
//!   device that role, which its open connections take at once, and prints
//!   it. A fingerprint no device has, a revoked device, or the host's last
//!   admin made anything else fails saying so and changes nothing.
//! - `floti devices audit` prints the host's audit log, newest entry first:
//!   who attached and detached, connections refused, requests to pair and
//!   what became of them, role changes, revokes, presence confirmed and
//!   every admin action, each with its number and time.
//!
//! What it says goes to standard output. A failure goes to standard error as
//! one line, with the bridge's exit status for it ([`BridgeExit`]): no host
//! running is [`BridgeExit::Unreachable`], and a code no request waits under
//! is [`BridgeExit::Failed`].

use std::fmt::Write as _;
use std::io::Write;

use floti_host::bridge::BridgeExit;
use floti_host::client::{self, ClientError};
use floti_host::keys::read_key_pair;
use floti_host::platform::folders::{self, UserEnv};
use floti_host::server::{HOST_KEY_FILE, local_endpoint};
use floti_protocol::channel::{EventChannel, from_payload};
use floti_protocol::channels::devices::{
    AdminOutcome, ApproveDevice, AttachedDevice, AttachedDevices, AuditActor, AuditDevice,
    AuditEntry, AuditEvent, AuditQuery, ChangeDeviceRole, DeviceListing, DeviceRole,
    DevicesApprove, DevicesAttached, DevicesAudit, DevicesList, DevicesRevoke, DevicesRole,
    PairedDevice, PairingEnd, RevokeDevice,
};
use floti_protocol::message::{ClientKind, ErrorReply, Message, Subscribe};

/// The name the host's log and its client list see this command as.
const CLIENT_NAME: &str = "floti devices";

/// What `floti devices` was asked to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// List the paired devices and the requests waiting.
    List,
    /// Approve the request waiting under `code`, with `role`.
    Approve { code: Code, role: DeviceRole },
    /// Revoke the device with `fingerprint`.
    Revoke { fingerprint: String },
    /// Give the device with `fingerprint` the role `role`.
    Role {
        fingerprint: String,
        role: DeviceRole,
    },
    /// Print the audit log, newest first.
    Audit,
}

/// The most entries asked for at a time while reading the audit log.
const AUDIT_PAGE: u32 = 200;

/// Where the code to approve comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Code {
    /// Given on the command line.
    Given(String),
    /// `-`: one line on standard input.
    StandardInput,
}

impl Code {
    fn of(arg: &str) -> Option<Self> {
        match arg {
            "" => None,
            "-" => Some(Self::StandardInput),
            code => Some(Self::Given(code.to_owned())),
        }
    }

    /// The code, read from standard input when it is `-`.
    fn read(&self) -> Result<String, Failure> {
        match self {
            Self::Given(code) => Ok(code.clone()),
            Self::StandardInput => {
                let mut line = String::new();
                std::io::stdin().read_line(&mut line).map_err(|err| {
                    (
                        BridgeExit::Failed,
                        format!("could not read the code from standard input: {err}"),
                    )
                })?;
                let code = line.trim().to_owned();
                if code.is_empty() {
                    return Err((
                        BridgeExit::Usage,
                        "no code came on standard input.".to_owned(),
                    ));
                }
                Ok(code)
            }
        }
    }
}

/// What follows `devices`: nothing; `approve <code>|-` and, optionally,
/// `--role viewer|operator|admin`; `revoke <fingerprint>`; `role
/// <fingerprint> viewer|operator|admin`; or `audit`. `None` for anything
/// else, which is answered with the usage and changes nothing.
pub fn parse(args: &[String]) -> Option<Step> {
    match args {
        [] => Some(Step::List),
        [approve, code] if approve == "approve" => Some(Step::Approve {
            code: Code::of(code)?,
            role: DeviceRole::Operator,
        }),
        [approve, code, flag, role] if approve == "approve" && flag == "--role" => {
            Some(Step::Approve {
                code: Code::of(code)?,
                role: role_of(role)?,
            })
        }
        [revoke, fingerprint] if revoke == "revoke" && !fingerprint.trim().is_empty() => {
            Some(Step::Revoke {
                fingerprint: fingerprint.trim().to_owned(),
            })
        }
        [step, fingerprint, role] if step == "role" && !fingerprint.trim().is_empty() => {
            Some(Step::Role {
                fingerprint: fingerprint.trim().to_owned(),
                role: role_of(role)?,
            })
        }
        [audit] if audit == "audit" => Some(Step::Audit),
        _ => None,
    }
}

/// The role `name` names: `viewer`, `operator` or `admin`, and nothing else.
fn role_of(name: &str) -> Option<DeviceRole> {
    match name {
        "viewer" => Some(DeviceRole::Viewer),
        "operator" => Some(DeviceRole::Operator),
        "admin" => Some(DeviceRole::Admin),
        _ => None,
    }
}

/// Runs `step` against the host on this computer, prints what it says, and
/// answers its exit status.
pub fn run(step: &Step) -> u8 {
    let outcome = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime.block_on(perform(UserEnv::from_process(), step)),
        Err(err) => Err((BridgeExit::Failed, format!("could not start: {err}"))),
    };
    match outcome {
        Ok(text) => {
            let mut out = std::io::stdout().lock();
            let _ = out.write_all(text.as_bytes()).and_then(|()| out.flush());
            0
        }
        Err((exit, why)) => {
            let line = why.replace(['\r', '\n'], " ");
            let mut err = std::io::stderr().lock();
            let _ = writeln!(err, "floti devices: {line}").and_then(|()| err.flush());
            exit.code()
        }
    }
}

type Failure = (BridgeExit, String);

async fn perform(env: UserEnv, step: &Step) -> Result<String, Failure> {
    // Read first: a code that does not come pairs nothing and asks nothing
    // of the host.
    let code = match step {
        Step::Approve { code, .. } => Some(code.read()?),
        Step::List | Step::Revoke { .. } | Step::Role { .. } | Step::Audit => None,
    };
    let folders = folders::resolve(&env).map_err(|err| (BridgeExit::Failed, err.to_string()))?;
    let no_host = || {
        (
            BridgeExit::Unreachable,
            "no host is running on this computer.".to_owned(),
        )
    };
    // Held only in this process, and never printed.
    let host = read_key_pair(&folders.data.join(HOST_KEY_FILE))
        .map_err(|err| (BridgeExit::Failed, err.to_string()))?
        .ok_or_else(no_host)?;
    let endpoint = local_endpoint(&folders);
    let mut connection = match client::connect(&endpoint, &host, &host.public()).await {
        Ok(connection) => connection,
        Err(ClientError::Unreachable { .. }) => return Err(no_host()),
        Err(err) => return Err((BridgeExit::of_connect(&err), err.to_string())),
    };
    let failed = |err: ClientError| (BridgeExit::Failed, err.to_string());
    connection
        .say_hello(CLIENT_NAME, ClientKind::Other)
        .await
        .map_err(failed)?;
    let said = match step {
        Step::List => match connection
            .request::<DevicesList>(1, &())
            .await
            .map_err(failed)?
        {
            Ok(listing) => {
                let attached = attached_now(&mut connection).await.map_err(failed)?;
                Ok(listed_with(&listing, attached.as_ref()))
            }
            Err(error) => Err(error),
        },
        Step::Approve { role, .. } => connection
            .request::<DevicesApprove>(
                1,
                &ApproveDevice {
                    code: code.unwrap_or_default(),
                    role: *role,
                },
            )
            .await
            .map_err(failed)?
            .map(|device| approved(&device)),
        Step::Revoke { fingerprint } => connection
            .request::<DevicesRevoke>(
                1,
                &RevokeDevice {
                    fingerprint: fingerprint.clone(),
                },
            )
            .await
            .map_err(failed)?
            .map(|device| revoked(&device)),
        Step::Role { fingerprint, role } => connection
            .request::<DevicesRole>(
                1,
                &ChangeDeviceRole {
                    fingerprint: fingerprint.clone(),
                    role: *role,
                },
            )
            .await
            .map_err(failed)?
            .map(|device| role_given(&device)),
        Step::Audit => read_audit(&mut connection).await.map_err(failed)?,
    };
    connection.close().await;
    said.map_err(|ErrorReply { message, .. }| (BridgeExit::Failed, message))
}

/// Who is attached to the host now, as one snapshot of `devices:attached`;
/// `None` from a host that does not say.
async fn attached_now(
    connection: &mut client::Connection,
) -> Result<Option<AttachedDevices>, ClientError> {
    const SUBSCRIPTION: u64 = 1;
    connection
        .send(&Message::Subscribe(Subscribe {
            subscription: SUBSCRIPTION,
            channel: <DevicesAttached as EventChannel>::NAME.to_owned(),
        }))
        .await?;
    loop {
        match connection.next().await? {
            Some(Message::Snapshot(snapshot)) if snapshot.subscription == SUBSCRIPTION => {
                return Ok(from_payload(&snapshot.state).ok());
            }
            Some(Message::SubscriptionError(error)) if error.subscription == SUBSCRIPTION => {
                return Ok(None);
            }
            Some(_) => {}
            None => return Ok(None),
        }
    }
}

/// Every entry in the host's audit log, newest first, read a page at a time
/// and printed; the host's refusal as it gave it.
async fn read_audit(
    connection: &mut client::Connection,
) -> Result<Result<String, ErrorReply>, ClientError> {
    let mut entries = Vec::new();
    let mut before = None;
    for id in 1.. {
        let page = match connection
            .request::<DevicesAudit>(
                id,
                &AuditQuery {
                    before,
                    limit: Some(AUDIT_PAGE),
                },
            )
            .await?
        {
            Ok(page) => page,
            Err(error) => return Ok(Err(error)),
        };
        before = page.entries.last().map(|entry| entry.number);
        entries.extend(page.entries);
        if !page.more || before.is_none() {
            break;
        }
    }
    Ok(Ok(audit_printed(&entries)))
}

/// What `floti devices` prints: each paired device, then each request
/// waiting, by fingerprint.
#[cfg(test)]
pub fn listed(listing: &DeviceListing) -> String {
    listed_with(listing, None)
}

/// [`listed`], marking each device `attached` holds as attached now.
pub fn listed_with(listing: &DeviceListing, attached: Option<&AttachedDevices>) -> String {
    let mut text = String::new();
    if listing.paired.is_empty() {
        text.push_str("No device is paired.\n");
    } else {
        text.push_str("Paired devices:\n");
        for device in &listing.paired {
            let _ = write!(
                text,
                "  {}  {:<8}  \"{}\"  paired {}",
                device.fingerprint,
                role_name(device.role),
                printable(&device.name),
                device.paired_at
            );
            if let Some(revoked) = &device.revoked_at {
                let _ = write!(text, "  revoked {revoked}");
            }
            if let Some(now) = attached.and_then(|attached| {
                attached
                    .devices
                    .iter()
                    .find(|now| now.fingerprint == device.fingerprint)
            }) {
                let _ = write!(text, "  {}", attached_mark(now));
            }
            text.push('\n');
        }
    }
    if listing.waiting.is_empty() {
        text.push_str("No device is waiting to pair.\n");
    } else {
        text.push_str("Waiting to pair (approve with `floti devices approve <code>`):\n");
        for request in &listing.waiting {
            let _ = writeln!(
                text,
                "  {}  \"{}\"  {}m {:02}s left",
                request.fingerprint,
                printable(&request.name),
                request.seconds_left / 60,
                request.seconds_left % 60
            );
        }
    }
    text
}

/// What `floti devices approve` prints once the device is paired.
pub fn approved(device: &PairedDevice) -> String {
    format!(
        "Paired \"{}\" ({}) as {}.\n",
        printable(&device.name),
        device.fingerprint,
        with_article(device.role)
    )
}

/// How `floti devices` marks a device attached now.
fn attached_mark(device: &AttachedDevice) -> String {
    let connections = if device.connections == 1 {
        "1 connection".to_owned()
    } else {
        format!("{} connections", device.connections)
    };
    format!(
        "attached since {}, {}, {}",
        device.since,
        if device.away {
            "from another computer"
        } else {
            "on this computer"
        },
        connections
    )
}

/// What `floti devices role` prints once the role is given.
pub fn role_given(device: &PairedDevice) -> String {
    format!(
        "\"{}\" ({}) is {} now.\n",
        printable(&device.name),
        device.fingerprint,
        with_article(device.role)
    )
}

/// What `floti devices audit` prints: each entry, newest first, as one line
/// with its number and time.
pub fn audit_printed(entries: &[AuditEntry]) -> String {
    if entries.is_empty() {
        return "The audit log is empty.\n".to_owned();
    }
    let mut text = String::new();
    for entry in entries {
        let _ = writeln!(
            text,
            "{:>6}  {}  {}",
            entry.number,
            entry.at,
            described(&entry.event)
        );
    }
    text
}

/// One audit entry as a sentence.
fn described(event: &AuditEvent) -> String {
    let from = |away: bool| if away { ", from another computer" } else { "" };
    match event {
        AuditEvent::Connected { device, away } => {
            format!("{} attached{}", audited(device), from(*away))
        }
        AuditEvent::Disconnected { device, away } => {
            format!("{} detached{}", audited(device), from(*away))
        }
        AuditEvent::Refused {
            reason,
            fingerprint,
            away,
        } => {
            let key = fingerprint
                .as_deref()
                .map(|fingerprint| format!(" (key {})", printable(fingerprint)))
                .unwrap_or_default();
            format!(
                "Refused a connection{}{key}: {}",
                from(*away),
                printable(reason)
            )
        }
        AuditEvent::PairingAsked { device, away } => {
            format!("{} asked to pair{}", audited(device), from(*away))
        }
        AuditEvent::PairingApproved { device, by, away } => format!(
            "{} approved {} as {}{}",
            actor(by),
            audited(device),
            device.role.map_or("a device", with_article),
            from(*away)
        ),
        AuditEvent::PairingEnded { device, why } => format!(
            "{}'s request to pair {}",
            audited(device),
            match why {
                PairingEnd::Expired => "expired",
                PairingEnd::Withdrawn => "was withdrawn",
            }
        ),
        AuditEvent::Enrolled { device } => {
            format!("{} enrolled as the first admin", audited(device))
        }
        AuditEvent::RoleChanged {
            device,
            from: was,
            to,
            by,
            away,
        } => format!(
            "{} made {} {}, from {}{}",
            actor(by),
            audited(device),
            with_article(*to),
            with_article(*was),
            from(*away)
        ),
        AuditEvent::Revoked { device, by, away } => {
            format!("{} revoked {}{}", actor(by), audited(device), from(*away))
        }
        AuditEvent::PresenceConfirmed { device, away } => {
            format!("{} confirmed its presence{}", audited(device), from(*away))
        }
        AuditEvent::AdminAction {
            channel,
            doing,
            by,
            away,
            outcome,
        } => format!(
            "{} asked for {} (`{}`){}: {}",
            actor(by),
            lowered(&printable(doing)),
            printable(channel),
            from(*away),
            match outcome {
                AdminOutcome::Done => "done",
                AdminOutcome::RefusedForRole => "refused for its role",
                AdminOutcome::RefusedForPresence => "refused until its user confirms presence",
            }
        ),
    }
}

/// A device as an audit entry names it.
fn audited(device: &AuditDevice) -> String {
    match &device.name {
        Some(name) => format!(
            "\"{}\" ({})",
            printable(name),
            printable(&device.fingerprint)
        ),
        None => format!("Device {}", printable(&device.fingerprint)),
    }
}

/// Who did something, as an audit entry names them.
fn actor(actor: &AuditActor) -> String {
    match actor {
        AuditActor::Device { fingerprint, name } => {
            format!("\"{}\" ({})", printable(name), printable(fingerprint))
        }
        AuditActor::HostShell => "The host's shell".to_owned(),
    }
}

/// `sentence` with its first letter lowered, to follow other words.
fn lowered(sentence: &str) -> String {
    let mut chars = sentence.chars();
    match chars.next() {
        Some(first) => first.to_lowercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// What `floti devices revoke` prints once the device is revoked.
pub fn revoked(device: &PairedDevice) -> String {
    format!(
        "Revoked \"{}\" ({}), {}. Its connections are closed; its sessions keep running.\n",
        printable(&device.name),
        device.fingerprint,
        with_article(device.role)
    )
}

fn with_article(role: DeviceRole) -> &'static str {
    match role {
        DeviceRole::Viewer => "a viewer",
        DeviceRole::Operator => "an operator",
        DeviceRole::Admin => "an admin",
    }
}

fn role_name(role: DeviceRole) -> &'static str {
    match role {
        DeviceRole::Viewer => "viewer",
        DeviceRole::Operator => "operator",
        DeviceRole::Admin => "admin",
    }
}

/// A name a device gave, with anything that would move the terminal's
/// cursor or colour it left out.
fn printable(name: &str) -> String {
    name.chars().filter(|c| !c.is_control()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use floti_protocol::channels::devices::WaitingDevice;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| (*arg).to_owned()).collect()
    }

    #[test]
    fn it_lists_with_no_arguments_and_approves_a_code_as_an_operator_by_default() {
        assert_eq!(parse(&args(&[])), Some(Step::List));
        assert_eq!(
            parse(&args(&["approve", "ABCD-2345"])),
            Some(Step::Approve {
                code: Code::Given("ABCD-2345".to_owned()),
                role: DeviceRole::Operator
            })
        );
    }

    #[test]
    fn s4_a_dash_reads_the_code_from_standard_input_so_it_is_in_no_command_line() {
        assert_eq!(
            parse(&args(&["approve", "-", "--role", "admin"])),
            Some(Step::Approve {
                code: Code::StandardInput,
                role: DeviceRole::Admin
            })
        );
    }

    #[test]
    fn s14_revoke_takes_one_fingerprint() {
        assert_eq!(
            parse(&args(&["revoke", "0123456789abcdef"])),
            Some(Step::Revoke {
                fingerprint: "0123456789abcdef".to_owned()
            })
        );
        for bad in [&["revoke"][..], &["revoke", " "], &["revoke", "a", "b"]] {
            assert_eq!(parse(&args(bad)), None, "{bad:?}");
        }
        assert_eq!(
            revoked(&PairedDevice {
                name: "a lost phone".to_owned(),
                role: DeviceRole::Operator,
                paired_at: "2026-11-01T10:00:00Z".to_owned(),
                revoked_at: Some("2026-11-02T09:00:00Z".to_owned()),
                fingerprint: "fedcba9876543210".to_owned(),
            }),
            "Revoked \"a lost phone\" (fedcba9876543210), an operator. Its connections are \
             closed; its sessions keep running.\n"
        );
    }

    #[test]
    fn s4_role_names_viewer_operator_or_admin_and_nothing_else() {
        for (name, role) in [
            ("viewer", DeviceRole::Viewer),
            ("operator", DeviceRole::Operator),
            ("admin", DeviceRole::Admin),
        ] {
            assert_eq!(
                parse(&args(&["approve", "ABCD2345", "--role", name])),
                Some(Step::Approve {
                    code: Code::Given("ABCD2345".to_owned()),
                    role
                })
            );
        }
        for bad in [
            &["approve", "ABCD2345", "--role", "owner"][..],
            &["approve", "ABCD2345", "--role"],
            &["approve"],
            &["approve", ""],
            &["approve", "ABCD2345", "--rule", "admin"],
            &["list"],
        ] {
            assert_eq!(parse(&args(bad)), None, "{bad:?}");
        }
    }

    #[test]
    fn s10_role_takes_one_fingerprint_and_a_role_and_audit_takes_nothing() {
        assert_eq!(
            parse(&args(&["role", " 0123456789abcdef ", "viewer"])),
            Some(Step::Role {
                fingerprint: "0123456789abcdef".to_owned(),
                role: DeviceRole::Viewer
            })
        );
        assert_eq!(parse(&args(&["audit"])), Some(Step::Audit));
        for bad in [
            &["role", "0123456789abcdef"][..],
            &["role", "0123456789abcdef", "owner"],
            &["role", " ", "admin"],
            &["role", "0123", "admin", "extra"],
            &["audit", "all"],
        ] {
            assert_eq!(parse(&args(bad)), None, "{bad:?}");
        }
        assert_eq!(
            role_given(&PairedDevice {
                name: "a\u{7} phone".to_owned(),
                role: DeviceRole::Operator,
                paired_at: "2026-11-01T10:00:00Z".to_owned(),
                revoked_at: None,
                fingerprint: "fedcba9876543210".to_owned(),
            }),
            "\"a phone\" (fedcba9876543210) is an operator now.\n"
        );
    }

    #[test]
    fn s1_the_list_marks_each_device_attached_now_since_when_and_from_where() {
        let listing = DeviceListing {
            paired: vec![
                PairedDevice {
                    name: "This computer".to_owned(),
                    role: DeviceRole::Admin,
                    paired_at: "2026-11-02T10:00:00Z".to_owned(),
                    revoked_at: None,
                    fingerprint: "0123456789abcdef".to_owned(),
                },
                PairedDevice {
                    name: "a phone".to_owned(),
                    role: DeviceRole::Operator,
                    paired_at: "2026-11-01T10:00:00Z".to_owned(),
                    revoked_at: None,
                    fingerprint: "fedcba9876543210".to_owned(),
                },
                PairedDevice {
                    name: "a tablet".to_owned(),
                    role: DeviceRole::Viewer,
                    paired_at: "2026-11-01T11:00:00Z".to_owned(),
                    revoked_at: None,
                    fingerprint: "00112233aabbccdd".to_owned(),
                },
            ],
            waiting: Vec::new(),
        };
        let attached = AttachedDevices {
            devices: vec![
                AttachedDevice {
                    fingerprint: "0123456789abcdef".to_owned(),
                    name: "This computer".to_owned(),
                    role: DeviceRole::Admin,
                    away: false,
                    since: "2026-11-03T09:00:00Z".to_owned(),
                    connections: 1,
                },
                AttachedDevice {
                    fingerprint: "fedcba9876543210".to_owned(),
                    name: "a phone".to_owned(),
                    role: DeviceRole::Operator,
                    away: true,
                    since: "2026-11-03T09:30:00Z".to_owned(),
                    connections: 2,
                },
            ],
        };
        assert_eq!(
            listed_with(&listing, Some(&attached)),
            "Paired devices:\n\
             \x20 0123456789abcdef  admin     \"This computer\"  paired 2026-11-02T10:00:00Z  attached since 2026-11-03T09:00:00Z, on this computer, 1 connection\n\
             \x20 fedcba9876543210  operator  \"a phone\"  paired 2026-11-01T10:00:00Z  attached since 2026-11-03T09:30:00Z, from another computer, 2 connections\n\
             \x20 00112233aabbccdd  viewer    \"a tablet\"  paired 2026-11-01T11:00:00Z\n\
             No device is waiting to pair.\n"
        );
    }

    #[test]
    fn s13_the_audit_log_prints_each_entry_newest_first_as_one_line() {
        let phone = AuditDevice {
            fingerprint: "fedcba9876543210".to_owned(),
            name: Some("a phone".to_owned()),
            role: Some(DeviceRole::Operator),
        };
        let laptop = AuditActor::Device {
            fingerprint: "0123456789abcdef".to_owned(),
            name: "a laptop".to_owned(),
        };
        let entry = |number, event| AuditEntry {
            number,
            at: format!("2026-11-03T09:00:0{number}Z"),
            event,
        };
        let entries = [
            entry(
                6,
                AuditEvent::AdminAction {
                    channel: "settings:write".to_owned(),
                    doing: "Changing the host's settings".to_owned(),
                    by: laptop.clone(),
                    away: true,
                    outcome: AdminOutcome::RefusedForPresence,
                },
            ),
            entry(
                5,
                AuditEvent::RoleChanged {
                    device: phone.clone(),
                    from: DeviceRole::Operator,
                    to: DeviceRole::Viewer,
                    by: AuditActor::HostShell,
                    away: false,
                },
            ),
            entry(
                4,
                AuditEvent::Refused {
                    reason: "An unknown key".to_owned(),
                    fingerprint: Some("00112233aabbccdd".to_owned()),
                    away: true,
                },
            ),
            entry(
                3,
                AuditEvent::Connected {
                    device: phone.clone(),
                    away: true,
                },
            ),
            entry(
                2,
                AuditEvent::PairingApproved {
                    device: phone.clone(),
                    by: AuditActor::HostShell,
                    away: false,
                },
            ),
            entry(
                1,
                AuditEvent::PairingEnded {
                    device: AuditDevice {
                        role: None,
                        ..phone.clone()
                    },
                    why: PairingEnd::Expired,
                },
            ),
        ];
        assert_eq!(
            audit_printed(&entries),
            "     6  2026-11-03T09:00:06Z  \"a laptop\" (0123456789abcdef) asked for changing the host's settings (`settings:write`), from another computer: refused until its user confirms presence\n\
             \x20    5  2026-11-03T09:00:05Z  The host's shell made \"a phone\" (fedcba9876543210) a viewer, from an operator\n\
             \x20    4  2026-11-03T09:00:04Z  Refused a connection, from another computer (key 00112233aabbccdd): An unknown key\n\
             \x20    3  2026-11-03T09:00:03Z  \"a phone\" (fedcba9876543210) attached, from another computer\n\
             \x20    2  2026-11-03T09:00:02Z  The host's shell approved \"a phone\" (fedcba9876543210) as an operator\n\
             \x20    1  2026-11-03T09:00:01Z  \"a phone\" (fedcba9876543210)'s request to pair expired\n"
        );
        assert_eq!(audit_printed(&[]), "The audit log is empty.\n");
    }

    #[test]
    fn s6_the_list_names_devices_by_fingerprint_with_roles_times_and_time_left() {
        let listing = DeviceListing {
            paired: vec![
                PairedDevice {
                    name: "This computer".to_owned(),
                    role: DeviceRole::Admin,
                    paired_at: "2026-11-02T10:00:00Z".to_owned(),
                    revoked_at: None,
                    fingerprint: "0123456789abcdef".to_owned(),
                },
                PairedDevice {
                    name: "a lost\u{1b}[31m phone".to_owned(),
                    role: DeviceRole::Viewer,
                    paired_at: "2026-11-01T10:00:00Z".to_owned(),
                    revoked_at: Some("2026-11-02T09:00:00Z".to_owned()),
                    fingerprint: "fedcba9876543210".to_owned(),
                },
            ],
            waiting: vec![WaitingDevice {
                name: "a laptop".to_owned(),
                kind: ClientKind::Desktop,
                fingerprint: "00112233aabbccdd".to_owned(),
                seconds_left: 539,
            }],
        };
        assert_eq!(
            listed(&listing),
            "Paired devices:\n\
             \x20 0123456789abcdef  admin     \"This computer\"  paired 2026-11-02T10:00:00Z\n\
             \x20 fedcba9876543210  viewer    \"a lost[31m phone\"  paired 2026-11-01T10:00:00Z  revoked 2026-11-02T09:00:00Z\n\
             Waiting to pair (approve with `floti devices approve <code>`):\n\
             \x20 00112233aabbccdd  \"a laptop\"  8m 59s left\n"
        );
        let empty = DeviceListing {
            paired: Vec::new(),
            waiting: Vec::new(),
        };
        assert_eq!(
            listed(&empty),
            "No device is paired.\nNo device is waiting to pair.\n"
        );
    }
}
