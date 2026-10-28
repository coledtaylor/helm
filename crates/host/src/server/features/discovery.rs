//! Project discovery: `discovery:*`, `scan:status`, `git:updated`, `roots:*`
//! and `harness:create`.

use floti_protocol::channel::Router;

use super::{Feature, FeatureContext};
use crate::session::ClientId;

pub(crate) struct Discovery;

impl Discovery {
    pub fn new(_context: &FeatureContext) -> crate::Result<Self> {
        Ok(Self)
    }
}

impl Feature for Discovery {
    fn requests<'a>(&'a self, _client: ClientId, _router: &mut Router<'a>) {}
}
