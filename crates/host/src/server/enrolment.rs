//! Enrolling the first admin: a device on the host's own computer pairs
//! itself, without SSH and without another admin, through a one-time code
//! only the user can read.
//!
//! While no unrevoked device in the registry is an admin, a host makes a
//! fresh code at every start, before its socket binds, and keeps it in
//! memory. It writes the code and its own public key to [`ENROLMENT_FILE`] in
//! its data folder, owner-only ([`private_files`](crate::platform::private_files)),
//! which is how a client on this computer, running as the same user, learns
//! both: `{"format":1,"hostKey":"<64 hex>","code":"<64 hex>"}`. Once an admin
//! exists the file is removed, at the start that finds one or by the
//! enrolment that makes one.
//!
//! The client proves the code inside the Noise handshake, holding the host
//! to the key the file names ([`Initiator::start_enrolling`](floti_protocol::noise::Initiator::start_enrolling)).
//! The host checks the code only for a key its registry does not know. Under
//! one lock it checks that the code is the one it holds and unused, pairs the
//! key as the admin named [`FIRST_ADMIN_NAME`] while no other admin exists,
//! and drops the code and removes the file, and only then answers. Every
//! other device is refused exactly as an unknown one is: closed without a
//! byte. The code is never logged, printed, sent to a client or put in a
//! session's environment.

use std::fmt::{self, Write as _};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use floti_protocol::noise::{ENROLMENT_CODE_LEN, EnrolmentCode, PublicKey};
use serde::Deserialize;
use zeroize::Zeroizing;

use super::ENROLMENT_FILE;
use crate::devices::{Device, DeviceRegistry, FirstAdmin};
use crate::platform::private_files::{Native, PrivateFiles};
use crate::{Error, Result};

/// The format of the file this build writes and reads.
const FORMAT: u32 = 1;

/// The name the registry gives the device that enrolled as the first admin.
pub const FIRST_ADMIN_NAME: &str = "This computer";

/// The host's enrolment: the code it holds while it waits for its first
/// admin, and the file a client on this computer reads it from.
pub(crate) struct Enrolment {
    path: PathBuf,
    /// `None` once used, and when the host is not waiting for a first admin.
    code: Mutex<Option<EnrolmentCode>>,
}

impl Enrolment {
    /// Sets up the host's enrolment over the data folder `data`, for the host
    /// holding `host`: a fresh code written to the file while `devices` has
    /// no unrevoked admin, and no file when it has one. A registry that
    /// cannot be read gives no code, and the log says so.
    pub(crate) fn prepare(data: &Path, host: PublicKey, devices: &DeviceRegistry) -> Self {
        let path = data.join(ENROLMENT_FILE);
        let code = match devices.has_admin() {
            Ok(true) => None,
            Ok(false) => match write_code(&path, host) {
                Ok(code) => {
                    eprintln!(
                        "floti host: no device is an admin yet; a client on this computer can \
                         enrol as the first admin with the one-time code in {}",
                        path.display()
                    );
                    Some(code)
                }
                Err(err) => {
                    eprintln!(
                        "floti host: no enrolment code was written, so no device can enrol: {err}"
                    );
                    None
                }
            },
            Err(err) => {
                eprintln!(
                    "floti host: the device registry cannot be read, so no enrolment code was \
                     written: {err}"
                );
                None
            }
        };
        if code.is_none() {
            remove(&path);
        }
        Self {
            path,
            code: Mutex::new(code),
        }
    }

    /// Whether the host holds a code no device has used yet.
    #[cfg(test)]
    pub(crate) fn waiting(&self) -> bool {
        self.code
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_some()
    }

