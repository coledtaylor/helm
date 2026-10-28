//! `content:*`, `config:render` and `editor:highlight` as a client's requests
//! reach them: through the router of a host's features, over a store of
//! their own and a project the discovery cache holds.

use std::path::Path;
use std::sync::{Arc, Mutex};

use floti_protocol::channel::{RequestChannel, Router, from_payload, to_payload};
use floti_protocol::channels::workspace::{
    ConfigScopeKind, ConfigWriteReason, ContentFileKind, ContentRenderRequest,
    ContentSearchRequest, HighlightSource, ListContentScopes, ListContentSnapshots, OpenArtifact,
    Project, ProjectKind, ReadContentDocument, RenderConfigFile, RenderContent, ResolveWikilink,
    RestoreContentSnapshot, RestoreSnapshotRequest, ScopedFile, SearchContent, SourceToRender,
    WikilinkRequest, WriteConfigRequest, WriteContent,
};
use floti_protocol::message::Request;
use floti_protocol::{Capability, CapabilitySet, Message};

use super::super::Features;
use crate::agent::AgentBackend;
use crate::config_console::{hash_content, normalize};
use crate::server::hosted::Hosted;
use crate::server::{CATALOGUE, HostRun};
use crate::session::ClientId;
use crate::store::Store;
use crate::store::projects::{EMPTY_INVENTORY, cache_projects};
use crate::testkit::{FakeAgent, TestDirs};

struct World {
    features: Features,
    store: Arc<Mutex<Store>>,
    /// Last: fields drop in order, and the folder goes only once nothing in it is open.
    dirs: TestDirs,
}

impl World {
    fn new() -> Self {
        let dirs = TestDirs::new();
        let backends: Vec<Arc<dyn AgentBackend>> = vec![Arc::new(
            FakeAgent::new("fake agent", &dirs).backend(Vec::<String>::new()),
        )];
        let store = Arc::new(Mutex::new(Store::open(&dirs.data).unwrap()));
        let hosted = Arc::new(
            Hosted::new(
                Arc::clone(&store),
                dirs.data.clone(),
                backends,
                Vec::new(),
                Vec::new(),
            )
            .unwrap(),
        );
        let features = Features::new(
            hosted,
            dirs.folders(),
            HostRun {
                mode: floti_protocol::channels::workspace::AppMode::Dev,
                home: Some(dirs.home.clone()),
            },
        )
        .unwrap();
        Self {
            features,
            store,
            dirs,
        }
    }

    /// A project discovery found, with a note and an artifact in it.
    fn project(&self, name: &str) -> String {
        let path = self.dirs.folder(name);
        std::fs::create_dir_all(path.join("notes")).unwrap();
        std::fs::write(
            path.join("notes").join("first.md"),
            "# First\n\nSee [[second]].\n",
        )
        .unwrap();
        std::fs::write(path.join("notes").join("second.md"), "# Second\n").unwrap();
        std::fs::write(
            path.join("notes").join("lesson.html"),
            "<html><body>[[second]]</body></html>",
        )
        .unwrap();
        let project = Project {
            path: path.display().to_string(),
            name: name.to_owned(),
            kind: ProjectKind::Folder,
            harness_path: None,
            has_claude_dir: false,
            inventory: EMPTY_INVENTORY,
            git: None,
        };
        let mut store = self.store.lock().unwrap();
        cache_projects(
            store.connection_mut(),
            &[project],
            &[],
            "2026-10-28T00:00:00Z",
        )
        .unwrap();
        normalize(&path).display().to_string()
    }

    fn ask<C: RequestChannel>(&self, request: &C::Request) -> Result<C::Response, String> {
        let mut router = Router::new(&CATALOGUE, CapabilitySet::from_names(["files"]));
        self.features.requests(ClientId(1), &mut router);
        let answer = router.dispatch(&Request {
            id: 7,
            channel: C::NAME.to_owned(),
            payload: to_payload(request).unwrap(),
        });
        match answer {
            Message::Response(response) => Ok(from_payload(&response.payload).unwrap()),
            Message::Error(error) => Err(error.message),
            other => panic!("`{}` answered {other:?}", C::NAME),
        }
    }
}

