//! Plugins on the host: folders the user registered, each read from its
//! `helm-plugin.json` by the SDK's own validator; each one's background
//! script, run in an isolate of its own; and the call layer every `floti.*`
//! method goes through.
//!
//! A background script's `floti` global is answered here as today's
//! background page is answered by Helm's main process: `floti.exec`,
//! `floti.fetch`, `settings.get`, `secrets.state`, `status.set` and
//! `badge.set` go through the registry's call layer to the methods below,
//! and what clients do (a command with no tab, a setting, a secret saved or
//! removed) reaches the script's `floti.on` listeners as an event.
//!
//! - [`engine`]: the V8 platform, started once per process, and the base
//!   isolate with the web's data types every plugin script runs in.
//! - [`manifest`]: the manifest, read by the SDK's validator in that isolate.
//!   This host runs apiVersion 2 plugins.
//! - [`loader`]: a folder read: the manifest, the files it names, the icon.
//! - [`store`]: the folders and settings in `floti.db`, today's schema.
//! - [`settings`]: whether a value fits a setting, and the values shown.
//! - [`info`]: a plugin as a client draws it.
//! - [`call`]: the call layer: errors, cancellation, the methods table, and
//!   the request and result types of `floti.fetch` and `floti.exec`.
//! - [`background`]: what the registry asks of the background runtime: start
//!   and stop a script, deliver it an event, hand it a tool call.
//! - [`runtime`]: the background runtime, one deno_core isolate per
//!   background script, whose only abilities are the `floti` API,
//!   BroadcastChannel and timers.
//! - [`secrets`]: the secret store, every value sealed for this user, and
//!   `floti.secrets.state`.
//! - [`exec`] and [`net`]: `floti.exec` and `floti.fetch`, a plugin's only
//!   ways to run a program and reach the network.
//! - [`services`]: a plugin's service, started on the host's Node or as any
//!   program when it is needed, and ended with the plugin.
//! - [`registry`]: every registered folder and what it is doing.

pub mod background;
pub mod call;
pub mod engine;
pub mod exec;
pub mod info;
pub mod loader;
pub mod manifest;
pub mod net;
pub mod registry;
pub mod runtime;
pub mod secrets;
pub mod services;
pub mod settings;
pub mod store;

pub use registry::{PluginCall, Registry, RegistryParts, WeakRegistry};
