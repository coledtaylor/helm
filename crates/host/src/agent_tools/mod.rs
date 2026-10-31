//! Floti's agent tools, served to the sessions the host runs: the one inbound
//! listener the host has besides its local socket.
//!
//! The rules that make a listener acceptable, in one place:
//!
//! - **Loopback, always.** It binds `127.0.0.1` on port 0: never `0.0.0.0`,
//!   never `::`, never a port anybody chose. The port is whatever the OS hands
//!   out for this run, and it is written nowhere but the per-session tool
//!   configuration a launch is given.
//! - **Token, always.** Every request carries `Authorization: Bearer <token>`
//!   or it is answered 401 before its body is read, the same on every path, so
//!   nothing without a token learns which routes exist. A token is 32 random
//!   bytes, minted per session and revoked when the session ends; a listener
//!   knows none of the tokens one before it handed out. There is no
//!   unauthenticated route, not even a health check.
//! - **The token is the identity.** Which session is calling is which token
//!   arrived, resolved here; a family is handed that [`Caller`], never the
//!   token, and no tool takes a session id.
//! - **Off is off.** A family switched off has no route (404 to a caller
//!   holding a token), no entry in a launch's servers and no tool. With every
//!   family off nothing binds and no token is minted.
//! - **A token reaches what its launch was given.** Each grant records the
//!   families it names, and a family the launch was not given answers its
//!   token 404 exactly as one switched off, even once it could be given to
//!   a launch now (a browser attached after the session started).
//! - **Origin is checked first**, because a page in a browser on this machine
//!   can reach a loopback port. A request announcing a non-loopback `Origin`
//!   is refused 403 before its token is even compared.
//!
//! The checks are this module's own ([`front`]), in that order: Origin, token,
//! route, method (POST only: nothing here pushes, so there is no SSE stream to
//! GET), body size. Only a request that passed every one reaches `rmcp`, which
//! speaks the MCP protocol for each family over stateless streamable HTTP.
//!
//! **Named families, one listener.** Each family is a name (such as
//! `helm-browser`, the name the agent's permission rules use), a route, an
//! instructions block, a tool table, an on/off check read on every request,
//! and whether a launch now may be given it ([`ToolFamily`]). One port and one token per session serve
//! them all, and each family's "off" is three separate facts rather than a
//! promise: its route answers 404, its name is absent from a launch's
//! servers, and its tools are in no list.
//!
//! **Families that come and go.** Besides the families it is built with, a
//! listener reads a [`FamilySource`] on every request and every grant, such
//! as the plugin tool servers a client offers: one that leaves the source
//! answers 404 at once, and one that joins it reaches the launches after.
//!
//! **Read-only is allowed.** A tool a family lists with `readOnlyHint` is
//! named in its launch entry's allowed tools, which the agent is given as an
//! allow rule, fixed at launch.

mod front;
mod mcp;
mod tokens;

#[cfg(test)]
mod tests;

use std::future::Future;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::runtime::Handle;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

pub use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool, ToolAnnotations};

use crate::agent::AgentToolServer;
use crate::session::SessionId;
use crate::{Error, Result};

use front::Router;

/// What a tool call answers, as a future a family can box.
pub type ToolFuture<'a> = Pin<Box<dyn Future<Output = CallToolResult> + Send + 'a>>;

/// One family of agent tools on the listener.
pub trait ToolFamily: Send + Sync + 'static {
    /// Its name as a session lists it, such as `helm-browser`.
    fn name(&self) -> &str;

    /// The path it is served at, such as `/mcp/sessions`. Exact: no other
    /// path, prefix or case reaches it.
    fn route(&self) -> &str;

    /// What `initialize` tells a session about these tools.
    fn instructions(&self) -> &str;

    /// Whether it is switched on. Read on every request, so switching a
    /// family off takes its route away from running sessions at once.
    fn is_on(&self) -> bool;

    /// Whether a launch now is given it, while it is on: a family that needs
    /// something only some moments have, such as an attached browser, says
    /// no while it lacks it. Read at grant only; a session already holding
    /// it keeps its route.
    fn grantable(&self) -> bool {
        true
    }

    /// Its tools, as `tools/list` answers them. A tool that changes nothing
    /// is marked with `readOnlyHint`.
    fn tools(&self) -> Vec<Tool>;

    /// Answers one call to `name`, one of [`Self::tools`], for `caller`.
    /// A failure is an answer too: a failed call the model can read.
    /// Dropping the future abandons the call: nobody waits on it any more.
    fn call<'a>(&'a self, caller: Caller, name: &'a str, arguments: JsonObject) -> ToolFuture<'a>;
}

