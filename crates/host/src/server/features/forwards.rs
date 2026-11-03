//! Forwarded ports: connections to the loopback ports a running session's
//! own process tree listens on, so a client on another computer can reach a
//! dev server the session started (`sessions:port`).
//!
//! A forward reaches only a session's own servers. A stream is opened with a
//! session id and a port, and the host refuses it, with a sentence and
//! without opening any connection, unless:
//!
//!   - the session is running on this host, and
//!   - its process tree listens on that port at an address the host's
//!     loopback reaches: `127.0.0.0/8`, `::1`, `0.0.0.0` or `::`.
//!
//! The first stream for a session and port checks with a fresh
//! process-and-ports pass ([`ResourcesHandle::one_pass`]); each later one
//! checks only that the session still runs, until a connection to it fails
//! or the session ends. The host then connects to its own loopback address
//! only: `127.0.0.1`, or `::1` for a port bound there alone, or the one
//! `127.x.y.z` address the port is bound to. Never to another interface or
//! computer, whatever the port is also bound to.
//!
//! Every stream carried for a session closes, with a sentence, when the
//! session ends. There is no general tunnel: nothing here names a host, and
//! no address but loopback is ever dialled.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use floti_protocol::channel::Router;
use floti_protocol::channels::common::SessionStatus;
use floti_protocol::channels::sessions::{SessionPortForward, SessionPortOpen};
use tokio::net::TcpStream;
use tokio::sync::broadcast::{self, error::RecvError};

use super::{
    Caller, Feature, FeatureContext, ResourcesHandle, SocketAttachment, StreamAttachment, Streams,
};
use crate::server::hosted::{Hosted, session_id};
use crate::server::records::ExitNotice;
use crate::session::SessionId;

/// The feature: the `sessions:port` stream.
pub(crate) struct Forwards {
    inner: Arc<Inner>,
}

struct Inner {
    hosted: Arc<Hosted>,
    resources: ResourcesHandle,
    /// Each session and port a pass found the session listening on, with the
    /// loopback address it is reached at.
    checked: Mutex<HashMap<(u64, u16), SocketAddr>>,
}

impl Forwards {
    /// Call it from inside a Tokio runtime: it follows the sessions' exits.
    pub fn new(context: &FeatureContext, resources: ResourcesHandle) -> Self {
        let inner = Arc::new(Inner {
            hosted: Arc::clone(&context.hosted),
            resources,
            checked: Mutex::new(HashMap::new()),
        });
        tokio::spawn(forget_on_exits(
            context.hosted.ledger().exits(),
            Arc::downgrade(&inner),
        ));
        Self { inner }
    }
}

impl Feature for Forwards {
    fn requests<'a>(&'a self, _caller: Caller, _router: &mut Router<'a>) {}

    fn streams<'a>(&'a self, streams: &mut Streams<'a>) {
        streams.handle_later::<SessionPortForward>(|_client, open| {
            Box::pin(Arc::clone(&self.inner).open(open))
        });
    }
}

impl Inner {
    fn checked(&self) -> MutexGuard<'_, HashMap<(u64, u16), SocketAddr>> {
        self.checked.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Opens one connection to session `id`'s port `port`, or says why not.
    async fn open(self: Arc<Self>, open: SessionPortOpen) -> Result<StreamAttachment, String> {
        let SessionPortOpen { id, port } = open;
        // Listened to before anything is checked, so an end that comes
        // after the check is heard.
        let exits = self.hosted.ledger().exits();
        let session = session_id(id)
            .filter(|session| running(&self.hosted, *session))
            .ok_or_else(|| not_running(id, port))?;
        let known = self.checked().get(&(id, port)).copied();
        let target = match known {
            Some(target) => target,
            None => self.look(id, port).await?,
        };
        if !running(&self.hosted, session) {
            self.checked().remove(&(id, port));
            return Err(not_running(id, port));
        }
        let socket = match TcpStream::connect(target).await {
            Ok(socket) => socket,
            Err(err) => {
                self.checked().remove(&(id, port));
                return Err(format!(
                    "Could not connect to port {port} on this host's loopback address: {err}."
                ));
            }
        };
        self.checked().insert((id, port), target);
        Ok(StreamAttachment::Socket(SocketAttachment {
            socket,
            ended: Box::pin(session_ended(
                exits,
                Arc::downgrade(&self.hosted),
                session,
                id,
            )),
        }))
    }

    /// Where session `id`'s port `port` is reached on this host's loopback,
    /// from a fresh process-and-ports pass, or why it is not forwarded.
    async fn look(&self, id: u64, port: u16) -> Result<SocketAddr, String> {
        let resources = self
            .resources
            .one_pass()
            .await
            .into_iter()
            .find(|resources| resources.id == id)
            .ok_or_else(|| not_running(id, port))?;
        let Some(ports) = resources.ports else {
            return Err(format!(
                "This host could not read which ports session {id}'s processes listen on, so port {port} is not forwarded."
            ));
        };
        let held: Vec<_> = ports.into_iter().filter(|held| held.port == port).collect();
        if held.is_empty() {
            return Err(format!(
                "No process of session {id} listens on port {port}, so it is not forwarded."
            ));
        }
        let addresses: Vec<String> = held.into_iter().flat_map(|held| held.addresses).collect();
        loopback_target(&addresses, port).ok_or_else(|| {
            format!(
                "Session {id}'s port {port} is not open on this host's loopback address, so it is not forwarded."
            )
        })
    }
}

