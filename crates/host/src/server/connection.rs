//! One client's connection: the Noise handshake first, then `hello`, then
//! requests, subscriptions and session terminals, until the client goes or
//! the host stops.
//!
//! The handshake runs on the raw stream within the admission's deadline
//! ([`HANDSHAKE_DEADLINE`](super::HANDSHAKE_DEADLINE) in a host). The
//! device's key arrives in its first message and is checked against the
//! device registry before the host writes anything. A key the registry does
//! not know is answered only when its first message carried the host's
//! unused one-time code while no admin exists and no other device holds it,
//! and it is paired as the first admin, the code used up, only once its
//! `hello` arrives under the session's keys; one that goes before that pairs
//! nothing and the code is kept (`super::enrolment`). A
//! connection that is not a handshake, whose first message does not decrypt,
//! whose key is unknown or revoked (whatever code it carried), that ends or
//! that runs out of time is closed without a byte written, and the host's
//! log gets one line naming the client, the reason and, where there is one,
//! the key's fingerprint. Never key material, never a code, never the
//! client's bytes. From the host's answer on every frame is sealed on the
//! way out and opened on the way in; one that does not open ends the
//! connection.
//!
//! A key the registry does not know whose first message asks to pair is
//! answered too, while fewer than [`MAX_WAITING`](super::pairing::MAX_WAITING)
//! requests wait (`super::pairing`). After its `hello` the host takes its
//! request and sends `pairing` with the code to show, and from then on
//! answers nothing: anything the device sends, or its going, withdraws the
//! request and ends the connection. Approval sends `pairing` approved, and
//! expiry `pairing` expired, and either closes it. A paired or revoked key
//! that asks to pair is closed without a byte, and an unknown key that does
//! not ask is too, withdrawing any request it had waiting.
//!
//! A connection whose device key is the host's own has proven it can read
//! the host's key file, owner-only in its data folder: it is the host's OS
//! user on the host's computer, which is `floti devices` in a shell there
//! (over ssh included). It is let in without the registry, and served the
//! devices channels (`devices:list`, `devices:approve`, `devices:revoke`,
//! `devices:role`, `devices:audit`, and who is attached now as a snapshot of
//! `devices:attached`) and nothing else, never asked for presence. It is not
//! a device: it is never attached.
//!
//! A paired device is served the devices channels too, as its role allows
//! (`super::access`): an admin lists, approves, revokes, changes roles and
//! reads the audit log; an operator or a viewer is refused, but may revoke
//! itself. Every device sees who is attached (`devices:attached`) and is
//! told of each device attaching after it (`devices:connected`).
//!
//! The audit log (`super::audit`) records every refusal of a connection
//! that sent anything, with a fixed sentence saying why, the fingerprint
//! where the handshake proved a key, and whether it came from another
//! computer; and every admin action, done or refused for role or presence,
//! by its channel and what it does, never by anything the request
//! carried. A connection accepted on the
//! host's relay endpoint, which `floti connect` opens, is away: an admin
//! action on it needs the device's presence within the last five minutes
//! (`devices:presence`). The welcome tells the device its role and whether
//! it is away.
//!
//! Revoking a device closes every live connection of its key at once: each
//! welcomed connection is entered in the host's live connections
//! (`super::access::LiveConnections`) and ends when its device is revoked,
//! detaching from its sessions and ending none of them.
//!
//! Once its answer is written, the host gives the client its own deadline
//! to say `hello` ([`HELLO_DEADLINE`](super::HELLO_DEADLINE) in a host). A
//! connection that has not by then is closed without another byte, and the
//! log's line names the device's fingerprint and that no hello came in time.
//! A new device waiting there holds the code; being cut off lets go of it
//! with nothing paired, so another device can enrol with it.
//!
//! The role a device is paired with, read at its handshake (an admin for
//! the first admin enrolling) and kept current among the attached devices
//! (`super::attached`) once it is welcomed, decides what it is served: every
//! request, subscription, publication and stream is checked against its
//! channel's least role (`super::access`) before any feature sees it, and a
//! viewer's keystrokes are dropped where they arrive. A role changed while
//! the device is connected holds from its next message on. The role also
//! goes with each request to the features, for a plugin page's calls, which
//! keep their own rule.
//!
//! A welcomed client is attached to the host with the device its key
//! proved, which is who the sessions it starts are recorded as started by.
//! Its device is entered among the attached devices; its first connection
//! attaches it, its last one closing detaches it.
//! A client leaving detaches it from every session it was attached to and
//! ends nothing: the sessions run on for the next client.
//!
//! Most requests are answered as they are read. One a feature answers later
//! (a plugin page's call waiting on the network, a program or the user) is
//! answered when it settles, while the connection reads on; its answer is
//! dropped with the connection, and the feature hears the client left.
//!
//! Of the events published, a connection delivers those for every
//! subscriber and those addressed to its own client, never another's.
//!
//! What is served is the features' to say ([`Features`]); the connection
//! carries requests, subscriptions and streams to them. A channel on the
//! not-yet-served list is refused naming it before anything else looks at
//! it, and the client is served on.

use std::collections::{BTreeSet, HashMap};
use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use floti_protocol::channel::from_payload;
use floti_protocol::channel::{ChannelKind, EventChannel, RequestChannel, Routed, Router};
use floti_protocol::channels::devices::{
    AdminOutcome, AuditActor, AuditDevice, AuditEvent, ChangeDeviceRole, DeviceListing,
    DevicesApprove, DevicesAttached, DevicesAudit, DevicesList, DevicesPresence, DevicesRevoke,
    DevicesRole, PairedDevice, RevokeDevice,
};
use floti_protocol::channels::host::{HostStop, HostStopReason};
use floti_protocol::message::{
    ErrorCode, ErrorReply, Event, Hello, Pairing as PairingStatus, PairingApproved, PairingWaiting,
    Request, Snapshot, StreamClose, StreamCredit, StreamData, StreamOpen, Subscribe,
    SubscriptionError,
};
use floti_protocol::noise::{
    KeyPair, NoiseError, Opener, PendingDevice, PublicKey, Responder, ResponderStep, Sealer,
    Transport,
};
use floti_protocol::{
    CapabilitySet, ClientChannels, CreditReceiver, DEFAULT_INITIAL_CREDIT, FrameDecoder,
    HostIdentity, Message, Outbox, ProtocolError, encode_frame,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::sync::{broadcast, mpsc, watch};
use tokio::task::{JoinHandle, JoinSet};

use super::access::{
    Asker, Confirmations, Gate, Live, LiveConnections, PRESENCE_NEEDED, gate, role_allows, rule,
};
use super::attached::Attached;
use super::audit::AuditLog;
use super::enrolment::{Claim, Enrolment, FIRST_ADMIN_NAME};
use super::events::{Publication, Start};
use super::features::{Caller, Features};
use super::hosted::Hosted;
use super::pairing::{MAX_WAITING, Outcome, Pairing};
use super::stopper::ReservedStop;
use super::{CATALOGUE, Stopper, unserved};
use crate::devices::{Device, DeviceRegistry, Revocation, Role, RoleChange, Standing};
use crate::platform::socket::LocalStream;
use crate::session::{ClientId, Session, SessionOutput};

#[cfg(test)]
mod tests;

const READ_CHUNK: usize = 64 * 1024;

/// The devices requests, which the connection serves itself.
const DEVICE_CHANNELS: [&str; 6] = [
    DevicesList::NAME,
    DevicesApprove::NAME,
    DevicesRevoke::NAME,
    DevicesPresence::NAME,
    DevicesRole::NAME,
    DevicesAudit::NAME,
];

/// The admin channels whose handler records what it did in the audit log
/// itself, as an entry of its own kind: approving, revoking and changing a
/// role.
const RECORDED_BY_HANDLER: [&str; 3] =
    [DevicesApprove::NAME, DevicesRevoke::NAME, DevicesRole::NAME];

/// Who asks on a connection, as the devices channels and the audit log name
/// it: its key, which is the host's own for the shell, and whether it came
/// from another computer.
#[derive(Debug, Clone)]
struct Asking {
    key: PublicKey,
    actor: AuditActor,
    away: bool,
}

/// The router that answers `caller`'s requests: every feature's handlers,
/// and `host:stop`, which records the stop asked for in `stop`. The devices
/// channels are added by [`devices_handlers`].
fn router<'a>(
    features: &'a Features,
    capabilities: CapabilitySet,
    caller: Caller,
    stop: &'a mut Option<HostStopReason>,
) -> Router<'a> {
    let mut router = Router::new(&CATALOGUE, capabilities);
    features.requests(caller, &mut router);
    router.handle::<HostStop>(move |request| {
        *stop = Some(request.reason);
        Ok(())
    });
    router
}

