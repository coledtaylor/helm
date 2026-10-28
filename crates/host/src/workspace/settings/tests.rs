use std::sync::{Arc, Mutex};

use floti_protocol::BackendId;
use floti_protocol::channels::workspace::{HostSettings, HostSettingsPatch};

use super::*;
use crate::store::Store;
use crate::testkit::TestDirs;

/// A store, the service over it, and every settings a listener was told.
struct World {
    store: Arc<Mutex<Store>>,
    service: SettingsService,
    told: Arc<Mutex<Vec<HostSettings>>>,
    /// Last: fields drop in order, and the folder goes only once nothing in it is open.
    dirs: TestDirs,
}

impl World {
    fn new() -> Self {
        let dirs = TestDirs::new();
        let store = Arc::new(Mutex::new(Store::open(&dirs.data).unwrap()));
        let service = SettingsService::new(Arc::clone(&store));
        let told = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&told);
        service.on_change(move |settings| seen.lock().unwrap().push(settings.clone()));
        Self {
            store,
            service,
            told,
            dirs,
        }
    }

    fn told(&self) -> Vec<HostSettings> {
        std::mem::take(&mut *self.told.lock().unwrap())
    }

    fn stored(&self) -> HostSettings {
        read(self.store.lock().unwrap().connection()).unwrap()
    }

    fn raw(&self, key: &str, value: &str) {
        self.store
            .lock()
            .unwrap()
            .connection()
            .execute(
                "INSERT INTO app_settings (key, value) VALUES (?1, ?2) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [key, value],
            )
            .unwrap();
    }

    fn path(&self, name: &str) -> String {
        self.dirs.root().join(name).display().to_string()
    }

    fn refusal(&self, patch: HostSettingsPatch) -> String {
        let before = self.stored();
        let err = self
            .service
            .write(&patch)
            .expect_err("the patch is refused");
        assert_eq!(self.stored(), before, "a refused patch writes nothing");
        assert!(self.told().is_empty(), "a refused patch tells nobody");
        err.to_string()
    }
}

#[test]
fn refuses_a_malformed_value_with_the_validators_sentence_and_keeps_what_was_stored() {
    let world = World::new();
    world
        .service
        .write(&HostSettingsPatch {
            transcript_archive_max_bytes: Some(2048),
            ..Default::default()
        })
        .unwrap();
    world.told();

    let refused = world.refusal(HostSettingsPatch {
        transcript_archive_max_bytes: Some(999),
        ..Default::default()
    });
    assert_eq!(
        refused,
        "settings rejected: transcriptArchiveMaxBytes: expected 1024 to 68719476736, got 999"
    );
    assert_eq!(world.stored().transcript_archive_max_bytes, 2048);
}

#[test]
fn a_patch_with_one_bad_value_writes_none_of_its_good_ones() {
    let world = World::new();
    let refused = world.refusal(HostSettingsPatch {
        scan_roots: Some(vec![world.path("projects")]),
        terminal_shell: Some(Some("pwsh.exe".into())),
        ..Default::default()
    });
    assert_eq!(
        refused,
        "settings rejected: terminalShell: expected an absolute path, got \"pwsh.exe\""
    );
    assert!(world.stored().scan_roots.is_empty());
}

#[test]
fn each_value_is_refused_in_its_own_sentence() {
    let world = World::new();
    let projects = world.path("projects");
    let cases: Vec<(HostSettingsPatch, &str)> = vec![
        (
            HostSettingsPatch {
                scan_roots: Some(vec![projects.clone(), "relative/root".into()]),
                ..Default::default()
            },
            "scanRoots: expected an absolute path, got \"relative/root\"",
        ),
        (
            HostSettingsPatch {
                scan_roots: Some(vec!["  ".into()]),
                ..Default::default()
            },
            "scanRoots: expected every root to be a path, got \"  \"",
        ),
        (
            HostSettingsPatch {
                pinned_projects: Some(vec![projects.clone(), projects.to_uppercase()]),
                ..Default::default()
            },
            "twice",
        ),
        (
            HostSettingsPatch {
                pinned_projects: Some(vec![String::new()]),
                ..Default::default()
            },
            "pinnedProjects: expected every pin to be a path, got \"\"",
        ),
        (
            HostSettingsPatch {
                pinned_projects: Some(
                    (0..=PINNED_PROJECTS_MAX)
                        .map(|n| world.path(&format!("p{n}")))
                        .collect(),
                ),
                ..Default::default()
            },
            "pinnedProjects: expected at most 200 projects, got 201",
        ),
        (
            HostSettingsPatch {
                first_run_completed_at: Some(Some("yesterday".into())),
                ..Default::default()
            },
            "firstRunCompletedAt: expected an ISO timestamp or null, got \"yesterday\"",
        ),
        (
            HostSettingsPatch {
                backend_paths: Some([(BackendId::claude_code(), "claude".to_owned())].into()),
                ..Default::default()
            },
            "backendPaths: expected an absolute path, got \"claude\" for claude-code",
        ),
        (
            HostSettingsPatch {
                terminal_shell: Some(Some(String::new())),
                ..Default::default()
            },
            "terminalShell: expected an absolute path or null, got \"\"",
        ),
        (
            HostSettingsPatch {
                transcript_archive_max_bytes: Some(64 * 1024 * 1024 * 1024 + 1),
                ..Default::default()
            },
            "transcriptArchiveMaxBytes: expected 1024 to 68719476736, got 68719476737",
        ),
    ];
    for (patch, expected) in cases {
        let refused = world.refusal(patch);
        assert!(refused.starts_with("settings rejected: "), "{refused}");
        assert!(
            refused.contains(expected),
            "{refused} does not say {expected}"
        );
    }
}

