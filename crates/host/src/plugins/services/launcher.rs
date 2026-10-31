//! Starting a service's process and ending its tree: what the supervisor
//! asks of the OS, behind a trait so its tests can drive a fake.

use std::ffi::OsString;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::platform::launcher::Program;
use crate::platform::process_tree::{self, Ending, ProcessTree};

/// How long one look at the service's port may take.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(500);

/// What to start for a service: the program, its folder, and exactly the
/// environment it runs with, which holds the run's token. Its `Debug` shows
/// neither the arguments' environment nor its values.
pub struct ServiceCommand {
    pub program: Program,
    pub folder: PathBuf,
    pub env: Vec<(OsString, OsString)>,
}

impl std::fmt::Debug for ServiceCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServiceCommand")
            .field("program", &self.program.program)
            .field("args", &self.program.args)
            .field("folder", &self.folder)
            .finish_non_exhaustive()
    }
}

/// Ends a started service and everything it started.
pub type EndTree = Box<dyn FnOnce() + Send>;

/// A service's process, started.
pub struct ServiceChild {
    pub pid: Option<u32>,
    /// Resolves once it has exited, with its exit code when it had one.
    pub exited: Pin<Box<dyn Future<Output = Option<i32>> + Send>>,
    /// Ends it and its whole tree. Does nothing once it has exited.
    pub end: EndTree,
}

pub type AcceptsFuture = Pin<Box<dyn Future<Output = bool> + Send>>;

/// The OS's side of a service.
pub trait ServiceLauncher: Send + Sync {
    /// Starts `command`, the root of a tree [`ServiceChild::end`] ends, and
    /// ties that tree to the host's life, so a host that is killed takes it
    /// with it.
    fn launch(&self, command: &ServiceCommand) -> std::io::Result<ServiceChild>;

    /// Whether something accepts a connection on `127.0.0.1:port` now.
    fn accepts(&self, port: u16) -> AcceptsFuture {
        Box::pin(async move {
            let connect = tokio::net::TcpStream::connect(("127.0.0.1", port));
            matches!(
                tokio::time::timeout(CONNECT_TIMEOUT, connect).await,
                Ok(Ok(_))
            )
        })
    }
}

/// The real thing: a child process with no console and nothing on its
/// standard streams, the leader of its own tree.
#[derive(Debug, Clone, Copy, Default)]
pub struct ProcessLauncher;

impl ServiceLauncher for ProcessLauncher {
    fn launch(&self, command: &ServiceCommand) -> std::io::Result<ServiceChild> {
        let mut std_command = std::process::Command::new(&command.program.program);
        std_command
            .args(&command.program.args)
            .current_dir(&command.folder)
            .env_clear()
            .envs(command.env.iter().map(|(name, value)| (name, value)))
            // What a service writes is its own: it may print its
            // environment, and the host's log never carries the token.
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        process_tree::Native.prepare_root(&mut std_command);
        let mut child = tokio::process::Command::from(std_command)
            .kill_on_drop(false)
            .spawn()?;
        let pid = child.id();
        if let Some(pid) = pid {
            process_tree::Native.tie_tree(pid);
        }
        let settled = Arc::new(AtomicBool::new(false));
        let exited = {
            let settled = Arc::clone(&settled);
            Box::pin(async move {
                let status = child.wait().await;
                // Its id may be another process's from here on.
                settled.store(true, Ordering::SeqCst);
                if let Some(pid) = pid {
                    process_tree::Native.untie_tree(pid);
                }
                status.ok().and_then(|status| status.code())
            })
        };
        let end: EndTree = Box::new(move || {
            if settled.swap(true, Ordering::SeqCst) {
                return;
            }
            if let Some(pid) = pid {
                // A tree that has already ended is not an error, and one the
                // OS would not end leaves nothing else to try.
                let _ = process_tree::Native.end_tree(pid, Ending::Forced);
            }
        });
        Ok(ServiceChild { pid, exited, end })
    }
}
