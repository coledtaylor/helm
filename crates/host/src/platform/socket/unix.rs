//! The local socket on macOS and Linux: a `0600` Unix socket in a `0700`
//! folder owned by this user. The two differ only in where the runtime
//! folder is, which the folders concern decides.
//!
//! The folder's mode is what keeps other users out: nobody else can reach a
//! file inside a `0700` folder, so the socket is safe in the moment between
//! `bind` creating it and its mode being set to `0600`. A folder another user
//! owns, or one that is not a folder, is refused rather than used.
//!
//! One host per socket: a host holds an exclusive `flock` on `<socket>.lock`
//! for as long as it listens. The kernel releases it when the host dies, so a
//! second host is refused while the first lives, and a socket file found
//! with the lock free was left by a host that was killed and is replaced.

use std::fs::{self, DirBuilder, File, OpenOptions, Permissions};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::UnixStream as StdUnixStream;
use std::path::{Path, PathBuf};

use tokio::net::{UnixListener, UnixStream};

use super::{Endpoint, LocalListener, LocalSocket, LocalStream, already_running};
use crate::{Error, Result};

/// The mode of the folder the socket is in.
pub(super) const FOLDER_MODE: u32 = 0o700;
/// The mode of the socket.
pub(super) const SOCKET_MODE: u32 = 0o600;

/// The macOS and Linux implementation.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

/// A listening socket. Dropping it removes the socket file, if it is still
/// the one this listener made, and then releases the lock.
#[derive(Debug)]
pub struct Listener {
    inner: UnixListener,
    path: PathBuf,
    /// The socket file's device and inode, to know it is still ours.
    identity: (u64, u64),
    /// Held for as long as the listener lives. Declared last so it is
    /// released after the socket file is removed.
    _lock: File,
}

impl LocalSocket for Native {
    type Listener = Listener;

    fn endpoint(&self, runtime_dir: &Path, name: &str) -> Endpoint {
        Endpoint::new(runtime_dir.join(format!("{name}.sock")))
    }

    fn bind(&self, endpoint: &Endpoint) -> Result<Listener> {
        let path = endpoint.as_path();
        let folder = path
            .parent()
            .filter(|folder| !folder.as_os_str().is_empty())
            .ok_or_else(|| {
                Error::Refused(format!(
                    "The socket path {} has no folder to keep it in.",
                    path.display()
                ))
            })?;
        private_folder(folder)?;
        let lock = take_lock(endpoint)?;
        clear_stale(endpoint)?;

        let listener = std::os::unix::net::UnixListener::bind(path)
            .map_err(|e| Error::path("listen on", path, e))?;
        fs::set_permissions(path, Permissions::from_mode(SOCKET_MODE))
            .map_err(|e| Error::path("restrict to this user", path, e))?;
        let metadata = fs::symlink_metadata(path).map_err(|e| Error::path("read", path, e))?;
        listener
            .set_nonblocking(true)
            .map_err(|e| Error::path("listen on", path, e))?;
        let inner =
            UnixListener::from_std(listener).map_err(|e| Error::path("listen on", path, e))?;
        Ok(Listener {
            inner,
            path: path.to_owned(),
            identity: (metadata.dev(), metadata.ino()),
            _lock: lock,
        })
    }

    async fn connect(&self, endpoint: &Endpoint) -> Result<LocalStream> {
        let stream = UnixStream::connect(endpoint.as_path())
            .await
            .map_err(|e| Error::path("connect to", endpoint.as_path(), e))?;
        Ok(Box::pin(stream))
    }
}

