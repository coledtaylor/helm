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
//! What each launch was granted is kept in its row (port, the token's
//! SHA-256 and the families), so a host that takes back sessions which
//! outlived the one before it serves them again at the same address and with
//! the same token ([`HostAgentTools::take_back`]).
//!
//! Today that is helm-browser ([`BrowserTools`]), on the `browserMcp`
//! setting and given to a launch only while a client with a browser pane is
//! attached; helm-sessions ([`SessionTools`]), on the `sessionMcp` setting;
//! floti-agents ([`FlotiAgents`]), on the `sessionAgents` setting, given to
//! every launch whoever is attached unless its profile turns it off; and `helm-plugin-<id>` for each plugin with its tools on: for a version 2
//! plugin, whose background module runs in the host's engine, served by the
//! host itself from its manifest with no client attached
//! ([`HostPluginFamilies`]), given to every launch while the plugin is on;
//! for a version 1 plugin, each tool server a client offers
//! ([`PluginFamilies`]), given to a launch only while that client is
//! attached. A client's offer naming a version 2 plugin is passed over.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use floti_protocol::channels::workspace::HostSettings;
use tokio::sync::broadcast::{self, error::RecvError};

use super::browser_tools::BrowserTools;
use super::features::{BrowserRelay, PluginRelay};
use super::floti_agents::FlotiAgents;
use super::hosted::Hosted;
use super::plugin_tools::{HostPluginFamilies, HostPluginTools, PluginFamilies};
use super::records::ExitNotice;
use super::session_tools::{SessionTools, SessionsWorld};
use crate::Result;
use crate::agent_tools::{AgentToolsListener, FamilySource, Grant, GrantId, KeptGrant, ToolFamily};
use crate::session::SessionId;

pub(crate) struct HostAgentTools {
    listener: AgentToolsListener,
    browser: Arc<BrowserTools>,
    sessions: Arc<SessionTools>,
    agents: Arc<FlotiAgents>,
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
    /// the settings, the browser tools carried through `relay`, the version
    /// 2 plugins' answered by the host through `hosted`, and the version 1
    /// plugins' carried to clients through `plugins`. Call it inside the
    /// host's runtime.
    pub fn new(
        relay: Arc<BrowserRelay>,
        plugins: Arc<PluginRelay>,
        hosted: Arc<HostPluginTools>,
    ) -> Self {
        let browser = Arc::new(BrowserTools::new(relay));
        let sessions = Arc::new(SessionTools::new());
        let agents = Arc::new(FlotiAgents::new());
        let families: Vec<Arc<dyn ToolFamily>> = vec![
            Arc::clone(&browser) as Arc<dyn ToolFamily>,
            Arc::clone(&sessions) as Arc<dyn ToolFamily>,
            Arc::clone(&agents) as Arc<dyn ToolFamily>,
        ];
        // The host's own first: a client's server of the same name is
        // passed over.
        let sources: Vec<Arc<dyn FamilySource>> = vec![
            Arc::new(HostPluginFamilies::new(hosted)),
            Arc::new(PluginFamilies::new(plugins)),
        ];
        Self {
            listener: AgentToolsListener::with_source(
                families,
                Some(Arc::new(sources) as Arc<dyn FamilySource>),
            ),
            browser,
            sessions,
            agents,
            held: Mutex::new(Held::default()),
            stopped: AtomicBool::new(false),
        }
    }

    /// What helm-sessions answers from.
    pub fn answer_from(&self, world: Arc<dyn SessionsWorld>) {
        self.sessions.answer_from(world);
    }

    /// What floti-agents acts through: the host's sessions.
    pub fn act_through(&self, hosted: Weak<Hosted>) {
        self.agents.act_through(hosted);
    }

    /// Switches each family as `settings` say, then [`Self::settle`]s.
    pub fn follow(&self, settings: &HostSettings) {
        self.browser.switch(settings.browser_mcp);
        self.sessions.switch(settings.session_mcp);
        self.agents.switch(settings.session_agents);
        self.settle();
    }

