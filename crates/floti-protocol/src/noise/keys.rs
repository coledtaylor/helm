//! The keys a session proves: each device's and the host's, on Curve25519.
//!
//! A [`PublicKey`] is safe anywhere: it prints as hex, and logs name it by its
//! [`fingerprint`](PublicKey::fingerprint). A [`PrivateKey`] never prints
//! itself: it has no `Display`, its `Debug` is redacted, and its bytes are
//! wiped when it is dropped. The one way to its bytes is
//! [`PrivateKey::expose_secret`], for writing it to the owner-only file or
//! store that keeps it.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use snow::params::DHChoice;
use snow::resolvers::{CryptoResolver, DefaultResolver};
use zeroize::Zeroize;

use super::{NoiseError, library, params};

/// The length of a Curve25519 key, public or private.
pub const KEY_LEN: usize = 32;

/// How many of a public key's bytes its fingerprint shows.
const FINGERPRINT_BYTES: usize = 8;

/// A device's or the host's public key.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PublicKey([u8; KEY_LEN]);

impl PublicKey {
    pub const fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
        Self(bytes)
    }

    pub const fn as_bytes(&self) -> &[u8; KEY_LEN] {
        &self.0
    }

    /// The key as 64 lowercase hex digits, the form it is stored in.
    pub fn to_hex(&self) -> String {
        hex(&self.0)
    }

    /// The first bytes of the key as hex: short enough for a log line, and
    /// enough to tell one device from another.
    pub fn fingerprint(&self) -> String {
        hex(&self.0[..FINGERPRINT_BYTES])
    }

    fn from_slice(bytes: &[u8]) -> Option<Self> {
        bytes.try_into().ok().map(Self)
    }
}

impl fmt::Debug for PublicKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "PublicKey({})", self.fingerprint())
    }
}

impl fmt::Display for PublicKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_hex())
    }
}

impl FromStr for PublicKey {
    type Err = NoiseError;

    /// 64 hex digits, either case.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let (pairs, []) = text.as_bytes().as_chunks::<2>() else {
            return Err(NoiseError::InvalidKey);
        };
        if pairs.len() != KEY_LEN {
            return Err(NoiseError::InvalidKey);
        }
        let mut bytes = [0; KEY_LEN];
        for (byte, pair) in bytes.iter_mut().zip(pairs) {
            *byte = (nibble(pair[0])? << 4) | nibble(pair[1])?;
        }
        Ok(Self(bytes))
    }
}

impl Serialize for PublicKey {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_hex())
    }
}

impl<'de> Deserialize<'de> for PublicKey {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        text.parse().map_err(serde::de::Error::custom)
    }
}

/// A device's or the host's private key. Never printed, wiped on drop.
#[derive(Clone)]
pub struct PrivateKey([u8; KEY_LEN]);

impl Drop for PrivateKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl PrivateKey {
    pub const fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
        Self(bytes)
    }

    /// The key's bytes, for the file or store that keeps it and for nothing
    /// that prints, logs or sends.
    pub const fn expose_secret(&self) -> &[u8; KEY_LEN] {
        &self.0
    }
}

impl fmt::Debug for PrivateKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PrivateKey(redacted)")
    }
}

/// A private key and the public key it makes.
#[derive(Clone, Debug)]
pub struct KeyPair {
    public: PublicKey,
    private: PrivateKey,
}

impl KeyPair {
    /// A new key pair from the operating system's random source.
    pub fn generate() -> Result<Self, NoiseError> {
        let mut pair = snow::Builder::new(params()?)
            .generate_keypair()
            .map_err(library)?;
        let made = match (
            PublicKey::from_slice(&pair.public),
            <[u8; KEY_LEN]>::try_from(pair.private.as_slice()),
        ) {
            (Some(public), Ok(private)) => Ok(Self {
                public,
                private: PrivateKey(private),
            }),
            _ => Err(NoiseError::InvalidKey),
        };
        pair.private.zeroize();
        made
    }

    /// The pair a stored private key belongs to.
    pub fn from_private(private: PrivateKey) -> Result<Self, NoiseError> {
        let mut dh = DefaultResolver
            .resolve_dh(&DHChoice::Curve25519)
            .ok_or(NoiseError::Library("no Curve25519 implementation".into()))?;
        dh.set(private.expose_secret());
        let public = PublicKey::from_slice(dh.pubkey()).ok_or(NoiseError::InvalidKey)?;
        Ok(Self { public, private })
    }

    pub const fn public(&self) -> PublicKey {
        self.public
    }

    pub const fn private(&self) -> &PrivateKey {
        &self.private
    }
}

/// A key from the bytes a handshake carried.
pub(super) fn public_from(bytes: Option<&[u8]>) -> Option<PublicKey> {
    bytes.and_then(PublicKey::from_slice)
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push(char::from(DIGITS[usize::from(byte >> 4)]));
        text.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    text
}

fn nibble(digit: u8) -> Result<u8, NoiseError> {
    match digit {
        b'0'..=b'9' => Ok(digit - b'0'),
        b'a'..=b'f' => Ok(digit - b'a' + 10),
        b'A'..=b'F' => Ok(digit - b'A' + 10),
        _ => Err(NoiseError::InvalidKey),
    }
}
