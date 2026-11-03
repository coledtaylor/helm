//! Who may ask for what: every channel's least role, a device's presence,
//! and the live connections a revoke closes.
//!
//! **Roles.** [`rule`] gives every request, event and stream channel the
//! host serves the least role that may use it (Viewer, Operator, Admin),
//! with what the request does, for the refusal. The connection applies it
//! before any feature sees the request, so a feature never checks a role
//! itself; a channel with no rule is served to no device, and a unit test
//! fails naming any channel the host serves without one. A viewer sees
//! sessions, screens, files, history and usage and types nothing (its keys
//! are dropped where they arrive); an operator also types into, starts,
//! stops, resumes and restores sessions, opens plain terminals and writes
//! notes; an admin also pairs and revokes devices, manages plugins, secrets
//! and host settings, and writes config. `host:quit` and
//! `host:deviceSessions` are every role's. Plugin page calls keep their own
//! rule in `features/plugins/pages.rs`.
//!
//! The admin channels that only read (`devices:list`, `devices:audit`) are
//! marked in the table ([`Least::AdminReading`]): every other request on an
//! admin channel is an admin action, which the audit log records whether it
//! was done or refused for role or presence (`super::audit`).
//!
//! **Presence.** A connection on the host's relay endpoint, which `floti
//! connect` opens, is away: the device reached the host from another
//! computer. An admin action from an away connection is refused with
//! `ErrorCode::PresenceNeeded` unless that device said `devices:presence`
//! within the last [`PRESENCE_WINDOW`]. The device sends it after its own OS
//! check (Windows Hello, Touch ID or the account password) and the host
//! trusts that statement, which arrives inside the device's authenticated
//! Noise session. The time is kept in memory only, on the host's clock
//! ([`HostClock`]), per device key. Nothing but an admin action from an
//! away connection ever asks, and presence never raises a role. A device on
//! the host's own computer and `floti devices` in a shell there are never
//! asked.
//!
//! **Revoking.** Every welcomed connection registers its device key in
//! [`LiveConnections`]; revoking a device closes each of its connections at
//! once, ending none of its sessions.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use floti_protocol::noise::PublicKey;
use tokio::sync::oneshot;
use tokio::time::Instant;

use super::clock::HostClock;
use crate::devices::Role;
use crate::session::ClientId;

#[cfg(test)]
mod tests;

/// How long a device's confirmed presence lets it make admin actions from
/// another computer.
pub const PRESENCE_WINDOW: Duration = Duration::from_secs(5 * 60);

/// The least role a channel takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Least {
    /// Every paired device.
    Viewer,
    Operator,
    Admin,
    /// An admin, but any device for itself: `devices:revoke`.
    AdminUnlessItself,
    /// An admin, for a request that only reads (`devices:list`,
    /// `devices:audit`): gated as any admin action, but not recorded in the
    /// audit log.
    AdminReading,
}

/// One channel's rule: its least role, and what a request on it does, as a
/// refusal says it ("Copying Helm's data into the host").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Rule {
    pub least: Least,
    pub doing: &'static str,
}

impl Rule {
    /// Whether a request on the channel is an admin action the audit log
    /// records, done or refused: every admin channel's but those that only
    /// read.
    pub(crate) fn audited(self) -> bool {
        matches!(self.least, Least::Admin | Least::AdminUnlessItself)
    }
}

const SEEING: &str = "Seeing this";
const SESSIONS: &str = "Starting, stopping or changing a session";
const TERMINALS: &str = "Opening, resizing or closing a plain terminal";
const NOTES: &str = "Writing a note";
const PROFILES: &str = "Changing or launching a profile";
const HARNESS: &str = "Creating a harness";
const PLUGIN_COMMANDS: &str = "Running a plugin's command";
const AGENT_TOOLS: &str = "Answering a session's agent tools";
const DEVICES: &str = "Listing, approving or revoking devices";
const ROLES: &str = "Changing a device's role";
const AUDIT: &str = "Reading the audit log";
const PLUGINS: &str = "Adding, removing or switching a plugin";
const SECRETS: &str = "Seeing or changing a plugin's secrets";
const SETTINGS: &str = "Changing the host's settings";
const ROOTS: &str = "Changing the host's scan roots";
const SETUP: &str = "Setting up the host";
const TEMPLATES: &str = "Changing a template";
const CONFIG: &str = "Writing config";
const CARRY: &str = "Copying Helm's data into the host";
const STOP: &str = "Stopping the host";

