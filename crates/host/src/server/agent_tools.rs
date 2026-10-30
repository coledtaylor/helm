//! The host's agent tools: its one listener ([`AgentToolsListener`]), the
//! families it serves, and the tokens its sessions hold.
//!
//! One per host, built when the host starts. A launch on a backend that takes
//! agent tools is granted a token, with an entry for each family on, before
//! its backend composes it; the token is tied to the session once the session
//! starts, revoked when the launch fails, and revoked when the session ends
//! (the records' exit notice). Switching a family in the settings takes its
//! route away from running sessions at once, or gives it back. Stopping the
//! host stops the listener, revoking every token, before the sessions end.
//!
//! Today that is helm-browser ([`BrowserTools`]), on the `browserMcp`
//! setting and given to a launch only while a client with a browser pane is
//! attached, and floti-sessions ([`SessionTools`]), on the `sessionMcp`
//! setting.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use floti_protocol::channels::workspace::HostSettings;
use tokio::sync::broadcast::{self, error::RecvError};

use super::browser_tools::BrowserTools;
use super::features::BrowserRelay;
use super::hosted::Hosted;
use super::records::ExitNotice;
use super::session_tools::{SessionTools, SessionsWorld};
use crate::Result;
use crate::agent_tools::{AgentToolsListener, Grant, GrantId, ToolFamily};
use crate::session::SessionId;

pub(crate) struct HostAgentTools {
    listener: AgentToolsListener,
    browser: Arc<BrowserTools>,
    sessions: Arc<SessionTools>,
    held: Mutex<Held>,
    /// Set by the first stop: from then on nothing is granted.
    stopped: AtomicBool,
}

/// Which session holds which grant, and what ended while a launch was
/// between its grant and its start.
#[derive(Default)]
struct Held {
    by_session: HashMap<SessionId, GrantId>,
    /// Grants minted whose session has not started or failed yet.
    launching: usize,
    /// Sessions that ended while a launch was in flight, before their grant
    /// was tied to them: a session can end before its launch has returned.
    ended_early: HashSet<SessionId>,
}

impl HostAgentTools {
    /// The listener with every family, each off until [`Self::follow`] reads
    /// the settings, the browser tools carried through `relay`. Call it
    /// inside the host's runtime.
    pub fn new(relay: Arc<BrowserRelay>) -> Self {
        let browser = Arc::new(BrowserTools::new(relay));
        let sessions = Arc::new(SessionTools::new());
        let families: Vec<Arc<dyn ToolFamily>> = vec![
            Arc::clone(&browser) as Arc<dyn ToolFamily>,
            Arc::clone(&sessions) as Arc<dyn ToolFamily>,
        ];
        Self {
            listener: AgentToolsListener::new(families),
            browser,
            sessions,
            held: Mutex::new(Held::default()),
            stopped: AtomicBool::new(false),
        }
    }

    /// What floti-sessions answers from.
    pub fn answer_from(&self, world: Arc<dyn SessionsWorld>) {
        self.sessions.answer_from(world);
    }

    /// Switches each family as `settings` say. With every family off and no
    /// token held, the socket is let go. Nothing binds here: the first grant
    /// binds, so a host whose sessions take no agent tools holds no port.
    pub fn follow(&self, settings: &HostSettings) {
        self.browser.switch(settings.browser_mcp);
        self.sessions.switch(settings.session_mcp);
        if self.stopped.load(Ordering::SeqCst) || !self.listener.served_names().is_empty() {
            return;
        }
        if let Err(err) = self.listener.sync() {
            eprintln!("floti host: {err}");
        }
    }

    /// A token for a launch about to be composed, with an entry for each
    /// family on that can be given now (helm-browser only while a browser
    /// client is attached); `None`, with nothing bound and no token minted,
    /// when there is none or the host is stopping.
    pub fn grant(&self) -> Result<Option<Grant>> {
        if self.stopped.load(Ordering::SeqCst) {
            return Ok(None);
        }
        let mut held = self.held();
        let grant = self.listener.grant()?;
        if grant.is_some() {
            held.launching += 1;
        }
        Ok(grant)
    }

    /// The launch `grant` was for has started as `session`.
    pub fn started(&self, grant: GrantId, session: SessionId) {
        let mut held = self.held();
        held.launching = held.launching.saturating_sub(1);
        if held.ended_early.remove(&session) {
            self.listener.revoke(grant);
        } else {
            self.listener.bind_session(grant, session);
            held.by_session.insert(session, grant);
        }
        if held.launching == 0 {
            held.ended_early.clear();
        }
    }

