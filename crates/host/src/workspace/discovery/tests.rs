//! The parts of discovery a client cannot reach one at a time: the parse of
//! `git status` (core's git.test.ts), which cached rows a scan or a removed
//! root proves wrong (scan.test.ts, "reconciling the discovery cache"), and
//! scans that overlap (desktop's services.scan.test.ts), with the same
//! inputs and expectations.

use std::path::Path;
use std::sync::{Arc, Mutex};

use floti_protocol::channels::workspace::{
    DiscoveryError, DiscoveryResult, GitState, HostSettingsPatch, Millis, Project, ProjectKind,
};

use super::git::parse_git_status;
use super::scan::{disproved_project_paths, orphaned_project_paths, scan};
use super::suggest::{find_enclosing_harness, suggest_roots};
use super::*;
use crate::store::Store;
use crate::store::projects::EMPTY_INVENTORY;
use crate::testkit::TestDirs;

fn state(branch: Option<&str>, detached: bool, dirty: u32, ahead: u32, behind: u32) -> GitState {
    GitState {
        branch: branch.map(str::to_owned),
        detached,
        dirty,
        ahead,
        behind,
        error: None,
    }
}

// ---------------------------------------------------------------------------
// parseGitStatus: real `git status --porcelain=v2 --branch` outputs.
// ---------------------------------------------------------------------------

#[test]
fn reads_a_clean_branch_with_an_upstream() {
    let out = [
        "# branch.oid 38a0c50f0e9a4f1b0b2f3d4c5e6a7b8c9d0e1f22",
        "# branch.head main",
        "# branch.upstream origin/main",
        "# branch.ab +0 -0",
        "",
    ]
    .join("\n");
    assert_eq!(parse_git_status(&out), state(Some("main"), false, 0, 0, 0));
}

#[test]
fn counts_changed_renamed_unmerged_and_untracked_paths_as_dirty() {
    let out = [
        "# branch.head feature/discovery",
        "# branch.upstream origin/feature/discovery",
        "# branch.ab +2 -3",
        "1 .M N... 100644 100644 100644 aaa bbb packages/core/src/index.ts",
        "1 M. N... 100644 100644 100644 ccc ddd packages/core/src/types.ts",
        "2 R. N... 100644 100644 100644 eee fff R100 new/path.ts\told/path.ts",
        "u UU N... 100644 100644 100644 100644 111 222 333 conflicted.ts",
        "? untracked.ts",
        "",
    ]
    .join("\n");
    assert_eq!(
        parse_git_status(&out),
        state(Some("feature/discovery"), false, 5, 2, 3)
    );
}

#[test]
fn recognises_a_detached_head() {
    let out = ["# branch.oid 38a0c50", "# branch.head (detached)", ""].join("\n");
    let parsed = parse_git_status(&out);
    assert!(parsed.detached);
    assert_eq!(parsed.branch, None);
}

#[test]
fn leaves_ahead_and_behind_at_zero_when_there_is_no_upstream() {
    let out = [
        "# branch.oid 38a0c50",
        "# branch.head local-only",
        "? notes.md",
        "",
    ]
    .join("\n");
    assert_eq!(
        parse_git_status(&out),
        state(Some("local-only"), false, 1, 0, 0)
    );
}

#[test]
fn handles_names_containing_spaces_in_the_path_column() {
    let out = [
        "# branch.head main",
        "# branch.ab +0 -0",
        "1 .M N... 100644 100644 100644 aaa bbb Acme Project/README.md",
        "",
    ]
    .join("\n");
    assert_eq!(parse_git_status(&out).dirty, 1);
}

// ---------------------------------------------------------------------------
// Reconciling the discovery cache.
// ---------------------------------------------------------------------------

fn join(base: &Path, parts: &[&str]) -> String {
    let mut path = base.to_path_buf();
    for part in parts {
        path.push(part);
    }
    path.to_string_lossy().into_owned()
}

fn scanned(roots: &[String], projects: &[String], errors: &[(String, &str)]) -> DiscoveryResult {
    DiscoveryResult {
        roots: roots.to_vec(),
        harnesses: Vec::new(),
        projects: projects
            .iter()
            .map(|path| Project {
                path: path.clone(),
                name: path.clone(),
                kind: ProjectKind::Folder,
                harness_path: None,
                has_claude_dir: false,
                inventory: EMPTY_INVENTORY,
                git: None,
            })
            .collect(),
        errors: errors
            .iter()
            .map(|(path, message)| DiscoveryError {
                path: path.clone(),
                message: (*message).to_owned(),
            })
            .collect(),
        scanned_at: String::new(),
        duration_ms: Millis(0.0),
    }
}