/// Every channel's rule, by name.
const RULES: &[(&str, Least, &str)] = &[
    // Every role's: what a device's own quit asks and does.
    ("host:quit", Least::Viewer, SEEING),
    ("host:deviceSessions", Least::Viewer, SEEING),
    // Presence is said by any device; it never raises a role.
    ("devices:presence", Least::Viewer, SEEING),
    // Who is attached, and each new connection: every role sees them.
    ("devices:attached", Least::Viewer, SEEING),
    ("devices:connected", Least::Viewer, SEEING),
    // Seeing: sessions, screens, files, notes, history, usage and the rest.
    ("app:info", Least::Viewer, SEEING),
    ("archive:changed", Least::Viewer, SEEING),
    ("archive:conversation", Least::Viewer, SEEING),
    ("archive:stats", Least::Viewer, SEEING),
    ("config:effective", Least::Viewer, SEEING),
    ("config:externalChange", Least::Viewer, SEEING),
    ("config:mcpList", Least::Viewer, SEEING),
    ("config:mcpPreview", Least::Viewer, SEEING),
    ("config:render", Least::Viewer, SEEING),
    ("config:snapshot", Least::Viewer, SEEING),
    ("config:snapshots", Least::Viewer, SEEING),
    ("config:watch", Least::Viewer, SEEING),
    ("config:read", Least::Viewer, SEEING),
    ("config:scopes", Least::Viewer, SEEING),
    ("config:tree", Least::Viewer, SEEING),
    ("config:doctor", Least::Viewer, SEEING),
    ("content:artifact", Least::Viewer, SEEING),
    ("content:artifactBytes", Least::Viewer, SEEING),
    ("content:document", Least::Viewer, SEEING),
    ("content:render", Least::Viewer, SEEING),
    ("content:scopes", Least::Viewer, SEEING),
    ("content:search", Least::Viewer, SEEING),
    ("content:snapshots", Least::Viewer, SEEING),
    ("content:wikilink", Least::Viewer, SEEING),
    ("discovery:cached", Least::Viewer, SEEING),
    ("discovery:updated", Least::Viewer, SEEING),
    ("discovery:scan", Least::Viewer, SEEING),
    ("editor:highlight", Least::Viewer, SEEING),
    ("files:changed", Least::Viewer, SEEING),
    ("files:dir", Least::Viewer, SEEING),
    ("files:list", Least::Viewer, SEEING),
    ("files:status", Least::Viewer, SEEING),
    ("files:watch", Least::Viewer, SEEING),
    ("files:read", Least::Viewer, SEEING),
    ("git:refresh", Least::Viewer, SEEING),
    ("git:updated", Least::Viewer, SEEING),
    ("history:changed", Least::Viewer, SEEING),
    ("history:projects", Least::Viewer, SEEING),
    ("history:prompts", Least::Viewer, SEEING),
    ("history:sessions", Least::Viewer, SEEING),
    ("history:summary", Least::Viewer, SEEING),
    ("plugins:changed", Least::Viewer, SEEING),
    ("plugins:deliver", Least::Viewer, SEEING),
    ("plugins:file", Least::Viewer, SEEING),
    ("plugins:list", Least::Viewer, SEEING),
    ("plugins:log", Least::Viewer, SEEING),
    ("plugins:metrics", Least::Viewer, SEEING),
    ("plugins:ui", Least::Viewer, SEEING),
    ("profile:export", Least::Viewer, SEEING),
    ("profile:list", Least::Viewer, SEEING),
    ("profiles:changed", Least::Viewer, SEEING),
    ("pterm:data", Least::Viewer, SEEING),
    ("pterm:exit", Least::Viewer, SEEING),
    ("pterm:shells", Least::Viewer, SEEING),
    ("roots:suggest", Least::Viewer, SEEING),
    ("scan:status", Least::Viewer, SEEING),
    ("session:activate", Least::Viewer, SEEING),
    ("session:activity", Least::Viewer, SEEING),
    ("session:confirm", Least::Viewer, SEEING),
    ("session:data", Least::Viewer, SEEING),
    ("session:exit", Least::Viewer, SEEING),
    ("session:list", Least::Viewer, SEEING),
    ("session:notify", Least::Viewer, SEEING),
    ("session:restorable", Least::Viewer, SEEING),
    ("sessions:overview", Least::Viewer, SEEING),
    ("sessions:resources", Least::Viewer, SEEING),
    ("sessions:watch", Least::Viewer, SEEING),
    ("settings:changed", Least::Viewer, SEEING),
    ("settings:read", Least::Viewer, SEEING),
    ("setup:status", Least::Viewer, SEEING),
    ("template:detail", Least::Viewer, SEEING),
    ("template:folderPreview", Least::Viewer, SEEING),
    ("template:list", Least::Viewer, SEEING),
    ("template:preview", Least::Viewer, SEEING),
    ("usage:changed", Least::Viewer, SEEING),
    ("usage:read", Least::Viewer, SEEING),
    // Plugin page calls: `features/plugins/pages.rs` limits a viewer's.
    ("plugins:call", Least::Viewer, SEEING),
    ("plugins:answer", Least::Viewer, SEEING),
    ("plugins:cancel", Least::Viewer, SEEING),
    ("plugins:session", Least::Viewer, SEEING),
    // Working in sessions, plain terminals and notes.
    ("session:start", Least::Operator, SESSIONS),
    ("session:launch", Least::Operator, SESSIONS),
    ("session:close", Least::Operator, SESSIONS),
    ("session:rename", Least::Operator, SESSIONS),
    ("session:resize", Least::Operator, SESSIONS),
    ("session:focus", Least::Operator, SESSIONS),
    ("session:confirmed", Least::Operator, SESSIONS),
    ("session:restore", Least::Operator, SESSIONS),
    ("history:resume", Least::Operator, SESSIONS),
    ("history:rename", Least::Operator, SESSIONS),
    ("history:refresh", Least::Operator, SESSIONS),
    ("pterm:open", Least::Operator, TERMINALS),
    ("pterm:resize", Least::Operator, TERMINALS),
    ("pterm:close", Least::Operator, TERMINALS),
    ("content:write", Least::Operator, NOTES),
    ("content:restore", Least::Operator, NOTES),
    ("profile:launch", Least::Operator, PROFILES),
    ("profile:save", Least::Operator, PROFILES),
    ("profile:delete", Least::Operator, PROFILES),
    ("profile:import", Least::Operator, PROFILES),
    ("profile:pin", Least::Operator, PROFILES),
    ("harness:create", Least::Operator, HARNESS),
    ("template:substitute", Least::Operator, HARNESS),
    ("plugins:command", Least::Operator, PLUGIN_COMMANDS),
    ("agentBrowser:call", Least::Operator, AGENT_TOOLS),
    ("agentBrowser:answer", Least::Operator, AGENT_TOOLS),
    ("agentPlugin:call", Least::Operator, AGENT_TOOLS),
    ("agentPlugin:cancel", Least::Operator, AGENT_TOOLS),
    ("agentPlugin:offer", Least::Operator, AGENT_TOOLS),
    ("agentPlugin:answer", Least::Operator, AGENT_TOOLS),
    // Changing the host.
    ("devices:list", Least::AdminReading, DEVICES),
    ("devices:approve", Least::Admin, DEVICES),
    ("devices:revoke", Least::AdminUnlessItself, DEVICES),
    ("devices:role", Least::Admin, ROLES),
    ("devices:audit", Least::AdminReading, AUDIT),
    ("plugins:add", Least::Admin, PLUGINS),
    ("plugins:remove", Least::Admin, PLUGINS),
    ("plugins:setEnabled", Least::Admin, PLUGINS),
    ("plugins:setTools", Least::Admin, PLUGINS),
    ("plugins:reload", Least::Admin, PLUGINS),
    ("plugins:setSetting", Least::Admin, PLUGINS),
    ("plugins:ownSecrets", Least::Admin, SECRETS),
    ("secrets:list", Least::Admin, SECRETS),
    ("secrets:save", Least::Admin, SECRETS),
    ("secrets:remove", Least::Admin, SECRETS),
    ("secrets:changed", Least::Admin, SECRETS),
    ("settings:write", Least::Admin, SETTINGS),
    ("roots:accept", Least::Admin, ROOTS),
    ("roots:remove", Least::Admin, ROOTS),
    ("setup:complete", Least::Admin, SETUP),
    ("setup:locateBackend", Least::Admin, SETUP),
    ("template:create", Least::Admin, TEMPLATES),
    ("template:delete", Least::Admin, TEMPLATES),
    ("template:rename", Least::Admin, TEMPLATES),
    ("template:metadata", Least::Admin, TEMPLATES),
    ("template:import", Least::Admin, TEMPLATES),
    ("template:fromFolder", Least::Admin, TEMPLATES),
    ("config:create", Least::Admin, CONFIG),
    ("config:write", Least::Admin, CONFIG),
    ("config:mcpAdd", Least::Admin, CONFIG),
    ("config:mcpRemove", Least::Admin, CONFIG),
    ("config:delete", Least::Admin, CONFIG),
    ("config:rename", Least::Admin, CONFIG),
    ("config:restore", Least::Admin, CONFIG),
    ("config:mcpApprove", Least::Admin, CONFIG),
    ("carry:status", Least::Admin, CARRY),
    ("carry:missing", Least::Admin, CARRY),
    ("carry:names", Least::Admin, CARRY),
    ("carry:versions", Least::Admin, CARRY),
    ("carry:usage", Least::Admin, CARRY),
    ("carry:conversations", Least::Admin, CARRY),
    ("carry:finish", Least::Admin, CARRY),
    ("host:stop", Least::Admin, STOP),
];