    /// The launch `grant` was for never started: its token goes.
    pub fn failed(&self, grant: GrantId) {
        let mut held = self.held();
        held.launching = held.launching.saturating_sub(1);
        self.listener.revoke(grant);
        if held.launching == 0 {
            held.ended_early.clear();
        }
    }

    /// `session` has ended: its token is answered 401 from now on.
    pub fn ended(&self, session: SessionId) {
        let mut held = self.held();
        if let Some(grant) = held.by_session.remove(&session) {
            self.listener.revoke(grant);
        } else if held.launching > 0 {
            held.ended_early.insert(session);
        }
    }

    /// Revokes the token of every session `running` says has ended: after
    /// exit notices were missed.
    fn ended_unless(&self, running: impl Fn(SessionId) -> bool) {
        let mut held = self.held();
        let gone: Vec<SessionId> = held
            .by_session
            .keys()
            .copied()
            .filter(|session| !running(*session))
            .collect();
        for session in gone {
            if let Some(grant) = held.by_session.remove(&session) {
                self.listener.revoke(grant);
            }
        }
    }

    /// Revokes every token and stops serving: once this returns the port
    /// accepts nothing, and nothing is granted again.
    pub async fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.held().by_session.clear();
        self.listener.stop().await;
    }

    fn held(&self) -> MutexGuard<'_, Held> {
        self.held.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Revokes each session's token as it ends, from the records' exit notices,
/// until the host's sessions are gone. Holds both weakly.
pub(crate) async fn revoke_at_exit(
    mut exits: broadcast::Receiver<ExitNotice>,
    tools: Weak<HostAgentTools>,
    hosted: Weak<Hosted>,
) {
    loop {
        let received = exits.recv().await;
        let Some(agent_tools) = tools.upgrade() else {
            return;
        };
        match received {
            Ok(notice) => agent_tools.ended(notice.session),
            // Missed notices: every session no longer running loses its token.
            Err(RecvError::Lagged(_)) => {
                let Some(hosted) = hosted.upgrade() else {
                    return;
                };
                agent_tools.ended_unless(|session| hosted.sessions().get(session).is_some());
            }
            Err(RecvError::Closed) => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every family on, or every family off.
    fn settings(on: bool) -> HostSettings {
        HostSettings {
            browser_mcp: on,
            session_mcp: on,
            ..crate::workspace::settings::defaults()
        }
    }

    fn tools() -> HostAgentTools {
        let events = Arc::new(super::super::events::Events::new());
        HostAgentTools::new(Arc::new(BrowserRelay::new(&events)))
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn s8_with_every_family_off_nothing_binds_and_no_token_is_minted() {
        let tools = tools();
        tools.follow(&settings(false));
        assert!(tools.grant().unwrap().is_none());
        assert_eq!(tools.listener.address(), None);

        // On, but nothing binds until a launch is granted.
        tools.follow(&settings(true));
        assert_eq!(tools.listener.address(), None);
        let grant = tools.grant().unwrap().expect("a grant with a family on");
        assert!(tools.listener.address().is_some());
        tools.failed(grant.id);

        // Off again with no token held: the socket is let go.
        tools.follow(&settings(false));
        assert_eq!(tools.listener.address(), None);
        tools.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn s7_a_stopped_host_grants_nothing_and_holds_no_port() {
        let tools = tools();
        tools.follow(&settings(true));
        let grant = tools.grant().unwrap().unwrap();
        tools.started(grant.id, SessionId(1));
        tools.stop().await;
        assert_eq!(tools.listener.address(), None);
        assert!(tools.grant().unwrap().is_none());
        // A settings change after the stop binds nothing.
        tools.follow(&settings(true));
        assert_eq!(tools.listener.address(), None);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_session_that_ends_before_its_launch_returns_has_its_token_revoked_on_start() {
        let tools = tools();
        tools.follow(&settings(true));
        let grant = tools.grant().unwrap().unwrap();
        tools.ended(SessionId(4));
        tools.started(grant.id, SessionId(4));
        {
            let held = tools.held();
            assert!(held.by_session.is_empty());
            assert!(held.ended_early.is_empty());
            assert_eq!(held.launching, 0);
        }
        tools.stop().await;
    }
}
