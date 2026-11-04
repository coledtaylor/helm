//! `wsl:keepAwake`: keeping a WSL distro on this computer running while the
//! host inside it has sessions.
//!
//! WSL stops a distro once no Windows process is attached to it through
//! `wsl.exe` (see [`crate::platform::wsl`] for the version that was checked
//! against), which would end the sessions of the host inside it when the
//! last window closed. The desktop asks this host, on the distro's PC, to
//! hold the distro; it holds one `wsl.exe -d <distro> -- <floti> keep-awake`
//! per distro, whose `floti keep-awake` exits once no session runs in the
//! distro or its host stops, and then forgets the hold. A second ask for a
//! distro already held starts nothing. A held distro counts as running for
//! the host's own idle exit ([`Hosted::hold_distros`]). A hold is tied to
//! this host: it ends when the host does, and the desktop asks again once it
//! reconnects to the next one.
//!
//! Where there is no WSL (macOS and Linux) the ask is answered with
//! [`NO_WSL_LINE`].

use std::collections::HashSet;
use std::process::Stdio;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use floti_protocol::channel::Router;
use floti_protocol::channels::wsl::{WslKeepAwake, WslKeepAwakeRequest};

use super::{Caller, Feature, FeatureContext};
use tokio::io::AsyncReadExt;

use crate::bridge::{floti_line, last_line_of, remote_floti_problem};
use crate::platform::wsl::{NO_WSL_LINE, WslProgram, distro_name_problem};
use crate::server::hosted::Hosted;

/// What `floti keep-awake` is called with in the distro.
pub const KEEP_AWAKE: &str = "keep-awake";

pub(crate) struct Wsl {
    holds: Arc<DistroHolds>,
}

impl Wsl {
    pub fn new(context: &FeatureContext, program: Option<WslProgram>) -> Self {
        Self {
            holds: Arc::new(DistroHolds {
                program,
                held: Mutex::new(HashSet::new()),
                hosted: Arc::downgrade(&context.hosted),
            }),
        }
    }
}

impl Feature for Wsl {
    fn requests<'a>(&'a self, _caller: Caller, router: &mut Router<'a>) {
        router.handle::<WslKeepAwake>(|request| self.holds.keep_awake(request));
    }
}

/// The distros held awake, by name.
struct DistroHolds {
    program: Option<WslProgram>,
    held: Mutex<HashSet<String>>,
    hosted: Weak<Hosted>,
}

impl DistroHolds {
    fn keep_awake(self: &Arc<Self>, request: WslKeepAwakeRequest) -> Result<(), String> {
        let WslKeepAwakeRequest { distro, floti } = request;
        if let Some(problem) = distro_name_problem(&distro) {
            return Err(problem);
        }
        if let Some(problem) = floti.as_deref().and_then(remote_floti_problem) {
            return Err(problem);
        }
        let Some(program) = &self.program else {
            return Err(NO_WSL_LINE.to_owned());
        };
        let mut held = lock(&self.held);
        if held.contains(&distro) {
            return Ok(());
        }
        let line = floti_line(floti.as_deref(), KEEP_AWAKE);
        let mut command = tokio::process::Command::from(program.in_distro(&distro, &line));
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            // A hold is this host's: it ends with it.
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|err| format!("could not run {}: {err}", program.program.to_string_lossy()))?;
        held.insert(distro.clone());
        let count = held.len();
        drop(held);
        self.moved(count);
        let holds = Arc::clone(self);
        let stderr = child.stderr.take();
        tokio::spawn(async move {
            let mut said = Vec::new();
            if let Some(mut stderr) = stderr {
                let _ = stderr.read_to_end(&mut said).await;
            }
            let ended = child.wait().await;
            // A hold that ends as it should says nothing.
            match (&ended, last_line_of(&said)) {
                (Ok(status), None) if status.success() => {}
                (Ok(status), line) => log_line!(
                    "floti host: the hold on WSL distro {distro} ended ({status}): {}",
                    line.unwrap_or_default()
                ),
                (Err(err), _) => {
                    log_line!("floti host: the hold on WSL distro {distro} ended: {err}");
                }
            }
            let count = {
                let mut held = lock(&holds.held);
                held.remove(&distro);
                held.len()
            };
            holds.moved(count);
        });
        Ok(())
    }

    fn moved(&self, count: usize) {
        if let Some(hosted) = self.hosted.upgrade() {
            hosted.hold_distros(count);
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