/// Serves the devices channels on `router` for a connection `asking`,
/// answering from `admission`. Who may ask what is the role table's to say
/// (`super::access`), before any of these is reached.
fn devices_handlers<'a>(router: &mut Router<'a>, admission: &'a Admission, asking: &'a Asking) {
    router
        .handle::<DevicesList>(|()| {
            let paired = admission.devices.devices().map_err(|err| err.to_string())?;
            Ok(DeviceListing {
                paired: paired.into_iter().map(paired_device).collect(),
                waiting: admission.pairing.list(),
            })
        })
        .handle::<DevicesApprove>(|request| {
            admission
                .pairing
                .approve(
                    &request.code,
                    request.role.into(),
                    &asking.actor,
                    asking.away,
                )
                .map(paired_device)
        })
        .handle::<DevicesRevoke>(|request| revoke(admission, &request.fingerprint, asking))
        .handle::<DevicesRole>(|request| change_role(admission, &request, asking))
        .handle::<DevicesAudit>(|query| admission.audit.page(&query).map_err(|err| err.to_string()))
        .handle::<DevicesPresence>(move |()| {
            admission.confirmations.confirm(asking.key);
            log_line!(
                "floti host: device {} confirmed its presence",
                asking.key.fingerprint()
            );
            admission.audit.record(AuditEvent::PresenceConfirmed {
                device: admission
                    .attached
                    .audit_device(&asking.key)
                    .unwrap_or_else(|| AuditDevice {
                        fingerprint: asking.key.fingerprint(),
                        name: None,
                        role: None,
                    }),
                away: asking.away,
            });
            Ok(())
        });
}

/// A paired device as an audit entry names it, with the role it has.
fn audit_device(device: &Device) -> AuditDevice {
    AuditDevice {
        fingerprint: device.key.fingerprint(),
        name: Some(device.name.clone()),
        role: Some(device.role.into()),
    }
}

/// A fingerprint as it was asked for, fit to say back.
fn shown_fingerprint(fingerprint: &str) -> String {
    fingerprint
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .collect()
}

/// Gives the device `request` names the role it names: its open connections
/// take it at once, every client is told, and the audit log records who
/// changed it from what to what. Refused, changing nothing, for a
/// fingerprint no device has, a revoked device, or the host's last admin
/// made anything else.
fn change_role(
    admission: &Admission,
    request: &ChangeDeviceRole,
    asking: &Asking,
) -> Result<PairedDevice, String> {
    let role: Role = request.role.into();
    match admission
        .devices
        .change_role(&request.fingerprint, role)
        .map_err(|err| err.to_string())?
    {
        RoleChange::Changed { device, from } => {
            admission.attached.role_changed(&device.key, device.role);
            log_line!(
                "floti host: device {} is {} now, and was {}",
                device.key.fingerprint(),
                device.role.with_article(),
                from.with_article()
            );
            admission.audit.record(AuditEvent::RoleChanged {
                device: audit_device(&device),
                from: from.into(),
                to: device.role.into(),
                by: asking.actor.clone(),
                away: asking.away,
            });
            Ok(paired_device(device))
        }
        RoleChange::Unchanged(device) => Ok(paired_device(device)),
        RoleChange::Revoked(device) => Err(format!(
            "The device \"{}\" ({}) is revoked, so it has no role to change; nothing changed.",
            device.name,
            device.key.fingerprint()
        )),
        RoleChange::LastAdmin(device) => Err(format!(
            "\"{}\" ({}) is this host's last admin, and a host keeps at least one admin; nothing changed.",
            device.name,
            device.key.fingerprint()
        )),
        RoleChange::Unknown => Err(format!(
            "No device paired with this host has the fingerprint {}; nothing changed.",
            shown_fingerprint(&request.fingerprint)
        )),
    }
}

/// Revokes the device with `fingerprint`: closes every live connection of
/// its key at once, detaches it, forgets its presence, ends none of its
/// sessions, records who revoked it, and answers with it, now revoked.
/// Refused, changing nothing, for a fingerprint no device has or one
/// already revoked.
fn revoke(
    admission: &Admission,
    fingerprint: &str,
    asking: &Asking,
) -> Result<PairedDevice, String> {
    let shown = shown_fingerprint(fingerprint);
    match admission
        .devices
        .revoke_fingerprint(fingerprint)
        .map_err(|err| err.to_string())?
    {
        Revocation::Revoked(device) => {
            admission.confirmations.forget(&device.key);
            admission.audit.record(AuditEvent::Revoked {
                device: audit_device(&device),
                by: asking.actor.clone(),
                away: asking.away,
            });
            admission.attached.revoked(&device.key);
            let closed = admission.live.close_all(&device.key);
            log_line!(
                "floti host: revoked device {} ({}); closed its {closed} live connections, and its sessions keep running",
                device.key.fingerprint(),
                device.role.with_article()
            );
            Ok(paired_device(device))
        }
        Revocation::AlreadyRevoked(device) => Err(format!(
            "The device \"{}\" ({}) was revoked already, at {}; nothing changed.",
            device.name,
            device.key.fingerprint(),
            device
                .revoked_at
                .map(|at| at.to_string())
                .unwrap_or_default()
        )),
        Revocation::Unknown => Err(format!(
            "No device paired with this host has the fingerprint {shown}; nothing changed."
        )),
    }
}

/// Every channel the host serves: what a client's requests are routed to,
/// the devices channels, and the features' events and streams.
pub(crate) fn served_channels(features: &Features) -> BTreeSet<&'static str> {
    let mut stop = None;
    let router = router(
        features,
        CapabilitySet::default(),
        Caller::admin(ClientId(0)),
        &mut stop,
    );
    let mut served: BTreeSet<&'static str> = router.handled().collect();
    served.extend(DEVICE_CHANNELS);
    served.extend(features.served_events_and_streams());
    debug_assert!(served.contains(HostStop::NAME));
    served
}

/// What the handshake needs: the host's key, the registry it checks each
/// device against, the enrolment of a first admin, the requests to pair,
/// how long a connection has to finish it, and how long it then has to say
/// `hello`; and what the devices channels answer from: each device's
/// presence, every live connection, which a revoke closes, the devices
/// attached now, and the audit log.
#[derive(Clone)]
pub(crate) struct Admission {
    pub host_key: Arc<KeyPair>,
    pub devices: Arc<DeviceRegistry>,
    pub enrolment: Arc<Enrolment>,
    pub pairing: Arc<Pairing>,
    pub deadline: Duration,
    pub hello_deadline: Duration,
    pub confirmations: Arc<Confirmations>,
    pub live: Arc<LiveConnections>,
    pub attached: Arc<Attached>,
    pub audit: Arc<AuditLog>,
}

