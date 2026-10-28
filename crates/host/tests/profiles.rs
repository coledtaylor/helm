//! Saved profiles, as today's `core/launch/profile.test.ts`,
//! `core/store/profiles.test.ts` and `desktop/main/profiles.test.ts` test
//! them, with the same inputs and expectations: the YAML document, the rows
//! in the host's own store, and what a save, export and import answer. The
//! profile channels and `profiles:changed` are tested as a client sees them
//! too: through a client connection to a running host, with the inputs and
//! expectations of the router's tests in `server/features/profiles.rs`. The
//! launch is `profile:launch`'s, in `tests/sessions.rs`.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Instant;

use floti_host::config_console::normalize;
use floti_host::platform::socket::Endpoint;
use floti_host::server::{HostConfig, HostRun, backends};
use floti_host::store::Store;
use floti_host::testkit::{PATIENCE, RunningHost, TestClient, TestDirs};
use floti_host::workspace::profiles::{
    self, profile_draft, profile_from_yaml, profile_to_yaml, store, validate_profile,
};
use floti_protocol::Message;
use floti_protocol::channel::{EventChannel, from_payload};
use floti_protocol::channels::common::PermissionMode;
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::sessions::{
    EffortLevel, ImportProfileResult, PinProfilesRequest, Profile, ProfileDelete, ProfileDeleted,
    ProfileDocument, ProfileDraft, ProfileExport, ProfileImport, ProfileList, ProfilePin,
    ProfileRef, ProfileSave, ProfilesChanged, SaveProfileRequest, SaveProfileResult,
};
use floti_protocol::channels::workspace::AppMode;

/// A store of its own in a test folder, and the home profiles are written
/// against.
struct World {
    store: Store,
    home: PathBuf,
    /// Last: fields drop in order, and the folder goes only once the store is closed.
    dirs: TestDirs,
}

impl World {
    fn new() -> Self {
        let dirs = TestDirs::new();
        Self {
            store: Store::open(&dirs.data).unwrap(),
            home: dirs.home.clone(),
            dirs,
        }
    }

    fn conn(&self) -> &rusqlite::Connection {
        self.store.connection()
    }

    fn harness(&self) -> PathBuf {
        self.home.join(".harness").join("dev")
    }
}

fn text(path: &Path) -> String {
    path.display().to_string()
}

/// The spec's example profile, rooted at `~/.harness/dev`.
fn sample(world: &World) -> ProfileDraft {
    let harness = world.harness();
    ProfileDraft {
        name: "Acme cloud sync".into(),
        root: text(&harness),
        overlays: vec![
            text(&harness.join("repos").join("acme")),
            text(&harness.join("repos").join("acme-reporting")),
        ],
        access: vec![
            text(&harness.join("repos").join("acme")),
            text(&harness.join("repos").join("other-repo")),
        ],
        model: Some("opus".into()),
        effort: Some(EffortLevel::High),
        permission_mode: Some(PermissionMode::Auto),
        agent: None,
        mcp: vec!["clickup".into()],
        opening_prompt: Some("/recap".into()),
        pinned_order: None,
    }
}

/// The store test's draft, rooted in the test folder rather than home.
fn draft(world: &World) -> ProfileDraft {
    let harness = world.dirs.root().join("harness");
    ProfileDraft {
        root: text(&harness),
        overlays: vec![text(&harness.join("repos").join("acme"))],
        access: vec![text(&harness.join("repos").join("other-repo"))],
        ..sample(world)
    }
}

fn named(world: &World, name: &str) -> ProfileDraft {
    ProfileDraft {
        name: name.into(),
        ..draft(world)
    }
}

// profileToYaml

#[test]
fn a_profile_document_writes_the_shape_the_spec_prints() {
    let world = World::new();
    let yaml = profile_to_yaml(&sample(&world), Some(&world.home));
    assert!(yaml.contains("name: Acme cloud sync"), "{yaml}");
    assert!(yaml.contains("permission_mode: auto"), "{yaml}");
    assert!(yaml.contains("opening_prompt: /recap"), "{yaml}");
    assert!(!yaml.contains("permissionMode"), "{yaml}");
}

