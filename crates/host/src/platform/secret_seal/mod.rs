//! Sealing plugin secrets so only this user on this computer can read them.
//!
//! [`SecretSeal`] turns a value into bytes only this user can turn back, and
//! [`Native`] is this OS's way of doing it:
//!
//! - Windows: DPAPI for the current user, what Credential Manager and
//!   Electron's `safeStorage` use underneath. The sealed bytes are the whole
//!   of it, so nothing is kept outside `floti.db`.
//! - macOS: one random 256-bit key in a Keychain item Floti owns.
//! - Linux: one random 256-bit key in a Secret Service entry Floti owns.
//!
//! On macOS and Linux the key seals with XChaCha20-Poly1305 ([`KeySeal`]).
//! Where no store answers (Linux with no Secret Service, as in WSL and CI),
//! [`SecretSeal::available`] is false and every seal is refused: a value is
//! stored sealed or not at all.
//!
//! Floti's secrets start empty. `floti.db` sits in Floti's own data folder and
//! nothing copies the desktop app's secrets table into it, so no value Electron
//! sealed reaches this module; the user saves each secret again in Floti. A
//! value that does not unseal here, however it got into the table, fails the
//! call that needs it with "could not be decrypted on this computer".

use std::fmt;

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
pub use linux::Native;
#[cfg(target_os = "macos")]
pub use macos::Native;
#[cfg(target_os = "windows")]
pub use windows::Native;

/// Why a value could not be sealed or unsealed. Says nothing of the value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SealError {
    /// This computer has no store to seal with for this user.
    Unavailable,
    /// The bytes are not something this user's key sealed, or the OS
    /// refused.
    Failed(String),
}

impl fmt::Display for SealError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable => f.write_str("this computer has no secret store for this user"),
            Self::Failed(why) => f.write_str(why),
        }
    }
}

impl std::error::Error for SealError {}

pub trait SecretSeal: Send + Sync {
    /// Whether values can be sealed here. When it is false, [`seal`] fails
    /// with [`SealError::Unavailable`].
    ///
    /// [`seal`]: SecretSeal::seal
    fn available(&self) -> bool;

    fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, SealError>;

    fn unseal(&self, sealed: &[u8]) -> Result<Vec<u8>, SealError>;
}

/// No store: nothing can be sealed or unsealed.
#[derive(Debug, Clone, Copy, Default)]
pub struct Unavailable;

impl SecretSeal for Unavailable {
    fn available(&self) -> bool {
        false
    }

    fn seal(&self, _plain: &[u8]) -> Result<Vec<u8>, SealError> {
        Err(SealError::Unavailable)
    }

    fn unseal(&self, _sealed: &[u8]) -> Result<Vec<u8>, SealError> {
        Err(SealError::Unavailable)
    }
}

/// The length of a [`KeySeal`] key.
pub const KEY_LEN: usize = 32;

/// The first byte of what a [`KeySeal`] seals, so a later format can be told
/// apart.
const KEY_SEAL_VERSION: u8 = 1;
const NONCE_LEN: usize = 24;

/// XChaCha20-Poly1305 under one 256-bit key: `[version][nonce][sealed]`,
/// with a random nonce for every value. Its `Debug` never prints the key.
pub struct KeySeal {
    cipher: XChaCha20Poly1305,
}

impl KeySeal {
    pub fn new(key: &[u8; KEY_LEN]) -> Self {
        Self {
            cipher: XChaCha20Poly1305::new(Key::from_slice(key)),
        }
    }

    /// A new random key.
    pub fn random_key() -> Result<[u8; KEY_LEN], SealError> {
        let mut key = [0u8; KEY_LEN];
        getrandom::fill(&mut key)
            .map_err(|err| SealError::Failed(format!("the OS gave no random bytes: {err}")))?;
        Ok(key)
    }

    /// The key in `stored`, when it is one.
    pub fn from_stored(stored: &[u8]) -> Option<Self> {
        let key: &[u8; KEY_LEN] = stored.try_into().ok()?;
        Some(Self::new(key))
    }
}

impl fmt::Debug for KeySeal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("KeySeal(..)")
    }
}

impl SecretSeal for KeySeal {
    fn available(&self) -> bool {
        true
    }

    fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, SealError> {
        let mut nonce = [0u8; NONCE_LEN];
        getrandom::fill(&mut nonce)
            .map_err(|err| SealError::Failed(format!("the OS gave no random bytes: {err}")))?;
        let sealed = self
            .cipher
            .encrypt(XNonce::from_slice(&nonce), plain)
            .map_err(|_| SealError::Failed("the value could not be sealed".into()))?;
        let mut out = Vec::with_capacity(1 + NONCE_LEN + sealed.len());
        out.push(KEY_SEAL_VERSION);
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&sealed);
        Ok(out)
    }

    fn unseal(&self, sealed: &[u8]) -> Result<Vec<u8>, SealError> {
        let not_ours = || SealError::Failed("the value was not sealed with this key".into());
        let (&version, rest) = sealed.split_first().ok_or_else(not_ours)?;
        if version != KEY_SEAL_VERSION || rest.len() < NONCE_LEN {
            return Err(not_ours());
        }
        let (nonce, body) = rest.split_at(NONCE_LEN);
        self.cipher
            .decrypt(XNonce::from_slice(nonce), body)
            .map_err(|_| not_ours())
    }
}

#[cfg(test)]
mod tests;
