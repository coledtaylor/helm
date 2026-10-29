//! Owner-only files on Windows: a protected access list with one entry, full
//! access for the user Floti runs as.
//!
//! The list is the local pipe's (`socket/windows.rs` builds it), given to
//! `CreateFileW` so the file has it from the moment it exists. Protected
//! means nothing is inherited from the folder, so administrators, SYSTEM and
//! everyone else the folder admits have no entry. A rename keeps a file's
//! access list, so the file a write renames into place is the one it made.

use std::ffi::c_void;
use std::fs::File;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{FromRawHandle, OwnedHandle, RawHandle};
use std::path::Path;
use std::ptr;

use windows_sys::Win32::Foundation::{
    ERROR_SUCCESS, GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE, LocalFree,
};
use windows_sys::Win32::Security::Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACL, ACL_SIZE_INFORMATION, AclSizeInformation, DACL_SECURITY_INFORMATION,
    EqualSid, GetAce, GetAclInformation, GetSecurityDescriptorControl, PSECURITY_DESCRIPTOR,
    SE_DACL_PROTECTED, SECURITY_ATTRIBUTES,
};
use windows_sys::Win32::Storage::FileSystem::{CREATE_NEW, CreateFileW, FILE_ATTRIBUTE_NORMAL};

use super::PrivateFiles;
use crate::platform::socket::windows::{CurrentUser, UserOnlyDescriptor};
use crate::{Error, Result};

/// ACCESS_ALLOWED_ACE_TYPE, from winnt.h.
const ACCESS_ALLOWED: u8 = 0;

/// The Windows implementation.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl PrivateFiles for Native {
    fn create_new(&self, path: &Path) -> io::Result<File> {
        let descriptor = UserOnlyDescriptor::for_current_user()?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.as_ptr(),
            bInheritHandle: 0,
        };
        let wide = wide(path);
        // SAFETY: `wide` is NUL-terminated and `attributes` points at a
        // descriptor that outlives the call, which copies what it needs. No
        // sharing while it is open: nobody else has a use for a half-written
        // file.
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                &attributes,
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL,
                ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: CreateFileW succeeded, so `handle` is a file handle we own.
        Ok(File::from(unsafe {
            OwnedHandle::from_raw_handle(handle as RawHandle)
        }))
    }

    /// NTFS journals the rename itself; a folder cannot be synced as a file.
    fn sync_folder(&self, _folder: &Path) -> io::Result<()> {
        Ok(())
    }

    fn owner_only(&self, path: &Path) -> Result<bool> {
        let (protected, entries) = access_list(path).map_err(|e| Error::path("check", path, e))?;
        Ok(protected
            && matches!(entries.as_slice(), [entry] if entry.kind == ACCESS_ALLOWED && entry.is_current_user && entry.mask != 0))
    }
}

/// One entry of a file's access list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct AccessEntry {
    /// The ACE type, such as ACCESS_ALLOWED.
    kind: u8,
    mask: u32,
    /// Whether the entry's SID is the user Floti runs as.
    is_current_user: bool,
}

/// The entries of the access list on the file at `path`, and whether the
/// list is protected from inheritance.
fn access_list(path: &Path) -> io::Result<(bool, Vec<AccessEntry>)> {
    let user = CurrentUser::query()?;
    let wide = wide(path);
    let mut dacl: *mut ACL = ptr::null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
    // SAFETY: `wide` is NUL-terminated; the out pointers are valid.
    let status = unsafe {
        GetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut dacl,
            ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    let descriptor = Descriptor(descriptor);
    if dacl.is_null() {
        // No access list at all grants everyone everything.
        return Ok((false, Vec::new()));
    }

    let mut control = 0u16;
    let mut revision = 0u32;
    // SAFETY: the descriptor came from GetNamedSecurityInfoW.
    if unsafe { GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision) } == 0 {
        return Err(io::Error::last_os_error());
    }

    let mut size = ACL_SIZE_INFORMATION::default();
    // SAFETY: `dacl` points into the descriptor; `size` is the right type.
    let ok = unsafe {
        GetAclInformation(
            dacl,
            (&raw mut size).cast(),
            size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }

    let mut entries = Vec::with_capacity(size.AceCount as usize);
    for index in 0..size.AceCount {
        let mut ace: *mut c_void = ptr::null_mut();
        // SAFETY: `index` is below AceCount.
        if unsafe { GetAce(dacl, index, &mut ace) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let ace = ace.cast::<ACCESS_ALLOWED_ACE>();
        // SAFETY: every ACE starts with an ACE_HEADER; the SID of an allowed
        // or denied ACE starts at SidStart. Other kinds are reported by type
        // and never count as the user's.
        let entry = unsafe {
            let kind = (*ace).Header.AceType;
            let sid = (&raw mut (*ace).SidStart).cast::<c_void>();
            AccessEntry {
                kind,
                mask: (*ace).Mask,
                is_current_user: kind == ACCESS_ALLOWED && EqualSid(sid, user.sid()) != 0,
            }
        };
        entries.push(entry);
    }
    Ok((control & SE_DACL_PROTECTED != 0, entries))
}

/// A security descriptor GetNamedSecurityInfoW allocated, freed on drop.
struct Descriptor(PSECURITY_DESCRIPTOR);

impl Drop for Descriptor {
    fn drop(&mut self) {
        // SAFETY: allocated by GetNamedSecurityInfoW with LocalAlloc.
        unsafe { LocalFree(self.0) };
    }
}

/// `path` as a NUL-terminated UTF-16 string.
fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::TestDirs;

    #[test]
    fn a_written_files_access_list_grants_the_current_user_only() {
        let dirs = TestDirs::new();
        let path = dirs.folder("keys").join("host.key");
        Native.write(&path, b"secret").unwrap();

        let (protected, entries) = access_list(&path).unwrap();
        assert!(
            protected,
            "the access list inherits nothing from the folder"
        );
        assert_eq!(
            entries.len(),
            1,
            "one entry and no other, for administrators, SYSTEM or anyone: {entries:?}"
        );
        assert_eq!(entries[0].kind, ACCESS_ALLOWED);
        assert!(
            entries[0].is_current_user,
            "the one entry is the current user's"
        );
        assert_ne!(entries[0].mask, 0);
        assert!(Native.owner_only(&path).unwrap());
    }

    #[test]
    fn a_file_made_the_ordinary_way_is_not_owner_only() {
        // The control for the test above: a file that inherits the folder's
        // list has more than the user's entry, and the check sees it.
        let dirs = TestDirs::new();
        let path = dirs.folder("keys").join("plain.txt");
        std::fs::write(&path, b"plain").unwrap();

        let (protected, entries) = access_list(&path).unwrap();
        assert!(!protected || entries.len() != 1, "{entries:?}");
        assert!(!Native.owner_only(&path).unwrap());
    }

    #[test]
    fn a_replace_keeps_the_user_only_access_list() {
        let dirs = TestDirs::new();
        let path = dirs.folder("keys").join("devices.json");
        // The old file is an ordinary one, so the list after the replace is
        // the new file's, not one the rename carried over.
        std::fs::write(&path, b"one").unwrap();
        assert!(!Native.owner_only(&path).unwrap());

        Native.write(&path, b"two").unwrap();
        assert!(Native.owner_only(&path).unwrap());
        Native.write(&path, b"three").unwrap();
        assert!(Native.owner_only(&path).unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), b"three");
    }
}