fn file(scope: &str, path: &Path) -> ScopedFile {
    ScopedFile {
        scope_path: scope.to_owned(),
        path: path.display().to_string(),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn every_content_channel_is_served_from_the_content_feature() {
    let world = World::new();
    let mut router = Router::new(&CATALOGUE, CapabilitySet::from_names(["files"]));
    world.features.requests(ClientId(1), &mut router);
    let handled: Vec<&str> = router.handled().collect();
    for channel in [
        "content:scopes",
        "content:document",
        "content:render",
        "content:search",
        "content:write",
        "content:snapshots",
        "content:restore",
        "content:artifact",
        "content:artifactBytes",
        "content:wikilink",
        "config:render",
        "editor:highlight",
    ] {
        assert!(handled.contains(&channel), "{channel} is not served");
    }
    assert!(Capability::ALL.contains(&Capability::Files));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_scope_that_is_neither_a_content_scope_nor_a_known_root_is_refused() {
    let world = World::new();
    let known = world.project("alpha");
    let stranger = world.dirs.folder("stranger");
    std::fs::write(stranger.join("note.md"), "# Private\n").unwrap();
    let stranger_scope = stranger.display().to_string();
    let refusal =
        format!("{stranger_scope} is not a folder Floti knows, so it will not list or read it.");

    let note = stranger.join("note.md");
    assert_eq!(
        world.ask::<ReadContentDocument>(&file(&stranger_scope, &note)),
        Err(refusal.clone())
    );
    assert_eq!(
        world.ask::<SearchContent>(&ContentSearchRequest {
            scope_path: stranger_scope.clone(),
            query: "private".to_owned(),
        }),
        Err(refusal.clone())
    );
    assert_eq!(
        world.ask::<WriteContent>(&WriteConfigRequest {
            scope_path: stranger_scope.clone(),
            path: note.display().to_string(),
            content: "overwritten".to_owned(),
            expected_hash: Some(hash_content("# Private\n")),
            reason: ConfigWriteReason::Edit,
        }),
        Err(refusal.clone())
    );
    assert_eq!(std::fs::read_to_string(&note).unwrap(), "# Private\n");
    assert_eq!(
        world.ask::<OpenArtifact>(&file(&stranger_scope, &note)),
        Err(refusal.clone())
    );
    assert_eq!(
        world.ask::<ListContentSnapshots>(&file(&stranger_scope, &note)),
        Err(refusal)
    );

    // A known scope does not lend its standing to a path outside it.
    let outside = world
        .ask::<ReadContentDocument>(&file(&known, &note))
        .unwrap_err();
    assert!(outside.contains("is not inside"), "{outside}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_known_scope_reads_renders_searches_writes_and_restores_through_the_router() {
    let world = World::new();
    let scope = world.project("alpha");
    let notes = Path::new(&scope).join("notes");

    let scopes = world.ask::<ListContentScopes>(&()).unwrap();
    assert_eq!(scopes.len(), 1);
    assert_eq!(scopes[0].kind, ConfigScopeKind::Project);
    assert_eq!(scopes[0].label, "alpha");

    let first = notes.join("first.md");
    let document = world
        .ask::<ReadContentDocument>(&file(&scope, &first))
        .unwrap();
    assert_eq!(document.file.kind, ContentFileKind::Markdown);
    let rendered = document.rendered.unwrap();
    assert_eq!(rendered.links.len(), 1);
    assert_eq!(
        rendered.links[0].resolved.as_deref().map(str::to_lowercase),
        Some(notes.join("second.md").display().to_string().to_lowercase())
    );

    let draft = world
        .ask::<RenderContent>(&ContentRenderRequest {
            scope_path: scope.clone(),
            path: first.display().to_string(),
            source: "# Draft\n\n[[nowhere]]\n".to_owned(),
        })
        .unwrap();
    assert_eq!(draft.counts.broken_wikilinks, 1);

    let found = world
        .ask::<SearchContent>(&ContentSearchRequest {
            scope_path: scope.clone(),
            query: "see".to_owned(),
        })
        .unwrap();
    assert!(found.cold);
    assert_eq!(found.hits.len(), 1);

    let saved = world
        .ask::<WriteContent>(&WriteConfigRequest {
            scope_path: scope.clone(),
            path: first.display().to_string(),
            content: "# First, edited\n".to_owned(),
            expected_hash: Some(document.content.hash.clone()),
            reason: ConfigWriteReason::Edit,
        })
        .unwrap();
    assert!(saved.ok);
    let versions = world
        .ask::<ListContentSnapshots>(&file(&scope, &first))
        .unwrap();
    assert_eq!(versions.len(), 1);
    let restored = world
        .ask::<RestoreContentSnapshot>(&RestoreSnapshotRequest {
            id: versions[0].id,
            path: first.display().to_string(),
        })
        .unwrap();
    assert!(restored.ok);
    assert_eq!(
        std::fs::read_to_string(&first).unwrap(),
        "# First\n\nSee [[second]].\n"
    );

    let lesson = notes.join("lesson.html");
    let link = world.ask::<OpenArtifact>(&file(&scope, &lesson)).unwrap();
    assert!(link.url.starts_with("floti-artifact://"));
    let target = world
        .ask::<ResolveWikilink>(&WikilinkRequest {
            scope_path: scope.clone(),
            target: "second".to_owned(),
            from: lesson.display().to_string(),
        })
        .unwrap();
    assert!(target.path.is_some());

    let config = world
        .ask::<RenderConfigFile>(&SourceToRender {
            path: "settings.json".to_owned(),
            source: "{ \"a\": 1 }\n".to_owned(),
        })
        .unwrap();
    assert!(config.markdown.is_none());
    assert!(config.code.unwrap().highlighted);
    let highlight = world
        .ask::<HighlightSource>(&SourceToRender {
            path: "tool.py".to_owned(),
            source: "print(1)\n".to_owned(),
        })
        .unwrap();
    assert!(highlight.highlighted);
    assert!(!highlight.too_large);
}
