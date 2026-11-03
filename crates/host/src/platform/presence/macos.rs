//! Touch ID or the account password, through LocalAuthentication's
//! device-owner policy: macOS offers Touch ID where the Mac has it and the
//! password otherwise.

use std::sync::mpsc;

use block2::RcBlock;
use objc2::runtime::Bool;
use objc2_foundation::{NSError, NSInteger, NSString};
use objc2_local_authentication::{LAContext, LAPolicy};

use super::{Presence, PresenceCheck};

/// The `LAError` codes of a check the user cancelled or did not pass:
/// authentication failed, user cancel, user fallback, system cancel and app
/// cancel. Any other code says the Mac could not check.
const DECLINED: [NSInteger; 5] = [-1, -2, -3, -4, -9];

/// The macOS implementation.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl PresenceCheck for Native {
    // Whether each generated binding is `unsafe` differs between versions of
    // the bindings; every call here is sound either way.
    #[allow(unused_unsafe)]
    fn confirm(&self, _window: Option<isize>, reason: &str) -> Presence {
        let policy = LAPolicy::DeviceOwnerAuthentication;
        // SAFETY: a new context, used on this thread only until its reply.
        let context = unsafe { LAContext::new() };
        if let Err(err) = unsafe { context.canEvaluatePolicy_error(policy) } {
            return Presence::Unavailable(format!(
                "this Mac cannot confirm its user ({})",
                err.localizedDescription()
            ));
        }
        let (tx, rx) = mpsc::channel::<Result<(), Option<NSInteger>>>();
        let reply = RcBlock::new(move |confirmed: Bool, error: *mut NSError| {
            let answer = if confirmed.as_bool() {
                Ok(())
            } else if error.is_null() {
                Err(None)
            } else {
                // SAFETY: LocalAuthentication passes a valid error with a
                // reply that is not a success.
                Err(Some(unsafe { (*error).code() }))
            };
            let _ = tx.send(answer);
        });
        let reason = NSString::from_str(reason);
        // SAFETY: the reply is called once, on a queue of the framework's.
        unsafe { context.evaluatePolicy_localizedReason_reply(policy, &reason, &reply) };
        match rx.recv() {
            Ok(Ok(())) => Presence::Confirmed,
            Ok(Err(Some(code))) if !DECLINED.contains(&code) => Presence::Unavailable(format!(
                "this Mac could not confirm its user (LocalAuthentication error {code})"
            )),
            Ok(Err(_)) => Presence::Declined,
            Err(_) => Presence::Unavailable("LocalAuthentication gave no answer".to_owned()),
        }
    }
}