/// A device the handshake let in.
pub(crate) struct Admitted {
    pub transport: Transport,
    /// Bytes read past the device's first message, which belong to the session.
    pub rest: Vec<u8>,
    /// The code a new device proved, held until its `hello` pairs it as the
    /// first admin; `None` for a paired device.
    pub enrolling: Option<Claim>,
    /// The role it is paired with, or will be once it enrols; a viewer's,
    /// which nothing reads, for a device asking to pair and for the shell.
    pub role: Role,
    /// The key it proved.
    pub device: PublicKey,
    /// What it was let in as.
    pub entry: Entry,
}

/// What a connection was let in as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Entry {
    /// A paired device, or one enrolling as the first admin: a client.
    Device,
    /// A device the registry does not know, asking to pair.
    Pairing,
    /// The host's own key: `floti devices` in a shell on its computer.
    Shell,
}

/// Why a connection was closed before `hello`, as the host's log says it.
enum Refusal {
    Unknown(PublicKey),
    Revoked(PublicKey),
    Unchecked(PublicKey, crate::Error),
    Failed(NoiseError),
    TimedOut(Duration),
    /// The device finished the handshake and said no `hello` within the
    /// deadline.
    NoHello(PublicKey, Duration),
    /// A paired device asked to pair.
    PairedAsks(PublicKey),
    /// A device asked to pair while as many requests as may wait did.
    TooManyWaiting(PublicKey),
    /// The connection ended during its handshake; `sent` says whether it
    /// sent any byte first.
    Ended {
        sent: bool,
    },
    ReadFailed(std::io::Error),
}

impl Refusal {
    /// Why, in the audit log's fixed sentence, with the fingerprint of the
    /// key the handshake proved; `None` for a connection that ended before
    /// sending a byte, which is not recorded.
    fn audited(&self) -> Option<(&'static str, Option<String>)> {
        let (reason, key) = match self {
            Self::Unknown(key) => ("An unknown key", Some(key)),
            Self::Revoked(key) => ("A revoked key", Some(key)),
            Self::Unchecked(key, _) => ("The device registry could not be read", Some(key)),
            Self::Failed(_) => ("The handshake failed", None),
            Self::TimedOut(_) => ("The handshake ran out of time", None),
            Self::NoHello(key, _) => ("No hello came in time", Some(key)),
            Self::PairedAsks(key) => ("A paired device asked to pair", Some(key)),
            Self::TooManyWaiting(key) => ("Too many requests to pair were waiting", Some(key)),
            Self::Ended { sent: false } => return None,
            Self::Ended { sent: true } => ("The connection ended during its handshake", None),
            Self::ReadFailed(_) => ("The handshake could not be read", None),
        };
        Some((reason, key.map(PublicKey::fingerprint)))
    }
}

/// Closes `client`'s connection for `refusal`, as it already is: the host's
/// log says why, and the audit log records it unless the connection sent
/// nothing. `away` says it came from another computer.
fn refuse(admission: &Admission, client: ClientId, refusal: &Refusal, away: bool) {
    log_line!("floti host: refused client {}: {refusal}", client.0);
    if let Some((reason, fingerprint)) = refusal.audited() {
        admission.audit.record(AuditEvent::Refused {
            reason: reason.to_owned(),
            fingerprint,
            away,
        });
    }
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unknown(key) => write!(f, "unknown device {}", key.fingerprint()),
            Self::Revoked(key) => write!(f, "revoked device {}", key.fingerprint()),
            Self::Unchecked(key, err) => write!(
                f,
                "device {} could not be checked against the registry: {err}",
                key.fingerprint()
            ),
            Self::Failed(err) => write!(f, "failed handshake: {err}"),
            Self::TimedOut(deadline) => {
                write!(f, "the handshake did not finish in time ({deadline:?})")
            }
            Self::NoHello(key, deadline) => write!(
                f,
                "device {} did not say hello in time ({deadline:?})",
                key.fingerprint()
            ),
            Self::PairedAsks(key) => {
                write!(
                    f,
                    "device {} asks to pair but is paired already",
                    key.fingerprint()
                )
            }
            Self::TooManyWaiting(key) => write!(
                f,
                "device {} asks to pair while {MAX_WAITING} requests wait",
                key.fingerprint()
            ),
            Self::Ended { .. } => write!(f, "the connection ended before the handshake finished"),
            Self::ReadFailed(err) => write!(f, "the handshake could not be read: {err}"),
        }
    }
}

/// What the connection needs from the host.
pub(crate) struct ConnectionContext {
    pub features: Arc<Features>,
    /// Where the client is counted as attached, with its device.
    pub hosted: Arc<Hosted>,
    pub admission: Admission,
    pub identity: Arc<HostIdentity>,
    pub stopper: Stopper,
    pub shutdown: watch::Receiver<bool>,
}

/// One session terminal open on this connection.
struct OpenStream {
    session: Arc<Session>,
    /// The client's credit for input on it.
    input: CreditReceiver,
    forward: JoinHandle<()>,
}

/// Serves one client until it disconnects, its device is revoked or the
/// host stops. `away` says it was accepted on the relay endpoint: it reached
/// the host from another computer.
pub(crate) async fn serve(
    mut stream: LocalStream,
    client: ClientId,
    away: bool,
    context: ConnectionContext,
) {
    let mut shutdown = context.shutdown;
    let admitted = admit_within_deadline(&mut stream, &context.admission, &mut shutdown).await;
    let Admitted {
        transport,
        rest,
        enrolling,
        role,
        device,
        entry,
    } = match admitted {
        Ok(admitted) => admitted,
        Err(refusal) => {
            // A host stopping closes a handshake in flight without a word.
            if let Some(refusal) = refusal {
                refuse(&context.admission, client, &refusal, away);
            }
            return;
        }
    };
    if entry != Entry::Device {
        if let Some(mut sealed) = Sealed::new(stream, transport, &rest) {
            sealed.away = away;
            let serving = (&*context.identity, &context.admission, &mut shutdown);
            match entry {
                Entry::Pairing => serve_pairing(sealed, client, device, serving).await,
                Entry::Shell | Entry::Device => serve_shell(sealed, client, device, serving).await,
            }
        }
        return;
    }
    let (sealer, opener) = transport.split();
    let (reader, writer) = tokio::io::split(stream);
    let mut connection = Connection {
        reader,
        writer,
        sealer,
        opener,
        decoder: FrameDecoder::new(),
        client,
        role,
        device,
        name: String::new(),
        away,
        admission: context.admission.clone(),
        features: context.features,
        stopper: context.stopper,
        outbox: Outbox::new(),
        snapshot_seq: HashMap::new(),
        streams: HashMap::new(),
        closing: BTreeSet::new(),
        stop_after_flush: None,
        later: Vec::new(),
    };
    if connection.received(&rest).is_err() {
        return;
    }
    let Some(channels) = connection
        .hello(
            &context.identity,
            device,
            enrolling,
            context.admission.hello_deadline,
            &mut shutdown,
        )
        .await
    else {
        return;
    };
    // Entered before the registry is read again, so a revoke that lands
    // between the handshake and here closes the connection either way.
    let mut live = context.admission.live.enter(device, client);
    let paired = match context.admission.devices.device(&device) {
        Ok(Some(paired)) if paired.standing() == Standing::Paired => paired,
        Ok(Some(_)) => return refuse(&context.admission, client, &Refusal::Revoked(device), away),
        Ok(None) => return refuse(&context.admission, client, &Refusal::Unknown(device), away),
        Err(err) => {
            return refuse(
                &context.admission,
                client,
                &Refusal::Unchecked(device, err),
                away,
            );
        }
    };
    // Its role from here on is the one the attached devices hold, which a
    // role change updates.
    let attachment = context.admission.attached.enter(&paired, client, away);
    connection.name = paired.name;
    context.hosted.attach_client(client, device);
    connection.run(channels, shutdown, &mut live).await;
    drop(live);
    drop(attachment);
    connection.detach_all();
    connection.features.events().leave(client);
    connection.features.client_left(client);
    // Last: a host that exits once nobody is attached hears it only when
    // everything the client held has been let go.
    context.hosted.detach_client(client);
}