#[test]
fn a_profile_document_writes_paths_under_the_root_relative_to_it_and_the_root_against_home() {
    let world = World::new();
    let yaml = profile_to_yaml(&sample(&world), Some(&world.home));
    assert!(yaml.contains("repos/acme"), "{yaml}");
    assert!(yaml.contains("~/.harness/dev"), "{yaml}");
    assert!(
        !yaml.contains(&text(&world.harness().join("repos").join("acme"))),
        "{yaml}"
    );
}

#[test]
fn a_profile_document_keeps_a_path_outside_the_root_addressable() {
    let world = World::new();
    let yaml = profile_to_yaml(
        &ProfileDraft {
            access: vec!["C:/elsewhere/repo".into()],
            ..sample(&world)
        },
        Some(&world.home),
    );
    assert!(yaml.contains("elsewhere"), "{yaml}");
}

#[test]
fn a_profile_document_lists_the_unset_keys_rather_than_dropping_them() {
    let world = World::new();
    let yaml = profile_to_yaml(
        &ProfileDraft {
            agent: None,
            model: None,
            ..sample(&world)
        },
        Some(&world.home),
    );
    assert!(yaml.contains("agent: null"), "{yaml}");
    assert!(yaml.contains("model: null"), "{yaml}");
}

// profileFromYaml

#[test]
fn a_profile_round_trips_through_its_document_intact() {
    let world = World::new();
    let home = Some(world.home.as_path());
    let profile = sample(&world);
    assert_eq!(
        profile_from_yaml(&profile_to_yaml(&profile, home), home).unwrap(),
        profile
    );
}

#[test]
fn a_profile_with_everything_unset_round_trips_too() {
    let world = World::new();
    let home = Some(world.home.as_path());
    let bare = ProfileDraft {
        name: "bare".into(),
        root: text(&world.harness()),
        overlays: Vec::new(),
        access: Vec::new(),
        model: None,
        effort: None,
        permission_mode: None,
        agent: None,
        mcp: Vec::new(),
        opening_prompt: None,
        pinned_order: None,
    };
    assert_eq!(
        profile_from_yaml(&profile_to_yaml(&bare, home), home).unwrap(),
        bare
    );
}

#[test]
fn a_profile_document_does_not_carry_the_pin_order_so_imports_arrive_unpinned() {
    let world = World::new();
    let home = Some(world.home.as_path());
    let yaml = profile_to_yaml(
        &ProfileDraft {
            pinned_order: Some(3),
            ..sample(&world)
        },
        home,
    );
    assert!(!yaml.contains("pinned"), "{yaml}");
    assert_eq!(profile_from_yaml(&yaml, home).unwrap().pinned_order, None);
}

#[test]
fn relative_paths_resolve_against_the_root_so_a_moved_harness_still_works() {
    let imported = profile_from_yaml(
        "name: moved\nroot: C:/somewhere/else\noverlays:\n  - repos/acme\n",
        None,
    )
    .unwrap();
    assert_eq!(
        imported.overlays,
        [text(&normalize(Path::new("C:/somewhere/else/repos/acme")))]
    );
}

#[test]
fn a_value_the_agent_would_reject_is_dropped_rather_than_refusing_the_file() {
    let world = World::new();
    let imported = profile_from_yaml(
        &format!(
            "name: odd\nroot: {}\neffort: medium-high\npermission_mode: whatever\n",
            text(&world.harness()).replace('\\', "/")
        ),
        None,
    )
    .unwrap();
    assert_eq!(imported.effort, None);
    assert_eq!(imported.permission_mode, None);
}

#[test]
fn a_document_that_is_not_a_profile_is_refused() {
    let root = "/harness";
    let refusal = |yaml: &str| profile_from_yaml(yaml, None).unwrap_err();
    assert!(refusal("- a\n- b").contains("mapping"));
    assert!(refusal(&format!("root: {root}")).contains("name"));
    assert!(refusal("name: x").contains("root"));
    assert!(refusal("name: [unclosed").contains("YAML"));
}

// validateProfile

#[test]
fn a_good_draft_validates() {
    let world = World::new();
    assert_eq!(validate_profile(&sample(&world)), Vec::<String>::new());
}

#[test]
fn validation_reports_every_problem_at_once() {
    let world = World::new();
    let problems = validate_profile(&ProfileDraft {
        name: "  ".into(),
        root: " ".into(),
        ..sample(&world)
    });
    assert_eq!(problems.len(), 2, "{problems:?}");
}

// profile CRUD

