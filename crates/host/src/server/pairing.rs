//! Requests to pair: a device the host does not know asks in its handshake
//! ([`Initiator::start_pairing`](floti_protocol::noise::Initiator::start_pairing)),
//! says `hello`, and waits under a short code it shows until someone on the
//! host's computer approves it with `floti devices approve <code>`.
//!
//! Requests live in this process's memory only, never on disk, and each
//! waits [`PAIRING_LIFETIME`] at most. At most [`MAX_WAITING`] wait at once;
//! the connection holding one ([`Waiting`]) is the request, so a device that
//! goes, or sends anything at all while it waits, withdraws it. A device
//! that asks again withdraws the request it already had, and one that
//! connects without asking while its request waits withdraws it too.
//!
//! Approval ([`Pairing::approve`]) works under one lock: requests that have
//! expired go first, then the one under the code is found, its key paired
//! in the registry ([`DeviceRegistry::pair`]) under the name it gave, and its
//! connection told. Expiry is a timer on each waiting connection, and is
//! also checked whenever the requests are read.
//!
//! The log says each request's coming and going in one line naming the
//! device's fingerprint. A pairing code is never logged, printed or sent to
//! anyone but the device it was made for, and `floti devices` lists no code.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use floti_protocol::channels::devices::WaitingDevice;
use floti_protocol::message::ClientKind;
use floti_protocol::noise::{PairingCode, PublicKey};
use tokio::sync::oneshot;
use tokio::time::Instant;

use crate::devices::{Device, DeviceRegistry, Role};

/// How long a request to pair waits for approval.
pub const PAIRING_LIFETIME: Duration = Duration::from_secs(10 * 60);

/// How many requests to pair wait at once, at most. A device that asks
/// past it is closed without a byte.
pub const MAX_WAITING: usize = 16;

/// The file in a data folder that moves a test build's pairing clock ahead
/// by the milliseconds it holds, read at every check, so the tests of
/// expiry against the executable step time rather than wait it out. A
/// production build never reads it.
#[cfg(any(test, feature = "testkit"))]
pub const TEST_PAIRING_CLOCK_MARKER: &str = "floti-test-pairing-clock";

/// What became of a request, as its connection is told.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// Approved: the device is paired with this role.
    Approved(Role),
    /// Nobody approved it within [`PAIRING_LIFETIME`].
    Expired,
}

/// Why a request was not taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Full;

/// The host's requests to pair.
pub(crate) struct Pairing {
    devices: Arc<DeviceRegistry>,
    /// The data folder, where a test build finds its clock marker.
    data: PathBuf,
    state: Mutex<State>,
}

struct State {
    next_id: u64,
    waiting: Vec<Request>,
}

struct Request {
    id: u64,
    key: PublicKey,
    name: String,
    kind: ClientKind,
    asked_at: Instant,
    code: PairingCode,
    tell: oneshot::Sender<Outcome>,
}

/// A request that waits, held by the connection that made it: dropping it
/// withdraws the request, unless it was approved or expired first.
pub(crate) struct Waiting {
    pairing: Arc<Pairing>,
    id: u64,
    key: PublicKey,
    asked_at: Instant,
    code: PairingCode,
    outcome: oneshot::Receiver<Outcome>,
}