#[test]
fn disproves_a_cached_row_a_completed_scan_of_its_own_root_did_not_return() {
    let dirs = TestDirs::new();
    let tool = join(dirs.root(), &["tool"]);
    let cached = [
        join(dirs.root(), &["tool", "src"]),
        join(dirs.root(), &["tool", "tests"]),
        tool.clone(),
    ];
    assert_eq!(
        disproved_project_paths(
            &cached,
            &scanned(
                std::slice::from_ref(&tool),
                std::slice::from_ref(&tool),
                &[]
            )
        ),
        [cached[0].clone(), cached[1].clone()]
    );
}

#[test]
fn keeps_everything_under_a_root_the_scan_could_not_read() {
    let dirs = TestDirs::new();
    let gone = join(dirs.root(), &["gone"]);
    let cached = [join(dirs.root(), &["gone", "alpha"])];
    assert!(
        disproved_project_paths(
            &cached,
            &scanned(
                std::slice::from_ref(&gone),
                &[],
                &[(gone.clone(), "not a directory")]
            )
        )
        .is_empty()
    );
    // An error below the root is the same answer: the walk was incomplete.
    assert!(
        disproved_project_paths(
            &cached,
            &scanned(
                std::slice::from_ref(&gone),
                &[],
                &[(join(dirs.root(), &["gone", "beta"]), "EPERM")]
            )
        )
        .is_empty()
    );
}

#[test]
fn keeps_a_cached_row_that_belongs_to_no_current_root_at_all() {
    let dirs = TestDirs::new();
    let cached = [join(dirs.root(), &["elsewhere", "alpha"])];
    assert!(
        disproved_project_paths(&cached, &scanned(&[join(dirs.root(), &["here"])], &[], &[]))
            .is_empty()
    );
}

/// On every OS: the host compares folders ignoring case everywhere, as the
/// discovery cache does.
#[test]
fn matches_roots_and_rows_across_two_spellings_of_one_directory() {
    let dirs = TestDirs::new();
    let cached = [join(dirs.root(), &["Tool", "SRC"])];
    let tool = join(dirs.root(), &["tool"]);
    assert_eq!(
        disproved_project_paths(
            &cached,
            &scanned(
                std::slice::from_ref(&tool),
                std::slice::from_ref(&tool),
                &[]
            )
        ),
        cached
    );
    assert!(
        disproved_project_paths(
            &cached,
            &scanned(
                std::slice::from_ref(&tool),
                &[join(dirs.root(), &["tool", "src"])],
                &[]
            )
        )
        .is_empty()
    );
}

#[test]
fn orphans_the_rows_a_removed_root_put_there_and_only_those() {
    let dirs = TestDirs::new();
    let removed = join(dirs.root(), &["tool"]);
    let kept = join(dirs.root(), &["work"]);
    let cached = [
        join(dirs.root(), &["tool", "src"]),
        removed.clone(),
        join(dirs.root(), &["work", "alpha"]),
    ];
    assert_eq!(
        orphaned_project_paths(&cached, &removed, &[kept]),
        [cached[0].clone(), cached[1].clone()]
    );
}

#[test]
fn keeps_an_orphan_that_another_root_still_covers() {
    let dirs = TestDirs::new();
    let outer = dirs.root().to_string_lossy().into_owned();
    let inner = join(dirs.root(), &["tool"]);
    let cached = [join(dirs.root(), &["tool", "src"])];
    assert!(orphaned_project_paths(&cached, &inner, &[outer]).is_empty());
}

// ---------------------------------------------------------------------------
// Suggested roots (roots.ts).
// ---------------------------------------------------------------------------

#[test]
fn suggests_the_folder_around_an_enclosing_harness_first_then_the_home_harness_folder() {
    let dirs = TestDirs::new();
    let harnesses = dirs.folder("harnesses");
    let dev = harnesses.join("dev");
    std::fs::create_dir_all(dev.join("repos").join("alpha")).unwrap();
    std::fs::write(dev.join("harness.yaml"), "name: dev\n").unwrap();
    std::fs::create_dir_all(dirs.home.join(".harness")).unwrap();
    let inside = dev.join("repos").join("alpha");

    assert_eq!(find_enclosing_harness(&inside), Some(dev.clone()));
    assert_eq!(
        suggest_roots(&inside, Some(&dirs.home)),
        [
            harnesses.to_string_lossy().into_owned(),
            dirs.home.join(".harness").to_string_lossy().into_owned()
        ]
    );
    // Nothing that is not there, and never the home folder itself.
    let elsewhere = dirs.folder("elsewhere");
    std::fs::remove_dir(dirs.home.join(".harness")).unwrap();
    assert!(suggest_roots(&elsewhere, Some(&dirs.home)).is_empty());
}

#[test]
fn a_suggestion_named_twice_is_offered_once() {
    let dirs = TestDirs::new();
    // The home folder's .harness is itself the folder around the harness.
    let dev = dirs.home.join(".harness").join("dev");
    std::fs::create_dir_all(&dev).unwrap();
    std::fs::write(dev.join("harness.yaml"), "").unwrap();
    assert_eq!(
        suggest_roots(&dev, Some(&dirs.home)),
        [dirs.home.join(".harness").to_string_lossy().into_owned()]
    );
}