/// Families that come and go, read on every request and every grant.
pub trait FamilySource: Send + Sync + 'static {
    /// The families now. One whose name or route a family before it has is
    /// passed over.
    fn families(&self) -> Vec<Arc<dyn ToolFamily>>;
}

/// One minted token, by an id that is not the token: what the host keeps to
/// bind it to its session and revoke it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct GrantId(u64);

#[cfg(test)]
impl GrantId {
    /// A grant id for a family's own tests, which call it with no listener.
    pub(crate) fn for_tests(id: u64) -> Self {
        Self(id)
    }
}

/// Who is calling, as the token that arrived resolves it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Caller {
    /// The grant the token belongs to.
    pub grant: GrantId,
    /// The session holding it, once the host has bound one. A token is
    /// minted before its session starts, so a call can arrive before then.
    pub session: Option<SessionId>,
}

/// A launch's agent tools: one token, and an entry for each family on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grant {
    pub id: GrantId,
    /// The families on and grantable at launch, each at its `127.0.0.1`
    /// address and with the session's token. Never empty: with no family to
    /// give there is no grant.
    pub servers: Vec<AgentToolServer>,
}

/// The listener: its families, the tokens it has minted and, while it is
/// bound, its socket.
///
/// Built inside the host's runtime, which serves its connections.
pub struct AgentToolsListener {
    router: Arc<Router>,
    socket: Mutex<Option<Bound>>,
    runtime: Handle,
}

/// The bound socket and the task serving it.
struct Bound {
    address: SocketAddr,
    /// Dropped or sent, the task stops accepting and ends its connections.
    stop: oneshot::Sender<()>,
    task: JoinHandle<()>,
}

impl AgentToolsListener {
    /// A listener for `families`, bound to nothing yet.
    ///
    /// # Panics
    ///
    /// Outside a Tokio runtime, or when two families share a name or a route.
    pub fn new(families: Vec<Arc<dyn ToolFamily>>) -> Self {
        Self::with_source(families, None)
    }

    /// A listener for `families` and whatever `source` has when asked.
    ///
    /// # Panics
    ///
    /// As [`Self::new`].
    pub fn with_source(
        families: Vec<Arc<dyn ToolFamily>>,
        source: Option<Arc<dyn FamilySource>>,
    ) -> Self {
        for (index, family) in families.iter().enumerate() {
            assert!(
                family.route().starts_with('/'),
                "{}'s route is a path",
                family.name()
            );
            for other in &families[..index] {
                assert!(
                    other.name() != family.name() && other.route() != family.route(),
                    "two agent tool families share {} or {}",
                    family.name(),
                    family.route()
                );
            }
        }
        Self {
            router: Arc::new(Router::new(families, source)),
            socket: Mutex::new(None),
            runtime: Handle::current(),
        }
    }

    /// The names of the families switched on now.
    pub fn served_names(&self) -> Vec<String> {
        self.router
            .families_on()
            .iter()
            .map(|family| family.name().to_owned())
            .collect()
    }

    /// Where it is bound, while it is.
    pub fn address(&self) -> Option<SocketAddr> {
        self.socket().as_ref().map(|bound| bound.address)
    }

    /// Binds when a family is on and it is not bound yet; lets go of its
    /// socket when no family is on and no session holds a token. A session
    /// still holding one keeps the port it was given, every route answering
    /// it 404, so a family switched back on answers it again.
    ///
    /// Called when a family's switch changes.
    pub fn sync(&self) -> Result<()> {
        let mut socket = self.socket();
        if !self.router.families_on().is_empty() {
            if socket.is_none() {
                *socket = Some(self.bind()?);
            }
        } else if self.router.tokens().is_empty() {
            release(&mut socket);
        }
        Ok(())
    }

    /// Lets go of its socket when no session holds a token and no family on
    /// can be given to a launch; binds nothing. A family on that no launch
    /// can be given (helm-browser with no browser client, a plugin's server
    /// whose client left) is reachable only through a token, so with none
    /// held it keeps no port. Called when what is offered changes.
    pub fn let_go_if_idle(&self) {
        let mut socket = self.socket();
        if self.router.tokens().is_empty() && !self.grantable_on() {
            release(&mut socket);
        }
    }

