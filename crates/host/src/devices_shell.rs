//! `floti devices` and `floti devices approve <code> [--role <role>]`: the
//! devices paired with the host on this computer, and approving a device
//! that asks to pair.
//!
//! Run in a shell on the host's computer as the host's own OS user, it
//! connects to the host on the local socket as the host itself: it reads
//! the host's key from the owner-only key file in the host's data folder
//! (never printing it) and proves it in the handshake. Only that user can
//! read the file, so the host takes the connection as its own user at its
//! own computer, and serves it `devices:list` and `devices:approve`, which
//! it refuses every paired device, an admin's included.
//!
//! - `floti devices` prints each paired device with its role, when it was
//!   paired and, once it is, revoked, and each request to pair still
//!   waiting with the name the device gave and the time it has left. Each
//!   is named by its key's fingerprint; no key and no code is printed.
//! - `floti devices approve <code>` pairs the device whose request waits
//!   under the code it shows, as an operator, or with the role `--role`
//!   names (`viewer`, `operator` or `admin`), and prints which device it
//!   paired and its role.
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
    ApproveDevice, DeviceListing, DeviceRole, DevicesApprove, DevicesList, PairedDevice,
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
    Approve { code: String, role: DeviceRole },
}

/// What follows `devices`: nothing, or `approve <code>` and, optionally,
/// `--role viewer|operator|admin`. `None` for anything else, which is
/// answered with the usage and pairs nothing.
pub fn parse(args: &[String]) -> Option<Step> {
    match args {
        [] => Some(Step::List),
        [approve, code] if approve == "approve" && !code.is_empty() => Some(Step::Approve {
            code: code.clone(),
            role: DeviceRole::Operator,
        }),
        [approve, code, flag, role] if approve == "approve" && flag == "--role" => {
            let role = match role.as_str() {
                "viewer" => DeviceRole::Viewer,
                "operator" => DeviceRole::Operator,
                "admin" => DeviceRole::Admin,
                _ => return None,
            };
            (!code.is_empty()).then(|| Step::Approve {
                code: code.clone(),
                role,
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
        Step::Approve { code, role } => connection
            .request::<DevicesApprove>(
                1,
                &ApproveDevice {
                    code: code.clone(),
                    role: *role,
                },
            )
            .await
            .map_err(failed)?
            .map(|device| approved(&device)),
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
        match device.role {
            DeviceRole::Viewer => "a viewer",
            DeviceRole::Operator => "an operator",
            DeviceRole::Admin => "an admin",
        }
    )
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
                code: "ABCD-2345".to_owned(),
                role: DeviceRole::Operator
            })
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
                    code: "ABCD2345".to_owned(),
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
