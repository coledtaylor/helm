//! The one-time code a device on the host's own computer enrols with.
//!
//! A host with no admin yet makes one and keeps it in memory; the file only
//! the user can read in the host's data folder is how a client on that
//! computer learns it. The device carries it as the payload of its first
//! handshake message ([`Initiator::start_enrolling`](super::Initiator::start_enrolling)),
//! which only the host's private key can decrypt, and the host finds it on
//! the [`PendingDevice`](super::PendingDevice).
//!
//! Like a [`PrivateKey`](super::PrivateKey), a code never prints itself: it
//! has no `Display`, its `Debug` is redacted, its bytes are wiped when it is
//! dropped, and two codes are compared in constant time
//! ([`EnrolmentCode::matches`]). The one way to its text is
//! [`EnrolmentCode::expose_hex`], for the owner-only file that holds it.

use std::fmt;
use std::str::FromStr;

use subtle::ConstantTimeEq;
use zeroize::{Zeroize, Zeroizing};

use super::NoiseError;
use super::keys::{from_hex, push_hex};

/// The length of an enrolment code in bytes; written as hex, it is twice as
/// many characters.
pub const ENROLMENT_CODE_LEN: usize = 32;

/// A single-use enrolment code. Never printed, wiped on drop.
pub struct EnrolmentCode([u8; ENROLMENT_CODE_LEN]);

impl Drop for EnrolmentCode {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl EnrolmentCode {
    /// A new code from the operating system's random source.
    pub fn generate() -> Result<Self, NoiseError> {
        let mut code = Self([0; ENROLMENT_CODE_LEN]);
        getrandom::fill(&mut code.0)
            .map_err(|err| NoiseError::Library(format!("the OS gave no random bytes: {err}")))?;
        Ok(code)
    }

    pub const fn from_bytes(bytes: [u8; ENROLMENT_CODE_LEN]) -> Self {
        Self(bytes)
    }

    /// The code's bytes, for the handshake that carries it and for nothing
    /// that prints, logs or sends.
    pub const fn expose_secret(&self) -> &[u8; ENROLMENT_CODE_LEN] {
        &self.0
    }

    /// The code as 64 lowercase hex digits, wiped when dropped: for the
    /// owner-only file that holds it, and for nothing that prints or logs.
    pub fn expose_hex(&self) -> Zeroizing<String> {
        let mut text = Zeroizing::new(String::with_capacity(ENROLMENT_CODE_LEN * 2));
        push_hex(&mut text, &self.0);
        text
    }

    /// Whether `other` is this code, in time that does not depend on where
    /// they differ.
    pub fn matches(&self, other: &Self) -> bool {
        bool::from(self.0.ct_eq(&other.0))
    }
}

impl FromStr for EnrolmentCode {
    type Err = NoiseError;

    /// 64 hex digits, either case.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let mut code = Self([0; ENROLMENT_CODE_LEN]);
        from_hex(text, &mut code.0).map_err(|_| NoiseError::InvalidCode)?;
        Ok(code)
    }
}

impl fmt::Debug for EnrolmentCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("EnrolmentCode(redacted)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_code_reads_back_from_its_hex_and_matches_only_itself() {
        let code = EnrolmentCode::generate().unwrap();
        let again: EnrolmentCode = code.expose_hex().parse().unwrap();
        assert!(code.matches(&again));
        assert!(!code.matches(&EnrolmentCode::generate().unwrap()));
        let upper: EnrolmentCode = code.expose_hex().to_uppercase().parse().unwrap();
        assert!(code.matches(&upper));
    }

    #[test]
    fn a_code_prints_nothing_of_itself() {
        let code = EnrolmentCode::generate().unwrap();
        let printed = format!("{code:?}");
        assert_eq!(printed, "EnrolmentCode(redacted)");
        assert!(!printed.contains(code.expose_hex().as_str()));
    }

    #[test]
    fn text_that_is_not_64_hex_digits_is_not_a_code() {
        for text in ["", "abc", &"g".repeat(64), &"0".repeat(62), &"0".repeat(66)] {
            assert_eq!(
                text.parse::<EnrolmentCode>().unwrap_err(),
                NoiseError::InvalidCode
            );
        }
    }
}
