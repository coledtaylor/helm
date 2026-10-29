//! DPAPI for the current user: what Credential Manager and Electron's
//! `safeStorage` use underneath. The OS keeps the key with the user's
//! profile, so the sealed bytes are all there is to store, and only this
//! user on this computer can unseal them.

use std::ptr;

use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
};

use super::{SealError, SecretSeal};

/// Mixed into every seal, so a value is Floti's to unseal and not any
/// program's that unseals the user's DPAPI blobs blindly.
const ENTROPY: &[u8] = b"floti plugin secret";

#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl Native {
    pub fn new() -> Self {
        Self
    }
}

fn blob(bytes: &[u8]) -> Result<CRYPT_INTEGER_BLOB, SealError> {
    Ok(CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(bytes.len())
            .map_err(|_| SealError::Failed("the value is too long to seal".into()))?,
        // DPAPI reads the input and never writes it.
        pbData: bytes.as_ptr().cast_mut(),
    })
}

/// Copies what DPAPI wrote and frees it.
///
/// # Safety
///
/// `out` must be a blob DPAPI filled in, not yet freed.
unsafe fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    let bytes = if out.pbData.is_null() {
        Vec::new()
    } else {
        // SAFETY: DPAPI allocated `cbData` bytes at `pbData`.
        unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec()
    };
    if !out.pbData.is_null() {
        // SAFETY: DPAPI allocates its output with LocalAlloc.
        unsafe { LocalFree(out.pbData.cast()) };
    }
    bytes
}

impl SecretSeal for Native {
    fn available(&self) -> bool {
        true
    }

    fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, SealError> {
        let input = blob(plain)?;
        let entropy = blob(ENTROPY)?;
        let mut out = CRYPT_INTEGER_BLOB::default();
        // SAFETY: every blob points at memory that lives across the call, and
        // `out` is freed by `take`.
        let ok = unsafe {
            CryptProtectData(
                &input,
                ptr::null(),
                &entropy,
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };
        if ok == 0 {
            return Err(SealError::Failed(format!(
                "Windows could not seal the value: {}",
                std::io::Error::last_os_error()
            )));
        }
        // SAFETY: the call succeeded, so DPAPI filled `out`.
        Ok(unsafe { take(out) })
    }

    fn unseal(&self, sealed: &[u8]) -> Result<Vec<u8>, SealError> {
        let input = blob(sealed)?;
        let entropy = blob(ENTROPY)?;
        let mut out = CRYPT_INTEGER_BLOB::default();
        // SAFETY: as in `seal`; no description is asked for.
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                &entropy,
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };
        if ok == 0 {
            return Err(SealError::Failed(
                "the value was not sealed by this user on this computer".into(),
            ));
        }
        // SAFETY: the call succeeded, so DPAPI filled `out`.
        Ok(unsafe { take(out) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dpapi_seals_for_this_user_and_unseals_what_it_sealed() {
        let native = Native::new();
        assert!(native.available());
        let plain = "ghp_secret value with spaces and ünïcode".as_bytes();
        let sealed = native.seal(plain).unwrap();
        assert!(
            !sealed.windows(plain.len()).any(|window| window == plain),
            "the sealed bytes hold the value in the clear"
        );
        assert_eq!(native.unseal(&sealed).unwrap(), plain);
        assert_ne!(native.seal(plain).unwrap(), sealed, "every seal is new");
    }

    #[test]
    fn dpapi_refuses_bytes_it_did_not_seal() {
        let native = Native::new();
        assert!(matches!(
            native.unseal(b"not a dpapi blob"),
            Err(SealError::Failed(_))
        ));
        let mut sealed = native.seal(b"value").unwrap();
        let last = sealed.len() - 1;
        sealed[last] ^= 0xff;
        assert!(native.unseal(&sealed).is_err());
    }
}
