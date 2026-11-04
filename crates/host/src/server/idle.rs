//! When a host a desktop started has nothing left to do.
//!
//! Such a host outlives the desktop, so the desktop's exit cannot end it. It
//! ends itself once it runs no session and no plain terminal, holds no WSL
//! distro awake and no client is attached: a held distro counts as running,
//! since the sessions of the host inside it end if the distro stops. That is judged each time the count moves, which can only
//! reach nothing when a session or terminal ends or a client leaves, and once
//! at start, after a bounded wait for the first client: the desktop that
//! started it connects as soon as it says it is listening, and a host whose
//! desktop never came would otherwise wait for nobody.

use std::time::Duration;

use tokio::sync::watch;

use super::Occupancy;

/// How long a host a desktop started waits for its first client before it
/// judges whether it is idle.
pub const FIRST_CLIENT_WAIT: Duration = Duration::from_secs(60);

/// Resolves once the host is idle: nothing running and nobody attached, at
/// the first judgement after `first_client` or at any later change. Also
/// resolves when the host has gone and nothing is watched any more.
pub async fn until_idle(mut occupancy: watch::Receiver<Occupancy>, first_client: Duration) {
    // A client attaching, or anything starting, is not idle: the wait is only
    // for the first judgement.
    let _ = tokio::time::timeout(first_client, occupancy.wait_for(|now| !now.is_idle())).await;
    loop {
        if occupancy.borrow_and_update().is_idle() {
            return;
        }
        if occupancy.changed().await.is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    const WAIT: Duration = Duration::from_secs(60);

    /// A watch of the occupancy, and whether `until_idle` over it, started
    /// now and run until it waits, has resolved.
    async fn watched() -> (watch::Sender<Occupancy>, Arc<AtomicBool>) {
        let (tx, rx) = watch::channel(Occupancy::default());
        let idle = Arc::new(AtomicBool::new(false));
        let seen = Arc::clone(&idle);
        tokio::spawn(async move {
            until_idle(rx, WAIT).await;
            seen.store(true, Ordering::SeqCst);
        });
        settle().await;
        (tx, idle)
    }

    /// Lets every task that can run, run.
    async fn settle() {
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
    }

    fn occupied(sessions: usize, terminals: usize, clients: usize) -> Occupancy {
        Occupancy {
            sessions,
            terminals,
            clients,
            distros: 0,
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_host_no_client_ever_reached_is_idle_once_the_first_client_wait_is_over() {
        let (_tx, idle) = watched().await;
        tokio::time::advance(WAIT - Duration::from_millis(1)).await;
        settle().await;
        assert!(
            !idle.load(Ordering::SeqCst),
            "judged before the wait was over"
        );
        tokio::time::advance(Duration::from_millis(1)).await;
        settle().await;
        assert!(idle.load(Ordering::SeqCst));
    }

    #[tokio::test(start_paused = true)]
    async fn a_host_is_idle_when_its_last_session_ends_with_no_client_attached() {
        let (tx, idle) = watched().await;
        tx.send_replace(occupied(0, 0, 1));
        tx.send_replace(occupied(2, 0, 1));
        tx.send_replace(occupied(2, 0, 0));
        tokio::time::advance(WAIT * 2).await;
        settle().await;
        assert!(!idle.load(Ordering::SeqCst), "sessions still run");
        tx.send_replace(occupied(1, 0, 0));
        settle().await;
        assert!(!idle.load(Ordering::SeqCst), "one session still runs");
        tx.send_replace(occupied(0, 0, 0));
        settle().await;
        assert!(idle.load(Ordering::SeqCst));
    }

    #[tokio::test(start_paused = true)]
    async fn a_host_is_idle_when_its_last_client_leaves_with_nothing_running() {
        let (tx, idle) = watched().await;
        tx.send_replace(occupied(0, 0, 2));
        tx.send_replace(occupied(0, 1, 1));
        tokio::time::advance(WAIT * 2).await;
        settle().await;
        assert!(!idle.load(Ordering::SeqCst), "a client is attached");
        tx.send_replace(occupied(0, 0, 1));
        settle().await;
        assert!(!idle.load(Ordering::SeqCst), "a client is still attached");
        tx.send_replace(occupied(0, 0, 0));
        settle().await;
        assert!(idle.load(Ordering::SeqCst));
    }

    #[tokio::test(start_paused = true)]
    async fn s7_a_host_a_desktop_started_does_not_exit_for_idleness_while_it_holds_a_distro() {
        let (tx, idle) = watched().await;
        tx.send_replace(Occupancy {
            distros: 1,
            ..Occupancy::default()
        });
        tokio::time::advance(WAIT * 2).await;
        settle().await;
        assert!(!idle.load(Ordering::SeqCst), "a distro is held awake");
        tx.send_replace(Occupancy::default());
        settle().await;
        assert!(idle.load(Ordering::SeqCst));
    }

    #[tokio::test(start_paused = true)]
    async fn a_plain_terminal_keeps_a_host_with_no_client_running() {
        let (tx, idle) = watched().await;
        tx.send_replace(occupied(0, 1, 0));
        tokio::time::advance(WAIT * 2).await;
        settle().await;
        assert!(!idle.load(Ordering::SeqCst));
        tx.send_replace(occupied(0, 0, 0));
        settle().await;
        assert!(idle.load(Ordering::SeqCst));
    }
}