#[test]
fn a_profile_is_stored_and_read_back_with_every_field() {
    let world = World::new();
    let created = store::create(world.conn(), &draft(&world)).unwrap();
    assert!(created.id > 0);
    assert_eq!(profile_draft(&created), draft(&world));
    let read = store::read(world.conn(), created.id).unwrap().unwrap();
    assert_eq!(profile_draft(&read), draft(&world));
}

#[test]
fn a_profile_updates_in_place_and_stamps_updated_at() {
    let world = World::new();
    let created = store::create(world.conn(), &draft(&world)).unwrap();
    let updated = store::update(
        world.conn(),
        created.id,
        &ProfileDraft {
            model: Some("sonnet".into()),
            mcp: Vec::new(),
            ..draft(&world)
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(updated.model.as_deref(), Some("sonnet"));
    assert_eq!(updated.mcp, Vec::<String>::new());
    assert!(updated.updated_at >= created.updated_at);
    assert_eq!(store::list(world.conn()).unwrap().len(), 1);
}

#[test]
fn updating_a_profile_that_has_been_deleted_finds_none() {
    let world = World::new();
    assert_eq!(
        store::update(world.conn(), 999, &draft(&world)).unwrap(),
        None
    );
}

#[test]
fn a_delete_says_whether_there_was_anything_to_delete() {
    let world = World::new();
    let created = store::create(world.conn(), &draft(&world)).unwrap();
    assert!(store::delete(world.conn(), created.id).unwrap());
    assert!(!store::delete(world.conn(), created.id).unwrap());
    assert_eq!(store::read(world.conn(), created.id).unwrap(), None);
}

#[test]
fn the_store_rejects_a_duplicate_name_which_is_what_makes_import_ask_for_a_new_one() {
    let world = World::new();
    store::create(world.conn(), &draft(&world)).unwrap();
    assert!(store::create(world.conn(), &draft(&world)).is_err());
}

#[test]
fn a_profile_is_found_by_name_without_case_the_way_a_person_types_it() {
    let world = World::new();
    store::create(world.conn(), &draft(&world)).unwrap();
    assert_eq!(
        store::find_by_name(world.conn(), "acme cloud sync")
            .unwrap()
            .map(|profile| profile.name),
        Some("Acme cloud sync".to_owned())
    );
    assert_eq!(store::find_by_name(world.conn(), "nothing").unwrap(), None);
}

#[test]
fn an_import_of_something_already_here_is_given_a_free_name() {
    let world = World::new();
    store::create(world.conn(), &draft(&world)).unwrap();
    assert_eq!(
        store::unique_name(world.conn(), "Acme cloud sync").unwrap(),
        "Acme cloud sync (2)"
    );
    store::create(world.conn(), &named(&world, "Acme cloud sync (2)")).unwrap();
    assert_eq!(
        store::unique_name(world.conn(), "Acme cloud sync").unwrap(),
        "Acme cloud sync (3)"
    );
}

// ordering

#[test]
fn pinned_profiles_come_first_in_their_order_then_the_rest_by_name() {
    let mut world = World::new();
    let a = store::create(world.conn(), &named(&world, "Alpha")).unwrap();
    let b = store::create(world.conn(), &named(&world, "Beta")).unwrap();
    let c = store::create(world.conn(), &named(&world, "Gamma")).unwrap();

    store::set_pinned(world.store.connection_mut(), &[c.id, a.id]).unwrap();
    let names: Vec<String> = store::list(world.conn())
        .unwrap()
        .into_iter()
        .map(|profile| profile.name)
        .collect();
    assert_eq!(names, ["Gamma", "Alpha", "Beta"]);
    assert_eq!(
        store::read(world.conn(), b.id)
            .unwrap()
            .unwrap()
            .pinned_order,
        None
    );
}

#[test]
fn a_profile_left_out_of_the_pin_list_is_unpinned() {
    let mut world = World::new();
    let a = store::create(world.conn(), &named(&world, "Alpha")).unwrap();
    let b = store::create(world.conn(), &named(&world, "Beta")).unwrap();
    store::set_pinned(world.store.connection_mut(), &[a.id, b.id]).unwrap();
    store::set_pinned(world.store.connection_mut(), &[b.id]).unwrap();

    assert_eq!(
        store::read(world.conn(), a.id)
            .unwrap()
            .unwrap()
            .pinned_order,
        None
    );
    let names: Vec<String> = store::list(world.conn())
        .unwrap()
        .into_iter()
        .map(|profile| profile.name)
        .collect();
    assert_eq!(names, ["Beta", "Alpha"]);
}

// YAML round trip through the store

#[test]
fn export_then_delete_then_import_leaves_the_profile_intact() {
    let world = World::new();
    let home = Some(world.home.as_path());
    let created = store::create(world.conn(), &draft(&world)).unwrap();
    let document = profiles::export(world.conn(), created.id, home)
        .unwrap()
        .unwrap();
    assert_eq!(document.file_name, "acme-cloud-sync.floti-profile.yaml");
    assert_eq!(
        document.yaml,
        profile_to_yaml(&profile_draft(&created), home)
    );

    assert!(store::delete(world.conn(), created.id).unwrap());
    assert!(store::list(world.conn()).unwrap().is_empty());

    let imported = profiles::import(world.conn(), &document, home).unwrap();
    let profile = imported.profile.unwrap();
    assert_eq!(profile_draft(&profile), draft(&world));
    assert_ne!(profile.id, created.id);
    assert_eq!(imported.renamed_to, None);
}

// Through the main process's save, export and import

#[test]
fn a_saved_profile_is_listed_and_a_second_one_by_the_same_name_is_refused() {
    let world = World::new();
    let saved = profiles::save(
        world.conn(),
        &SaveProfileRequest {
            id: None,
            draft: named(&world, "  hub dev  "),
        },
    )
    .unwrap();
    assert_eq!(saved.problems, Vec::<String>::new());
    let listed = store::list(world.conn()).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(profile_draft(&listed[0]), named(&world, "hub dev"));
    assert_eq!(Some(listed[0].id), saved.profile.map(|profile| profile.id));

    let clash = profiles::save(
        world.conn(),
        &SaveProfileRequest {
            id: None,
            draft: named(&world, "HUB DEV"),
        },
    )
    .unwrap();
    assert_eq!(clash.profile, None);
    assert_eq!(
        clash.problems,
        ["A profile named \u{201c}hub dev\u{201d} already exists."]
    );
    assert_eq!(store::list(world.conn()).unwrap().len(), 1);
}

#[test]
fn a_draft_that_fails_validation_is_refused_with_its_problems_and_nothing_is_written() {
    let world = World::new();
    let refused = profiles::save(
        world.conn(),
        &SaveProfileRequest {
            id: None,
            draft: named(&world, " "),
        },
    )
    .unwrap();
    assert_eq!(refused.profile, None);
    assert_eq!(refused.problems, ["A profile needs a name."]);
    assert!(store::list(world.conn()).unwrap().is_empty());
}

#[test]
fn saving_over_a_profile_that_has_gone_says_so() {
    let world = World::new();
    let refused = profiles::save(
        world.conn(),
        &SaveProfileRequest {
            id: Some(42),
            draft: draft(&world),
        },
    )
    .unwrap();
    assert_eq!(refused.problems, ["That profile no longer exists."]);
}

#[test]
fn a_profile_keeps_its_own_name_when_it_is_saved_again() {
    let world = World::new();
    let created = store::create(world.conn(), &draft(&world)).unwrap();
    let saved = profiles::save(
        world.conn(),
        &SaveProfileRequest {
            id: Some(created.id),
            draft: ProfileDraft {
                model: Some("haiku".into()),
                ..draft(&world)
            },
        },
    )
    .unwrap();
    assert_eq!(saved.problems, Vec::<String>::new());
    assert_eq!(saved.profile.unwrap().model.as_deref(), Some("haiku"));
}

#[test]
fn an_import_of_a_name_already_taken_is_renamed_rather_than_refused_or_overwritten() {
    let world = World::new();
    let home = Some(world.home.as_path());
    let created = store::create(world.conn(), &draft(&world)).unwrap();
    let document = profiles::export(world.conn(), created.id, home)
        .unwrap()
        .unwrap();
    let imported = profiles::import(world.conn(), &document, home).unwrap();
    assert_eq!(imported.renamed_to.as_deref(), Some("Acme cloud sync (2)"));
    assert_eq!(store::list(world.conn()).unwrap().len(), 2);
}

#[test]
fn an_import_of_a_document_that_is_not_a_profile_names_the_file_and_writes_nothing() {
    let world = World::new();
    let imported = profiles::import(
        world.conn(),
        &ProfileDocument {
            file_name: "broken.yaml".into(),
            yaml: "name: x\n".into(),
        },
        Some(&world.home),
    )
    .unwrap();
    assert_eq!(imported.profile, None);
    assert_eq!(
        imported.error.as_deref(),
        Some("broken.yaml: A profile needs a `root`.")
    );
    assert!(store::list(world.conn()).unwrap().is_empty());
}

#[test]
fn exporting_a_profile_that_has_gone_says_so() {
    let world = World::new();
    assert_eq!(
        profiles::export(world.conn(), 7, None).unwrap(),
        Err("That profile no longer exists.".to_owned())
    );
}

// Through a client connection to a running host

const PROFILES_CHANGED: u64 = 1;

/// A host over a test's folders, with a client connected to it.
struct HostWorld {
    host: Option<RunningHost>,
    client: TestClient,
    endpoint: Endpoint,
    /// Last: fields drop in order, and the folder goes only once the host
    /// has let go of its store.
    dirs: TestDirs,
}

impl HostWorld {
    async fn start() -> Self {
        let dirs = TestDirs::new();
        let endpoint = dirs.endpoint();
        let host = RunningHost::start(HostConfig {
            folders: dirs.folders(),
            endpoint: endpoint.clone(),
            backends: backends(&dirs.user_env(), None),
            inherited_env: std::env::vars_os()
                .filter(|(key, _)| key != "SHELL")
                .chain([(OsString::from("SHELL"), OsString::from("/bin/sh"))])
                .collect(),
            run: HostRun {
                mode: AppMode::Dev,
                home: Some(dirs.home.clone()),
            },
        });
        let client = TestClient::connect(&endpoint, &[]).await;
        Self {
            host: Some(host),
            client,
            endpoint,
            dirs,
        }
    }

    async fn stop(mut self) {
        if let Some(host) = self.host.take() {
            host.stop(HostStopReason::Stop).await;
        }
    }

    /// The router tests' draft: rooted at `hub` in the test folder, with
    /// one overlay inside it.
    fn draft(&self, name: &str) -> ProfileDraft {
        let root = self.dirs.root().join("hub");
        ProfileDraft {
            name: name.into(),
            root: text(&root),
            overlays: vec![text(&root.join("repos").join("tools"))],
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

    async fn save(&mut self, name: &str) -> SaveProfileResult {
        let draft = self.draft(name);
        self.client
            .request::<ProfileSave>(&SaveProfileRequest { id: None, draft })
            .await
            .unwrap()
    }

    /// Another client, subscribed to `profiles:changed`, and the names of
    /// the list it started with.
    async fn watcher(&self) -> (TestClient, Vec<String>) {
        let mut client = TestClient::connect(&self.endpoint, &[]).await;
        match client
            .subscribe_on(PROFILES_CHANGED, ProfilesChanged::NAME)
            .await
        {
            Message::Snapshot(snapshot) => {
                let listed: Vec<Profile> = from_payload(&snapshot.state).unwrap();
                (client, names_of(&listed))
            }
            other => panic!("profiles:changed starts with its state, not {other:?}"),
        }
    }
}

fn names_of(listed: &[Profile]) -> Vec<String> {
    listed.iter().map(|profile| profile.name.clone()).collect()
}

/// The names in the next list published on `profiles:changed`.
async fn next_list(client: &mut TestClient) -> Vec<String> {
    let deadline = Instant::now() + PATIENCE;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match client.next(left).await {
            Some(Message::Event(event)) if event.subscription == PROFILES_CHANGED => {
                let listed: Vec<Profile> = from_payload(&event.payload).unwrap();
                return names_of(&listed);
            }
            Some(_) => {}
            None => panic!("no profiles:changed event within {PATIENCE:?}"),
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn over_a_client_connection_every_subscriber_to_profile_changes_gets_the_whole_list_after_each_change()
 {
    let mut world = HostWorld::start().await;
    let (mut first, first_start) = world.watcher().await;
    let (mut second, second_start) = world.watcher().await;
    assert_eq!(first_start, Vec::<String>::new());
    assert_eq!(second_start, first_start);

    let alpha = world.save("Alpha").await.profile.unwrap();
    let beta = world.save("Beta").await.profile.unwrap();
    let pinned = world
        .client
        .request::<ProfilePin>(&PinProfilesRequest {
            ids: vec![beta.id, alpha.id],
        })
        .await
        .unwrap();
    assert_eq!(
        names_of(&pinned),
        ["Beta", "Alpha"],
        "pins keep the order given"
    );
    let deleted: ProfileDeleted = world
        .client
        .request::<ProfileDelete>(&ProfileRef { id: alpha.id })
        .await
        .unwrap();
    assert!(deleted.deleted);

    let expected = [
        vec!["Alpha".to_owned()],
        vec!["Alpha".to_owned(), "Beta".to_owned()],
        vec!["Beta".to_owned(), "Alpha".to_owned()],
        vec!["Beta".to_owned()],
    ];
    for watcher in [&mut first, &mut second] {
        for list in &expected {
            assert_eq!(&next_list(watcher).await, list);
        }
    }
    let (_later, later_start) = world.watcher().await;
    assert_eq!(later_start, ["Beta"]);
    assert_eq!(
        names_of(&world.client.request::<ProfileList>(&()).await.unwrap()),
        ["Beta"]
    );

    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn over_a_client_connection_a_draft_that_fails_validation_or_takes_a_used_name_is_refused_with_its_problems_and_tells_nobody()
 {
    let mut world = HostWorld::start().await;
    world.save("hub dev").await;
    let (mut watcher, _) = world.watcher().await;

    let clash = world.save("HUB DEV").await;
    assert_eq!(clash.profile, None);
    assert_eq!(
        clash.problems,
        ["A profile named \u{201c}hub dev\u{201d} already exists."]
    );
    let invalid = world.save("  ").await;
    assert_eq!(invalid.profile, None);
    assert_eq!(invalid.problems, ["A profile needs a name."]);
    let deleted: ProfileDeleted = world
        .client
        .request::<ProfileDelete>(&ProfileRef { id: 99 })
        .await
        .unwrap();
    assert!(!deleted.deleted);
    assert_eq!(
        names_of(&world.client.request::<ProfileList>(&()).await.unwrap()),
        ["hub dev"]
    );

    // None of them told anybody: the next change is the first heard.
    world.save("lab notes").await.profile.unwrap();
    assert_eq!(next_list(&mut watcher).await, ["hub dev", "lab notes"]);

    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn over_a_client_connection_an_export_is_the_profiles_yaml_document_and_an_import_is_validated_before_it_is_saved()
 {
    let mut world = HostWorld::start().await;
    let saved = world.save("Acme cloud sync").await.profile.unwrap();
    let document: ProfileDocument = world
        .client
        .request::<ProfileExport>(&ProfileRef { id: saved.id })
        .await
        .unwrap();
    assert_eq!(document.file_name, "acme-cloud-sync.floti-profile.yaml");
    for line in [
        "name: Acme cloud sync",
        "- repos/tools",
        "permission_mode: plan",
    ] {
        assert!(document.yaml.contains(line), "{}", document.yaml);
    }

    let (mut watcher, _) = world.watcher().await;
    let refused: ImportProfileResult = world
        .client
        .request::<ProfileImport>(&ProfileDocument {
            file_name: "list.yaml".into(),
            yaml: "- a\n- b\n".into(),
        })
        .await
        .unwrap();
    assert_eq!(refused.profile, None);
    assert_eq!(
        refused.error.as_deref(),
        Some("list.yaml: A profile file must be a YAML mapping.")
    );
    assert_eq!(
        names_of(&world.client.request::<ProfileList>(&()).await.unwrap()),
        ["Acme cloud sync"]
    );

    let imported: ImportProfileResult = world
        .client
        .request::<ProfileImport>(&document)
        .await
        .unwrap();
    let profile = imported.profile.unwrap();
    assert_eq!(imported.renamed_to.as_deref(), Some("Acme cloud sync (2)"));
    assert_eq!(profile.overlays, saved.overlays);
    assert_eq!(profile.root, saved.root);
    // The refused import told nobody: the first change heard is this one.
    assert_eq!(
        next_list(&mut watcher).await,
        ["Acme cloud sync", "Acme cloud sync (2)"]
    );

    let gone = world
        .client
        .request::<ProfileExport>(&ProfileRef { id: 404 })
        .await
        .unwrap_err();
    assert_eq!(gone.message, "That profile no longer exists.");

    world.stop().await;
}
