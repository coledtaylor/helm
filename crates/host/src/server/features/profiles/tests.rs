//! `profile:*` and `profiles:changed` as a client's requests reach them:
//! through the router and the event channels of a host's features.

use std::sync::{Arc, Mutex};

use floti_protocol::channel::{RequestChannel, Router, from_payload, to_payload};
use floti_protocol::channels::common::PermissionMode;
use floti_protocol::channels::sessions::ImportProfileResult;
use floti_protocol::channels::sessions::{
    EffortLevel, PinProfilesRequest, Profile, ProfileDelete, ProfileDeleted, ProfileDocument,
    ProfileDraft, ProfileExport, ProfileImport, ProfileList, ProfilePin, ProfileRef, ProfileSave,
    SaveProfileRequest, SaveProfileResult,
};
use floti_protocol::channels::workspace::AppMode;
use floti_protocol::message::Request;
use floti_protocol::{CapabilitySet, Message};
use tokio::sync::broadcast;

use super::super::Features;
use crate::agent::AgentBackend;
use crate::server::events::{Publication, Start};
use crate::server::hosted::Hosted;
use crate::server::{CATALOGUE, HostRun};
use crate::session::ClientId;
use crate::store::Store;
use crate::testkit::{FakeAgent, TestDirs};

struct World {
    features: Features,
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
            Hosted::new(store, dirs.data.clone(), backends, Vec::new(), Vec::new()).unwrap(),
        );
        let features = Features::new(
            hosted,
            dirs.folders(),
            HostRun {
                mode: AppMode::Dev,
                home: Some(dirs.home.clone()),
            },
        )
        .unwrap();
        Self { features, dirs }
    }

    fn ask<C: RequestChannel>(&self, request: &C::Request) -> Result<C::Response, String> {
        let mut router = Router::new(&CATALOGUE, CapabilitySet::default());
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

    fn snapshot(&self) -> Vec<Profile> {
        match self.features.events().start("profiles:changed") {
            Some(Start::Snapshot { state, .. }) => from_payload(&state).unwrap(),
            other => panic!("profiles:changed starts with its state, not {other:?}"),
        }
    }

    fn listen(&self, client: u64) -> broadcast::Receiver<Publication> {
        self.features.events().listen(ClientId(client))
    }

    fn draft(&self, name: &str) -> ProfileDraft {
        let root = self.dirs.root().join("hub");
        ProfileDraft {
            name: name.into(),
            root: root.display().to_string(),
            overlays: vec![root.join("repos").join("tools").display().to_string()],
            access: Vec::new(),
            model: Some("sonnet".into()),
            effort: Some(EffortLevel::Medium),
            permission_mode: Some(PermissionMode::Plan),
            agent: None,
            mcp: Vec::new(),
            opening_prompt: Some("/recap".into()),
            pinned_order: None,
        }
    }

    fn save(&self, name: &str) -> SaveProfileResult {
        self.ask::<ProfileSave>(&SaveProfileRequest {
            id: None,
            draft: self.draft(name),
        })
        .unwrap()
    }
}

/// Every list published on `profiles:changed` since the last call, by name.
fn heard(listener: &mut broadcast::Receiver<Publication>) -> Vec<Vec<String>> {
    let mut out = Vec::new();
    while let Ok(publication) = listener.try_recv() {
        if publication.channel == "profiles:changed" {
            let listed: Vec<Profile> = from_payload(&publication.payload).unwrap();
            out.push(listed.into_iter().map(|profile| profile.name).collect());
        }
    }
    out
}

fn names(listed: &[Profile]) -> Vec<String> {
    listed.iter().map(|profile| profile.name.clone()).collect()
}