/// [`admit`], cut off at the admission's deadline.
async fn admit_within_deadline(
    stream: &mut (impl AsyncRead + AsyncWrite + Unpin),
    admission: &Admission,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<Admitted, Option<Refusal>> {
    tokio::time::timeout(admission.deadline, admit(stream, admission, shutdown))
        .await
        .unwrap_or(Err(Some(Refusal::TimedOut(admission.deadline))))
}

/// The responder's half of the handshake, on the raw stream. The error is why
/// the device was refused, or `None` when the host is stopping. A new device
/// that proved the code holds it from before the host answers; a failure from
/// there on, or the handshake being cut off, lets go of it with nothing paired.
async fn admit(
    stream: &mut (impl AsyncRead + AsyncWrite + Unpin),
    admission: &Admission,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<Admitted, Option<Refusal>> {
    let mut responder =
        Responder::new(&admission.host_key).map_err(|err| Some(Refusal::Failed(err)))?;
    let mut buf = vec![0; READ_CHUNK];
    // Whether the connection has sent anything: one that ends before it
    // does is not recorded.
    let mut sent = false;
    loop {
        let n = tokio::select! {
            read = stream.read(&mut buf) => match read {
                Ok(0) => return Err(Some(Refusal::Ended { sent })),
                Ok(n) => n,
                Err(err) if is_closed(&err) => return Err(Some(Refusal::Ended { sent })),
                Err(err) => return Err(Some(Refusal::ReadFailed(err))),
            },
            _ = shutdown.changed() => return Err(None),
        };
        sent = true;
        match responder.push(&buf[..n]) {
            Ok(ResponderStep::Pending(next)) => responder = next,
            Ok(ResponderStep::Received { device, used }) => {
                let key = device.device_key();
                let (enrolling, role, entry) = entry_of(&device, admission)?;
                let (transport, answer) =
                    device.accept().map_err(|err| Some(Refusal::Failed(err)))?;
                stream
                    .write_all(&answer)
                    .await
                    .map_err(|err| Some(Refusal::ReadFailed(err)))?;
                return Ok(Admitted {
                    transport,
                    rest: buf[used..n].to_vec(),
                    enrolling,
                    role,
                    device: key,
                    entry,
                });
            }
            Err(err) => return Err(Some(Refusal::Failed(err))),
        }
    }
}

/// What `device`, whose first message the host has read, is let in as: the
/// code it holds while it enrols, its role and its entry; or why it is
/// refused.
fn entry_of(
    device: &PendingDevice,
    admission: &Admission,
) -> Result<(Option<Claim>, Role, Entry), Option<Refusal>> {
    let key = device.device_key();
    if key == admission.host_key.public() {
        // Only a process that can read the host's key file holds it, and it
        // asks for nothing else.
        if device.asks_to_pair() || device.enrolment_code().is_some() {
            return Err(Some(Refusal::Unknown(key)));
        }
        return Ok((None, Role::Viewer, Entry::Shell));
    }
    // Read fresh: a device paired or revoked since the last connection
    // counts from this one.
    match admission.devices.device(&key) {
        Ok(Some(paired)) if paired.standing() == Standing::Paired => {
            if device.asks_to_pair() {
                return Err(Some(Refusal::PairedAsks(key)));
            }
            Ok((None, paired.role, Entry::Device))
        }
        Ok(Some(_)) => Err(Some(Refusal::Revoked(key))),
        Ok(None) if device.asks_to_pair() => {
            if admission.pairing.has_room() {
                Ok((None, Role::Viewer, Entry::Pairing))
            } else {
                Err(Some(Refusal::TooManyWaiting(key)))
            }
        }
        Ok(None) => {
            let Some(code) = device.enrolment_code() else {
                admission.pairing.withdraw_key(&key);
                return Err(Some(Refusal::Unknown(key)));
            };
            match admission.enrolment.claim(&admission.devices, key, code) {
                Ok(Some(claim)) => Ok((Some(claim), Role::Admin, Entry::Device)),
                Ok(None) => Err(Some(Refusal::Unknown(key))),
                Err(err) => Err(Some(Refusal::Unchecked(key, err))),
            }
        }
        Err(err) => Err(Some(Refusal::Unchecked(key, err))),
    }
}

/// [`read_hello`], cut off `deadline` after it starts, which is as soon as
/// the host's answer to `device`'s handshake has been written. The error is
/// why the device was refused, or `None` when it went, sent something other
/// than `hello`, or the host is stopping. Nothing is written either way.
async fn hello_within_deadline(
    reader: &mut (impl AsyncRead + Unpin),
    opener: &mut Opener,
    decoder: &mut FrameDecoder,
    device: PublicKey,
    deadline: Duration,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<Hello, Option<Refusal>> {
    match tokio::time::timeout(deadline, read_hello(reader, opener, decoder, shutdown)).await {
        Ok(Some(hello)) => Ok(hello),
        Ok(None) => Err(None),
        Err(_) => Err(Some(Refusal::NoHello(device, deadline))),
    }
}

/// Reads the client's first message, opened and decoded after whatever
/// `decoder` already holds: its `hello`, or `None` when it went, sent
/// anything else first (a client that does not speak the protocol), sent a
/// frame that does not open, or the host is stopping.
async fn read_hello(
    reader: &mut (impl AsyncRead + Unpin),
    opener: &mut Opener,
    decoder: &mut FrameDecoder,
    shutdown: &mut watch::Receiver<bool>,
) -> Option<Hello> {
    let mut buf = vec![0; READ_CHUNK];
    loop {
        match decoder.next_message() {
            Ok(Some(Message::Hello(hello))) => return Some(hello),
            Ok(Some(_)) | Err(_) => return None,
            Ok(None) => {}
        }
        tokio::select! {
            read = reader.read(&mut buf) => match read {
                Ok(0) | Err(_) => return None,
                Ok(n) => decoder.push(&opener.open(&buf[..n]).ok()?),
            },
            _ = shutdown.changed() => return None,
        }
    }
}

/// What a connection that is not a client's is served with: the host's
/// identity, its admission, and its shutdown.
type Serving<'a> = (
    &'a HostIdentity,
    &'a Admission,
    &'a mut watch::Receiver<bool>,
);

/// A connection's session on a stream of any kind, for the connections that
/// are not a client's: a device asking to pair, and the host's own shell.
struct Sealed<S> {
    reader: ReadHalf<S>,
    writer: WriteHalf<S>,
    sealer: Sealer,
    opener: Opener,
    decoder: FrameDecoder,
    /// Whether it reached the host from another computer.
    away: bool,
}

impl<S: AsyncRead + AsyncWrite> Sealed<S> {
    /// The session on `stream` once `transport`'s handshake is done, with
    /// `rest`, the bytes read past it; `None` when they do not open.
    fn new(stream: S, transport: Transport, rest: &[u8]) -> Option<Self> {
        let (sealer, mut opener) = transport.split();
        let mut decoder = FrameDecoder::new();
        decoder.push(&opener.open(rest).ok()?);
        let (reader, writer) = tokio::io::split(stream);
        Some(Self {
            reader,
            writer,
            sealer,
            opener,
            decoder,
            away: false,
        })
    }

    /// `device`'s `hello`, within the admission's deadline; `None` when it
    /// did not come, which the log and the audit log say naming the device
    /// when it ran out of time.
    async fn hello(
        &mut self,
        client: ClientId,
        device: PublicKey,
        admission: &Admission,
        shutdown: &mut watch::Receiver<bool>,
    ) -> Option<Hello> {
        match hello_within_deadline(
            &mut self.reader,
            &mut self.opener,
            &mut self.decoder,
            device,
            admission.hello_deadline,
            shutdown,
        )
        .await
        {
            Ok(hello) => Some(hello),
            Err(refusal) => {
                if let Some(refusal) = refusal {
                    refuse(admission, client, &refusal, self.away);
                }
                None
            }
        }
    }

    async fn write(&mut self, message: &Message) -> std::io::Result<()> {
        let frame = encode_frame(message).map_err(std::io::Error::other)?;
        let sealed = self.sealer.seal(&frame).map_err(std::io::Error::other)?;
        self.writer.write_all(&sealed).await?;
        self.writer.flush().await
    }

    /// The client's next message; `None` once it has gone, its session or
    /// framing failed, or the host is stopping.
    async fn next(&mut self, shutdown: &mut watch::Receiver<bool>) -> Option<Message> {
        let mut buf = vec![0; READ_CHUNK];
        loop {
            match self.decoder.next_message() {
                Ok(Some(message)) => return Some(message),
                Ok(None) => {}
                Err(ProtocolError::FrameTooLarge { .. }) => return None,
                // A frame that did not decode is skipped.
                Err(_) => continue,
            }
            tokio::select! {
                read = self.reader.read(&mut buf) => match read {
                    Ok(0) | Err(_) => return None,
                    Ok(n) => self.decoder.push(&self.opener.open(&buf[..n]).ok()?),
                },
                _ = shutdown.changed() => return None,
            }
        }
    }

    /// Returns once the client sends anything at all, goes, or the host is
    /// stopping.
    async fn anything(&mut self, shutdown: &mut watch::Receiver<bool>) {
        if !matches!(self.decoder.next_message(), Ok(None)) {
            return;
        }
        let mut buf = [0; 1];
        tokio::select! {
            _ = self.reader.read(&mut buf) => {}
            _ = shutdown.changed() => {}
        }
    }

    /// Closes the writing side once what was written has gone.
    async fn close(mut self) {
        let _ = self.writer.shutdown().await;
    }
}

/// A device asking to pair, from its `hello` until its request is approved,
/// expires or is withdrawn. Its `hello` is answered with the code to show,
/// or refused as any client's is; from then on nothing it sends is answered,
/// and anything it sends ends the connection, withdrawing the request.
async fn serve_pairing<S: AsyncRead + AsyncWrite>(
    mut sealed: Sealed<S>,
    client: ClientId,
    device: PublicKey,
    (identity, admission, shutdown): Serving<'_>,
) {
    let Some(hello) = sealed.hello(client, device, admission, shutdown).await else {
        return;
    };
    let (answer, capabilities) = identity.answer(&hello);
    if capabilities.is_none() {
        if sealed.write(&answer).await.is_ok() {
            sealed.close().await;
        }
        return;
    }
    let Ok(mut waiting) =
        admission
            .pairing
            .ask(device, &hello.client.name, hello.client.kind, sealed.away)
    else {
        return refuse(
            admission,
            client,
            &Refusal::TooManyWaiting(device),
            sealed.away,
        );
    };
    let told = PairingStatus::Waiting(PairingWaiting {
        code: waiting.code().as_str().to_owned(),
        expires_in_seconds: waiting.seconds_left(),
    });
    if sealed.write(&Message::Pairing(told)).await.is_err() {
        return;
    }
    let outcome = tokio::select! {
        outcome = waiting.outcome() => outcome,
        () = sealed.anything(shutdown) => None,
    };
    let told = match outcome {
        Some(Outcome::Approved(role)) => {
            PairingStatus::Approved(PairingApproved { role: role.into() })
        }
        Some(Outcome::Expired) => PairingStatus::Expired,
        // Withdrawn: the connection ends without another byte.
        None => return,
    };
    if sealed.write(&Message::Pairing(told)).await.is_ok() {
        sealed.close().await;
    }
}

/// The host's own shell: the devices channels, who is attached now as one
/// snapshot, and every other request refused, until it goes. It is never
/// asked for presence, and it is not a device: it is never attached.
async fn serve_shell<S: AsyncRead + AsyncWrite>(
    mut sealed: Sealed<S>,
    client: ClientId,
    device: PublicKey,
    (identity, admission, shutdown): Serving<'_>,
) {
    const SERVED: &str = "The host's own shell is served `devices:list`, `devices:approve`, \
                          `devices:revoke`, `devices:role`, `devices:audit` and a snapshot of \
                          `devices:attached` only.";
    let Some(hello) = sealed.hello(client, device, admission, shutdown).await else {
        return;
    };
    let (answer, capabilities) = identity.answer(&hello);
    if sealed.write(&answer).await.is_err() {
        return;
    }
    let Some(capabilities) = capabilities else {
        return sealed.close().await;
    };
    while let Some(message) = sealed.next(shutdown).await {
        let answer = match message {
            Message::Request(request) => {
                if request.channel != DevicesPresence::NAME
                    && DEVICE_CHANNELS.contains(&request.channel.as_str())
                {
                    let asking = Asking {
                        key: device,
                        actor: AuditActor::HostShell,
                        away: false,
                    };
                    shell_router(admission, capabilities, &asking).dispatch(&request)
                } else {
                    Message::Error(ErrorReply {
                        id: request.id,
                        channel: request.channel,
                        code: ErrorCode::Unavailable,
                        message: SERVED.to_owned(),
                    })
                }
            }
            Message::Subscribe(subscribe)
                if subscribe.channel == <DevicesAttached as EventChannel>::NAME =>
            {
                match floti_protocol::channel::to_payload(&admission.attached.state()) {
                    Ok(state) => Message::Snapshot(Snapshot {
                        subscription: subscribe.subscription,
                        seq: 0,
                        state,
                    }),
                    Err(err) => Message::SubscriptionError(SubscriptionError {
                        subscription: subscribe.subscription,
                        channel: subscribe.channel,
                        code: ErrorCode::Unavailable,
                        message: err.to_string(),
                    }),
                }
            }
            Message::Subscribe(subscribe) => Message::SubscriptionError(SubscriptionError {
                subscription: subscribe.subscription,
                channel: subscribe.channel,
                code: ErrorCode::Unavailable,
                message: SERVED.to_owned(),
            }),
            Message::StreamOpen(open) => Message::StreamClose(StreamClose {
                stream: open.stream,
                reason: Some(SERVED.to_owned()),
            }),
            _ => continue,
        };
        if sealed.write(&answer).await.is_err() {
            return;
        }
    }
}

/// What answers the host's own shell, `asking` as itself: the devices
/// channels, served.
fn shell_router<'a>(
    admission: &'a Admission,
    capabilities: CapabilitySet,
    asking: &'a Asking,
) -> Router<'a> {
    let mut router = Router::new(&CATALOGUE, capabilities);
    devices_handlers(&mut router, admission, asking);
    router
}

