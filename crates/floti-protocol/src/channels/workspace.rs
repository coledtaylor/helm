//! Settings, setup, discovery, roots, harnesses, templates, the config
//! console, content and the Files view: `app:info`, `settings:*`, `setup:*`,
//! `discovery:*`, `scan:status`, `git:updated`, `roots:*`, `harness:create`,
//! `template:*`, `config:*`, `editor:highlight`, `content:*` and `files:*` in
//! `shared/ipc.ts`.
//!
//! How the ipc.ts channels map onto the protocol:
//!
//! - Wire names keep the ipc.ts strings, except where ipc.ts speaks of Claude.
//!   Setup speaks of agent backends: `setup:status` answers a status per
//!   backend, keyed by [`BackendId`](crate::backend::BackendId), and
//!   `setup:locateClaude` is `setup:locateBackend`, which names the backend.
//!   The settings' `claudePath` is `backendPaths`, one per backend.
//! - Where an ipc.ts handler opened a native dialog, the dialog stays in the
//!   client and the channel takes the path it produced: the folder the
//!   client's picker chose for `roots:add` arrives on `roots:accept`.
//! - `settings:*` carries the host's settings only. Theme, accent, density,
//!   window bounds, the pane layout, the terminal's look, the Files view's
//!   wrap, the rail, the browser pane's reach, search and remembered
//!   addresses, and the update check belong to one client's window and stay
//!   in the client. `app:info` is the host's identity; the client's own
//!   runtime versions stay in the client.
//! - Whole-state pushes (`settings:changed`, `discovery:updated`,
//!   `scan:status`, `git:updated`) are events that carry state: a
//!   subscription starts with a snapshot. `config:externalChange` and
//!   `files:changed` are events without state.
//! - Every `content:*` and `files:*` channel, and `files:changed`, needs the
//!   `files` capability.
//! - `roots:add`, `files:editor`, `files:openInEditor` and
//!   `content:artifactConsole` stay in the client:
//!   [`CLIENT_ONLY`](super::boundary::CLIENT_ONLY) says why.

mod app;
mod config;
mod content;
mod discovery;
mod files;
mod templates;

#[cfg(test)]
mod tests;

pub use app::*;
pub use config::*;
pub use content::*;
pub use discovery::*;
pub use files::*;
pub use templates::*;

use std::fmt;

use schemars::JsonSchema;
use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

use crate::channel::Catalogue;

pub fn declare(catalogue: &mut Catalogue) {
    catalogue
        // App, settings and setup.
        .request::<ReadAppInfo>()
        .request::<ReadSettings>()
        .request::<WriteSettings>()
        .event::<SettingsChanged>()
        .request::<ReadSetupStatus>()
        .request::<LocateBackend>()
        .request::<CompleteSetup>()
        // Discovery, roots and harnesses.
        .request::<ReadCachedDiscovery>()
        .request::<ScanForProjects>()
        .event::<DiscoveryUpdated>()
        .event::<ScanStatusChanged>()
        .event::<GitUpdated>()
        .request::<RefreshGit>()
        .request::<SuggestRoots>()
        .request::<AcceptRoot>()
        .request::<RemoveRoot>()
        .request::<CreateHarness>()
        // Templates.
        .request::<ListTemplates>()
        .request::<PreviewTemplate>()
        .request::<ReadTemplateDetail>()
        .request::<CreateTemplate>()
        .request::<RenameTemplate>()
        .request::<DeleteTemplate>()
        .request::<WriteTemplateMetadata>()
        .request::<SubstituteTemplateFile>()
        .request::<ImportIntoTemplate>()
        .request::<PreviewFolderTemplate>()
        .request::<SaveFolderAsTemplate>()
        // The config console.
        .request::<ListConfigScopes>()
        .request::<ReadConfigTree>()
        .request::<ReadConfigFile>()
        .request::<RenderConfigFile>()
        .request::<WriteConfigFile>()
        .request::<ListConfigSnapshots>()
        .request::<ReadConfigSnapshot>()
        .request::<RestoreConfigSnapshot>()
        .request::<WatchConfigFile>()
        .request::<CreateConfigFile>()
        .request::<RenameConfigFile>()
        .request::<DeleteConfigFile>()
        .request::<ReadEffectiveView>()
        .request::<PreviewMcpServer>()
        .request::<AddMcpServer>()
        .request::<RemoveMcpServer>()
        .request::<ApproveMcpServer>()
        .request::<ListMcpServers>()
        .request::<RunDoctor>()
        .event::<ConfigChangedOutside>()
        .request::<HighlightSource>()
        // Content.
        .request::<ListContentScopes>()
        .request::<ReadContentDocument>()
        .request::<RenderContent>()
        .request::<SearchContent>()
        .request::<WriteContent>()
        .request::<ListContentSnapshots>()
        .request::<RestoreContentSnapshot>()
        .request::<OpenArtifact>()
        .request::<ResolveWikilink>()
        // The Files view.
        .request::<ReadFilesDir>()
        .request::<ReadFilesStatus>()
        .request::<ReadFile>()
        .request::<ListFiles>()
        .request::<WatchFiles>()
        .event::<FilesChanged>();
}

/// Milliseconds, as a number that may have a fraction: a file's modification
/// time, or how long something took.
///
/// Decodes from a CBOR float or integer, because a JavaScript client encodes
/// a whole number as an integer.
#[derive(Debug, Clone, Copy, PartialEq, PartialOrd, Default, Serialize, JsonSchema, TS)]
#[serde(transparent)]
pub struct Millis(pub f64);

impl<'de> Deserialize<'de> for Millis {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct MillisVisitor;

        impl Visitor<'_> for MillisVisitor {
            type Value = Millis;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a number of milliseconds")
            }

            fn visit_f64<E: de::Error>(self, value: f64) -> Result<Millis, E> {
                Ok(Millis(value))
            }

            fn visit_i64<E: de::Error>(self, value: i64) -> Result<Millis, E> {
                Ok(Millis(value as f64))
            }

            fn visit_u64<E: de::Error>(self, value: u64) -> Result<Millis, E> {
                Ok(Millis(value as f64))
            }

            fn visit_i128<E: de::Error>(self, value: i128) -> Result<Millis, E> {
                Ok(Millis(value as f64))
            }

            fn visit_u128<E: de::Error>(self, value: u128) -> Result<Millis, E> {
                Ok(Millis(value as f64))
            }
        }

        deserializer.deserialize_any(MillisVisitor)
    }
}

/// For a field of a partial update that may be left out, set, or set to
/// null: left out is `None`, null is `Some(None)`. Pair it with
/// `#[serde(default)]`.
fn present<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}