#[tokio::test]
async fn every_subscriber_to_profile_changes_gets_the_whole_list_after_each_change() {
    let world = World::new();
    assert_eq!(world.snapshot(), Vec::<Profile>::new());
    let mut first = world.listen(1);
    let mut second = world.listen(2);

    let alpha = world.save("Alpha").profile.unwrap();
    let beta = world.save("Beta").profile.unwrap();
    let pinned = world
        .ask::<ProfilePin>(&PinProfilesRequest {
            ids: vec![beta.id, alpha.id],
        })
        .unwrap();
    assert_eq!(names(&pinned), ["Beta", "Alpha"]);
    let deleted: ProfileDeleted = world
        .ask::<ProfileDelete>(&ProfileRef { id: alpha.id })
        .unwrap();
    assert!(deleted.deleted);

    let expected = vec![
        vec!["Alpha".to_owned()],
        vec!["Alpha".to_owned(), "Beta".to_owned()],
        vec!["Beta".to_owned(), "Alpha".to_owned()],
        vec!["Beta".to_owned()],
    ];
    assert_eq!(heard(&mut first), expected);
    assert_eq!(heard(&mut second), expected);
    assert_eq!(names(&world.snapshot()), ["Beta"]);
    assert_eq!(names(&world.ask::<ProfileList>(&()).unwrap()), ["Beta"]);
}

#[tokio::test]
async fn a_refused_save_or_a_delete_of_nothing_changes_nothing_and_tells_nobody() {
    let world = World::new();
    world.save("hub dev");
    let mut listener = world.listen(1);

    let clash = world.save("HUB DEV");
    assert_eq!(clash.profile, None);
    assert_eq!(
        clash.problems,
        ["A profile named \u{201c}hub dev\u{201d} already exists."]
    );
    let invalid = world.save("  ");
    assert_eq!(invalid.problems, ["A profile needs a name."]);
    let deleted: ProfileDeleted = world.ask::<ProfileDelete>(&ProfileRef { id: 99 }).unwrap();
    assert!(!deleted.deleted);

    assert_eq!(heard(&mut listener), Vec::<Vec<String>>::new());
    assert_eq!(names(&world.snapshot()), ["hub dev"]);
}

#[tokio::test]
async fn an_export_is_the_profiles_yaml_document_and_an_import_is_validated_before_it_is_saved() {
    let world = World::new();
    let saved = world.save("Acme cloud sync").profile.unwrap();
    let document: ProfileDocument = world
        .ask::<ProfileExport>(&ProfileRef { id: saved.id })
        .unwrap();
    assert_eq!(document.file_name, "acme-cloud-sync.floti-profile.yaml");
    assert!(
        document.yaml.contains("name: Acme cloud sync"),
        "{}",
        document.yaml
    );
    assert!(document.yaml.contains("- repos/tools"), "{}", document.yaml);
    assert!(
        document.yaml.contains("permission_mode: plan"),
        "{}",
        document.yaml
    );

    let mut listener = world.listen(1);
    let refused: ImportProfileResult = world
        .ask::<ProfileImport>(&ProfileDocument {
            file_name: "list.yaml".into(),
            yaml: "- a\n- b\n".into(),
        })
        .unwrap();
    assert_eq!(refused.profile, None);
    assert_eq!(
        refused.error.as_deref(),
        Some("list.yaml: A profile file must be a YAML mapping.")
    );
    assert_eq!(heard(&mut listener), Vec::<Vec<String>>::new());

    let imported: ImportProfileResult = world.ask::<ProfileImport>(&document).unwrap();
    let profile = imported.profile.unwrap();
    assert_eq!(imported.renamed_to.as_deref(), Some("Acme cloud sync (2)"));
    assert_eq!(profile.overlays, saved.overlays);
    assert_eq!(profile.root, saved.root);
    assert_eq!(
        heard(&mut listener),
        [vec![
            "Acme cloud sync".to_owned(),
            "Acme cloud sync (2)".to_owned()
        ]]
    );

    assert_eq!(
        world.ask::<ProfileExport>(&ProfileRef { id: 404 }),
        Err("That profile no longer exists.".to_owned())
    );
}
