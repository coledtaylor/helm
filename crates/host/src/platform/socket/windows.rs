//! The local socket on Windows: a named pipe whose access list grants this
//! user only, refusing remote clients.
//!
//! The pipe's security descriptor has a protected access list with a single
//! entry, full access for the user the host runs as. No entry for Everyone,
//! Authenticated Users, anonymous logons, administrators or SYSTEM, so no
//! other account on the machine can open it. `PIPE_REJECT_REMOTE_CLIENTS`
//! refuses a connection that arrives over the network (`\\server\pipe\...`),
//! even from this user.
//!
//! The first instance is created with `FILE_FLAG_FIRST_PIPE_INSTANCE`, which
//! fails when any process already has a pipe of that name, so a second host,
//! or a process squatting on the name, makes `bind` refuse. A pipe exists
//! only while a process holds a handle to it, so a killed host leaves nothing
//! behind to replace.

use std::ffi::{OsString, c_void};
use std::fmt;
use std::io;
use std::os::windows::io::{FromRawHandle, OwnedHandle, RawHandle};
use std::path::Path;
use std::ptr;
use std::time::Instant;

use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeServer, PipeMode, ServerOptions};
use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_PIPE_BUSY, HANDLE, LocalFree};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
    TokenUser,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

use super::{CONNECT_PATIENCE, Endpoint, LocalListener, LocalSocket, LocalStream, already_running};
use crate::{Error, Result};

/// How long `connect` waits before trying a busy pipe again.
const BUSY_RETRY: std::time::Duration = std::time::Duration::from_millis(20);

/// The Windows implementation.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

/// A listening pipe. It always has one instance waiting for the next client,
/// created with the same user-only descriptor as the first.
pub struct Listener {
    name: OsString,
    descriptor: UserOnlyDescriptor,
    waiting: NamedPipeServer,
}

impl fmt::Debug for Listener {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Listener")
            .field("name", &self.name)
            .finish_non_exhaustive()
    }
}

impl Listener {
    /// A new instance of the pipe for the next client.
    fn instance(&self) -> io::Result<NamedPipeServer> {
        create_instance(&self.name, &self.descriptor, false)
    }
}

impl LocalSocket for Native {
    type Listener = Listener;

    /// A pipe in the local pipe namespace. Pipes are not files, and that
    /// namespace is one for the whole machine, so the name carries a hash of
    /// the runtime folder: each user's folder is their own, which keeps two
    /// users' hosts apart, and moving the folder moves the pipe as it moves a
    /// socket file elsewhere. Windows paths ignore case, so the hash does too.
    fn endpoint(&self, runtime_dir: &Path, name: &str) -> Endpoint {
        // FNV-1a, 64 bits: stable across builds, unlike std's hasher.
        let folder = runtime_dir.to_string_lossy().to_lowercase();
        let hash = folder
            .bytes()
            .fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
                (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
            });
        Endpoint::new(format!(r"\\.\pipe\{name}-{hash:016x}"))
    }

    fn bind(&self, endpoint: &Endpoint) -> Result<Listener> {
        let name = endpoint.as_path().as_os_str().to_owned();
        let descriptor = UserOnlyDescriptor::for_current_user()
            .map_err(|e| Error::io("build the pipe's access list for this user", e))?;
        let waiting = create_instance(&name, &descriptor, true).map_err(|e| {
            if e.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) {
                already_running(endpoint)
            } else {
                Error::path("listen on", endpoint.as_path(), e)
            }
        })?;
        Ok(Listener {
            name,
            descriptor,
            waiting,
        })
    }

    async fn connect(&self, endpoint: &Endpoint) -> Result<LocalStream> {
        let deadline = Instant::now() + CONNECT_PATIENCE;
        loop {
            match ClientOptions::new().open(endpoint.as_path()) {
                Ok(client) => return Ok(Box::pin(client)),
                Err(e)
                    if e.raw_os_error() == Some(ERROR_PIPE_BUSY as i32)
                        && Instant::now() < deadline =>
                {
                    tokio::time::sleep(BUSY_RETRY).await;
                }
                Err(e) => return Err(Error::path("connect to", endpoint.as_path(), e)),
            }
        }
    }
}