    /// Enrols `key`, which `devices` does not know, as the first admin when
    /// `offered` is the unused code and no admin exists yet: the device it
    /// paired, or `None` when it enrolled nothing. The code is used up by
    /// the enrolment, and by finding an admin paired some other way.
    pub(crate) fn enrol(
        &self,
        devices: &DeviceRegistry,
        key: PublicKey,
        offered: &EnrolmentCode,
    ) -> Result<Option<Device>> {
        let mut held = self.code.lock().unwrap_or_else(PoisonError::into_inner);
        if !held.as_ref().is_some_and(|code| code.matches(offered)) {
            return Ok(None);
        }
        match devices.pair_first_admin(key, FIRST_ADMIN_NAME)? {
            FirstAdmin::Enrolled(device) => {
                *held = None;
                remove(&self.path);
                Ok(Some(device))
            }
            FirstAdmin::AdminExists => {
                *held = None;
                remove(&self.path);
                Ok(None)
            }
            FirstAdmin::KeyKnown => Ok(None),
        }
    }
}

impl fmt::Debug for Enrolment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Enrolment")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

/// Makes a code and writes it, with the host's key, to `path`, owner-only.
fn write_code(path: &Path, host: PublicKey) -> Result<EnrolmentCode> {
    let code = EnrolmentCode::generate()
        .map_err(|err| Error::io("make an enrolment code", io::Error::other(err)))?;
    // Sized up front, so the text holding the code is never moved and left
    // behind; wiped when dropped.
    let mut text = Zeroizing::new(String::with_capacity(64 + 4 * ENROLMENT_CODE_LEN));
    let _ = writeln!(
        text,
        r#"{{"format":{FORMAT},"hostKey":"{}","code":"{}"}}"#,
        host.to_hex(),
        code.expose_hex().as_str()
    );
    Native.write(path, text.as_bytes())?;
    Ok(code)
}

/// Removes the file at `path`, when there is one. A file that will not go is
/// said in the log: the code in it no longer works, but it should not stay.
fn remove(path: &Path) {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
        Err(err) => eprintln!("floti host: could not remove {}: {err}", path.display()),
    }
}

/// What a client on the host's computer reads from the host's enrolment
/// file: the key the host must prove and the code to prove the device with.
#[derive(Debug)]
pub struct LocalEnrolment {
    pub host_key: PublicKey,
    pub code: EnrolmentCode,
}

/// The enrolment file in the host data folder `data`, or `None` when there
/// is none: the host is not waiting for a first admin, or has not started.
pub fn read_enrolment(data: &Path) -> Result<Option<LocalEnrolment>> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct File<'a> {
        format: u32,
        host_key: PublicKey,
        #[serde(borrow)]
        code: &'a str,
    }

    let path = data.join(ENROLMENT_FILE);
    let Some(bytes) = Native.read(&path)? else {
        return Ok(None);
    };
    let bytes = Zeroizing::new(bytes);
    // serde's own message can quote what it read, so it is not passed on.
    let unreadable = || {
        Error::Refused(format!(
            "The enrolment file {} is not one this build of floti reads.",
            path.display()
        ))
    };
    let file: File<'_> = serde_json::from_slice(&bytes).map_err(|_| unreadable())?;
    if file.format != FORMAT {
        return Err(unreadable());
    }
    let code = file.code.parse().map_err(|_| unreadable())?;
    Ok(Some(LocalEnrolment {
        host_key: file.host_key,
        code,
    }))
}

#[cfg(test)]
mod tests {
    use floti_protocol::noise::KeyPair;

    use super::*;
    use crate::devices::Role;
    use crate::testkit::TestDirs;

    fn key() -> PublicKey {
        KeyPair::generate().unwrap().public()
    }

    #[test]
    fn a_host_with_no_admin_writes_its_key_and_a_fresh_code_owner_only() {
        let dirs = TestDirs::new();
        let devices = DeviceRegistry::in_data_folder(&dirs.data);
        let host = key();
        let enrolment = Enrolment::prepare(&dirs.data, host, &devices);
        assert!(enrolment.waiting());
        let path = dirs.data.join(ENROLMENT_FILE);
        assert!(Native.owner_only(&path).unwrap());

        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(json["format"], 1);
        assert_eq!(json["hostKey"], host.to_hex());
        let read = read_enrolment(&dirs.data).unwrap().unwrap();
        assert_eq!(read.host_key, host);
        assert_eq!(json["code"], read.code.expose_hex().as_str());
        assert!(!format!("{enrolment:?}{read:?}").contains(read.code.expose_hex().as_str()));

        let again = Enrolment::prepare(&dirs.data, host, &devices);
        assert!(again.waiting());
        let replaced = read_enrolment(&dirs.data).unwrap().unwrap();
        assert!(!replaced.code.matches(&read.code));
    }