    /// With no token held and nothing a launch could be given, the socket is
    /// let go. Called when the settings, the plugins' offers or the host's
    /// own plugins change.
    /// Nothing binds here: the first grant binds, so a host whose sessions
    /// take no agent tools holds no port.
    pub fn settle(&self) {
        if !self.stopped.load(Ordering::SeqCst) {
            self.listener.let_go_if_idle();
        }
    }

    /// A token for a launch about to be composed, with an entry for each
    /// family on that can be given now (helm-browser only while a browser
    /// client is attached) except those in `excluded`; `None`, with nothing
    /// bound and no token minted, when there is none or the host is stopping.
    pub fn grant(&self, excluded: &[&str]) -> Result<Option<Grant>> {
        if self.stopped.load(Ordering::SeqCst) {
            return Ok(None);
        }
        let mut held = self.held();
        let grant = self.listener.grant_without(excluded)?;
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

    /// What to keep of `grant` in its session's row.
    pub fn kept(&self, grant: GrantId) -> Option<KeptGrant> {
        self.listener.kept(grant)
    }

    /// Serves again the sessions taken back from the keeper, each with what
    /// its row kept of its grant, on the port they were told. Sessions told
    /// a port that cannot be had again run on without their tools, and the
    /// log says so, naming the port and never a token.
    pub fn take_back(&self, sessions: Vec<(SessionId, KeptGrant)>) {
        if sessions.is_empty() || self.stopped.load(Ordering::SeqCst) {
            return;
        }
        let mut by_port: Vec<(u16, Vec<(SessionId, KeptGrant)>)> = Vec::new();
        for (session, kept) in sessions {
            match by_port.iter_mut().find(|(port, _)| *port == kept.port) {
                Some((_, group)) => group.push((session, kept)),
                None => by_port.push((kept.port, vec![(session, kept)])),
            }
        }
        let mut held = self.held();
        for (port, group) in by_port {
            match self.listener.take_back(port, &group) {
                Ok(grants) => held.by_session.extend(grants),
                Err(err) => log_line!(
                    "floti host: {} session(s) that outlived the last host run on without Helm's agent tools: {err}",
                    group.len()
                ),
            }
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
    pub(crate) fn ended_unless(&self, running: impl Fn(SessionId) -> bool) {
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
            session_agents: on,
            ..crate::workspace::settings::defaults()
        }
    }

    fn tools() -> HostAgentTools {
        let events = Arc::new(super::super::events::Events::new());
        HostAgentTools::new(
            Arc::new(BrowserRelay::new(&events)),
            Arc::new(PluginRelay::new(&events)),
            Arc::new(HostPluginTools::new(|_| None)),
        )
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn s8_with_every_family_off_nothing_binds_and_no_token_is_minted() {
        let tools = tools();
        tools.follow(&settings(false));
        assert!(tools.grant(&[]).unwrap().is_none());
        assert_eq!(tools.listener.address(), None);

        // On, but nothing binds until a launch is granted.
        tools.follow(&settings(true));
        assert_eq!(tools.listener.address(), None);
        let grant = tools.grant(&[]).unwrap().expect("a grant with a family on");
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
        let grant = tools.grant(&[]).unwrap().unwrap();
        tools.started(grant.id, SessionId(1));
        tools.stop().await;
        assert_eq!(tools.listener.address(), None);
        assert!(tools.grant(&[]).unwrap().is_none());
        // A settings change after the stop binds nothing.
        tools.follow(&settings(true));
        assert_eq!(tools.listener.address(), None);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_session_that_ends_before_its_launch_returns_has_its_token_revoked_on_start() {
        let tools = tools();
        tools.follow(&settings(true));
        let grant = tools.grant(&[]).unwrap().unwrap();
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
