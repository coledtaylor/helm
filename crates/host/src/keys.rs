//! The key pairs Floti keeps on disk: the host's own key in its data folder,
//! and a client's device key in the client's folder.
//!
//! Each is one file of the private key's 32 bytes, owner-only
//! ([`private_files`](crate::platform::private_files)), made the first time
//! it is needed and read back on every later start, so the key it holds
//! stays the same for as long as the file does. The keys and the Noise
//! sessions they prove come from snow, through `floti_protocol::noise`;
//! nothing here does any cryptography of its own.
//!
//! A private key is never printed, logged or sent: [`PrivateKey`] has no
//! `Display`, its `Debug` is redacted, and the bytes read from a file are
//! wiped once the key is made from them.

use std::path::Path;

use floti_protocol::noise::{KEY_LEN, KeyPair, PrivateKey};
use zeroize::Zeroize;

use crate::platform::private_files::{Native, PrivateFiles};
use crate::{Error, Result};

/// The key pair kept in the file at `path`, or `None` when there is no file.
pub fn read_key_pair(path: &Path) -> Result<Option<KeyPair>> {
    let Some(mut bytes) = Native.read(path)? else {
        return Ok(None);
    };
    let raw = <[u8; KEY_LEN]>::try_from(bytes.as_slice()).ok();
    bytes.zeroize();
    let Some(mut raw) = raw else {
        return Err(not_a_key(path));
    };
    let private = PrivateKey::from_bytes(raw);
    raw.zeroize();
    KeyPair::from_private(private)
        .map(Some)
        .map_err(|_| not_a_key(path))
}

/// The key pair kept in the file at `path`, made and written there, owner-
/// only, when there is none yet. The folder must exist.
///
/// The file is made once and never replaced: when two processes find no key
/// at the same moment, one makes the file and the other reads that one back,
/// so every caller answers the key that is on disk.
pub fn load_or_create_key_pair(path: &Path) -> Result<KeyPair> {
    if let Some(pair) = read_key_pair(path)? {
        return Ok(pair);
    }
    let pair = KeyPair::generate().map_err(|err| {
        Error::Refused(format!(
            "A new key for {} could not be made: {err}.",
            path.display()
        ))
    })?;
    if Native.write_new(path, pair.private().expose_secret())? {
        return Ok(pair);
    }
    read_key_pair(path)?.ok_or_else(|| {
        Error::Refused(format!(
            "The key at {} was removed while it was being made.",
            path.display()
        ))
    })
}

fn not_a_key(path: &Path) -> Error {
    Error::Refused(format!(
        "{} does not hold a Floti key: it is not {KEY_LEN} bytes of a Curve25519 private key.",
        path.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::TestDirs;

    #[test]
    fn a_key_is_made_once_and_read_back_the_same() {
        let dirs = TestDirs::new();
        let path = dirs.data.join("a key");
        assert!(read_key_pair(&path).unwrap().is_none());
        let made = load_or_create_key_pair(&path).unwrap();
        let again = load_or_create_key_pair(&path).unwrap();
        assert_eq!(made.public(), again.public());
        assert_eq!(
            read_key_pair(&path).unwrap().unwrap().public(),
            made.public()
        );
        assert!(Native.owner_only(&path).unwrap());
    }

    #[test]
    fn callers_racing_to_make_the_first_key_all_answer_the_one_on_disk() {
        const RACERS: usize = 8;
        let dirs = TestDirs::new();
        // A folder of its own: the data folder holds the testkit's markers.
        let folder = dirs.folder("keys");
        let path = folder.join("device.key");
        let start = std::sync::Barrier::new(RACERS);
        let keys: Vec<_> = std::thread::scope(|scope| {
            let racers: Vec<_> = (0..RACERS)
                .map(|_| {
                    scope.spawn(|| {
                        start.wait();
                        load_or_create_key_pair(&path).unwrap().public()
                    })
                })
                .collect();
            racers
                .into_iter()
                .map(|racer| racer.join().unwrap())
                .collect()
        });
        let on_disk = read_key_pair(&path).unwrap().unwrap().public();
        assert!(
            keys.iter().all(|key| *key == on_disk),
            "{keys:?} vs {on_disk:?}"
        );
        assert!(Native.owner_only(&path).unwrap());
        let left: Vec<_> = std::fs::read_dir(&folder)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(left, ["device.key"], "no new file left behind");
    }

    #[test]
    fn a_file_that_is_not_a_key_is_refused_and_left_alone() {
        let dirs = TestDirs::new();
        let path = dirs.data.join("not a key");
        std::fs::write(&path, b"short").unwrap();
        let err = load_or_create_key_pair(&path).unwrap_err();
        assert!(
            err.to_string().contains("does not hold a Floti key"),
            "{err}"
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"short");
    }
}
