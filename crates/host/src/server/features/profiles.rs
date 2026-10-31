//! Saved profiles: `profile:*` but `profile:launch`, which the sessions
//! feature serves, and `profiles:changed`.
//!
//! `profiles:changed` carries the whole list: a subscription starts with it,
//! and every write that changed something (a save, a delete that removed a
//! profile, a pin, an import that added one), from whichever client, sends
//! it again to every subscriber. A refused write changes nothing and sends
//! nothing.
//!
//! The dialogs stay in the client: `profile:export` answers the document for
//! the client to save, `profile:import` is given the document its open
//! dialog read, and the client asks before it sends `profile:delete`.

use std::path::PathBuf;
use std::sync::Arc;

use floti_protocol::channel::Router;
use floti_protocol::channels::sessions::{
    ProfileDelete, ProfileDeleted, ProfileExport, ProfileImport, ProfileList, ProfilePin,
    ProfileSave, ProfilesChanged,
};

use super::{Caller, Feature, FeatureContext};
use crate::server::events::Events;
use crate::server::hosted::Hosted;
use crate::workspace::profiles::{self, store};

pub(crate) struct Profiles {
    hosted: Arc<Hosted>,
    events: Arc<Events>,
    home: Option<PathBuf>,
}

impl Profiles {
    pub fn new(context: &FeatureContext) -> crate::Result<Self> {
        let feature = Self {
            hosted: Arc::clone(&context.hosted),
            events: Arc::clone(&context.events),
            home: context.workspace.run.home.clone(),
        };
        let listed = store::list(feature.hosted.ledger().store().connection())?;
        feature.events.serve_state::<ProfilesChanged, _>(&listed)?;
        Ok(feature)
    }

    /// Sends every subscriber the whole list as it is now.
    fn changed(&self) -> Result<(), String> {
        let listed = store::list(self.hosted.ledger().store().connection()).map_err(text)?;
        self.events
            .set_state::<ProfilesChanged, _>(&listed)
            .map_err(text)
    }
}

impl Feature for Profiles {
    fn requests<'a>(&'a self, _caller: Caller, router: &mut Router<'a>) {
        router
            .handle::<ProfileList>(|()| {
                store::list(self.hosted.ledger().store().connection()).map_err(text)
            })
            .handle::<ProfileSave>(|request| {
                let saved = profiles::save(self.hosted.ledger().store().connection(), &request)
                    .map_err(text)?;
                if saved.profile.is_some() {
                    self.changed()?;
                }
                Ok(saved)
            })
            .handle::<ProfileDelete>(|profile| {
                let deleted = store::delete(self.hosted.ledger().store().connection(), profile.id)
                    .map_err(text)?;
                if deleted {
                    self.changed()?;
                }
                Ok(ProfileDeleted { deleted })
            })
            .handle::<ProfilePin>(|request| {
                store::set_pinned(self.hosted.ledger().store().connection_mut(), &request.ids)
                    .map_err(text)?;
                self.changed()?;
                store::list(self.hosted.ledger().store().connection()).map_err(text)
            })
            .handle::<ProfileExport>(|profile| {
                profiles::export(
                    self.hosted.ledger().store().connection(),
                    profile.id,
                    self.home.as_deref(),
                )
                .map_err(text)?
            })
            .handle::<ProfileImport>(|document| {
                let imported = profiles::import(
                    self.hosted.ledger().store().connection(),
                    &document,
                    self.home.as_deref(),
                )
                .map_err(text)?;
                if imported.profile.is_some() {
                    self.changed()?;
                }
                Ok(imported)
            });
    }
}

fn text(err: crate::Error) -> String {
    err.to_string()
}

#[cfg(test)]
mod tests;
