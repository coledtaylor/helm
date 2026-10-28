//! The Files view: `files:dir`, `files:status`, `files:read`, `files:list`,
//! `files:watch` and `files:changed`.
//!
//! Every request names a root the host knows, and a root it does not is
//! refused with a sentence naming it before anything under it is listed or
//! read. `files:watch` replaces the calling client's whole set of watched
//! roots each time, skipping any the host does not know. `files:changed` is
//! served one client at a time: a change under a watched root goes only to
//! the client watching it, and a client whose connection ends leaves no
//! watch behind.
//!
//! git runs as a program for status, changed lines and listings, off the
//! runtime's workers, so other clients are never kept waiting on it.

use std::sync::Arc;

use floti_protocol::channel::Router;
use floti_protocol::channels::workspace::{
    FilesChanged, ListFiles, ReadFile, ReadFilesDir, ReadFilesStatus, WatchFiles,
};

use super::config::off_the_workers;
use super::{Feature, FeatureContext};
use crate::session::ClientId;
use crate::workspace::files::FilesService;

pub(crate) struct Files {
    service: FilesService,
}

impl Files {
    pub fn new(context: &FeatureContext) -> crate::Result<Self> {
        context.events.serve_per_client::<FilesChanged>();
        let events = Arc::clone(&context.events);
        let service = FilesService::new(
            Arc::clone(&context.workspace.roots),
            move |client, change| {
                if let Err(err) = events.emit_to::<FilesChanged>(client, change) {
                    eprintln!("floti host: {err}");
                }
            },
        );
        Ok(Self { service })
    }
}

impl Feature for Files {
    fn requests<'a>(&'a self, client: ClientId, router: &mut Router<'a>) {
        let service = &self.service;
        router
            .handle::<ReadFilesDir>(|request| {
                off_the_workers(|| service.dir(&request.root, &request.rel_path))
            })
            .handle::<ReadFilesStatus>(|request| off_the_workers(|| service.status(&request.root)))
            .handle::<ReadFile>(|request| {
                off_the_workers(|| service.read(&request.root, &request.path))
            })
            .handle::<ListFiles>(|request| off_the_workers(|| service.list(&request.root)))
            .handle::<WatchFiles>(move |request| {
                service.watch(client, &request.roots);
                Ok(())
            });
    }

    fn client_left(&self, client: ClientId) {
        self.service.forget(client);
    }
}
