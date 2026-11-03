//! Linux has no check of the user Floti can ask yet: presence is Unavailable,
//! and the user runs `floti devices` over ssh on the host instead.

use super::{Presence, PresenceCheck};

/// The Linux implementation.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl PresenceCheck for Native {
    fn confirm(&self, _window: Option<isize>, _reason: &str) -> Presence {
        Presence::Unavailable(
            "this computer has no check of its user that Floti can ask".to_owned(),
        )
    }
}
