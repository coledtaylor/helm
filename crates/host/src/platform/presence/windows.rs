//! Windows Hello, through `UserConsentVerifier`: over the window that asked
//! when its handle is given (`IUserConsentVerifierInterop`), so the prompt is
//! that window's, and on its own otherwise. It accepts the user's face,
//! fingerprint or PIN; Windows decides which.

use windows::Security::Credentials::UI::{
    UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::WinRT::IUserConsentVerifierInterop;
use windows::core::{HSTRING, factory};
use windows_future::IAsyncOperation;

use super::{Presence, PresenceCheck};

/// The Windows implementation.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl PresenceCheck for Native {
    fn confirm(&self, window: Option<isize>, reason: &str) -> Presence {
        verify(window, reason).unwrap_or_else(|err| {
            Presence::Unavailable(format!(
                "Windows Hello could not be asked ({})",
                err.message()
            ))
        })
    }
}

fn verify(window: Option<isize>, reason: &str) -> windows::core::Result<Presence> {
    let availability = UserConsentVerifier::CheckAvailabilityAsync()?.join()?;
    if availability != UserConsentVerifierAvailability::Available {
        return Ok(Presence::Unavailable(unavailable(availability).to_owned()));
    }
    let message = HSTRING::from(reason);
    let result = match window {
        Some(handle) => {
            let interop = factory::<UserConsentVerifier, IUserConsentVerifierInterop>()?;
            // SAFETY: the handle names a window of the process that asked,
            // which outlives this call; Windows only parents its prompt on it.
            let asked: IAsyncOperation<UserConsentVerificationResult> =
                unsafe { interop.RequestVerificationForWindowAsync(HWND(handle as _), &message)? };
            asked.join()?
        }
        None => UserConsentVerifier::RequestVerificationAsync(&message)?.join()?,
    };
    Ok(match result {
        UserConsentVerificationResult::Verified => Presence::Confirmed,
        UserConsentVerificationResult::Canceled
        | UserConsentVerificationResult::RetriesExhausted => Presence::Declined,
        UserConsentVerificationResult::DeviceNotPresent => {
            Presence::Unavailable("Windows Hello has no device to check with".to_owned())
        }
        UserConsentVerificationResult::NotConfiguredForUser => {
            Presence::Unavailable("Windows Hello is not set up for this user".to_owned())
        }
        UserConsentVerificationResult::DisabledByPolicy => {
            Presence::Unavailable("Windows Hello is turned off by policy".to_owned())
        }
        UserConsentVerificationResult::DeviceBusy => {
            Presence::Unavailable("Windows Hello is busy".to_owned())
        }
        _ => Presence::Unavailable("Windows Hello gave no answer Floti knows".to_owned()),
    })
}

fn unavailable(availability: UserConsentVerifierAvailability) -> &'static str {
    match availability {
        UserConsentVerifierAvailability::DeviceNotPresent => {
            "Windows Hello has no device to check with"
        }
        UserConsentVerifierAvailability::NotConfiguredForUser => {
            "Windows Hello is not set up for this user"
        }
        UserConsentVerifierAvailability::DisabledByPolicy => {
            "Windows Hello is turned off by policy"
        }
        UserConsentVerifierAvailability::DeviceBusy => "Windows Hello is busy",
        _ => "Windows Hello is not available",
    }
}