impl LocalListener for Listener {
    async fn accept(&mut self) -> Result<LocalStream> {
        let connected = self.waiting.connect().await;
        // Whatever happened to that instance, the next client needs a fresh
        // one waiting before this returns.
        let next = self
            .instance()
            .map_err(|e| Error::path("listen on", Path::new(&self.name), e))?;
        let served = std::mem::replace(&mut self.waiting, next);
        connected.map_err(|e| Error::io("accept a client on the local pipe", e))?;
        Ok(Box::pin(served))
    }
}

/// One instance of the pipe, open to this user and local clients only.
fn create_instance(
    name: &OsString,
    descriptor: &UserOnlyDescriptor,
    first: bool,
) -> io::Result<NamedPipeServer> {
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    // SAFETY: `attributes` is a valid SECURITY_ATTRIBUTES whose descriptor
    // lives as long as `descriptor`, which outlives this call; CreateNamedPipe
    // copies what it needs.
    unsafe {
        ServerOptions::new()
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .access_inbound(true)
            .access_outbound(true)
            .pipe_mode(PipeMode::Byte)
            .create_with_security_attributes_raw(name, (&raw mut attributes).cast::<c_void>())
    }
}

/// A self-relative security descriptor whose protected access list has one
/// entry: full access for the current user.
struct UserOnlyDescriptor(PSECURITY_DESCRIPTOR);

// SAFETY: the descriptor is heap memory from LocalAlloc that nothing mutates
// after it is built; it is only read, by CreateNamedPipe.
unsafe impl Send for UserOnlyDescriptor {}
// SAFETY: as above, shared reads of immutable memory.
unsafe impl Sync for UserOnlyDescriptor {}

impl UserOnlyDescriptor {
    fn for_current_user() -> io::Result<Self> {
        let sid = CurrentUser::query()?.sid_string()?;
        // D:P is a protected access list, so nothing is inherited into it;
        // (A;;GA;;;sid) allows generic all to the user, and nobody else.
        let sddl: Vec<u16> = format!("D:P(A;;GA;;;{sid})")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
        // SAFETY: `sddl` is NUL-terminated; on success the API allocates the
        // descriptor with LocalAlloc, freed in Drop.
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(descriptor))
    }
}

impl Drop for UserOnlyDescriptor {
    fn drop(&mut self) {
        // SAFETY: allocated by ConvertStringSecurityDescriptorToSecurityDescriptorW.
        unsafe { LocalFree(self.0) };
    }
}

/// The user this process runs as: its token's TOKEN_USER, which holds the
/// SID.
struct CurrentUser {
    /// A TOKEN_USER and the SID it points into, in u64s for alignment.
    buffer: Vec<u64>,
}

impl CurrentUser {
    fn query() -> io::Result<Self> {
        let mut raw: HANDLE = ptr::null_mut();
        // SAFETY: the pseudo handle needs no closing; `raw` receives a token
        // handle, owned below.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: OpenProcessToken succeeded, so `raw` is a handle we own.
        let token = unsafe { OwnedHandle::from_raw_handle(raw as RawHandle) };
        let token = std::os::windows::io::AsRawHandle::as_raw_handle(&token) as HANDLE;

        let mut needed = 0u32;
        // SAFETY: a size query with no buffer; it fails and sets `needed`.
        unsafe { GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut needed) };
        if needed == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut buffer = vec![0u64; (needed as usize).div_ceil(size_of::<u64>())];
        // SAFETY: `buffer` holds at least `needed` bytes, aligned for TOKEN_USER.
        let ok = unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { buffer })
    }

    /// The user's SID, valid while `self` lives.
    fn sid(&self) -> PSID {
        // SAFETY: GetTokenInformation(TokenUser) wrote a TOKEN_USER at the
        // start of the buffer.
        unsafe { (*self.buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid }
    }

    /// The SID as text, such as `S-1-5-21-...`.
    fn sid_string(&self) -> io::Result<String> {
        let mut text: *mut u16 = ptr::null_mut();
        // SAFETY: `sid()` is a valid SID; on success `text` is a
        // NUL-terminated string from LocalAlloc, freed below.
        if unsafe { ConvertSidToStringSidW(self.sid(), &mut text) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `text` is NUL-terminated.
        let len = (0..).take_while(|&i| unsafe { *text.add(i) } != 0).count();
        // SAFETY: `len` u16s are readable at `text`.
        let sid = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, len) });
        // SAFETY: allocated by ConvertSidToStringSidW.
        unsafe { LocalFree(text.cast()) };
        Ok(sid)
    }
}