    #[test]
    fn a_host_with_an_admin_writes_no_code_and_removes_one_left_before() {
        let dirs = TestDirs::new();
        let devices = DeviceRegistry::in_data_folder(&dirs.data);
        Enrolment::prepare(&dirs.data, key(), &devices);
        assert!(dirs.data.join(ENROLMENT_FILE).exists());
        devices.pair(key(), "desk", Role::Admin).unwrap();

        let enrolment = Enrolment::prepare(&dirs.data, key(), &devices);
        assert!(!enrolment.waiting());
        assert!(!dirs.data.join(ENROLMENT_FILE).exists());
        assert!(read_enrolment(&dirs.data).unwrap().is_none());
    }

    #[test]
    fn a_registry_that_cannot_be_read_gives_no_code() {
        let dirs = TestDirs::new();
        let devices = DeviceRegistry::in_data_folder(&dirs.data);
        std::fs::write(devices.path(), b"{ not json").unwrap();
        let enrolment = Enrolment::prepare(&dirs.data, key(), &devices);
        assert!(!enrolment.waiting());
        assert!(!dirs.data.join(ENROLMENT_FILE).exists());
    }

    #[test]
    fn the_code_enrols_one_device_as_admin_once_and_the_file_goes() {
        let dirs = TestDirs::new();
        let devices = DeviceRegistry::in_data_folder(&dirs.data);
        let enrolment = Enrolment::prepare(&dirs.data, key(), &devices);
        let code = read_enrolment(&dirs.data).unwrap().unwrap().code;

        let wrong = EnrolmentCode::generate().unwrap();
        assert_eq!(enrolment.enrol(&devices, key(), &wrong).unwrap(), None);
        assert!(enrolment.waiting());

        let desk = key();
        let device = enrolment.enrol(&devices, desk, &code).unwrap().unwrap();
        assert_eq!((device.key, device.role), (desk, Role::Admin));
        assert_eq!(device.name, FIRST_ADMIN_NAME);
        assert!(!enrolment.waiting());
        assert!(!dirs.data.join(ENROLMENT_FILE).exists());
        assert_eq!(enrolment.enrol(&devices, key(), &code).unwrap(), None);
        assert_eq!(devices.devices().unwrap().len(), 1);
    }

    #[test]
    fn an_admin_paired_another_way_uses_the_code_up() {
        let dirs = TestDirs::new();
        let devices = DeviceRegistry::in_data_folder(&dirs.data);
        let enrolment = Enrolment::prepare(&dirs.data, key(), &devices);
        let code = read_enrolment(&dirs.data).unwrap().unwrap().code;
        devices.pair(key(), "desk", Role::Admin).unwrap();

        assert_eq!(enrolment.enrol(&devices, key(), &code).unwrap(), None);
        assert!(!enrolment.waiting());
        assert!(!dirs.data.join(ENROLMENT_FILE).exists());
    }

    #[test]
    fn an_enrolment_file_in_another_format_is_refused_without_quoting_it() {
        let dirs = TestDirs::new();
        let code = "ab".repeat(32);
        std::fs::write(
            dirs.data.join(ENROLMENT_FILE),
            format!(
                r#"{{"format":2,"hostKey":"{}","code":"{code}"}}"#,
                key().to_hex()
            ),
        )
        .unwrap();
        let err = read_enrolment(&dirs.data).unwrap_err().to_string();
        assert!(!err.contains(&code), "{err}");
        std::fs::write(
            dirs.data.join(ENROLMENT_FILE),
            format!(r#"{{"code":{code}}}"#),
        )
        .unwrap();
        let err = read_enrolment(&dirs.data).unwrap_err().to_string();
        assert!(!err.contains(&code), "{err}");
    }
}