/// A registry entry as the devices channels describe it: named by its
/// key's fingerprint, never the key.
fn paired_device(device: Device) -> PairedDevice {
    PairedDevice {
        name: device.name,
        role: device.role.into(),
        paired_at: device.paired_at.to_string(),
        revoked_at: device.revoked_at.map(|at| at.to_string()),
        fingerprint: device.key.fingerprint(),
    }
}

/// The audit entry of an admin action on `channel`, which does `doing`,
/// asked by `asking`, with `outcome`: its channel's name and its rule's
/// sentence, never anything the request carried.
fn admin_action(channel: &str, doing: &str, asking: &Asking, outcome: AdminOutcome) -> AuditEvent {
    AuditEvent::AdminAction {
        channel: channel.to_owned(),
        doing: doing.to_owned(),
        by: asking.actor.clone(),
        away: asking.away,
        outcome,
    }
}

/// `answer`, recording `done` in `audit` once it turns out to be a
/// response: an admin action whose feature answered with an error changed
/// nothing and is not recorded.
fn recorded_when_done(answer: Routed, audit: Arc<AuditLog>, done: AuditEvent) -> Routed {
    match answer {
        Routed::Now(message) => {
            if matches!(message, Message::Response(_)) {
                audit.record(done);
            }
            Routed::Now(message)
        }
        Routed::Later(later) => Routed::Later(Box::pin(async move {
            let message = later.await;
            if matches!(message, Message::Response(_)) {
                audit.record(done);
            }
            message
        })),
    }
}