/// Every TCP socket listening and every UDP socket bound in process `pid`,
/// one line each, read from `netstat -ano`. A TCP socket is listening when
/// its remote address is the unspecified one, which holds whatever language
/// netstat prints its states in.
#[cfg(any(test, feature = "testkit"))]
pub fn network_listeners(pid: u32) -> io::Result<Vec<String>> {
    let output = std::process::Command::new("netstat").arg("-ano").output()?;
    if !output.status.success() {
        return Err(io::Error::other(format!(
            "netstat -ano failed: {}",
            output.status
        )));
    }
    let pid = pid.to_string();
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(text
        .lines()
        .filter(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            match fields.as_slice() {
                ["TCP", _, remote, _, owner] => *owner == pid && remote.ends_with(":0"),
                ["UDP", _, _, owner] => *owner == pid,
                _ => false,
            }
        })
        .map(|line| line.trim().to_owned())
        .collect())
}

#[cfg(test)]
mod tests {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_KERNEL_OBJECT};
    use windows_sys::Win32::Security::{
        ACCESS_ALLOWED_ACE, ACL, ACL_SIZE_INFORMATION, AclSizeInformation,
        DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetAclInformation,
        GetSecurityDescriptorControl, SE_DACL_PROTECTED,
    };

    use super::*;
    use crate::testkit::{TestDirs, unique_name};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// ACCESS_ALLOWED_ACE_TYPE, from winnt.h.
    const ACCESS_ALLOWED: u8 = 0;

    /// The entries of the access list on `handle`'s object, as (ACE type,
    /// access mask, whether the SID is the current user's), and whether the
    /// list is protected from inheritance.
    fn access_list(handle: HANDLE) -> (bool, Vec<(u8, u32, bool)>) {
        let user = CurrentUser::query().expect("read this process's user");
        let mut dacl: *mut ACL = ptr::null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
        // SAFETY: `handle` is a live pipe handle; the out pointers are valid.
        let status = unsafe {
            GetSecurityInfo(
                handle,
                SE_KERNEL_OBJECT,
                DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                &mut dacl,
                ptr::null_mut(),
                &mut descriptor,
            )
        };
        assert_eq!(status, ERROR_SUCCESS, "read the pipe's security descriptor");
        assert!(!dacl.is_null(), "the pipe has an access list, not none");

        let mut control = 0u16;
        let mut revision = 0u32;
        // SAFETY: `descriptor` came from GetSecurityInfo.
        let ok = unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) };
        assert_ne!(ok, 0);

        let mut size = ACL_SIZE_INFORMATION::default();
        // SAFETY: `dacl` points into `descriptor`; `size` is the right type.
        let ok = unsafe {
            GetAclInformation(
                dacl,
                (&raw mut size).cast(),
                size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        };
        assert_ne!(ok, 0);

        let entries = (0..size.AceCount)
            .map(|index| {
                let mut ace: *mut c_void = ptr::null_mut();
                // SAFETY: `index` is below AceCount.
                assert_ne!(unsafe { GetAce(dacl, index, &mut ace) }, 0);
                let ace = ace.cast::<ACCESS_ALLOWED_ACE>();
                // SAFETY: every ACE starts with an ACE_HEADER; the SID of an
                // allowed or denied ACE starts at SidStart.
                unsafe {
                    let kind = (*ace).Header.AceType;
                    let sid = (&raw mut (*ace).SidStart).cast::<c_void>();
                    (kind, (*ace).Mask, EqualSid(sid, user.sid()) != 0)
                }
            })
            .collect();
        // SAFETY: allocated by GetSecurityInfo.
        unsafe { LocalFree(descriptor) };
        (control & SE_DACL_PROTECTED != 0, entries)
    }

    fn handle_of(listener: &Listener) -> HANDLE {
        std::os::windows::io::AsRawHandle::as_raw_handle(&listener.waiting) as HANDLE
    }

    #[tokio::test]
    async fn the_pipes_access_list_grants_the_current_user_only() {
        let dirs = TestDirs::new();
        let endpoint = dirs.endpoint();
        let mut listener = Native.bind(&endpoint).expect("bind");

        let (protected, entries) = access_list(handle_of(&listener));
        assert!(protected, "the access list inherits nothing");
        assert_eq!(
            entries.len(),
            1,
            "one entry and no other, for Everyone, Authenticated Users, anonymous or anyone: {entries:?}"
        );
        let (kind, mask, is_user) = entries[0];
        assert_eq!(kind, ACCESS_ALLOWED);
        assert!(is_user, "the one entry is the current user's");
        assert_ne!(mask, 0);

        // Every instance after the first carries the same list.
        let client = Native.connect(&endpoint).await.expect("connect");
        let _served = listener.accept().await.expect("accept");
        let (protected, entries) = access_list(handle_of(&listener));
        assert!(protected);
        assert_eq!(entries.len(), 1);
        assert!(entries[0].2);
        drop(client);
    }

    #[tokio::test]
    async fn the_pipe_refuses_remote_clients() {
        let dirs = TestDirs::new();
        let endpoint = dirs.endpoint();
        let name = endpoint
            .as_path()
            .file_name()
            .expect("a pipe name")
            .to_string_lossy()
            .into_owned();
        let mut listener = Native.bind(&endpoint).expect("bind");

        // `\\localhost\pipe\...` goes through the network redirector, so the
        // pipe sees a remote client even though it is this machine.
        let remote = format!(r"\\localhost\pipe\{name}");
        let refused = ClientOptions::new().open(&remote);
        let refused = refused.expect_err("a remote client is refused");
        assert_eq!(
            refused.raw_os_error(),
            Some(ERROR_ACCESS_DENIED as i32),
            "refused by the pipe, not unreachable: {refused}"
        );

        // The refusal used no instance: a local client still connects.
        let mut client = Native.connect(&endpoint).await.expect("connect locally");
        let mut served = listener.accept().await.expect("accept");
        client.write_all(b"local").await.unwrap();
        let mut buf = [0u8; 5];
        served.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"local");
    }

    #[tokio::test]
    async fn the_same_pipe_without_the_flag_takes_remote_clients() {
        // The control for the test above: the redirector path does reach a
        // pipe that does not refuse remote clients, so the refusal there is
        // the flag's doing.
        let name = unique_name();
        let local = format!(r"\\.\pipe\{name}");
        let descriptor = UserOnlyDescriptor::for_current_user().unwrap();
        let mut attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: 0,
        };
        // SAFETY: as in create_instance.
        let server = unsafe {
            ServerOptions::new()
                .first_pipe_instance(true)
                .reject_remote_clients(false)
                .create_with_security_attributes_raw(&local, (&raw mut attributes).cast())
        }
        .expect("create a control pipe");
        let remote = format!(r"\\localhost\pipe\{name}");
        let client = ClientOptions::new().open(&remote);
        assert!(
            client.is_ok(),
            "the redirector reaches a pipe that takes remote clients: {client:?}"
        );
        drop(server);
    }

    #[test]
    fn a_pipe_name_already_held_is_refused() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let _guard = runtime.enter();
        let name = unique_name();
        let endpoint = Native.endpoint(Path::new("unused"), &name);
        // Someone else's pipe of that name, with default security.
        let squatter = ServerOptions::new()
            .first_pipe_instance(true)
            .create(endpoint.as_path())
            .expect("create the squatting pipe");
        let refused = Native.bind(&endpoint).expect_err("the name is taken");
        assert!(refused.to_string().contains("already running"), "{refused}");
        drop(squatter);
        Native.bind(&endpoint).expect("the name is free again");
    }
}
