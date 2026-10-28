//! Notes and documents: `content:*`, `config:render` and
//! `editor:highlight`.
//!
//! Every `content:*` request names a scope the host knows and a path inside
//! it ([`ContentService`]); rendering and highlighting read nothing from disk
//! but what the request names. Walking a scope, reading a corpus and
//! highlighting a file are disk and CPU work, so each runs off the workers.

#[cfg(test)]
mod tests;

use std::sync::Arc;

use floti_protocol::channel::Router;
use floti_protocol::channels::workspace::{
    HighlightSource, ListContentScopes, ListContentSnapshots, OpenArtifact, ReadContentDocument,
    RenderConfigFile, RenderContent, ResolveWikilink, RestoreContentSnapshot, SearchContent,
    WikilinkTarget, WriteContent,
};

use super::config::off_the_workers;
use super::{Feature, FeatureContext};
use crate::session::ClientId;
use crate::workspace::content::ContentService;
use crate::workspace::render::{editor_highlight, render_config};

pub(crate) struct Content {
    service: Arc<ContentService>,
}

impl Content {
    pub fn new(context: &FeatureContext) -> crate::Result<Self> {
        Ok(Self {
            service: Arc::new(ContentService::new(
                context.hosted.ledger().shared_store(),
                Arc::clone(&context.workspace.roots),
            )),
        })
    }
}

impl Feature for Content {
    fn requests<'a>(&'a self, _client: ClientId, router: &mut Router<'a>) {
        let content = &self.service;
        router
            .handle::<ListContentScopes>(|()| off_the_workers(|| content.scopes()))
            .handle::<ReadContentDocument>(|file| {
                off_the_workers(|| content.document(&file.scope_path, &file.path))
            })
            .handle::<RenderContent>(|draft| {
                off_the_workers(|| content.render(&draft.scope_path, &draft.path, &draft.source))
            })
            .handle::<SearchContent>(|search| {
                off_the_workers(|| content.search(&search.scope_path, &search.query))
            })
            .handle::<WriteContent>(|request| off_the_workers(|| content.write(&request)))
            .handle::<ListContentSnapshots>(|file| {
                off_the_workers(|| content.snapshots(&file.scope_path, &file.path))
            })
            .handle::<RestoreContentSnapshot>(|request| {
                off_the_workers(|| content.restore(request.id, &request.path))
            })
            .handle::<OpenArtifact>(|file| {
                off_the_workers(|| content.artifact(&file.scope_path, &file.path))
            })
            .handle::<ResolveWikilink>(|link| {
                off_the_workers(|| {
                    content
                        .wikilink(&link.scope_path, &link.target, &link.from)
                        .map(|path| WikilinkTarget { path })
                })
            })
            .handle::<RenderConfigFile>(|source| {
                Ok(off_the_workers(|| {
                    render_config(&source.path, &source.source)
                }))
            })
            .handle::<HighlightSource>(|source| {
                Ok(off_the_workers(|| {
                    editor_highlight(&source.path, &source.source)
                }))
            });
    }
}
