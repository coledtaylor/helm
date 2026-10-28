//! The Files view: `files:*` and `files:changed`.

use floti_protocol::channel::Router;

use super::{Feature, FeatureContext};
use crate::session::ClientId;

pub(crate) struct Files;

impl Files {
    pub fn new(_context: &FeatureContext) -> crate::Result<Self> {
        Ok(Self)
    }
}

impl Feature for Files {
    fn requests<'a>(&'a self, _client: ClientId, _router: &mut Router<'a>) {}
}
