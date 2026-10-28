//! Plugins on the host: folders the user registered, each read from its
//! `helm-plugin.json` by the SDK's own validator, and the call layer every
//! `floti.*` method goes through.
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
//! - [`secrets`] and [`background`]: what the registry asks of the secret
//!   store and the background runtime, with stand-ins that hold and run
//!   nothing.
//! - [`registry`]: every registered folder and what it is doing.
//! - [`runtime`]: the background runtime, one isolate per background script.

pub mod background;
pub mod call;
pub mod engine;
pub mod info;
pub mod loader;
pub mod manifest;
pub mod registry;
pub mod runtime;
pub mod secrets;
pub mod settings;
pub mod store;

pub use registry::{PluginCall, Registry, RegistryParts, WeakRegistry};
