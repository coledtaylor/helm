//! The host's one error type.
//!
//! Every message is a sentence a person can act on, because the host's errors
//! end up in front of the user: on the console when `floti host` refuses to
//! start, and in a client when a request fails.

use std::io;
use std::path::PathBuf;

use floti_protocol::BackendId;

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// An I/O operation failed; `action` says what the host was doing, such
    /// as "open the socket".
    #[error("could not {action}: {source}")]
    Io {
        action: String,
        #[source]
        source: io::Error,
    },

    /// An I/O operation on one path failed.
    #[error("could not {action} {}: {source}", path.display())]
    Path {
        action: &'static str,
        path: PathBuf,
        #[source]
        source: io::Error,
    },

    /// A per-OS concern with no implementation on this OS. Callers show it as
    /// Unknown and keep working, as the processes pass does off Windows today.
    #[error("{concern} is not available on {os}")]
    Unsupported {
        concern: &'static str,
        os: &'static str,
    },

    /// An agent backend asked for something it does not declare.
    #[error("{backend} cannot {action}")]
    Backend { backend: BackendId, action: String },

    /// The host refuses to do something, and says why in one sentence.
    #[error("{0}")]
    Refused(String),

    /// A part of the host that is not in this build.
    #[error("{what} is not in this build of floti")]
    NotBuilt { what: &'static str },
}

impl Error {
    /// An I/O failure while doing `action`.
    pub fn io(action: impl Into<String>, source: io::Error) -> Self {
        Self::Io {
            action: action.into(),
            source,
        }
    }

    /// An I/O failure while doing `action` to `path`.
    pub fn path(action: &'static str, path: impl Into<PathBuf>, source: io::Error) -> Self {
        Self::Path {
            action,
            path: path.into(),
            source,
        }
    }

    /// `concern` has no implementation on the OS this was built for.
    pub fn unsupported(concern: &'static str) -> Self {
        Self::Unsupported {
            concern,
            os: std::env::consts::OS,
        }
    }

    /// `backend` cannot do `action`, such as "resume a conversation".
    pub fn backend(backend: &BackendId, action: impl Into<String>) -> Self {
        Self::Backend {
            backend: backend.clone(),
            action: action.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_name_what_failed() {
        let err = Error::path(
            "open",
            "C:/data dir/floti.db",
            io::Error::new(io::ErrorKind::NotFound, "missing"),
        );
        assert_eq!(
            err.to_string(),
            "could not open C:/data dir/floti.db: missing"
        );

        let err = Error::unsupported("ending a process tree");
        assert_eq!(
            err.to_string(),
            format!(
                "ending a process tree is not available on {}",
                std::env::consts::OS
            )
        );

        let err = Error::backend(&BackendId::new("my-cli"), "resume a conversation");
        assert_eq!(err.to_string(), "my-cli cannot resume a conversation");
    }
}