/// A read error that is the client having gone: what a pipe reports on
/// Windows where a Unix socket reads as ended.
fn is_closed(err: &std::io::Error) -> bool {
    matches!(
        err.kind(),
        std::io::ErrorKind::BrokenPipe
            | std::io::ErrorKind::ConnectionReset
            | std::io::ErrorKind::ConnectionAborted
    )
}

struct Connection {
    reader: ReadHalf<LocalStream>,
    writer: WriteHalf<LocalStream>,
    /// Seals every frame written.
    sealer: Sealer,
    /// Opens every byte read, before the frames in it are decoded.
    opener: Opener,
    decoder: FrameDecoder,
    client: ClientId,
    /// The role its device was paired with at its handshake; from its
    /// welcome on, [`Connection::role`] reads the role it has now.
    role: Role,
    /// The key its device proved.
    device: PublicKey,
    /// The name its device was paired under, once it is attached.
    name: String,
    /// Whether it reached the host from another computer.
    away: bool,
    /// What the devices channels answer from.
    admission: Admission,
    features: Arc<Features>,
    stopper: Stopper,
    outbox: Outbox,
    /// For each subscription that started with a snapshot, the number of the
    /// last event it included: publications up to it are already covered.
    snapshot_seq: HashMap<u64, u64>,
    streams: HashMap<u64, OpenStream>,
    /// Streams whose session has ended, closed once their output is sent.
    closing: BTreeSet<u64>,
    /// A stop a client asked for, reserved when it was answered and carried
    /// out once the answer has been sent.
    stop_after_flush: Option<ReservedStop>,
    /// Answers routed to be worked out, not yet handed to the loop that
    /// waits on them.
    later: Vec<LaterAnswer>,
}

/// An answer a feature is still working out: the message it comes to.
type LaterAnswer = std::pin::Pin<Box<dyn std::future::Future<Output = Message> + Send>>;

/// Why the connection ends.
enum End {
    Gone,
}

impl Connection {
    /// The role its device has now: changed while it is connected, the new
    /// one holds from this connection's next message.
    fn role(&self) -> Role {
        self.admission
            .attached
            .role(&self.device)
            .unwrap_or(self.role)
    }

    /// Who asks on this connection, as the devices channels and the audit
    /// log name it.
    fn asking(&self) -> Asking {
        Asking {
            key: self.device,
            actor: AuditActor::Device {
                fingerprint: self.device.fingerprint(),
                name: self.name.clone(),
            },
            away: self.away,
        }
    }

    /// Records an admin action on `channel`, which does `doing`, with
    /// `outcome`.
    fn record_admin_action(&self, channel: &str, doing: &str, outcome: AdminOutcome) {
        self.admission
            .audit
            .record(admin_action(channel, doing, &self.asking(), outcome));
    }

    /// Opens `bytes` from the client and decodes the frames in them. An
    /// error is a session that failed: nothing more from it can be trusted.
    fn received(&mut self, bytes: &[u8]) -> Result<(), End> {
        let opened = self.opener.open(bytes).map_err(|_| End::Gone)?;
        self.decoder.push(&opened);
        Ok(())
    }

