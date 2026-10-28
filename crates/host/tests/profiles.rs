//! Saved profiles, as today's `core/launch/profile.test.ts`,
//! `core/store/profiles.test.ts` and `desktop/main/profiles.test.ts` test
//! them, with the same inputs and expectations: the YAML document, the rows
//! in the host's own store, and what a save, export and import answer. The
//! profile channels and `profiles:changed` are tested through the host's
//! router in `server/features/profiles.rs`; the launch is
//! `profile:launch`'s, in `tests/sessions.rs`.

use std::path::{Path, PathBuf};

use floti_host::config_console::normalize;
use floti_host::store::Store;
use floti_host::testkit::TestDirs;
use floti_host::workspace::profiles::{
    self, profile_draft, profile_from_yaml, profile_to_yaml, store, validate_profile,
};
use floti_protocol::channels::common::PermissionMode;
use floti_protocol::channels::sessions::{
    EffortLevel, ProfileDocument, ProfileDraft, SaveProfileRequest,
};

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