    /// Whether a family on can be given to a launch now.
    fn grantable_on(&self) -> bool {
        self.router
            .families_on()
            .iter()
            .any(|family| family.grantable())
    }

    /// Mints a token for a session about to launch, for every family on and
    /// grantable now, binding first when it is not bound. `None`, with no
    /// token minted and nothing bound, when there is no such family.
    pub fn grant(&self) -> Result<Option<Grant>> {
        let mut socket = self.socket();
        let on: Vec<Arc<dyn ToolFamily>> = self
            .router
            .families_on()
            .into_iter()
            .filter(|family| family.grantable())
            .collect();
        if on.is_empty() {
            return Ok(None);
        }
        if socket.is_none() {
            *socket = Some(self.bind()?);
        }
        let port = socket.as_ref().map_or(0, |bound| bound.address.port());
        let names = on.iter().map(|family| family.name().to_owned()).collect();
        let (id, token) = self.router.tokens().mint(names);
        let servers = on
            .into_iter()
            .map(|family| AgentToolServer {
                name: family.name().to_owned(),
                url: format!("http://127.0.0.1:{port}{}", family.route()),
                token: token.clone(),
                allowed_tools: read_only_tools(family.as_ref()),
            })
            .collect();
        Ok(Some(Grant { id, servers }))
    }

    /// Ties a grant's token to the session that launched with it.
    pub fn bind_session(&self, grant: GrantId, session: SessionId) {
        self.router.tokens().bind(grant, session);
    }

    /// Revokes one grant's token: from now on it is answered 401. With no
    /// token left and no family on that a launch can be given, the socket is
    /// let go as well.
    pub fn revoke(&self, grant: GrantId) {
        let mut socket = self.socket();
        let no_token_left = {
            let mut tokens = self.router.tokens();
            tokens.revoke(grant);
            tokens.is_empty()
        };
        self.router.abandon_grant(grant);
        if no_token_left && !self.grantable_on() {
            release(&mut socket);
        }
    }

    /// Revokes every token, then stops serving: once this returns the port
    /// accepts no connection, and a listener started after knows none of the
    /// tokens this one handed out.
    pub async fn stop(&self) {
        self.router.tokens().revoke_all();
        self.router.abandon_all();
        let bound = self.socket().take();
        if let Some(bound) = bound {
            let _ = bound.stop.send(());
            let _ = bound.task.await;
        }
    }

    fn socket(&self) -> MutexGuard<'_, Option<Bound>> {
        self.socket
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// `127.0.0.1`, port 0: the OS picks the port, for this run only.
    fn bind(&self) -> Result<Bound> {
        let what = "bind the agent tools listener on 127.0.0.1";
        let loopback = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0));
        let listener = std::net::TcpListener::bind(loopback).map_err(|err| Error::io(what, err))?;
        listener
            .set_nonblocking(true)
            .map_err(|err| Error::io(what, err))?;
        let address = listener.local_addr().map_err(|err| Error::io(what, err))?;
        let listener = {
            let _entered = self.runtime.enter();
            tokio::net::TcpListener::from_std(listener).map_err(|err| Error::io(what, err))?
        };
        let (stop, stopped) = oneshot::channel();
        let task = self
            .runtime
            .spawn(front::serve(listener, Arc::clone(&self.router), stopped));
        Ok(Bound {
            address,
            stop,
            task,
        })
    }
}

impl Drop for AgentToolsListener {
    fn drop(&mut self) {
        release(&mut self.socket());
    }
}

/// Tells the serving task to stop without waiting for it.
fn release(socket: &mut Option<Bound>) {
    if let Some(bound) = socket.take() {
        let _ = bound.stop.send(());
    }
}

/// The tools `family` lists with `readOnlyHint`, by name: the ones a launch
/// is allowed to call without asking.
fn read_only_tools(family: &dyn ToolFamily) -> Vec<String> {
    family
        .tools()
        .into_iter()
        .filter(|tool| {
            tool.annotations
                .as_ref()
                .and_then(|notes| notes.read_only_hint)
                == Some(true)
        })
        .map(|tool| tool.name.into_owned())
        .collect()
}
