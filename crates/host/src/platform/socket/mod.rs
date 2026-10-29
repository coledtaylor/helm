//! The local socket clients connect on, which only this user can open: a
//! named pipe with the user's access list on Windows, a `0600` Unix socket in
//! a `0700` folder on macOS and Linux. The host has no other listener for
//! clients, and none on a network interface.
//!
//! One host per endpoint: binding refuses an endpoint a live host holds, and
//! takes over one a killed host left behind.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(unix)]
mod unix;
#[cfg(target_os = "windows")]
pub(crate) mod windows;

#[cfg(target_os = "linux")]
pub use linux::{Listener, Native};
#[cfg(target_os = "macos")]
pub use macos::{Listener, Native};
#[cfg(target_os = "windows")]
pub use windows::{Listener, Native};

#[cfg(all(target_os = "linux", any(test, feature = "testkit")))]
pub use linux::network_listeners;
#[cfg(all(target_os = "macos", any(test, feature = "testkit")))]
pub use macos::network_listeners;
#[cfg(all(target_os = "windows", any(test, feature = "testkit")))]
pub use windows::network_listeners;

#[cfg(test)]
mod tests;

use std::fmt;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite};

use crate::{Error, Result};

/// How long `connect` keeps trying while a host is busy answering other
/// clients, before it gives up.
pub const CONNECT_PATIENCE: Duration = Duration::from_secs(5);

/// Where the socket is: a pipe name on Windows, a file path elsewhere.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Endpoint(PathBuf);

impl Endpoint {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self(path.into())
    }

    pub fn as_path(&self) -> &Path {
        &self.0
    }
}

impl fmt::Display for Endpoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.display().fmt(f)
    }
}

/// A byte stream to or from one client.
pub trait LocalIo: AsyncRead + AsyncWrite + Send {}

impl<T: AsyncRead + AsyncWrite + Send> LocalIo for T {}

/// One connection on the socket, from either end.
pub type LocalStream = Pin<Box<dyn LocalIo>>;

/// The OS's local socket.
pub trait LocalSocket {
    type Listener: LocalListener;

    /// The endpoint called `name`, inside `runtime_dir` where the socket is a
    /// file.
    fn endpoint(&self, runtime_dir: &Path, name: &str) -> Endpoint;

    /// Starts listening at `endpoint`, open to this user only. It refuses,
    /// with [`Error::Refused`], an endpoint a live host is listening on, and
    /// replaces one that a host which was killed left behind.
    ///
    /// Call it from inside a Tokio runtime.
    fn bind(&self, endpoint: &Endpoint) -> Result<Self::Listener>;

    /// Connects to a host listening at `endpoint`.
    fn connect(&self, endpoint: &Endpoint) -> impl Future<Output = Result<LocalStream>> + Send;
}

/// A bound socket, accepting clients. Dropping it stops listening.
pub trait LocalListener: Send {
    /// The next client to connect.
    fn accept(&mut self) -> impl Future<Output = Result<LocalStream>> + Send;
}

/// The refusal when another host already holds `endpoint`.
fn already_running(endpoint: &Endpoint) -> Error {
    Error::Refused(format!(
        "A Floti host is already running for this user: it is listening at {endpoint}."
    ))
}