#[test]
fn every_listener_is_told_the_whole_settings_after_each_change() {
    let world = World::new();
    let roots = vec![world.path("projects")];
    let after = world
        .service
        .write(&HostSettingsPatch {
            scan_roots: Some(roots.clone()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(after.scan_roots, roots);
    let after_second = world
        .service
        .write(&HostSettingsPatch {
            session_mcp: Some(false),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(world.told(), vec![after, after_second.clone()]);
    assert_eq!(
        after_second.scan_roots, roots,
        "a patch leaves the rest alone"
    );
    assert!(!after_second.session_mcp);
    assert_eq!(world.service.read().unwrap(), after_second);
}

#[test]
fn a_nullable_setting_sent_as_null_is_cleared_and_one_left_out_is_kept() {
    let world = World::new();
    let shell = world.path("shell");
    world
        .service
        .write(&HostSettingsPatch {
            terminal_shell: Some(Some(shell.clone())),
            first_run_completed_at: Some(Some("2026-10-28T10:00:00.000Z".into())),
            ..Default::default()
        })
        .unwrap();
    let cleared = world
        .service
        .write(&HostSettingsPatch {
            terminal_shell: Some(None),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(cleared.terminal_shell, None);
    assert_eq!(
        cleared.first_run_completed_at.as_deref(),
        Some("2026-10-28T10:00:00.000Z")
    );
}

#[test]
fn a_new_store_reads_as_the_defaults() {
    let world = World::new();
    assert_eq!(world.stored(), defaults());
    let defaults = defaults();
    assert!(defaults.browser_mcp && defaults.session_mcp);
    assert!(!defaults.browser_mcp_local_only && !defaults.restore_without_asking);
    assert_eq!(defaults.transcript_archive_max_bytes, 1024 * 1024 * 1024);
}

#[test]
fn an_unreadable_row_falls_back_to_its_default_and_the_rest_still_load() {
    let world = World::new();
    let roots = vec![world.path("projects")];
    world.raw("scanRoots", &serde_json::to_string(&roots).unwrap());
    world.raw("pinnedProjects", "{ not json");
    world.raw("browserMcp", "\"false\"");
    world.raw("theme", "\"dark\"");
    let settings = world.stored();
    assert_eq!(settings.scan_roots, roots);
    assert!(settings.pinned_projects.is_empty());
    assert!(settings.browser_mcp, "a string is not a boolean");
}

#[test]
fn todays_claude_path_reads_as_claude_codes_until_backend_paths_are_written() {
    let world = World::new();
    let picked = world.path("bin/claude");
    world.raw("claudePath", &serde_json::to_string(&picked).unwrap());
    assert_eq!(
        world.stored().backend_paths,
        [(BackendId::claude_code(), picked.clone())].into()
    );

    world
        .service
        .write(&HostSettingsPatch {
            backend_paths: Some(BTreeMap::new()),
            ..Default::default()
        })
        .unwrap();
    assert!(world.stored().backend_paths.is_empty());
}

#[test]
fn pins_keep_their_order_and_one_whose_folder_is_gone_is_kept() {
    let world = World::new();
    let pins = vec![world.path("alpha"), world.path("unplugged/tools")];
    world
        .service
        .write(&HostSettingsPatch {
            pinned_projects: Some(pins.clone()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(world.stored().pinned_projects, pins);
}
