//! A client's own data, carried into the host once: `carry:status`,
//! `carry:missing`, `carry:names`, `carry:versions`, `carry:usage`,
//! `carry:conversations` and `carry:finish`.
//!
//! Each batch is merged ([`crate::carry`]) in one transaction over the shared
//! store, held only for that batch, so History, the session list and every
//! other request are answered between batches. A batch that changed what
//! History, the archive or usage read tells their subscribers. The host's
//! log says how many rows each batch merged, never what they hold.

use std::sync::{Arc, MutexGuard};

use floti_protocol::channel::Router;
use floti_protocol::channels::carry::{
    CarryConversations, CarryFinish, CarryMerged, CarryMissing, CarryNames, CarrySessionIds,
    CarryStatusRead, CarryUsage, CarryVersions,
};

use super::history::HistoryHandle;
use super::{Caller, Feature, FeatureContext};
use crate::carry;
use crate::history::archive;
use crate::server::hosted::Hosted;
use crate::store::Store;

pub(crate) struct Carry {
    hosted: Arc<Hosted>,
    history: HistoryHandle,
}

impl Carry {
    pub fn new(context: &FeatureContext, history: HistoryHandle) -> Self {
        Self {
            hosted: Arc::clone(&context.hosted),
            history,
        }
    }

    fn store(&self) -> MutexGuard<'_, Store> {
        self.hosted.ledger().store()
    }

    /// Tells History's and the archive's subscribers what a batch changed.
    fn stored_changed(&self, names: bool) {
        if let Err(err) = self.history.stored_changed(names) {
            log_line!("floti host: {err}");
        }
    }
}

fn said(merged: CarryMerged, what: &str) {
    log_line!(
        "floti host: copied {} {what} from Helm, kept {} already here",
        merged.added,
        merged.kept
    );
}

impl Feature for Carry {
    fn requests<'a>(&'a self, _caller: Caller, router: &mut Router<'a>) {
        router
            .handle::<CarryStatusRead>(|()| {
                carry::status(self.store().connection()).map_err(|err| err.to_string())
            })
            .handle::<CarryMissing>(|request| {
                carry::missing(self.store().connection(), &request.session_ids)
                    .map(|session_ids| CarrySessionIds { session_ids })
                    .map_err(|err| err.to_string())
            })
            .handle::<CarryNames>(|request| {
                let merged = carry::merge_names(self.store().connection(), &request.names)
                    .map_err(|err| err.to_string())?;
                said(merged, "session names");
                if merged.added > 0 {
                    self.stored_changed(true);
                }
                Ok(merged)
            })
            .handle::<CarryVersions>(|request| {
                let merged = carry::merge_versions(self.store().connection(), &request.versions)
                    .map_err(|err| err.to_string())?;
                said(merged, "config file versions");
                Ok(merged)
            })
            .handle::<CarryUsage>(|request| {
                let merged = carry::merge_usage(self.store().connection(), &request.rows)
                    .map_err(|err| err.to_string())?;
                said(merged, "usage rows");
                if merged.added > 0
                    && let Err(err) = self.history.usage_changed()
                {
                    log_line!("floti host: {err}");
                }
                Ok(merged)
            })
            .handle::<CarryConversations>(|request| {
                // Compressed before the store is taken.
                let parts = carry::encode(&request.parts);
                let merged = {
                    let store = self.store();
                    let conn = store.connection();
                    archive::ceiling(conn)
                        .and_then(|ceiling| carry::merge_conversations(conn, &parts, ceiling))
                        .map_err(|err| err.to_string())?
                };
                log_line!(
                    "floti host: copied {} archived conversations ({} messages) from Helm, kept {} parts already here, dropped {} to stay under the archive's limit",
                    merged.added, merged.messages, merged.kept, merged.evicted
                );
                if merged.added > 0 || merged.messages > 0 || merged.evicted > 0 {
                    self.stored_changed(false);
                }
                Ok(merged)
            })
            .handle::<CarryFinish>(|()| {
                let status =
                    carry::finish(self.store().connection()).map_err(|err| err.to_string())?;
                log_line!("floti host: copying Helm's data finished");
                Ok(status)
            });
    }
}
