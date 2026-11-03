//! `floti devices`, `floti devices approve <code> [--role <role>]` and
//! `floti devices revoke <fingerprint>`: the devices paired with the host on
//! this computer, approving a device that asks to pair, and revoking one.
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
//!   paired and, once it is, revoked, and each request to pair still
//!   waiting with the name the device gave and the time it has left. Each
//!   is named by its key's fingerprint; no key and no code is printed.
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
use floti_protocol::channels::devices::{
    ApproveDevice, DeviceListing, DeviceRole, DevicesApprove, DevicesList, DevicesRevoke,
    PairedDevice, RevokeDevice,
};
use floti_protocol::message::{ClientKind, ErrorReply};

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
}

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
/// `--role viewer|operator|admin`; or `revoke <fingerprint>`. `None` for
/// anything else, which is answered with the usage and changes nothing.
pub fn parse(args: &[String]) -> Option<Step> {
    match args {
        [] => Some(Step::List),
        [approve, code] if approve == "approve" => Some(Step::Approve {
            code: Code::of(code)?,
            role: DeviceRole::Operator,
        }),
        [approve, code, flag, role] if approve == "approve" && flag == "--role" => {
            let role = match role.as_str() {
                "viewer" => DeviceRole::Viewer,
                "operator" => DeviceRole::Operator,
                "admin" => DeviceRole::Admin,
                _ => return None,
            };
            Some(Step::Approve {
                code: Code::of(code)?,
                role,
            })
        }
        [revoke, fingerprint] if revoke == "revoke" && !fingerprint.trim().is_empty() => {
            Some(Step::Revoke {
                fingerprint: fingerprint.trim().to_owned(),
            })
        }
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
        Step::List | Step::Revoke { .. } => None,
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
        Step::List => connection
            .request::<DevicesList>(1, &())
            .await
            .map_err(failed)?
            .map(|listing| listed(&listing)),
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
    };
    connection.close().await;
    said.map_err(|ErrorReply { message, .. }| (BridgeExit::Failed, message))
}

/// What `floti devices` prints: each paired device, then each request
/// waiting, by fingerprint.
pub fn listed(listing: &DeviceListing) -> String {
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
