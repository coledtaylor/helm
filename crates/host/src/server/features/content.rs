//! Notes and documents: `content:*`, `config:render` and
//! `editor:highlight`.

use floti_protocol::channel::Router;

use super::{Feature, FeatureContext};
use crate::session::ClientId;

pub(crate) struct Content;

impl Content {
    pub fn new(_context: &FeatureContext) -> crate::Result<Self> {
        Ok(Self)
    }
}

impl Feature for Content {
    fn requests<'a>(&'a self, _client: ClientId, _router: &mut Router<'a>) {}
}
