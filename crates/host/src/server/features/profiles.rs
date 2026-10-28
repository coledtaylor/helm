//! Saved profiles: `profile:*` but `profile:launch`, which the sessions
//! feature serves, and `profiles:changed`.

use floti_protocol::channel::Router;

use super::{Feature, FeatureContext};
use crate::session::ClientId;

pub(crate) struct Profiles;

impl Profiles {
    pub fn new(_context: &FeatureContext) -> crate::Result<Self> {
        Ok(Self)
    }
}

impl Feature for Profiles {
    fn requests<'a>(&'a self, _client: ClientId, _router: &mut Router<'a>) {}
}