fn not_running(id: u64, port: u16) -> String {
    format!("Session {id} is not running on this Floti host, so its port {port} is not forwarded.")
}

/// Whether session `id` is running: still in the host's list, and its row
/// says so.
fn running(hosted: &Hosted, id: SessionId) -> bool {
    hosted.sessions().get(id).is_some()
        && hosted
            .record(id)
            .is_ok_and(|record| record.status == SessionStatus::Running)
}

/// The loopback address a port bound at `addresses` is reached at: every
/// IPv4 address or `127.0.0.1` gives `127.0.0.1`; otherwise every IPv6
/// address or `::1` gives `::1`; otherwise the one other `127.x.y.z` it is
/// bound to. `None` when loopback does not reach it.
pub(crate) fn loopback_target(addresses: &[String], port: u16) -> Option<SocketAddr> {
    let parsed: Vec<IpAddr> = addresses
        .iter()
        .filter_map(|address| address.parse().ok())
        .collect();
    let v4_any = parsed.iter().any(
        |ip| matches!(ip, IpAddr::V4(v4) if v4.is_unspecified() || *v4 == Ipv4Addr::LOCALHOST),
    );
    let v6_any = parsed
        .iter()
        .any(|ip| matches!(ip, IpAddr::V6(v6) if v6.is_unspecified() || v6.is_loopback()));
    let ip = if v4_any {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    } else if v6_any {
        IpAddr::V6(Ipv6Addr::LOCALHOST)
    } else {
        *parsed
            .iter()
            .find(|ip| matches!(ip, IpAddr::V4(v4) if v4.is_loopback()))?
    };
    Some(SocketAddr::new(ip, port))
}

/// Settles once session `session` (row `id`) has ended, with the sentence
/// its forwarded streams close with.
async fn session_ended(
    mut exits: broadcast::Receiver<ExitNotice>,
    hosted: Weak<Hosted>,
    session: SessionId,
    id: u64,
) -> String {
    let sentence = format!("Session {id} has ended, so its forwarded connection is closed.");
    loop {
        match exits.recv().await {
            Ok(notice) if notice.session == session => return sentence,
            Ok(_) => {}
            // Exits were missed: whether this one was among them is read
            // from the host.
            Err(RecvError::Lagged(_)) => {
                if !hosted
                    .upgrade()
                    .is_some_and(|hosted| running(&hosted, session))
                {
                    return sentence;
                }
            }
            Err(RecvError::Closed) => return sentence,
        }
    }
}

/// Forgets what was checked for each session that ends. Holds the feature
/// weakly; the exits close with the host and this ends.
async fn forget_on_exits(mut exits: broadcast::Receiver<ExitNotice>, inner: Weak<Inner>) {
    loop {
        let ended = match exits.recv().await {
            Ok(notice) => u64::try_from(notice.session.0).ok(),
            Err(RecvError::Lagged(_)) => None,
            Err(RecvError::Closed) => return,
        };
        let Some(inner) = inner.upgrade() else {
            return;
        };
        let hosted = Arc::clone(&inner.hosted);
        inner.checked().retain(|(id, _), _| match ended {
            Some(ended) => *id != ended,
            None => session_id(*id).is_some_and(|session| running(&hosted, session)),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(addresses: &[&str]) -> Option<String> {
        let owned: Vec<String> = addresses.iter().map(|&a| a.to_owned()).collect();
        loopback_target(&owned, 5173).map(|addr| addr.to_string())
    }

    #[test]
    fn a_port_is_reached_only_at_this_hosts_own_loopback_address() {
        assert_eq!(target(&["127.0.0.1"]).as_deref(), Some("127.0.0.1:5173"));
        assert_eq!(target(&["0.0.0.0"]).as_deref(), Some("127.0.0.1:5173"));
        assert_eq!(
            target(&["0.0.0.0", "::"]).as_deref(),
            Some("127.0.0.1:5173")
        );
        assert_eq!(target(&["::1"]).as_deref(), Some("[::1]:5173"));
        assert_eq!(target(&["::"]).as_deref(), Some("[::1]:5173"));
        assert_eq!(target(&["127.0.0.5"]).as_deref(), Some("127.0.0.5:5173"));
        // Bound to another interface as well: still only loopback is dialled.
        assert_eq!(
            target(&["192.168.1.20", "127.0.0.1"]).as_deref(),
            Some("127.0.0.1:5173")
        );
    }

    #[test]
    fn a_port_bound_only_to_another_interface_or_to_nothing_known_is_not_reached() {
        assert_eq!(target(&["192.168.1.20"]), None);
        assert_eq!(target(&["fe80::1"]), None);
        assert_eq!(target(&[]), None);
        assert_eq!(target(&["not an address"]), None);
    }
}
