//! Harness templates: `template:*`.

use floti_protocol::channel::Router;

use super::{Feature, FeatureContext};
use crate::session::ClientId;

pub(crate) struct Templates;

impl Templates {
    pub fn new(_context: &FeatureContext) -> crate::Result<Self> {
        Ok(Self)
    }
}

impl Feature for Templates {
    fn requests<'a>(&'a self, _client: ClientId, _router: &mut Router<'a>) {}
}
