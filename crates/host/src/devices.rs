//! The device registry: every device key paired with this host, the role it
//! was paired with ([`Role`]), and when each was paired and, once it is,
//! revoked.
//!
//! While no unrevoked device is an admin, the host waits for its first one:
//! a device on the host's computer enrols itself with the host's one-time
//! code ([`DeviceRegistry::pair_first_admin`]), and becomes that admin.
//!
//! It is `devices.json` in the host's data folder ([`DEVICES_FILE`]), owner-
//! only and rewritten whole and atomically on every change
//! ([`private_files`](crate::platform::private_files)). It is not in
//! `floti.db`, whose schema is the desktop app's. The host reads it fresh at
//! every handshake, so a device paired or revoked is let in or kept out from
//! the next connection on.
//!
//! A revoked device stays in the file with the time it was revoked: the key
//! is refused for good, and pairing it again is refused too. A device that
//! was revoked pairs again only with a new key.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use floti_protocol::noise::PublicKey;
use jiff::Timestamp;
use serde::{Deserialize, Serialize};

use crate::platform::private_files::{Native, PrivateFiles};
use crate::server::DEVICES_FILE;
use crate::{Error, Result};

/// The format of the file this build writes and reads.
const FORMAT: u32 = 1;

/// Changes made in this process, one at a time: each reads the file and
/// writes it back whole.
static CHANGING: Mutex<()> = Mutex::new(());

/// Where a device key stands with this host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Standing {
    Paired,
    Revoked,
    Unknown,
}

/// What a device may do with the host. Each role can do all the one before
/// it can: a viewer sees, an operator also types into and runs sessions,
/// an admin also pairs and revokes devices and changes the host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Viewer,
    Operator,
    Admin,
}

/// How a first admin's enrolment went.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FirstAdmin {
    /// The device is paired as the admin.
    Enrolled(Device),
    /// An unrevoked admin is already paired: there is no first one to be.
    AdminExists,
    /// The key is in the registry already, paired or revoked.
    KeyKnown,
}

/// One device the host has paired.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub key: PublicKey,
    pub name: String,
    pub role: Role,
    #[serde(with = "rfc3339")]
    pub paired_at: Timestamp,
    #[serde(
        default,
        with = "rfc3339_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub revoked_at: Option<Timestamp>,
}

impl Device {
    fn new(key: PublicKey, name: &str, role: Role) -> Self {
        Self {
            key,
            name: name.to_owned(),
            role,
            paired_at: Timestamp::now(),
            revoked_at: None,
        }
    }

    pub fn standing(&self) -> Standing {
        if self.revoked_at.is_some() {
            Standing::Revoked
        } else {
            Standing::Paired
        }
    }
}

fn any_admin(devices: &[Device]) -> bool {
    devices
        .iter()
        .any(|device| device.role == Role::Admin && device.standing() == Standing::Paired)
}

#[derive(Debug, Serialize, Deserialize)]
struct RegistryFile {
    format: u32,
    devices: Vec<Device>,
}

/// The registry in one data folder.
#[derive(Debug, Clone)]
pub struct DeviceRegistry {
    path: PathBuf,
}

