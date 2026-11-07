//! Standing notices: `notices:changed`, `notices:dismiss` and
//! `notices:allowMore`.
//!
//! The host keeps the notices (`hosted/children/notices.rs`); this feature
//! sends the whole list to every subscriber when it starts and again on every
//! change, so every client lists the same notices whichever device it is on,
//! and dismissing or allowing more from one is seen by all. Nothing here needs
//! a client: the notices stand whether anyone is attached.

use std::sync::Arc;

use floti_protocol::channel::Router;
use floti_protocol::channels::sessions::{
    AllowMoreStarts, AllowMoreStartsResult, DismissNotice, NoticesChanged,
};

use super::{Caller, Feature, FeatureContext};
use crate::server::events::Events;
use crate::server::hosted::Hosted;

pub(crate) struct Notices {
    hosted: Arc<Hosted>,
}

impl Notices {
    /// Serves the channel and starts the task that sends the list as it
    /// changes. Call it from inside a Tokio runtime.
    pub fn new(context: &FeatureContext) -> crate::Result<Self> {
        let hosted = Arc::clone(&context.hosted);
        // Listening starts before the first list is read, so no change in
        // between is missed.
        let mut changes = hosted.notices_changes();
        let first = hosted.standing_notices().map_err(crate::Error::Refused)?;
        context.events.serve_state::<NoticesChanged, _>(&first)?;
        let events = Arc::clone(&context.events);
        let watching = Arc::downgrade(&hosted);
        tokio::spawn(async move {
            while changes.changed().await.is_ok() {
                let Some(hosted) = watching.upgrade() else {
                    return;
                };
                let listed = tokio::task::spawn_blocking(move || hosted.standing_notices()).await;
                send(&events, listed);
            }
        });
        Ok(Self { hosted })
    }
}

/// Sends the list a read gave, or says why it could not be read.
fn send(
    events: &Events,
    listed: Result<
        Result<Vec<floti_protocol::channels::sessions::StandingNotice>, String>,
        tokio::task::JoinError,
    >,
) {
    match listed {
        Ok(Ok(list)) => {
            if let Err(err) = events.set_state::<NoticesChanged, _>(&list) {
                log_line!("floti host: {err}");
            }
        }
        Ok(Err(why)) => log_line!("floti host: {why}"),
        Err(err) => log_line!("floti host: reading the notices failed: {err}"),
    }
}

impl Feature for Notices {
    fn requests<'a>(&'a self, _caller: Caller, router: &mut Router<'a>) {
        router
            .handle::<DismissNotice>(|request| self.hosted.dismiss_notice(&request.id))
            .handle::<AllowMoreStarts>(|request| {
                self.hosted
                    .allow_more_starts(request.parent_id)
                    .map(|added| AllowMoreStartsResult { added })
            });
    }
}
