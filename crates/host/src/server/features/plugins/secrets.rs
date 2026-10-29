//! Plugin secrets: `secrets:list`, `save` and `remove`, and
//! `secrets:changed`, over the [`SecretStore`].
//!
//! `secrets:changed` carries the whole list, with no values: a subscription
//! starts with it, and every save and every removal that took something
//! sends it again to every subscriber, before the client that asked is
//! answered with the same list. A change also tells each plugin that
//! declares secrets where its keys stand, and sends the plugin list again,
//! since it shows them.

use std::sync::Arc;

use floti_protocol::channel::Router;
use floti_protocol::channels::plugins::{SecretsChanged, SecretsList, SecretsRemove, SecretsSave};

use crate::plugins::Registry;
use crate::plugins::secrets::{SecretStore, seal};
use crate::server::features::FeatureContext;

pub(super) struct Secrets {
    store: Arc<SecretStore>,
}

impl Secrets {
    /// The store over the host's `floti.db`, sealing with this OS's store
    /// for the user, with `secrets:changed` served from it.
    pub fn new(context: &FeatureContext) -> crate::Result<Self> {
        let events = Arc::clone(&context.events);
        let store = Arc::new(SecretStore::new(
            context.hosted.ledger().shared_store(),
            seal::for_data_folder(&context.workspace.folders.data),
            Box::new(move |state| {
                // A list nobody could be sent is not a reason to fail the
                // change that made it: the next one carries it.
                let _ = events.set_state::<SecretsChanged, _>(state);
            }),
        ));
        let state = store
            .snapshot()
            .map_err(|why| crate::Error::io("read the secrets", std::io::Error::other(why)))?;
        context.events.serve_state::<SecretsChanged, _>(&state)?;
        Ok(Self { store })
    }

    pub fn store(&self) -> Arc<SecretStore> {
        Arc::clone(&self.store)
    }

    pub fn requests<'a>(&'a self, registry: &'a Registry, router: &mut Router<'a>) {
        let store = &self.store;
        router
            .handle::<SecretsList>(|()| store.snapshot())
            .handle::<SecretsSave>(|input| {
                let state = store.save(&input)?;
                registry.secrets_changed();
                Ok(state)
            })
            .handle::<SecretsRemove>(|request| {
                let (state, removed) = store.remove(&request.key)?;
                if removed {
                    registry.secrets_changed();
                }
                Ok(state)
            });
    }
}