impl DeviceRegistry {
    /// The registry of the host whose data folder is `data`.
    pub fn in_data_folder(data: &Path) -> Self {
        Self {
            path: data.join(DEVICES_FILE),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Every device in the registry, revoked ones included, in the order
    /// they were paired. No file is no devices.
    pub fn devices(&self) -> Result<Vec<Device>> {
        let Some(bytes) = Native.read(&self.path)? else {
            return Ok(Vec::new());
        };
        let file: RegistryFile = serde_json::from_slice(&bytes).map_err(|err| {
            Error::Refused(format!(
                "The device registry {} cannot be read: {err}.",
                self.path.display()
            ))
        })?;
        if file.format != FORMAT {
            return Err(Error::Refused(format!(
                "The device registry {} is in format {}, which this build of floti does not read.",
                self.path.display(),
                file.format
            )));
        }
        Ok(file.devices)
    }

    /// Where `key` stands, read from the file as it is now.
    pub fn standing(&self, key: &PublicKey) -> Result<Standing> {
        Ok(self
            .devices()?
            .iter()
            .find(|device| device.key == *key)
            .map_or(Standing::Unknown, Device::standing))
    }

    /// Whether an unrevoked device is an admin, read from the file as it is
    /// now. While none is, the host waits for its first admin.
    pub fn has_admin(&self) -> Result<bool> {
        Ok(any_admin(&self.devices()?))
    }

    /// Pairs `key` as `name` with `role`. A key already paired keeps the
    /// entry it has; a revoked key is refused.
    pub fn pair(&self, key: PublicKey, name: &str, role: Role) -> Result<Device> {
        let _changing = CHANGING.lock().unwrap_or_else(PoisonError::into_inner);
        let mut devices = self.devices()?;
        if let Some(device) = devices.iter().find(|device| device.key == key) {
            return match device.standing() {
                Standing::Revoked => Err(Error::Refused(format!(
                    "The device {} was revoked; a revoked device pairs again only with a new key.",
                    key.fingerprint()
                ))),
                _ => Ok(device.clone()),
            };
        }
        let device = Device::new(key, name, role);
        devices.push(device.clone());
        self.write(devices)?;
        Ok(device)
    }

    /// Pairs `key`, which the registry does not know, as `name` and the
    /// admin, only while no unrevoked admin is paired. The check and the
    /// write are one change: of two racing, exactly one is the first admin.
    pub fn pair_first_admin(&self, key: PublicKey, name: &str) -> Result<FirstAdmin> {
        let _changing = CHANGING.lock().unwrap_or_else(PoisonError::into_inner);
        let mut devices = self.devices()?;
        if any_admin(&devices) {
            return Ok(FirstAdmin::AdminExists);
        }
        if devices.iter().any(|device| device.key == key) {
            return Ok(FirstAdmin::KeyKnown);
        }
        let device = Device::new(key, name, Role::Admin);
        devices.push(device.clone());
        self.write(devices)?;
        Ok(FirstAdmin::Enrolled(device))
    }

    /// Revokes `key`: its entry, now revoked, or `None` when it was never
    /// paired. Revoking a revoked key changes nothing.
    pub fn revoke(&self, key: &PublicKey) -> Result<Option<Device>> {
        let _changing = CHANGING.lock().unwrap_or_else(PoisonError::into_inner);
        let mut devices = self.devices()?;
        let Some(device) = devices.iter_mut().find(|device| device.key == *key) else {
            return Ok(None);
        };
        if device.revoked_at.is_some() {
            return Ok(Some(device.clone()));
        }
        device.revoked_at = Some(Timestamp::now());
        let revoked = device.clone();
        self.write(devices)?;
        Ok(Some(revoked))
    }

    fn write(&self, devices: Vec<Device>) -> Result<()> {
        if let Some(folder) = self.path.parent() {
            std::fs::create_dir_all(folder)
                .map_err(|source| Error::path("create the data folder", folder, source))?;
        }
        let file = RegistryFile {
            format: FORMAT,
            devices,
        };
        let mut bytes = serde_json::to_vec_pretty(&file)
            .map_err(|err| Error::io("write the device registry", std::io::Error::other(err)))?;
        bytes.push(b'\n');
        Native.write(&self.path, &bytes)
    }
}

/// A timestamp as RFC 3339 text.
mod rfc3339 {
    use jiff::Timestamp;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(at: &Timestamp, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(at)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Timestamp, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

/// An optional timestamp as RFC 3339 text, absent when there is none.
mod rfc3339_optional {
    use jiff::Timestamp;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(
        at: &Option<Timestamp>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match at {
            Some(at) => serializer.collect_str(at),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Timestamp>, D::Error> {
        Option::<String>::deserialize(deserializer)?
            .map(|text| text.parse().map_err(serde::de::Error::custom))
            .transpose()
    }
}

#[cfg(test)]
mod tests {
    use floti_protocol::noise::KeyPair;

    use super::*;
    use crate::testkit::TestDirs;

    fn key() -> PublicKey {
        KeyPair::generate().unwrap().public()
    }

    #[test]
    fn a_key_is_unknown_until_paired_and_revoked_once_revoked() {
        let dirs = TestDirs::new();
        let registry = DeviceRegistry::in_data_folder(&dirs.data);
        let (laptop, phone) = (key(), key());
        assert_eq!(registry.standing(&laptop).unwrap(), Standing::Unknown);
        assert!(registry.devices().unwrap().is_empty());

        let paired = registry.pair(laptop, "laptop", Role::Operator).unwrap();
        registry.pair(phone, "phone", Role::Viewer).unwrap();
        assert_eq!(registry.standing(&laptop).unwrap(), Standing::Paired);
        assert_eq!(
            registry.pair(laptop, "renamed", Role::Admin).unwrap(),
            paired
        );

        let revoked = registry.revoke(&laptop).unwrap().unwrap();
        assert!(revoked.revoked_at.is_some());
        assert_eq!(revoked.paired_at, paired.paired_at);
        assert_eq!(registry.standing(&laptop).unwrap(), Standing::Revoked);
        assert_eq!(registry.standing(&phone).unwrap(), Standing::Paired);
        assert!(registry.pair(laptop, "laptop", Role::Operator).is_err());
        assert_eq!(registry.revoke(&key()).unwrap(), None);

        let devices = registry.devices().unwrap();
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].name, "laptop");
        assert!(Native.owner_only(registry.path()).unwrap());
    }

    #[test]
    fn the_file_names_each_key_by_its_hex_and_each_time_in_rfc_3339() {
        let dirs = TestDirs::new();
        let registry = DeviceRegistry::in_data_folder(&dirs.data);
        let laptop = key();
        registry.pair(laptop, "laptop", Role::Operator).unwrap();
        let text = std::fs::read_to_string(registry.path()).unwrap();
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(json["format"], 1);
        assert_eq!(json["devices"][0]["key"], laptop.to_hex());
        assert_eq!(json["devices"][0]["role"], "operator");
        let paired_at = json["devices"][0]["pairedAt"].as_str().unwrap();
        assert!(paired_at.parse::<Timestamp>().is_ok(), "{paired_at}");
        assert!(json["devices"][0].get("revokedAt").is_none());
    }

    #[test]
    fn a_registry_that_cannot_be_read_is_an_error_never_an_empty_one() {
        let dirs = TestDirs::new();
        let registry = DeviceRegistry::in_data_folder(&dirs.data);
        std::fs::write(registry.path(), b"{ not json").unwrap();
        assert!(registry.standing(&key()).is_err());
        assert!(registry.has_admin().is_err());
        assert!(registry.pair(key(), "laptop", Role::Operator).is_err());
        assert!(registry.pair_first_admin(key(), "laptop").is_err());
    }

    #[test]
    fn a_device_with_no_role_in_the_file_is_not_read() {
        let dirs = TestDirs::new();
        let registry = DeviceRegistry::in_data_folder(&dirs.data);
        let text = format!(
            r#"{{"format":1,"devices":[{{"key":"{}","name":"laptop","pairedAt":"2026-01-02T03:04:05Z"}}]}}"#,
            key().to_hex()
        );
        std::fs::write(registry.path(), text).unwrap();
        assert!(registry.devices().is_err());
    }

    #[test]
    fn only_an_unrevoked_admin_counts_as_the_registry_having_one() {
        let dirs = TestDirs::new();
        let registry = DeviceRegistry::in_data_folder(&dirs.data);
        assert!(!registry.has_admin().unwrap());
        registry.pair(key(), "phone", Role::Operator).unwrap();
        registry.pair(key(), "tablet", Role::Viewer).unwrap();
        assert!(!registry.has_admin().unwrap());
        let admin = key();
        registry.pair(admin, "desk", Role::Admin).unwrap();
        assert!(registry.has_admin().unwrap());
        registry.revoke(&admin).unwrap();
        assert!(!registry.has_admin().unwrap());
    }

    #[test]
    fn a_first_admin_is_paired_only_while_there_is_none_and_only_for_a_new_key() {
        let dirs = TestDirs::new();
        let registry = DeviceRegistry::in_data_folder(&dirs.data);
        let revoked = key();
        registry.pair(revoked, "lost", Role::Operator).unwrap();
        registry.revoke(&revoked).unwrap();
        assert_eq!(
            registry.pair_first_admin(revoked, "This computer").unwrap(),
            FirstAdmin::KeyKnown
        );

        let desk = key();
        let FirstAdmin::Enrolled(device) =
            registry.pair_first_admin(desk, "This computer").unwrap()
        else {
            panic!("the first admin was not enrolled");
        };
        assert_eq!(device.role, Role::Admin);
        assert_eq!(device.name, "This computer");
        assert_eq!(registry.standing(&desk).unwrap(), Standing::Paired);
        assert_eq!(
            registry.pair_first_admin(key(), "This computer").unwrap(),
            FirstAdmin::AdminExists
        );
    }

    #[test]
    fn of_two_first_admins_racing_exactly_one_is_enrolled() {
        let dirs = TestDirs::new();
        let registry = DeviceRegistry::in_data_folder(&dirs.data);
        let barrier = std::sync::Barrier::new(2);
        let outcomes: Vec<FirstAdmin> = std::thread::scope(|scope| {
            let racers: Vec<_> = (0..2)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        registry.pair_first_admin(key(), "This computer").unwrap()
                    })
                })
                .collect();
            racers
                .into_iter()
                .map(|racer| racer.join().unwrap())
                .collect()
        });
        let enrolled = outcomes
            .iter()
            .filter(|outcome| matches!(outcome, FirstAdmin::Enrolled(_)))
            .count();
        assert_eq!(enrolled, 1, "{outcomes:?}");
        assert!(outcomes.contains(&FirstAdmin::AdminExists));
        assert_eq!(registry.devices().unwrap().len(), 1);
    }
}