impl LocalListener for Listener {
    async fn accept(&mut self) -> Result<LocalStream> {
        let (stream, _) = self
            .inner
            .accept()
            .await
            .map_err(|e| Error::io("accept a client on the local socket", e))?;
        Ok(Box::pin(stream))
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        let ours = fs::symlink_metadata(&self.path)
            .map(|m| (m.dev(), m.ino()) == self.identity)
            .unwrap_or(false);
        if ours {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Makes `folder` a `0700` folder this user owns: creates it when it is
/// missing, tightens its mode when it is ours and looser, and refuses one
/// that is someone else's or not a folder.
fn private_folder(folder: &Path) -> Result<()> {
    match fs::symlink_metadata(folder) {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            DirBuilder::new()
                .recursive(true)
                .mode(FOLDER_MODE)
                .create(folder)
                .map_err(|e| Error::path("create", folder, e))?;
        }
        Err(e) => return Err(Error::path("read", folder, e)),
    }
    let metadata = fs::symlink_metadata(folder).map_err(|e| Error::path("read", folder, e))?;
    if !metadata.is_dir() {
        return Err(Error::Refused(format!(
            "{} is not a folder, so the host will not keep its socket there.",
            folder.display()
        )));
    }
    // SAFETY: geteuid has no preconditions and cannot fail.
    if metadata.uid() != unsafe { libc::geteuid() } {
        return Err(Error::Refused(format!(
            "{} belongs to another user, so the host will not keep its socket there.",
            folder.display()
        )));
    }
    if metadata.mode() & 0o777 != FOLDER_MODE {
        fs::set_permissions(folder, Permissions::from_mode(FOLDER_MODE))
            .map_err(|e| Error::path("restrict to this user", folder, e))?;
    }
    Ok(())
}

/// The lock beside the socket, held exclusively; a host holding it already
/// means one is running.
fn take_lock(endpoint: &Endpoint) -> Result<File> {
    let mut lock_path = endpoint.as_path().as_os_str().to_owned();
    lock_path.push(".lock");
    let lock_path = PathBuf::from(lock_path);
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(SOCKET_MODE)
        .open(&lock_path)
        .map_err(|e| Error::path("open", &lock_path, e))?;
    // SAFETY: `file` is an open descriptor for the call's duration.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        let e = io::Error::last_os_error();
        return Err(if e.kind() == io::ErrorKind::WouldBlock {
            already_running(endpoint)
        } else {
            Error::path("lock", &lock_path, e)
        });
    }
    Ok(file)
}

/// Removes a socket file nobody answers on. A socket somebody answers on is
/// refused, and anything that is not a socket is left alone and refused.
fn clear_stale(endpoint: &Endpoint) -> Result<()> {
    let path = endpoint.as_path();
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(Error::path("read", path, e)),
    };
    if !metadata.file_type().is_socket() {
        return Err(Error::Refused(format!(
            "{} is in the way of the host's socket and is not a socket, so the host leaves it alone.",
            path.display()
        )));
    }
    match StdUnixStream::connect(path) {
        Ok(_) => Err(already_running(endpoint)),
        Err(e)
            if matches!(
                e.kind(),
                io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound
            ) =>
        {
            fs::remove_file(path).map_err(|e| Error::path("remove the stale socket", path, e))
        }
        Err(e) => Err(Error::path("check", path, e)),
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::net::UnixListener as StdUnixListener;
    use std::time::{Duration, Instant};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;
    use crate::testkit::{PATIENCE, TestDirs};

    fn mode(path: &Path) -> u32 {
        fs::symlink_metadata(path).unwrap().mode() & 0o777
    }

    // SAFETY: geteuid has no preconditions and cannot fail.
    fn me() -> u32 {
        unsafe { libc::geteuid() }
    }

    #[tokio::test]
    async fn the_socket_is_0600_in_a_0700_folder_the_user_owns() {
        let dirs = TestDirs::new();
        // A runtime folder that already exists with a looser mode is
        // tightened; one that does not exist is made 0700.
        fs::set_permissions(&dirs.runtime, Permissions::from_mode(0o755)).unwrap();
        for folder in [dirs.runtime.clone(), dirs.root().join("fresh run")] {
            let endpoint = Native.endpoint(&folder, &crate::testkit::unique_name());
            let mut listener = Native.bind(&endpoint).expect("bind");

            let socket = fs::symlink_metadata(endpoint.as_path()).unwrap();
            assert!(socket.file_type().is_socket(), "a Unix socket");
            assert_eq!(socket.mode() & 0o777, SOCKET_MODE, "socket mode");
            assert_eq!(socket.uid(), me(), "the socket is the user's");

            let parent = fs::symlink_metadata(&folder).unwrap();
            assert!(parent.is_dir());
            assert_eq!(parent.mode() & 0o777, FOLDER_MODE, "folder mode");
            assert_eq!(parent.uid(), me(), "the folder is the user's");

            let mut client = Native.connect(&endpoint).await.expect("connect");
            let mut served = listener.accept().await.expect("accept");
            client.write_all(b"hi").await.unwrap();
            let mut buf = [0u8; 2];
            served.read_exact(&mut buf).await.unwrap();
            assert_eq!(&buf, b"hi");
        }
    }

    #[tokio::test]
    async fn a_stale_socket_nobody_answers_on_is_replaced() {
        let dirs = TestDirs::new();
        let endpoint = dirs.endpoint();
        fs::set_permissions(&dirs.runtime, Permissions::from_mode(FOLDER_MODE)).unwrap();
        // A socket whose listener is gone but whose file stays, as a killed
        // host leaves it; std does not unlink on drop.
        drop(StdUnixListener::bind(endpoint.as_path()).unwrap());
        assert!(endpoint.as_path().exists(), "the stale file is there");

        let mut listener = Native.bind(&endpoint).expect("replace the stale socket");
        assert_eq!(mode(endpoint.as_path()), SOCKET_MODE);
        let _client = Native.connect(&endpoint).await.expect("connect");
        listener.accept().await.expect("accept");
    }

    #[tokio::test]
    async fn a_socket_an_unlocked_live_listener_answers_on_is_refused() {
        // A listener that holds no lock (say, a host of another build) but
        // answers: the socket is not stale, so it is not taken.
        let dirs = TestDirs::new();
        let endpoint = dirs.endpoint();
        let _live = StdUnixListener::bind(endpoint.as_path()).unwrap();
        let refused = Native.bind(&endpoint).expect_err("a live socket is kept");
        assert!(refused.to_string().contains("already running"), "{refused}");
        assert!(endpoint.as_path().exists());
    }

    #[tokio::test]
    async fn a_file_in_the_way_that_is_not_a_socket_is_left_alone() {
        let dirs = TestDirs::new();
        let endpoint = dirs.endpoint();
        fs::write(endpoint.as_path(), b"someone's file").unwrap();
        let refused = Native.bind(&endpoint).expect_err("not a socket");
        assert!(refused.to_string().contains("not a socket"), "{refused}");
        assert_eq!(fs::read(endpoint.as_path()).unwrap(), b"someone's file");
    }

    #[tokio::test]
    async fn a_folder_path_that_is_a_file_is_refused() {
        let dirs = TestDirs::new();
        let not_a_folder = dirs.root().join("plain file");
        fs::write(&not_a_folder, b"").unwrap();
        let endpoint = Native.endpoint(&not_a_folder, "x");
        let refused = Native.bind(&endpoint).expect_err("not a folder");
        assert!(refused.to_string().contains("is not a folder"), "{refused}");
    }

    #[tokio::test]
    async fn dropping_the_listener_removes_its_socket_file() {
        let dirs = TestDirs::new();
        let endpoint = dirs.endpoint();
        let listener = Native.bind(&endpoint).expect("bind");
        assert!(endpoint.as_path().exists());
        drop(listener);
        assert!(!endpoint.as_path().exists());
        // A fork another test makes meanwhile (a pty's child before it execs,
        // the process-tree guard before it closes what it inherited) holds a
        // copy of the lock's descriptor for a moment, so the lock comes free
        // soon after the drop rather than at once.
        let deadline = Instant::now() + PATIENCE;
        loop {
            match Native.bind(&endpoint) {
                Ok(_) => break,
                Err(e) if Instant::now() < deadline => {
                    assert!(e.to_string().contains("already running"), "{e}");
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                Err(e) => panic!("bind again: {e}"),
            }
        }
    }
}
