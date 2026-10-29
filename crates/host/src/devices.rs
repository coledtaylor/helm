//! The device registry: every device key paired with this host, and when
//! each was paired and, once it is, revoked.
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

/// One device the host has paired.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub key: PublicKey,
    pub name: String,
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
    pub fn standing(&self) -> Standing {
        if self.revoked_at.is_some() {
            Standing::Revoked
        } else {
            Standing::Paired
        }
    }
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

    /// Pairs `key` as `name`. A key already paired keeps the entry it has;
    /// a revoked key is refused.
    pub fn pair(&self, key: PublicKey, name: &str) -> Result<Device> {
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
        let device = Device {
            key,
            name: name.to_owned(),
            paired_at: Timestamp::now(),
            revoked_at: None,
        };
        devices.push(device.clone());
        self.write(devices)?;
        Ok(device)
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

        let paired = registry.pair(laptop, "laptop").unwrap();
        registry.pair(phone, "phone").unwrap();
        assert_eq!(registry.standing(&laptop).unwrap(), Standing::Paired);
        assert_eq!(registry.pair(laptop, "renamed").unwrap(), paired);

        let revoked = registry.revoke(&laptop).unwrap().unwrap();
        assert!(revoked.revoked_at.is_some());
        assert_eq!(revoked.paired_at, paired.paired_at);
        assert_eq!(registry.standing(&laptop).unwrap(), Standing::Revoked);
        assert_eq!(registry.standing(&phone).unwrap(), Standing::Paired);
        assert!(registry.pair(laptop, "laptop").is_err());
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
        registry.pair(laptop, "laptop").unwrap();
        let text = std::fs::read_to_string(registry.path()).unwrap();
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(json["format"], 1);
        assert_eq!(json["devices"][0]["key"], laptop.to_hex());
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
        assert!(registry.pair(key(), "laptop").is_err());
    }
}
