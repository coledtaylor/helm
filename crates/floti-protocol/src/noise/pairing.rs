//! Asking to pair: the marker a device's first handshake message carries
//! when it asks a host that does not know its key to pair with it, and the
//! short code the host answers with.
//!
//! A device that asks starts with [`Initiator::start_pairing`](super::Initiator::start_pairing):
//! its first message carries [`PAIRING_MARKER`] as its payload, which only
//! the host's private key can decrypt, so the ask is part of the handshake
//! and no stranger's bytes are read as one. The host finds it with
//! [`PendingDevice::asks_to_pair`](super::PendingDevice::asks_to_pair).
//!
//! The host then answers with a [`PairingCode`] the device shows, and pairs
//! the device once someone on the host's computer approves that code. The
//! code is short so a person can read it off one screen and type it on
//! another: [`PAIRING_CODE_LEN`] characters from [`PAIRING_CODE_ALPHABET`],
//! which leaves out characters that are easily taken for another (`0`, `1`,
//! `I`, `L`, `O`, `U`). Typed back, case, spaces and hyphens do not matter.
//!
//! The host never logs a code; its `Debug` is redacted, and two codes are
//! compared in constant time ([`PairingCode::matches`]).

use std::fmt;
use std::str::FromStr;

use subtle::ConstantTimeEq;

use super::NoiseError;

/// The payload of a first handshake message that asks to pair. It is not
/// secret: the handshake hides it from everyone but the host, and its only
/// job is to make the ask a message of its own length.
pub const PAIRING_MARKER: &[u8; 16] = b"floti pairing v1";

/// How many characters a pairing code has.
pub const PAIRING_CODE_LEN: usize = 8;

/// The characters a pairing code is drawn from: digits and capital letters,
/// less `0`, `1`, `I`, `L`, `O` and `U`.
pub const PAIRING_CODE_ALPHABET: &[u8; 30] = b"23456789ABCDEFGHJKMNPQRSTVWXYZ";

/// The largest multiple of the alphabet's length a byte can hold: a random
/// byte below it maps onto the alphabet evenly, and one at or above it is
/// drawn again.
const UNBIASED_BELOW: u8 = (256 / PAIRING_CODE_ALPHABET.len() * PAIRING_CODE_ALPHABET.len()) as u8;

/// The code a host answers a device that asks to pair with.
#[derive(Clone, Copy)]
pub struct PairingCode([u8; PAIRING_CODE_LEN]);

impl PairingCode {
    /// A new code from the operating system's random source, each character
    /// drawn evenly from [`PAIRING_CODE_ALPHABET`].
    pub fn generate() -> Result<Self, NoiseError> {
        let mut code = [0; PAIRING_CODE_LEN];
        let mut filled = 0;
        let mut random = [0; 2 * PAIRING_CODE_LEN];
        while filled < PAIRING_CODE_LEN {
            getrandom::fill(&mut random).map_err(|err| {
                NoiseError::Library(format!("the OS gave no random bytes: {err}"))
            })?;
            for byte in random {
                if filled == PAIRING_CODE_LEN {
                    break;
                }
                if byte < UNBIASED_BELOW {
                    code[filled] =
                        PAIRING_CODE_ALPHABET[usize::from(byte) % PAIRING_CODE_ALPHABET.len()];
                    filled += 1;
                }
            }
        }
        Ok(Self(code))
    }

    /// The code as its eight characters, for the device that shows it.
    pub fn as_str(&self) -> &str {
        // Every byte is from the alphabet, which is ASCII.
        std::str::from_utf8(&self.0).unwrap_or_default()
    }

    /// Whether `other` is this code, in time that does not depend on where
    /// they differ.
    pub fn matches(&self, other: &Self) -> bool {
        bool::from(self.0.ct_eq(&other.0))
    }
}

impl FromStr for PairingCode {
    type Err = NoiseError;

    /// Eight characters from the alphabet, in either case, with any spaces
    /// and hyphens between them left out.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let mut code = [0; PAIRING_CODE_LEN];
        let mut len = 0;
        for byte in text.bytes().filter(|byte| !matches!(byte, b' ' | b'-')) {
            let byte = byte.to_ascii_uppercase();
            if len == PAIRING_CODE_LEN || !PAIRING_CODE_ALPHABET.contains(&byte) {
                return Err(NoiseError::InvalidPairingCode);
            }
            code[len] = byte;
            len += 1;
        }
        if len == PAIRING_CODE_LEN {
            Ok(Self(code))
        } else {
            Err(NoiseError::InvalidPairingCode)
        }
    }
}

impl fmt::Debug for PairingCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PairingCode(redacted)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pairing_code_is_eight_characters_from_an_alphabet_without_lookalikes() {
        for lookalike in b"01ILOU" {
            assert!(!PAIRING_CODE_ALPHABET.contains(lookalike));
        }
        for _ in 0..200 {
            let code = PairingCode::generate().unwrap();
            assert_eq!(code.as_str().len(), PAIRING_CODE_LEN);
            assert!(
                code.as_str()
                    .bytes()
                    .all(|byte| PAIRING_CODE_ALPHABET.contains(&byte)),
                "{}",
                code.as_str()
            );
        }
    }

    #[test]
    fn a_pairing_code_draws_every_character_of_the_alphabet() {
        let mut seen = [false; 256];
        for _ in 0..2000 {
            for byte in PairingCode::generate().unwrap().as_str().bytes() {
                seen[usize::from(byte)] = true;
            }
        }
        for byte in PAIRING_CODE_ALPHABET {
            assert!(
                seen[usize::from(*byte)],
                "{} never drawn",
                char::from(*byte)
            );
        }
    }

    #[test]
    fn a_pairing_code_typed_back_ignores_case_spaces_and_hyphens() {
        let code = PairingCode::generate().unwrap();
        let text = code.as_str();
        let typed = format!("{}-{}", &text[..4], &text[4..]).to_lowercase();
        assert!(code.matches(&typed.parse().unwrap()));
        let spaced = format!(" {} {} ", &text[..4], &text[4..]);
        assert!(code.matches(&spaced.parse().unwrap()));
        assert!(!code.matches(&PairingCode(*b"22222222")) || text == "22222222");
    }

    #[test]
    fn text_that_is_not_eight_characters_of_the_alphabet_is_not_a_pairing_code() {
        for text in [
            "",
            "ABCD",
            "ABCDEFGHJ",
            "ABCDEFG0",
            "ABCDEFGI",
            "ABCDEFG_",
            "ÄBCDEFGH",
        ] {
            assert_eq!(
                text.parse::<PairingCode>().unwrap_err(),
                NoiseError::InvalidPairingCode,
                "{text}"
            );
        }
    }

    #[test]
    fn a_pairing_code_prints_nothing_of_itself_in_debug() {
        let code = PairingCode::generate().unwrap();
        let printed = format!("{code:?}");
        assert_eq!(printed, "PairingCode(redacted)");
        assert!(!printed.contains(code.as_str()));
    }
}
