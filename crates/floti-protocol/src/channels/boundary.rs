//! Where every channel in `shared/ipc.ts` went.
//!
//! Each ipc.ts channel lands in exactly one place: declared in the protocol
//! under its own name or a recorded backend-neutral rename, carried on a byte
//! stream, kept by the client ([`CLIENT_ONLY`]), or kept inside the host
//! ([`HOST_INTERNAL`]). A test reads ipc.ts and fails naming any channel that
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
];

/// Channels that stay inside the host: plugin background pages run there, so
/// their tool calls, the answers and their state never cross the protocol.
pub const HOST_INTERNAL: &[Outside] = &[
    outside(
        "plugins:tool",
        "a session's call to a plugin tool, answered by its background page on the host",
    ),
    outside(
        "plugins:toolCancel",
        "cancels a plugin tool call on the host",
    ),
    outside(
        "plugins:toolResult",
        "a background page's answer to a plugin tool call, on the host",
    ),
    outside(
        "plugins:backgroundState",
        "a background page reporting its state to the host that runs it",
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
