//! Where every channel in `shared/ipc.ts` went.
//!
//! Each ipc.ts channel lands in exactly one place: declared in the protocol
//! under its own name or a recorded backend-neutral rename, carried on a byte
//! stream, kept by the client ([`CLIENT_ONLY`]), or kept between a plugin's
//! background page and whatever runs it ([`HOST_INTERNAL`]). A test reads ipc.ts and fails naming any channel that
//! lands nowhere, so a channel added there is placed here in the same change.
//!
//! The browser pane, clipboard, window, theme, dialogs and diagnostics belong
//! to one client's window and never cross the protocol.

use crate::channel::Catalogue;
use crate::channels::sessions::CARRIED_ON_STREAMS;

/// ipc.ts channels, or `family:*` families, that stay out of the protocol,
/// with why.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Outside {
    /// A channel name, or a family written `family:*`.
    pub channels: &'static str,
    pub reason: &'static str,
}

impl Outside {
    /// Whether `name` is this channel or in this family.
    pub fn covers(&self, name: &str) -> bool {
        match self.channels.strip_suffix('*') {
            Some(family) => name.starts_with(family),
            None => name == self.channels,
        }
    }
}

const fn outside(channels: &'static str, reason: &'static str) -> Outside {
    Outside { channels, reason }
}

/// Channels that belong to the client: they act on its window, its machine
/// or its own diagnostics.
pub const CLIENT_ONLY: &[Outside] = &[
    outside(
        "browser:*",
        "the browser pane and its sign-ins live in the client; agent browser tools reach it over agentBrowser:*",
    ),
    outside("clipboard:*", "the clipboard of the client's machine"),
    outside("shell:*", "opens a file or a link on the client's machine"),
    outside(
        "path:*",
        "native file and folder pickers; the channel that needs the choice takes the path",
    ),
    outside("theme:*", "the theme of the client's window"),
    outside("themes:*", "theme files the client's window draws with"),
    outside(
        "plugins:theme",
        "the theme plugin pages see is the theme of the window framing them",
    ),
    outside(
        "update:check",
        "each client checks for its own updates; the host contacts nothing",
    ),
    outside("update:checked", "the client's own update check"),
    outside(
        "files:editor",
        "names the editor installed on the client's machine",
    ),
    outside(
        "files:openInEditor",
        "opens a file in the editor on the client's machine",
    ),
    outside(
        "roots:add",
        "opens the client's folder picker; the folder it chose arrives on roots:accept",
    ),
    outside(
        "renderer:ready",
        "the desktop window telling its own main process it has painted",
    ),
    outside(
        "term:*",
        "the desktop's single-terminal spike page, never a hosted session",
    ),
    outside("pty:*", "the desktop's single-terminal spike page's input"),
    outside("probe:*", "the desktop's terminal fidelity diagnostics"),
    outside(
        "content:artifactConsole",
        "a line from an HTML artifact's frame, which the client renders",
    ),
    outside(
        "hostLink:*",
        "a Helm page's own connection to the host, whose protocol frames the desktop's main process pipes to a bridge and never reads",
    ),
    outside(
        "ownSettings:*",
        "the settings the client keeps for itself: its window, theme, terminal and browser preferences, and the programs it picked, which its main process tells the host",
    ),
    outside(
        "ownApp:info",
        "the client's own build, data folder and runtime versions",
    ),
    outside(
        "profileDialog:*",
        "the client's own dialogs for deleting, exporting and importing a profile, and the file it writes or reads on its machine; the profile itself is the host's",
    ),
    outside(
        "windowSessions:*",
        "what the client's main process keeps of its sessions for its window: the OS notification for an exit nobody saw, the question before it quits with sessions running, and the pane layout its last run saved",
    ),
    outside(
        "pluginBackground:*",
        "what the client's hidden plugin window saw of the background pages it runs under plugin API v1, which its main process alone hears and tells its window",
    ),
    outside(
        "pluginWindow:*",
        "what a background page in the client's hidden plugin window asks that only the client's own window can draw (a plugin tab, a secret dialog), passed between its two windows by its main process",
    ),
];

/// Channels between a plugin's background page and what runs it, which never
/// cross the protocol. A v1 background page runs in the desktop's hidden
/// plugin host window and these are Electron IPC inside the desktop, its tool
/// calls reaching it through `agentPlugin:call`; a v2 background script runs
/// in the host's engine and these stay inside the host.
pub const HOST_INTERNAL: &[Outside] = &[
    outside(
        "plugins:tool",
        "a session's call to a plugin tool, handed to its background page by whatever runs it",
    ),
    outside(
        "plugins:toolCancel",
        "cancels a plugin tool call at whatever runs its background page",
    ),
    outside(
        "plugins:toolResult",
        "a background page's answer to a plugin tool call, to whatever runs it",
    ),
    outside(
        "plugins:backgroundState",
        "a background page reporting its state to whatever runs it",
    ),
];

/// ipc.ts channels the protocol declares under a backend-neutral name, as
/// `(ipc.ts channel, protocol channel)`.
pub const RENAMED: &[(&str, &str)] = &[("setup:locateClaude", "setup:locateBackend")];

/// Where one ipc.ts channel went.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placement {
    /// Declared in the protocol under this name.
    Declared(&'static str),
    /// The client-to-host direction of this stream channel.
    CarriedOnStream(&'static str),
    ClientOnly(&'static Outside),
    HostInternal(&'static Outside),
}

/// Where the ipc.ts channel `name` went in `catalogue`, or `None` when it
/// went nowhere: the protocol neither declares it nor lists it as
/// client-only or host-internal.
pub fn placement(catalogue: &Catalogue, name: &str) -> Option<Placement> {
    if let Some(decl) = catalogue.get(name) {
        return Some(Placement::Declared(decl.name()));
    }
    if let Some(decl) = RENAMED
        .iter()
        .find(|(ipc, _)| *ipc == name)
        .and_then(|(_, renamed)| catalogue.get(renamed))
    {
        return Some(Placement::Declared(decl.name()));
    }
    if let Some(decl) = CARRIED_ON_STREAMS
        .iter()
        .find(|(input, _)| *input == name)
        .and_then(|(_, stream)| catalogue.get(stream))
    {
        return Some(Placement::CarriedOnStream(decl.name()));
    }
    if let Some(entry) = CLIENT_ONLY.iter().find(|entry| entry.covers(name)) {
        return Some(Placement::ClientOnly(entry));
    }
    HOST_INTERNAL
        .iter()
        .find(|entry| entry.covers(name))
        .map(Placement::HostInternal)
}

/// Declared channels that a client-only entry covers. The protocol describes
/// the host, so this is empty.
pub fn declared_client_only(catalogue: &Catalogue) -> Vec<&'static str> {
    catalogue
        .channels()
        .map(|decl| decl.name())
        .filter(|name| CLIENT_ONLY.iter().any(|entry| entry.covers(name)))
        .collect()
}