    /// Waits up to `deadline` for `device`'s `hello` and answers it. The
    /// capabilities the client was welcomed with, or `None` when it was
    /// refused, went away or said nothing in time, which the log says
    /// naming the device.
    ///
    /// A device `enrolling` is paired as the first admin when its `hello` is
    /// welcomed, before the welcome is written: by then it has read the
    /// host's answer and pinned the key. Going away, being refused or
    /// running out of time before that drops the claim, which keeps the code.
    async fn hello(
        &mut self,
        identity: &HostIdentity,
        device: PublicKey,
        enrolling: Option<Claim>,
        deadline: Duration,
        shutdown: &mut watch::Receiver<bool>,
    ) -> Option<ClientChannels<'static>> {
        let hello = match hello_within_deadline(
            &mut self.reader,
            &mut self.opener,
            &mut self.decoder,
            device,
            deadline,
            shutdown,
        )
        .await
        {
            Ok(hello) => hello,
            Err(refusal) => {
                if let Some(refusal) = refusal {
                    refuse(&self.admission, self.client, &refusal, self.away);
                }
                return None;
            }
        };
        let (mut answer, capabilities) = identity.answer(&hello);
        if let Message::Welcome(welcome) = &mut answer {
            welcome.role = Some(self.role.into());
            welcome.away = self.away;
            welcome.device = Some(self.device.fingerprint());
        }
        if capabilities.is_some()
            && let Some(claim) = enrolling
            && !self.enrol(claim)
        {
            return None;
        }
        self.write(&answer).await.ok()?;
        capabilities.map(|caps| ClientChannels::new(&CATALOGUE, caps))
    }

    /// Pairs the device holding `claim` as the first admin and says so in the
    /// log and the audit log, never with the code: whether it was. One that
    /// was not is refused as an unknown device.
    fn enrol(&self, claim: Claim) -> bool {
        let key = claim.key();
        let refusal = match claim.commit() {
            Ok(Some(device)) => {
                log_line!(
                    "floti host: enrolled device {} as the first admin, named \"{FIRST_ADMIN_NAME}\"",
                    key.fingerprint()
                );
                self.admission.audit.record(AuditEvent::Enrolled {
                    device: audit_device(&device),
                });
                return true;
            }
            Ok(None) => Refusal::Unknown(key),
            Err(err) => Refusal::Unchecked(key, err),
        };
        refuse(&self.admission, self.client, &refusal, self.away);
        false
    }

    async fn run(
        &mut self,
        mut channels: ClientChannels<'static>,
        mut shutdown: watch::Receiver<bool>,
        live: &mut Live,
    ) {
        let (output_tx, mut output_rx) = mpsc::unbounded_channel::<(u64, SessionOutput)>();
        let mut events = self.features.events().listen(self.client);
        let mut buf = vec![0; READ_CHUNK];
        // Answers still being worked out. Dropped with the connection, which
        // drops their work with them.
        let mut later = JoinSet::new();
        loop {
            for answer in self.later.drain(..) {
                later.spawn(answer);
            }
            if self.flush().await.is_err() {
                return;
            }
            // Dropping the reserved stop carries it out.
            drop(self.stop_after_flush.take());
            let ended = tokio::select! {
                read = self.reader.read(&mut buf) => match read {
                    Ok(0) | Err(_) => Err(End::Gone),
                    Ok(n) => self
                        .received(&buf[..n])
                        .and_then(|()| self.take_messages(&mut channels, &output_tx)),
                },
                Some((stream, output)) = output_rx.recv() => {
                    self.session_output(stream, output);
                    Ok(())
                }
                Some(answered) = later.join_next(), if !later.is_empty() => {
                    // An answer whose work panicked is lost; the client's
                    // request is the one that waits.
                    if let Ok(answer) = answered {
                        self.outbox.push(answer);
                    }
                    Ok(())
                }
                published = events.recv() => {
                    match published {
                        Ok(published) => self.publication(&channels, published),
                        // Missed events: the client sees a gap in the numbers
                        // and subscribes again.
                        Err(broadcast::error::RecvError::Lagged(_)) => {}
                        Err(broadcast::error::RecvError::Closed) => {}
                    }
                    Ok(())
                }
                _ = shutdown.changed() => Err(End::Gone),
                () = live.closed() => {
                    log_line!(
                        "floti host: closed client {}: its device {} was revoked",
                        self.client.0,
                        self.device.fingerprint()
                    );
                    Err(End::Gone)
                }
            };
            if ended.is_err() {
                // Whatever is already queued, such as the answer to a stop,
                // still goes out.
                let _ = self.flush().await;
                return;
            }
        }
    }

    /// Handles every whole message received so far.
    fn take_messages(
        &mut self,
        channels: &mut ClientChannels<'static>,
        output_tx: &mpsc::UnboundedSender<(u64, SessionOutput)>,
    ) -> Result<(), End> {
        loop {
            match self.decoder.next_message() {
                Ok(Some(message)) => self.message(channels, message, output_tx),
                Ok(None) => return Ok(()),
                // The framing is lost for good: nothing more can be read.
                Err(ProtocolError::FrameTooLarge { .. }) => return Err(End::Gone),
                // A frame that did not decode is skipped; the next one
                // starts where its length said.
                Err(_) => {}
            }
        }
    }

    fn message(
        &mut self,
        channels: &mut ClientChannels<'static>,
        message: Message,
        output_tx: &mpsc::UnboundedSender<(u64, SessionOutput)>,
    ) {
        match message {
            Message::Request(request) => match self.answer(channels, &request) {
                Routed::Now(answer) => self.outbox.push(answer),
                Routed::Later(answer) => self.later.push(answer),
            },
            Message::Subscribe(subscribe) => {
                self.subscribe(channels, &subscribe);
                self.features.subscriptions_changed(self.client, channels);
            }
            Message::Unsubscribe(unsubscribe) => {
                channels.unsubscribe(unsubscribe.subscription);
                self.snapshot_seq.remove(&unsubscribe.subscription);
                self.features.subscriptions_changed(self.client, channels);
            }
            Message::StreamOpen(open) => self.open_stream(channels, &open, output_tx),
            Message::StreamData(data) => self.input(&data),
            Message::StreamCredit(credit) => {
                // Credit for a stream already closed is nothing to act on.
                let _ = self.outbox.grant(&credit);
            }
            Message::StreamClose(close) => self.close_stream(close.stream, None, false),
            // A second hello, or a message only a host sends, means nothing
            // from a client.
            _ => {}
        }
    }

    /// The answer to one request: an error naming the channel when it is not
    /// served yet, otherwise the features', now or once its work is done.
    fn answer(&mut self, channels: &ClientChannels<'static>, request: &Request) -> Routed {
        if let Some(later) = unserved::later(&request.channel) {
            return Routed::Now(Message::Error(ErrorReply {
                id: request.id,
                channel: request.channel.clone(),
                code: ErrorCode::Unavailable,
                message: unserved::refusal(&request.channel, later),
            }));
        }
        // An admin action, which the audit log records done or refused.
        let mut audited = rule(&request.channel).filter(|rule| rule.audited());
        if CATALOGUE
            .get(&request.channel)
            .is_some_and(|decl| decl.kind() == ChannelKind::Request)
        {
            let itself = request.channel == DevicesRevoke::NAME
                && from_payload::<RevokeDevice>(&request.payload).is_ok_and(|revoke| {
                    revoke
                        .fingerprint
                        .trim()
                        .eq_ignore_ascii_case(&self.device.fingerprint())
                });
            if let Some((code, message)) = self.refused(&request.channel, itself) {
                if let Some(rule) = audited {
                    let outcome = if code == ErrorCode::PresenceNeeded {
                        AdminOutcome::RefusedForPresence
                    } else {
                        AdminOutcome::RefusedForRole
                    };
                    self.record_admin_action(&request.channel, rule.doing, outcome);
                }
                return Routed::Now(Message::Error(ErrorReply {
                    id: request.id,
                    channel: request.channel.clone(),
                    code,
                    message,
                }));
            }
        } else {
            audited = None;
        }
        let mut stop = None;
        let caller = Caller {
            client: self.client,
            role: self.role(),
        };
        let asking = self.asking();
        let mut router = router(&self.features, channels.capabilities(), caller, &mut stop);
        devices_handlers(&mut router, &self.admission, &asking);
        let mut answer = router.route(request);
        drop(router);
        if let Some(rule) = audited
            && !RECORDED_BY_HANDLER.contains(&request.channel.as_str())
        {
            answer = recorded_when_done(
                answer,
                Arc::clone(&self.admission.audit),
                admin_action(&request.channel, rule.doing, &asking, AdminOutcome::Done),
            );
        }
        // Taken before the answer is queued, so nothing asked once the client
        // has its answer replaces it. A later stop finds it taken and is
        // answered all the same. `host:stop` is answered at once.
        if matches!(answer, Routed::Now(Message::Response(_)))
            && let Some(reserved) = stop.and_then(|reason| self.stopper.reserve(reason))
        {
            self.stop_after_flush = Some(reserved);
        }
        answer
    }

    /// Why this connection may not use `channel`, by its role and, for an
    /// admin action from another computer, its presence: the error's code
    /// and sentence. `None` when it may. `itself` says the request names
    /// this connection's own device.
    fn refused(&self, channel: &str, itself: bool) -> Option<(ErrorCode, String)> {
        let asker = Asker {
            role: self.role(),
            away: self.away,
            present: self.away && self.admission.confirmations.recent(&self.device),
        };
        match gate(channel, asker, itself) {
            Gate::Open => None,
            Gate::NotPermitted(sentence) => Some((ErrorCode::NotPermitted, sentence)),
            Gate::PresenceNeeded => Some((ErrorCode::PresenceNeeded, PRESENCE_NEEDED.to_owned())),
        }
    }

    /// Starts a subscription: with its channel's state when it carries one,
    /// with nothing until the next event when it does not.
    fn subscribe(&mut self, channels: &mut ClientChannels<'static>, subscribe: &Subscribe) {
        let subscription = subscribe.subscription;
        self.snapshot_seq.remove(&subscription);
        let refuse = |message: String| {
            Message::SubscriptionError(SubscriptionError {
                subscription,
                channel: subscribe.channel.clone(),
                code: ErrorCode::Unavailable,
                message,
            })
        };
        if let Some(later) = unserved::later(&subscribe.channel) {
            // A number reused for this one ends what it was before.
            channels.unsubscribe(subscription);
            return self
                .outbox
                .push(refuse(unserved::refusal(&subscribe.channel, later)));
        }
        if CATALOGUE.get(&subscribe.channel).is_some()
            && let Some((code, message)) = self.refused(&subscribe.channel, false)
        {
            channels.unsubscribe(subscription);
            return self
                .outbox
                .push(Message::SubscriptionError(SubscriptionError {
                    subscription,
                    channel: subscribe.channel.clone(),
                    code,
                    message,
                }));
        }
        let decl = match channels.subscribe(subscribe) {
            Ok(decl) => decl,
            Err(refusal) => return self.outbox.push(Message::SubscriptionError(refusal)),
        };
        match self.features.events().start(decl.name()) {
            Some(Start::Snapshot { seq, state }) => {
                self.snapshot_seq.insert(subscription, seq);
                self.outbox.push(Message::Snapshot(Snapshot {
                    subscription,
                    seq,
                    state,
                }));
            }
            Some(Start::Quiet) => {}
            None => {
                channels.unsubscribe(subscription);
                self.outbox.push(refuse(format!(
                    "This host does not serve `{}`.",
                    decl.name()
                )));
            }
        }
    }

    /// One publication, to each of this client's subscriptions to its
    /// channel that its snapshot did not already cover, unless it is
    /// addressed to another client.
    fn publication(&mut self, channels: &ClientChannels<'static>, published: Publication) {
        if !published.is_for(self.client) {
            return;
        }
        // A device whose role changed since it subscribed is sent only what
        // its role now allows.
        if !role_allows(published.channel, self.role()) {
            return;
        }
        for subscription in channels.subscriptions_to(published.channel) {
            if self
                .snapshot_seq
                .get(&subscription)
                .is_some_and(|covered| published.seq <= *covered)
            {
                continue;
            }
            self.outbox.push(Message::Event(Event {
                subscription,
                seq: published.seq,
                payload: published.payload.clone(),
            }));
        }
    }

    /// Opens a terminal stream: the feature serving its channel attaches the
    /// client, and the stream carries the screen, then the live output; what
    /// the client sends on it is typed.
    fn open_stream(
        &mut self,
        channels: &ClientChannels<'static>,
        open: &StreamOpen,
        output_tx: &mpsc::UnboundedSender<(u64, SessionOutput)>,
    ) {
        let refuse = |reason: String| {
            Message::StreamClose(StreamClose {
                stream: open.stream,
                reason: Some(reason),
            })
        };
        if let Some(later) = unserved::later(&open.channel) {
            return self
                .outbox
                .push(refuse(unserved::refusal(&open.channel, later)));
        }
        if CATALOGUE.get(&open.channel).is_some()
            && let Some((_, why)) = self.refused(&open.channel, false)
        {
            return self.outbox.push(refuse(why));
        }
        let decl = match channels.open_stream(open) {
            Ok(decl) => decl,
            Err(close) => return self.outbox.push(Message::StreamClose(close)),
        };
        // A stream number reused while open replaces the earlier stream.
        self.close_stream(open.stream, None, false);
        let features = Arc::clone(&self.features);
        let attachment = match features
            .streams()
            .open(decl.name(), self.client, &open.params)
        {
            Some(Ok(attachment)) => attachment,
            Some(Err(why)) => return self.outbox.push(refuse(why)),
            None => {
                return self.outbox.push(refuse(format!(
                    "This host does not serve `{}`.",
                    decl.name()
                )));
            }
        };
        self.outbox.open_stream(open.stream, DEFAULT_INITIAL_CREDIT);
        let _ = self.outbox.write(open.stream, &attachment.redraw);

        let stream = open.stream;
        let forwarding = output_tx.clone();
        let mut output = attachment.output;
        let forward = tokio::spawn(async move {
            while let Some(item) = output.recv().await {
                if forwarding.send((stream, item)).is_err() {
                    return;
                }
            }
        });
        self.streams.insert(
            stream,
            OpenStream {
                session: attachment.session,
                input: CreditReceiver::new(stream, DEFAULT_INITIAL_CREDIT),
                forward,
            },
        );
    }

    /// Keys the client typed on a session's stream. A viewer's are dropped:
    /// it types nothing. Its credit is granted back all the same, so its
    /// stream keeps flowing.
    fn input(&mut self, data: &StreamData) {
        let viewer = self.role() == Role::Viewer;
        let Some(open) = self.streams.get_mut(&data.stream) else {
            return;
        };
        if let Err(err) = open.input.accept(data) {
            return self.close_stream(data.stream, Some(err.to_string()), false);
        }
        let typed = if viewer {
            Ok(())
        } else {
            open.session.input(self.client, &data.data.0)
        };
        let credit: StreamCredit = open.input.grant(data.data.0.len() as u64);
        self.outbox.push(Message::StreamCredit(credit));
        if let Err(err) = typed {
            self.close_stream(data.stream, Some(err.to_string()), true);
        }
    }

    fn session_output(&mut self, stream: u64, output: SessionOutput) {
        if !self.streams.contains_key(&stream) {
            return;
        }
        match output {
            SessionOutput::Data(bytes) => {
                let _ = self.outbox.write(stream, &bytes);
            }
            // The protocol has no message for a size change yet; the client
            // that typed set it and already knows.
            SessionOutput::Resized(_) => {}
            // Closed once the output before it has gone; the exit code
            // travels on `session:exit`.
            SessionOutput::Exited(_) => {
                self.closing.insert(stream);
            }
        }
    }

    /// Ends one stream. With `tell`, the client is sent the close, after any
    /// output still queued for it.
    fn close_stream(&mut self, stream: u64, reason: Option<String>, tell: bool) {
        let Some(open) = self.streams.remove(&stream) else {
            return;
        };
        open.forward.abort();
        if !self
            .streams
            .values()
            .any(|other| Arc::ptr_eq(&other.session, &open.session))
        {
            open.session.detach(self.client);
        }
        self.closing.remove(&stream);
        self.outbox.close_stream(stream);
        if tell || reason.is_some() {
            self.outbox
                .push(Message::StreamClose(StreamClose { stream, reason }));
        }
    }

    /// Sends everything the client's credit allows, then closes the streams
    /// of ended sessions whose output has all gone.
    async fn flush(&mut self) -> std::io::Result<()> {
        loop {
            while let Some(message) = self.outbox.next_message() {
                self.write(&message).await?;
            }
            let drained: Vec<u64> = self
                .closing
                .iter()
                .copied()
                .filter(|stream| {
                    self.outbox
                        .stream(*stream)
                        .is_none_or(|sender| sender.held() == 0)
                })
                .collect();
            if drained.is_empty() {
                return Ok(());
            }
            for stream in drained {
                self.close_stream(stream, None, true);
            }
        }
    }

    async fn write(&mut self, message: &Message) -> std::io::Result<()> {
        let frame = encode_frame(message).map_err(std::io::Error::other)?;
        let sealed = self.sealer.seal(&frame).map_err(std::io::Error::other)?;
        self.writer.write_all(&sealed).await
    }

    /// The client has gone: its sessions run on without it.
    fn detach_all(&mut self) {
        for (_, open) in self.streams.drain() {
            open.forward.abort();
            open.session.detach(self.client);
        }
    }
}