// ---------------------------------------------------------------------------
// Overlapping scans (services.scan.test.ts): the startup scan is still
// walking when a root accepted in setup starts another one.
// ---------------------------------------------------------------------------

struct World {
    service: DiscoveryService,
    settings: Arc<SettingsService>,
    first: String,
    second: String,
    added: String,
    /// Last: fields drop in order.
    dirs: TestDirs,
}

impl World {
    fn new() -> Self {
        let dirs = TestDirs::new();
        let store = Arc::new(Mutex::new(Store::open(&dirs.data).unwrap()));
        let settings = Arc::new(SettingsService::new(Arc::clone(&store)));
        let service = DiscoveryService::new(store, Arc::clone(&settings), None);
        let first = dirs.folder("projects");
        for name in ["alpha", "beta"] {
            std::fs::create_dir_all(first.join(name).join(".git")).unwrap();
        }
        let second = dirs.folder("more");
        let added = second.join("gamma");
        std::fs::create_dir_all(added.join(".claude")).unwrap();
        Self {
            service,
            settings,
            first: first.to_string_lossy().into_owned(),
            second: second.to_string_lossy().into_owned(),
            added: added.to_string_lossy().into_owned(),
            dirs,
        }
    }

    /// Starts a scan over `roots` the way `roots:accept` and then a rescan
    /// do, and walks it; it lands when the test says.
    fn start(&self, roots: &[&String]) -> (ScanTicket, DiscoveryResult) {
        self.settings
            .write(&HostSettingsPatch {
                scan_roots: Some(roots.iter().map(|root| (*root).clone()).collect()),
                ..HostSettingsPatch::default()
            })
            .unwrap();
        let ticket = self.service.begin_scan().unwrap();
        let result = scan(&ticket.roots, false);
        (ticket, result)
    }

    fn cached_paths(&self) -> Vec<String> {
        self.service
            .cached()
            .unwrap()
            .into_iter()
            .map(|row| row.path)
            .collect()
    }
}

fn paths(result: &DiscoveryResult) -> Vec<String> {
    result.projects.iter().map(|p| p.path.clone()).collect()
}

#[test]
fn keeps_the_newer_scan_when_the_older_one_finishes_after_it() {
    let world = World::new();
    let startup = world.start(&[&world.first]);
    let accepted = world.start(&[&world.first, &world.second]);
    assert_eq!(startup.0.roots, std::slice::from_ref(&world.first));
    assert_eq!(
        accepted.0.roots,
        [world.first.clone(), world.second.clone()]
    );

    world.service.finish_scan(&accepted.0, accepted.1).unwrap();
    let told = world.service.finish_scan(&startup.0, startup.1).unwrap();

    // What the host holds, and what the older scan's caller was handed,
    // both describe the roots as they are now.
    let last = world.service.last().unwrap();
    assert_eq!(last.roots, [world.first.clone(), world.second.clone()]);
    assert!(paths(&last).contains(&world.added));
    assert_eq!(told.roots, [world.first.clone(), world.second.clone()]);
    assert!(world.cached_paths().contains(&world.added));
}

#[test]
fn takes_the_newer_scan_when_the_two_finish_in_the_order_they_started() {
    let world = World::new();
    let older = world.start(&[&world.second]);
    let newer = world.start(&[&world.first, &world.second]);

    world.service.finish_scan(&older.0, older.1).unwrap();
    world.service.finish_scan(&newer.0, newer.1).unwrap();

    let last = world.service.last().unwrap();
    assert_eq!(last.roots, [world.first.clone(), world.second.clone()]);
    let found = paths(&last);
    for project in [
        Path::new(&world.first).join("alpha"),
        Path::new(&world.first).join("beta"),
    ] {
        assert!(
            found.contains(&project.to_string_lossy().into_owned()),
            "{found:?}"
        );
    }
    assert!(found.contains(&world.added));
    assert!(Path::new(&world.added).starts_with(world.dirs.root()));
}

#[test]
fn the_branch_at_spawn_is_the_checked_out_branch_and_none_without_one() {
    let dirs = TestDirs::new();
    let repo = crate::testkit::GitRepo::init(dirs.folder("repo"));
    repo.write("readme.md", "one");
    repo.commit_all("first");
    assert_eq!(
        super::git::read_git_branch(repo.path()).as_deref(),
        Some("main")
    );
    repo.git(&["checkout", "--quiet", "-b", "feature/two"]);
    assert_eq!(
        super::git::read_git_branch(repo.path()).as_deref(),
        Some("feature/two")
    );
    // A detached head has no branch, and neither has a folder outside any
    // repository: neither is guessed.
    repo.git(&["checkout", "--quiet", "--detach"]);
    assert_eq!(super::git::read_git_branch(repo.path()), None);
    assert_eq!(super::git::read_git_branch(&dirs.folder("plain")), None);
}