/// The rule for `channel`; `None` for a channel no device is served.
pub(crate) fn rule(channel: &str) -> Option<Rule> {
    RULES
        .iter()
        .find(|(name, ..)| *name == channel)
        .map(|&(_, least, doing)| Rule { least, doing })
}

/// Every channel with a rule.
#[cfg(test)]
pub(crate) fn ruled() -> impl Iterator<Item = &'static str> {
    RULES.iter().map(|(name, ..)| *name)
}

/// What a request comes to before any feature sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Gate {
    /// Served.
    Open,
    /// Refused for the device's role: the sentence says what the request
    /// takes and what the device is paired as.
    NotPermitted(String),
    /// An admin action from an away connection without a recent presence.
    PresenceNeeded,
}

/// What a connection is, for its gate.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Asker {
    pub role: Role,
    /// Whether it reached the host from another computer.
    pub away: bool,
    /// Whether its device said `devices:presence` within the window.
    pub present: bool,
}

/// Whether `asker` may use `channel`; `itself` says whether the request
/// names the asker's own device (a revoke of itself).
pub(crate) fn gate(channel: &str, asker: Asker, itself: bool) -> Gate {
    let Some(rule) = rule(channel) else {
        return Gate::NotPermitted(format!("This host serves `{channel}` to no device."));
    };
    let least = match rule.least {
        Least::Viewer => return Gate::Open,
        Least::Operator => Role::Operator,
        Least::Admin | Least::AdminReading => Role::Admin,
        Least::AdminUnlessItself if itself => return Gate::Open,
        Least::AdminUnlessItself => Role::Admin,
    };
    if rank(asker.role) < rank(least) {
        return Gate::NotPermitted(refusal(rule.doing, least, asker.role));
    }
    if least == Role::Admin && asker.away && !asker.present {
        return Gate::PresenceNeeded;
    }
    Gate::Open
}