impl Pairing {
    /// No requests yet, for the host whose registry is `devices` and whose
    /// data folder is `data`.
    pub(crate) fn new(data: &Path, devices: Arc<DeviceRegistry>) -> Self {
        Self {
            devices,
            data: data.to_path_buf(),
            state: Mutex::new(State {
                next_id: 0,
                waiting: Vec::new(),
            }),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The pairing clock: now, moved ahead in a test build by its marker.
    fn now(&self) -> Instant {
        Instant::now() + clock_ahead(&self.data)
    }

    /// Drops every request whose time is up, telling its connection.
    fn drop_expired(&self, state: &mut State) {
        let now = self.now();
        state.waiting.retain_mut(|request| {
            if now.saturating_duration_since(request.asked_at) < PAIRING_LIFETIME {
                return true;
            }
            log_line!(
                "floti host: the request to pair from device {} expired",
                request.key.fingerprint()
            );
            let (closed, _) = oneshot::channel();
            let _ = std::mem::replace(&mut request.tell, closed).send(Outcome::Expired);
            false
        });
    }

    /// Whether another request may wait.
    pub(crate) fn has_room(&self) -> bool {
        let mut state = self.state();
        self.drop_expired(&mut state);
        state.waiting.len() < MAX_WAITING
    }

    /// Takes `key`'s request to pair, named `name`, under a code no other
    /// request has. A request `key` already had is withdrawn.
    pub(crate) fn ask(
        self: &Arc<Self>,
        key: PublicKey,
        name: &str,
        kind: ClientKind,
    ) -> Result<Waiting, Full> {
        self.ask_with(key, name, kind, || {
            PairingCode::generate().expect("the OS's random source gives a pairing code")
        })
    }

    /// [`Self::ask`], drawing codes from `generate`.
    fn ask_with(
        self: &Arc<Self>,
        key: PublicKey,
        name: &str,
        kind: ClientKind,
        mut generate: impl FnMut() -> PairingCode,
    ) -> Result<Waiting, Full> {
        let mut state = self.state();
        self.drop_expired(&mut state);
        if let Some(index) = state.waiting.iter().position(|request| request.key == key) {
            state.waiting.remove(index);
            log_line!(
                "floti host: device {} asked to pair again; its earlier request is withdrawn",
                key.fingerprint()
            );
        }
        if state.waiting.len() >= MAX_WAITING {
            return Err(Full);
        }
        let code = loop {
            let code = generate();
            if !state
                .waiting
                .iter()
                .any(|request| request.code.matches(&code))
            {
                break code;
            }
        };
        let id = state.next_id;
        state.next_id += 1;
        let asked_at = self.now();
        let (tell, outcome) = oneshot::channel();
        state.waiting.push(Request {
            id,
            key,
            name: name.to_owned(),
            kind,
            asked_at,
            code,
            tell,
        });
        log_line!(
            "floti host: device {} asks to pair, named {name:?}; it waits for `floti devices approve` on this computer",
            key.fingerprint()
        );
        Ok(Waiting {
            pairing: Arc::clone(self),
            id,
            key,
            asked_at,
            code,
            outcome,
        })
    }

    /// Withdraws `key`'s request, when it has one: the device connected
    /// without asking while it waited.
    pub(crate) fn withdraw_key(&self, key: &PublicKey) {
        let mut state = self.state();
        if let Some(index) = state.waiting.iter().position(|request| request.key == *key) {
            state.waiting.remove(index);
            log_line!(
                "floti host: device {} connected without asking to pair while its request \
                 waited; the request is withdrawn",
                key.fingerprint()
            );
        }
    }

    /// Every request that waits, oldest first, with the time it has left.
    pub(crate) fn list(&self) -> Vec<WaitingDevice> {
        let mut state = self.state();
        self.drop_expired(&mut state);
        let now = self.now();
        state
            .waiting
            .iter()
            .map(|request| WaitingDevice {
                name: request.name.clone(),
                kind: request.kind,
                fingerprint: request.key.fingerprint(),
                seconds_left: seconds_up(
                    PAIRING_LIFETIME
                        .saturating_sub(now.saturating_duration_since(request.asked_at)),
                ),
            })
            .collect()
    }

    /// Pairs the device whose request waits under `code` with `role`, and
    /// tells its connection: the device as paired. A sentence for whoever
    /// approved when no request waits under that code.
    pub(crate) fn approve(&self, code: &str, role: Role) -> Result<Device, String> {
        const NO_SUCH_CODE: &str = "No device is waiting to pair with that code.";
        let code: PairingCode = code.parse().map_err(|_| NO_SUCH_CODE.to_owned())?;
        let mut state = self.state();
        self.drop_expired(&mut state);
        let index = state
            .waiting
            .iter()
            .position(|request| request.code.matches(&code))
            .ok_or_else(|| NO_SUCH_CODE.to_owned())?;
        let request = &state.waiting[index];
        let device = self
            .devices
            .pair(request.key, &request.name, role)
            .map_err(|err| err.to_string())?;
        let request = state.waiting.remove(index);
        log_line!(
            "floti host: paired device {} as {}, named {:?}",
            device.key.fingerprint(),
            device.role.with_article(),
            device.name
        );
        let _ = request.tell.send(Outcome::Approved(device.role));
        Ok(device)
    }

    /// When the request asked at `asked_at` expires, by the pairing clock
    /// as it reads now, on tokio's clock.
    fn expires_at(&self, asked_at: Instant) -> Instant {
        let ahead = self.now().saturating_duration_since(Instant::now());
        (asked_at + PAIRING_LIFETIME)
            .checked_sub(ahead)
            .unwrap_or_else(Instant::now)
    }

    /// Withdraws request `id`, when it still waits.
    fn withdraw(&self, id: u64) {
        let mut state = self.state();
        if let Some(index) = state.waiting.iter().position(|request| request.id == id) {
            let request = state.waiting.remove(index);
            log_line!(
                "floti host: device {} withdrew its request to pair",
                request.key.fingerprint()
            );
        }
    }
}

impl Waiting {
    /// The code the device shows.
    pub(crate) fn code(&self) -> PairingCode {
        self.code
    }

    /// How many seconds the request has left, by the pairing clock, a part
    /// of one counted as one.
    pub(crate) fn seconds_left(&self) -> u64 {
        seconds_up(
            PAIRING_LIFETIME
                .saturating_sub(self.pairing.now().saturating_duration_since(self.asked_at)),
        )
    }

    /// Waits for the request to be approved or to expire; `None` when it was
    /// withdrawn: the device asked again on another connection.
    pub(crate) async fn outcome(&mut self) -> Option<Outcome> {
        loop {
            let expires_at = self.pairing.expires_at(self.asked_at);
            tokio::select! {
                outcome = &mut self.outcome => return outcome.ok(),
                () = tokio::time::sleep_until(expires_at) => {
                    let mut state = self.pairing.state();
                    self.pairing.drop_expired(&mut state);
                }
            }
        }
    }
}

impl Drop for Waiting {
    fn drop(&mut self) {
        self.pairing.withdraw(self.id);
    }
}

impl std::fmt::Debug for Waiting {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Waiting")
            .field("key", &self.key)
            .finish_non_exhaustive()
    }
}

/// `time` in whole seconds, a part of one counted as one: a request with
/// any time left never says it has none.
fn seconds_up(time: Duration) -> u64 {
    time.as_secs() + u64::from(time.subsec_nanos() > 0)
}

/// How far a test build's pairing clock is ahead, by the marker in `data`;
/// always nothing in a production build.
fn clock_ahead(data: &Path) -> Duration {
    #[cfg(any(test, feature = "testkit"))]
    if let Some(ms) = std::fs::read_to_string(data.join(TEST_PAIRING_CLOCK_MARKER))
        .ok()
        .and_then(|text| text.trim().parse().ok())
    {
        return Duration::from_millis(ms);
    }
    let _ = data;
    Duration::ZERO
}

#[cfg(test)]
mod tests;
