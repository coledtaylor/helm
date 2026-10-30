//! Asking a running host to stop, where the first ask is the one it stops
//! for.
//!
//! A client's `host:stop` is answered before the host stops, so the answer
//! goes out first. The stop is reserved when it is answered and carried out
//! once the answer is sent: anything asked in between, such as standard
//! input closing the moment the client has its answer, finds the stop
//! already taken and changes nothing.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use floti_protocol::channels::host::HostStopReason;
use tokio::sync::watch;

/// Asks a running host to stop. The first reason asked for is the one it
/// stops for, including one reserved with [`Stopper::reserve`] and not yet
/// carried out.
#[derive(Clone)]
pub struct Stopper(Arc<Asks>);

struct Asks {
    /// The reason the host stops for, once one is carried out.
    requested: watch::Sender<Option<HostStopReason>>,
    /// Whether a stop has been asked for or reserved.
    taken: AtomicBool,
}

impl Stopper {
    /// A stopper and what the host watches for the reason it stops for.
    pub(super) fn new() -> (Self, watch::Receiver<Option<HostStopReason>>) {
        let (requested, receiver) = watch::channel(None);
        let asks = Asks {
            requested,
            taken: AtomicBool::new(false),
        };
        (Self(Arc::new(asks)), receiver)
    }

    /// Asks for a stop for `reason`; whether this was the first ask, which
    /// the host stops for.
    pub fn stop(&self, reason: HostStopReason) -> bool {
        self.reserve(reason).is_some()
    }

    /// Takes the stop for `reason` without carrying it out yet, when no
    /// other has been asked for: the host stops for it when the returned
    /// [`ReservedStop`] is dropped, and every ask made before then is
    /// refused.
    pub(super) fn reserve(&self, reason: HostStopReason) -> Option<ReservedStop> {
        if self.0.taken.swap(true, Ordering::SeqCst) {
            return None;
        }
        Some(ReservedStop {
            asks: Arc::clone(&self.0),
            reason,
        })
    }
}

/// The host's first stop, taken and carried out when this is dropped, so a
/// reserved stop is never lost: a connection that cannot send its answer
/// still stops the host it was asked to.
pub(super) struct ReservedStop {
    asks: Arc<Asks>,
    reason: HostStopReason,
}

impl Drop for ReservedStop {
    fn drop(&mut self) {
        self.asks.requested.send_replace(Some(self.reason));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_ask_is_the_one_the_host_stops_for() {
        let (stopper, requested) = Stopper::new();
        assert!(stopper.stop(HostStopReason::Stop));
        assert!(!stopper.stop(HostStopReason::Update));
        assert_eq!(*requested.borrow(), Some(HostStopReason::Stop));
    }

    #[test]
    fn a_stop_reserved_while_its_answer_is_sent_wins_over_an_ask_made_before_it_is_carried_out() {
        let (stopper, requested) = Stopper::new();
        let reserved = stopper
            .reserve(HostStopReason::Stop)
            .expect("the first ask is reserved");
        assert_eq!(*requested.borrow(), None, "nothing is carried out yet");

        assert!(!stopper.stop(HostStopReason::Update));
        assert!(stopper.reserve(HostStopReason::Update).is_none());
        assert_eq!(*requested.borrow(), None);

        drop(reserved);
        assert_eq!(*requested.borrow(), Some(HostStopReason::Stop));
    }
}