/// Whether a device paired as `role` may be sent what is published on
/// `channel`: its role alone decides, as it does for a device whose role
/// changed after it subscribed. A channel with no rule is left to its
/// subscription's own gate.
pub(crate) fn role_allows(channel: &str, role: Role) -> bool {
    let Some(rule) = rule(channel) else {
        return true;
    };
    let least = match rule.least {
        Least::Viewer => return true,
        Least::Operator => Role::Operator,
        Least::Admin | Least::AdminReading | Least::AdminUnlessItself => Role::Admin,
    };
    rank(role) >= rank(least)
}

/// What an admin action from another computer without a recent presence is
/// told.
pub const PRESENCE_NEEDED: &str = "This admin action comes from another computer, so it needs \
                                   you present: confirm it is you on this device, then ask \
                                   again. A confirmation lasts five minutes.";

fn rank(role: Role) -> u8 {
    match role {
        Role::Viewer => 0,
        Role::Operator => 1,
        Role::Admin => 2,
    }
}

/// The refusal of `doing`, which takes `least`, to a device paired as
/// `role`.
pub(crate) fn refusal(doing: &str, least: Role, role: Role) -> String {
    let takes = match least {
        Role::Admin => "an admin device",
        Role::Operator | Role::Viewer => "an operator or admin device",
    };
    format!(
        "{doing} takes {takes}, and this device is paired as {}.",
        role.with_article()
    )
}

/// The time each device last confirmed its presence, in memory only.
pub(crate) struct Confirmations {
    clock: HostClock,
    at: Mutex<HashMap<PublicKey, Instant>>,
}

impl Confirmations {
    pub(crate) fn new(clock: HostClock) -> Self {
        Self {
            clock,
            at: Mutex::new(HashMap::new()),
        }
    }

    fn at(&self) -> MutexGuard<'_, HashMap<PublicKey, Instant>> {
        self.at.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `device` confirmed its presence now.
    pub(crate) fn confirm(&self, device: PublicKey) {
        let now = self.clock.now();
        self.at().insert(device, now);
    }

    /// Whether `device` confirmed its presence within [`PRESENCE_WINDOW`].
    pub(crate) fn recent(&self, device: &PublicKey) -> bool {
        let now = self.clock.now();
        self.at()
            .get(device)
            .is_some_and(|at| now.saturating_duration_since(*at) <= PRESENCE_WINDOW)
    }

    /// Forgets `device`: it was revoked.
    pub(crate) fn forget(&self, device: &PublicKey) {
        self.at().remove(device);
    }
}

type ByKey = HashMap<PublicKey, HashMap<ClientId, oneshot::Sender<()>>>;

/// Every welcomed connection, by its device's key, with what closes it.
#[derive(Default)]
pub(crate) struct LiveConnections {
    by_key: Mutex<ByKey>,
}

/// A connection's place in [`LiveConnections`]: [`Live::closed`] resolves
/// when its device is revoked; dropping it takes the connection out.
pub(crate) struct Live {
    live: std::sync::Arc<LiveConnections>,
    key: PublicKey,
    client: ClientId,
    closed: Option<oneshot::Receiver<()>>,
}

impl LiveConnections {
    fn by_key(&self) -> MutexGuard<'_, ByKey> {
        self.by_key.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Counts `client`, on a connection that proved `key`, until the
    /// returned place is dropped.
    pub(crate) fn enter(self: &std::sync::Arc<Self>, key: PublicKey, client: ClientId) -> Live {
        let (close, closed) = oneshot::channel();
        self.by_key().entry(key).or_default().insert(client, close);
        Live {
            live: std::sync::Arc::clone(self),
            key,
            client,
            closed: Some(closed),
        }
    }

    /// Closes every connection of `key`: how many there were.
    pub(crate) fn close_all(&self, key: &PublicKey) -> usize {
        let Some(connections) = self.by_key().remove(key) else {
            return 0;
        };
        let count = connections.len();
        for (_, close) in connections {
            let _ = close.send(());
        }
        count
    }

    /// How many connections `key` has open.
    #[cfg(test)]
    pub(crate) fn count(&self, key: &PublicKey) -> usize {
        self.by_key().get(key).map_or(0, HashMap::len)
    }
}

impl Live {
    /// Resolves once the device is revoked; never, once it has.
    pub(crate) async fn closed(&mut self) {
        match self.closed.as_mut() {
            Some(closed) => {
                // A sender dropped without a send is the registry going: it
                // closes the connection all the same.
                let _ = closed.await;
                self.closed = None;
            }
            None => std::future::pending().await,
        }
    }
}

impl Drop for Live {
    fn drop(&mut self) {
        let mut by_key = self.live.by_key();
        if let Some(connections) = by_key.get_mut(&self.key) {
            connections.remove(&self.client);
            if connections.is_empty() {
                by_key.remove(&self.key);
            }
        }
    }
}
