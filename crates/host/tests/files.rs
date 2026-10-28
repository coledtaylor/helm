//! The Files view as a client of the host sees it: core's listing, reading,
//! git status and changed-lines tests and the desktop's Files service tests,
//! with the same inputs and expectations, run against a host through its
//! socket over real repositories, plus the known-root rule and the watch.
//!
//! A folder is made known the way a client makes one known in these tests:
//! a session starts in it, driven against the fake agent.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use floti_host::agent::AgentBackend;
use floti_host::fake_agent;
use floti_host::platform::links::{FolderLinks, Native as NativeLinks};
use floti_host::platform::socket::Endpoint;
use floti_host::server::HostConfig;
use floti_host::testkit::{
    FakeAgent, GitRepo, PATIENCE, RunningHost, TestClient, TestDirs, link_folder,
};
use floti_host::workspace::files::changes::parse_zero_context_diff;
use floti_host::workspace::files::listing::FILE_LIST_MAX;
use floti_host::workspace::files::status::parse_status_z;
use floti_host::workspace::files::view::FILE_VIEW_MAX_BYTES;
use floti_host::workspace::files::watch::SETTLE;
use floti_protocol::Message;
use floti_protocol::channel::{EventChannel, from_payload};
use floti_protocol::channels::common::SessionRecord;
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::sessions::{
    CloseSessionRequest, SessionClose, SessionStart, StartSessionRequest,
};
use floti_protocol::channels::workspace::{
    ContentDirListing, ContentIgnoreReason, FileChangeState, FileListSource, FileListing, FileView,
    FilesChange, FilesChanged, FilesDirRequest, FilesPathRequest, FilesRoot, FilesStatus,
    FilesWatchRequest, GitFileState, LineChanges, LineEnding, ListFiles, ReadFile, ReadFilesDir,
    ReadFilesStatus, WatchFiles,
};

const CAPABILITIES: &[&str] = &["files", "terminal"];
const CHANGES: u64 = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// A host whose one backend is the fake agent, with a client connected.
struct World {
    host: Option<RunningHost>,
    client: TestClient,
    endpoint: Endpoint,
    _agent: FakeAgent,
    /// Last: fields drop in order.
    dirs: TestDirs,
}

fn config(dirs: &TestDirs, endpoint: &Endpoint, agent: &FakeAgent) -> HostConfig {
    HostConfig {
        run: Default::default(),
        folders: dirs.folders(),
        endpoint: endpoint.clone(),
        backends: vec![Arc::new(agent.backend(std::iter::empty::<&str>())) as Arc<dyn AgentBackend>],
        inherited_env: std::env::vars_os()
            .filter(|(key, _)| key != "SHELL")
            .chain([(OsString::from("SHELL"), OsString::from("/bin/sh"))])
            .collect(),
    }
}

impl World {
    async fn start() -> Self {
        let dirs = TestDirs::new();
        let agent = fake_agent!(&dirs);
        let endpoint = dirs.endpoint();
        let host = RunningHost::start(config(&dirs, &endpoint, &agent));
        let client = TestClient::connect(&endpoint, CAPABILITIES).await;
        Self {
            host: Some(host),
            client,
            endpoint,
            _agent: agent,
            dirs,
        }
    }

    /// Stops the host, and hands back the test's folders for a test that
    /// looks at them afterwards.
    async fn stop(mut self) -> TestDirs {
        if let Some(host) = self.host.take() {
            host.stop(HostStopReason::Stop).await;
        }
        self.dirs
    }

    /// A new folder in the test's tree; `name` may hold spaces.
    fn folder(&self, name: &str) -> PathBuf {
        self.dirs.folder(name)
    }

    /// A repository with one commit holding `src/a.ts` (ten lines),
    /// `README.md` and a `.gitignore` that ignores `build/`, as core's tests
    /// make one.
    fn committed_repo(&self, name: &str) -> GitRepo {
        let repo = GitRepo::init(self.folder(name));
        repo.write("src/a.ts", &lines(10));
        repo.write("README.md", "# Readme\n");
        repo.write(".gitignore", "build/\n");
        repo.commit_all("first");
        repo
    }

    /// Makes `folder` known by starting a session in it.
    async fn know(&mut self, folder: &Path) -> SessionRecord {
        self.client
            .request::<SessionStart>(&StartSessionRequest {
                cwd: text(folder),
                cols: 80,
                rows: 24,
                ..StartSessionRequest::default()
            })
            .await
            .expect("a session starts in the folder")
    }

    async fn dir(&mut self, root: &Path, rel_path: &str) -> Result<ContentDirListing, String> {
        self.client
            .request::<ReadFilesDir>(&FilesDirRequest {
                root: text(root),
                rel_path: rel_path.to_owned(),
            })
            .await
            .map_err(|error| error.message)
    }

    async fn status(&mut self, root: &Path) -> Result<FilesStatus, String> {
        self.client
            .request::<ReadFilesStatus>(&FilesRoot { root: text(root) })
            .await
            .map_err(|error| error.message)
    }

    async fn read(&mut self, root: &Path, path: &Path) -> Result<FileView, String> {
        self.client
            .request::<ReadFile>(&FilesPathRequest {
                root: text(root),
                path: text(path),
            })
            .await
            .map_err(|error| error.message)
    }

    async fn list(&mut self, root: &Path) -> Result<FileListing, String> {
        self.client
            .request::<ListFiles>(&FilesRoot { root: text(root) })
            .await
            .map_err(|error| error.message)
    }
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn lines(count: usize) -> String {
    (1..=count).map(|n| format!("line {n}\n")).collect()
}

fn write(path: &Path, content: impl AsRef<[u8]>) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, content).unwrap();
}

fn files(
    entries: &[(&str, GitFileState)],
) -> Option<std::collections::BTreeMap<String, GitFileState>> {
    Some(
        entries
            .iter()
            .map(|(path, state)| ((*path).to_owned(), *state))
            .collect(),
    )
}

fn tracked(
    changed: &[(u32, u32)],
    removed_after: &[u32],
    changed_count: u32,
    removed_count: u32,
) -> FileChangeState {
    FileChangeState::Tracked {
        lines: LineChanges {
            changed: changed.to_vec(),
            removed_after: removed_after.to_vec(),
            changed_count,
            removed_count,
        },
    }
}

fn unchanged() -> FileChangeState {
    tracked(&[], &[], 0, 0)
}

fn refused_as_unknown(said: &str, root: &Path) {
    assert_eq!(
        said,
        format!(
            "{} is not a folder Floti knows, so it will not list or read it.",
            text(root)
        )
    );
}

/// The next change on `client`'s Files subscription within `timeout`.
async fn next_change(client: &mut TestClient, timeout: Duration) -> Option<FilesChange> {
    let deadline = Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match client.next(left).await {
            Some(Message::Event(event)) if event.subscription == CHANGES => {
                return Some(from_payload(&event.payload).expect("a Files change"));
            }
            Some(_) => continue,
            None => return None,
        }
    }
}

/// Every change told within `quiet` of the last, until it goes quiet.
async fn changes_until_quiet(client: &mut TestClient, quiet: Duration) -> Vec<FilesChange> {
    let mut seen = Vec::new();
    while let Some(change) = next_change(client, quiet).await {
        seen.push(change);
    }
    seen
}

/// Writes `path` again and again until `client` is told about it: a
/// watch's first moments may miss a write (macOS's FSEvents), and nothing
/// says when it is live. Then waits for quiet.
async fn until_told(client: &mut TestClient, path: &Path, rel: &str) {
    let deadline = Instant::now() + PATIENCE;
    let mut n = 0;
    loop {
        n += 1;
        write(path, format!("changed {n}\n"));
        if let Some(change) = next_change(client, Duration::from_millis(500)).await
            && change
                .paths
                .as_ref()
                .is_some_and(|paths| paths.iter().any(|p| p == rel))
        {
            break;
        }
        assert!(Instant::now() < deadline, "the watch never told of {rel}");
    }
    changes_until_quiet(client, Duration::from_millis(600)).await;
}

// ---------------------------------------------------------------------------
// Parsers (core: parseZeroContextDiff, parseStatusZ)
// ---------------------------------------------------------------------------

#[test]
fn a_zero_context_diff_marks_added_changed_and_removed_lines_from_the_hunk_headers_alone() {
    let diff = [
        "diff --git a/x b/x",
        "@@ -2,0 +3,2 @@",
        "+new one",
        "+new two",
        "@@ -5 +7 @@",
        "-old",
        "+changed",
        "@@ -9,3 +10,0 @@",
        "-gone",
        "-gone",
        "-gone",
        "@@ -20,4 +18,2 @@",
    ]
    .join("\n");
    assert_eq!(
        parse_zero_context_diff(&diff),
        LineChanges {
            changed: vec![(3, 4), (7, 7), (18, 19)],
            removed_after: vec![10, 19],
            changed_count: 5,
            removed_count: 5,
        }
    );
}

#[test]
fn a_diff_with_no_hunks_a_binary_file_or_none_at_all_is_nothing_changed() {
    assert_eq!(
        parse_zero_context_diff("Binary files a/x and b/x differ\n"),
        LineChanges {
            changed: vec![],
            removed_after: vec![],
            changed_count: 0,
            removed_count: 0,
        }
    );
}

#[test]
fn status_keys_every_kind_of_entry_by_its_path_inside_the_project_a_rename_consuming_its_source() {
    let out = [
        "# branch.oid abc",
        "1 .M N... 100644 100644 100644 aaa bbb app/src/a b.ts",
        "1 A. N... 000000 100644 100644 000 ccc app/new.ts",
        "1 D. N... 100644 000000 000000 ddd 000 app/gone.ts",
        "2 R. N... 100644 100644 100644 eee eee R100 app/moved.ts",
        "app/was.ts",
        "u UU N... 100644 100644 100644 100644 f1 f2 f3 app/conflict.ts",
        "? app/scratch/notes.md",
        "? app/nested-repo/",
        "1 .M N... 100644 100644 100644 aaa bbb other/outside.ts",
    ]
    .map(|record| format!("{record}\0"))
    .concat();
    assert_eq!(
        Some(parse_status_z(&out, "App")),
        files(&[
            ("src/a b.ts", GitFileState::Modified),
            ("new.ts", GitFileState::Added),
            ("gone.ts", GitFileState::Deleted),
            ("moved.ts", GitFileState::Renamed),
            ("conflict.ts", GitFileState::Conflicted),
            ("scratch/notes.md", GitFileState::Untracked),
            ("nested-repo", GitFileState::Untracked),
        ])
    );
}

// ---------------------------------------------------------------------------
// Status (core: readFilesStatus)
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn status_reports_each_changed_file_under_the_project_and_an_empty_map_for_a_clean_one() {
    let mut world = World::start().await;
    let repo = world.committed_repo("helm files");
    let root = repo.path().to_path_buf();
    world.know(&root).await;
    assert_eq!(world.status(&root).await.unwrap().files, files(&[]));

    write(&root.join("src").join("a.ts"), lines(11));
    write(&root.join("src").join("b.ts"), "new\n");
    std::fs::remove_file(root.join("README.md")).unwrap();
    write(&root.join("build").join("out.js"), "ignored\n");

    let status = world.status(&root).await.unwrap();
    assert_eq!(status.error, None);
    assert_eq!(status.repo.as_deref(), Some(text(&root).as_str()));
    assert_eq!(
        status.files,
        files(&[
            ("src/a.ts", GitFileState::Modified),
            ("src/b.ts", GitFileState::Untracked),
            ("README.md", GitFileState::Deleted),
        ])
    );
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn status_carries_modified_added_deleted_renamed_and_untracked_files_by_root_relative_path() {
    let mut world = World::start().await;
    let repo = world.committed_repo("helm files");
    let root = repo.path().to_path_buf();
    repo.write("notes/was.md", &lines(20));
    repo.commit_all("a note");
    world.know(&root).await;

    write(&root.join("src").join("a.ts"), lines(12));
    repo.write("src/staged.ts", "staged\n");
    repo.git(&["add", "src/staged.ts"]);
    std::fs::remove_file(root.join("README.md")).unwrap();
    repo.git(&["mv", "notes/was.md", "notes/now.md"]);
    write(&root.join("scratch").join("idea one.md"), "x\n");

    assert_eq!(
        world.status(&root).await.unwrap().files,
        files(&[
            ("src/a.ts", GitFileState::Modified),
            ("src/staged.ts", GitFileState::Added),
            ("README.md", GitFileState::Deleted),
            ("notes/now.md", GitFileState::Renamed),
            ("scratch/idea one.md", GitFileState::Untracked),
        ])
    );
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn status_answers_for_a_folder_inside_a_repository_with_paths_relative_to_that_folder() {
    let mut world = World::start().await;
    let repo = world.committed_repo("helm files");
    let src = repo.path().join("src");
    world.know(&src).await;
    write(&src.join("a.ts"), lines(12));
    write(&repo.path().join("README.md"), "# Changed\n");
    assert_eq!(
        world.status(&src).await.unwrap().files,
        files(&[("a.ts", GitFileState::Modified)])
    );
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn status_says_a_folder_outside_any_repository_has_nothing_for_git_to_say() {
    let mut world = World::start().await;
    let root = world.folder("plain folder");
    write(&root.join("plain.txt"), "x");
    world.know(&root).await;
    let status = world.status(&root).await.unwrap();
    assert_eq!(
        (status.repo, status.files, status.error),
        (None, files(&[]), None)
    );
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_git_failure_is_reported_as_an_error_never_as_an_empty_status() {
    let mut world = World::start().await;
    let root = world.folder("broken repo");
    // A `.git` that points at no repository: git refuses to answer for it.
    write(&root.join(".git"), "gitdir: ./nowhere\n");
    write(&root.join("a.txt"), "x\n");
    world.know(&root).await;

    let status = world.status(&root).await.unwrap();
    assert_eq!(
        status.files, None,
        "could not look is not clean: {status:?}"
    );
    assert!(
        status.error.as_deref().is_some_and(|said| !said.is_empty()),
        "{status:?}"
    );
    let view = world.read(&root, &root.join("a.txt")).await.unwrap();
    assert!(
        matches!(view.changes, FileChangeState::Unknown { .. }),
        "{:?}",
        view.changes
    );
    world.stop().await;
}

// ---------------------------------------------------------------------------
// Changed lines (core: readFileChanges, through files:read)
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_read_marks_the_lines_that_differ_from_the_last_commit() {
    let mut world = World::start().await;
    let repo = world.committed_repo("helm files");
    let root = repo.path().to_path_buf();
    world.know(&root).await;
    let mut text_lines: Vec<String> = lines(10).split('\n').map(str::to_owned).collect();
    text_lines[2] = "changed 3".into();
    text_lines.insert(6, "inserted".into());
    text_lines.remove(9);
    write(&root.join("src").join("a.ts"), text_lines.join("\n"));

    let view = world
        .read(&root, &root.join("src").join("a.ts"))
        .await
        .unwrap();
    assert_eq!(view.changes, tracked(&[(3, 3), (7, 7)], &[9], 2, 1));
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_read_tells_unchanged_new_ignored_and_outside_apart() {
    let mut world = World::start().await;
    let repo = world.committed_repo("helm files");
    let root = repo.path().to_path_buf();
    world.know(&root).await;
    write(&root.join("src").join("fresh.ts"), "x\n");
    write(&root.join("build").join("out.js"), "x\n");
    repo.write("src/staged.ts", "x\n");
    repo.git(&["add", "src/staged.ts"]);

    let changes = |view: FileView| view.changes;
    assert_eq!(
        changes(world.read(&root, &root.join("README.md")).await.unwrap()),
        unchanged()
    );
    assert_eq!(
        changes(
            world
                .read(&root, &root.join("src").join("fresh.ts"))
                .await
                .unwrap()
        ),
        FileChangeState::New
    );
    assert_eq!(
        changes(
            world
                .read(&root, &root.join("src").join("staged.ts"))
                .await
                .unwrap()
        ),
        FileChangeState::New
    );
    assert_eq!(
        changes(
            world
                .read(&root, &root.join("build").join("out.js"))
                .await
                .unwrap()
        ),
        FileChangeState::Ignored
    );

    let elsewhere = world.folder("helm no-repo");
    write(&elsewhere.join("x.txt"), "x\n");
    world.know(&elsewhere).await;
    assert_eq!(
        changes(
            world
                .read(&elsewhere, &elsewhere.join("x.txt"))
                .await
                .unwrap()
        ),
        FileChangeState::Outside
    );
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_read_of_a_file_whose_name_git_would_take_as_a_pattern_answers_for_that_file() {
    let mut world = World::start().await;
    let repo = world.committed_repo("helm files");
    let root = repo.path().to_path_buf();
    world.know(&root).await;
    repo.write("src/[id].tsx", "one\n");
    repo.write("src/i.tsx", "decoy\n");
    repo.commit_all("route");
    repo.write("src/i.tsx", "decoy changed\n");

    // `[id]` as a glob matches `i.tsx`, which did change; the file did not.
    let view = world
        .read(&root, &root.join("src").join("[id].tsx"))
        .await
        .unwrap();
    assert_eq!(view.changes, unchanged());
    world.stop().await;
}

// ---------------------------------------------------------------------------
// Reading (core: readFileView)
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_read_has_line_feeds_only_says_how_the_file_ended_its_lines_and_carries_its_changes() {
    let mut world = World::start().await;
    let repo = world.committed_repo("helm files");
    let root = repo.path().to_path_buf();
    world.know(&root).await;
    write(&root.join("src").join("a.ts"), "one\r\ntwo\r\n");

    let view = world
        .read(&root, &root.join("src").join("a.ts"))
        .await
        .unwrap();
    assert_eq!(view.rel_path, "src/a.ts");
    assert!(view.exists && !view.binary && !view.too_large);
    assert_eq!(view.content, "one\ntwo\n");
    assert_eq!(view.eol, Some(LineEnding::Crlf));
    assert_eq!(view.error, None);
    assert!(
        matches!(view.changes, FileChangeState::Tracked { .. }),
        "{:?}",
        view.changes
    );
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_read_of_a_path_outside_the_project_is_refused_before_it_is_read() {
    let mut world = World::start().await;
    let root = world.folder("helm files");
    world.know(&root).await;
    let outside = world.folder("helm outside");
    write(&outside.join("secret.txt"), "nope");

    for path in [
        outside.join("secret.txt"),
        root.join("..").join("helm outside").join("secret.txt"),
    ] {
        let view = world.read(&root, &path).await.unwrap();
        assert_eq!(view.content, "");
        assert!(
            view.error
                .as_deref()
                .is_some_and(|said| said.contains("not inside")),
            "{view:?}"
        );
    }
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_read_says_a_file_is_gone_binary_or_too_large_rather_than_showing_nothing() {
    let mut world = World::start().await;
    let root = world.folder("helm files");
    world.know(&root).await;

    let gone = world.read(&root, &root.join("missing.txt")).await.unwrap();
    assert!(!gone.exists && gone.error.is_none(), "{gone:?}");

    write(&root.join("blob.bin"), [0u8, 1, 2, 3]);
    let blob = world.read(&root, &root.join("blob.bin")).await.unwrap();
    assert!(
        blob.exists && blob.binary && blob.content.is_empty(),
        "{blob:?}"
    );

    let size = usize::try_from(FILE_VIEW_MAX_BYTES).unwrap() + 1;
    assert_eq!(FILE_VIEW_MAX_BYTES, 5 * 1024 * 1024);
    write(&root.join("huge.log"), vec![b'a'; size]);
    let huge = world.read(&root, &root.join("huge.log")).await.unwrap();
    assert!(
        huge.exists && huge.too_large && huge.content.is_empty(),
        "{:?}",
        (huge.exists, huge.too_large)
    );
    assert_eq!(huge.size, FILE_VIEW_MAX_BYTES + 1);
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_project_reached_through_a_link_reads_as_the_project_and_a_link_out_of_it_is_refused() {
    let mut world = World::start().await;
    let root = world.folder("helm files");
    let elsewhere = world.folder("helm files elsewhere");
    let linked = elsewhere.join("linked project");
    let escape = root.join("escape");
    write(&root.join("a.txt"), "one\n");
    link_folder(&root, &linked);
    world.know(&linked).await;

    let view = world.read(&linked, &linked.join("a.txt")).await.unwrap();
    assert!(view.exists && view.error.is_none(), "{view:?}");
    assert_eq!(view.content, "one\n");
    let missing = world
        .read(&linked, &linked.join("missing.txt"))
        .await
        .unwrap();
    assert!(!missing.exists && missing.error.is_none(), "{missing:?}");

    // Out through a link inside the project, for a file there and one not.
    write(&elsewhere.join("outside").join("secret.txt"), "nope");
    link_folder(&elsewhere.join("outside"), &escape);
    for name in ["secret.txt", "gone.txt"] {
        let secret = world
            .read(&linked, &linked.join("escape").join(name))
            .await
            .unwrap();
        assert_eq!(secret.content, "");
        assert!(
            secret
                .error
                .as_deref()
                .is_some_and(|said| said.contains("not inside")),
            "{secret:?}"
        );
    }
    let through = world.dir(&linked, "escape").await.unwrap();
    assert!(through.entries.is_empty(), "{through:?}");
    assert!(
        through
            .error
            .as_deref()
            .is_some_and(|said| said.contains("link out of this scope")),
        "{through:?}"
    );

    let dirs = world.stop().await;
    NativeLinks.unlink_folder(&escape).unwrap();
    NativeLinks.unlink_folder(&linked).unwrap();
    assert!(elsewhere.join("outside").join("secret.txt").exists());
    drop(dirs);
}

/// The 8.3 alias Windows keeps for an existing folder, or `None` where
/// there is none: off Windows, and on a volume that keeps no short names.
fn short_path(path: &Path) -> Option<PathBuf> {
    let script = format!(
        "(New-Object -ComObject Scripting.FileSystemObject).GetFolder('{}').ShortPath",
        text(path).replace('\'', "''")
    );
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    let short = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    (out.status.success() && !short.is_empty() && short != text(path)).then(|| PathBuf::from(short))
}

#[tokio::test(flavor = "multi_thread")]
async fn a_project_named_by_its_short_alias_reads_as_the_project() {
    let mut world = World::start().await;
    let root = world.folder("helm files long name");
    write(&root.join("a.txt"), "one\n");
    let Some(short) = short_path(&root) else {
        // No 8.3 names here: nothing to read through.
        world.stop().await;
        return;
    };
    world.know(&short).await;
    let view = world.read(&short, &short.join("a.txt")).await.unwrap();
    assert!(view.exists && view.error.is_none(), "{view:?}");
    assert_eq!(view.content, "one\n");
    let missing = world
        .read(&short, &short.join("missing.txt"))
        .await
        .unwrap();
    assert!(!missing.exists && missing.error.is_none(), "{missing:?}");
    let fresh = world
        .read(&short, &short.join("new").join("b.txt"))
        .await
        .unwrap();
    assert!(
        fresh.error.is_none(),
        "a file not made yet is inside: {fresh:?}"
    );
    world.stop().await;
}

// ---------------------------------------------------------------------------
// Listing (core: listProjectFiles; readContentDir through files:dir)
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn the_list_is_what_git_tracks_and_does_not_ignore_relative_to_the_project() {
    let mut world = World::start().await;
    let repo = world.committed_repo("helm files");
    let root = repo.path().to_path_buf();
    world.know(&root).await;
    write(&root.join("src").join("b.ts"), "new\n");
    write(&root.join("build").join("out.js"), "ignored\n");

    let listing = world.list(&root).await.unwrap();
    assert_eq!(listing.source, FileListSource::Git);
    let mut listed = listing.files;
    listed.sort();
    assert_eq!(listed, [".gitignore", "README.md", "src/a.ts", "src/b.ts"]);
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_folder_with_no_repository_is_walked_skipping_what_the_tree_skips() {
    let mut world = World::start().await;
    let root = world.folder("helm files");
    write(&root.join("docs").join("a.md"), "x");
    write(&root.join("top.txt"), "x");
    write(&root.join("node_modules").join("dep").join("index.js"), "x");
    world.know(&root).await;

    let listing = world.list(&root).await.unwrap();
    assert_eq!(
        (listing.source, listing.truncated, listing.error.clone()),
        (FileListSource::Walk, false, None)
    );
    assert_eq!(FILE_LIST_MAX, 50_000);
    let mut listed = listing.files;
    listed.sort();
    assert_eq!(listed, ["docs/a.md", "top.txt"]);
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_folder_lists_its_entries_marking_the_skipped_ones_and_refuses_a_path_out_of_the_root() {
    let mut world = World::start().await;
    let root = world.folder("helm files");
    write(&root.join("src").join("file10.ts"), "x");
    write(&root.join("src").join("file2.ts"), "x");
    write(&root.join("node_modules").join("dep").join("index.js"), "x");
    write(&root.join("README.md"), "x");
    world.know(&root).await;

    let top = world.dir(&root, "").await.unwrap();
    assert_eq!(top.error, None);
    assert_eq!(top.ignore_source, ContentIgnoreReason::Default);
    let names: Vec<(&str, bool)> = top
        .entries
        .iter()
        .map(|entry| (entry.name.as_str(), entry.ignored))
        .collect();
    assert_eq!(
        names,
        [("node_modules", true), ("src", false), ("README.md", false)]
    );
    assert_eq!(top.ignored, 1);

    let src = world.dir(&root, "src").await.unwrap();
    let names: Vec<&str> = src
        .entries
        .iter()
        .map(|entry| entry.rel_path.as_str())
        .collect();
    assert_eq!(names, ["src/file2.ts", "src/file10.ts"]);

    let out = world.dir(&root, "../..").await.unwrap();
    assert!(out.entries.is_empty());
    assert_eq!(out.error.as_deref(), Some("../.. is outside this scope"));
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_folder_in_a_repository_marks_what_git_ignores() {
    let mut world = World::start().await;
    let repo = world.committed_repo("helm files");
    let root = repo.path().to_path_buf();
    write(&root.join("build").join("out.js"), "x");
    world.know(&root).await;

    let top = world.dir(&root, "").await.unwrap();
    assert_eq!(top.ignore_source, ContentIgnoreReason::Gitignore);
    let ignored: Vec<(&str, Option<ContentIgnoreReason>)> = top
        .entries
        .iter()
        .filter(|entry| entry.ignored)
        .map(|entry| (entry.name.as_str(), entry.ignored_by))
        .collect();
    assert_eq!(
        ignored,
        [
            (".git", Some(ContentIgnoreReason::Default)),
            ("build", Some(ContentIgnoreReason::Gitignore))
        ]
    );
    world.stop().await;
}

// ---------------------------------------------------------------------------
// The Files service (main: files.test.ts) and the known-root rule
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn the_files_view_lists_reads_and_reports_status_only_under_a_folder_the_host_knows() {
    let mut world = World::start().await;
    let repo = GitRepo::init(world.folder("helm files-ipc"));
    repo.write("src/a.ts", "one\ntwo\nthree\n");
    repo.commit_all("first");
    let root = repo.path().to_path_buf();
    write(&root.join("src").join("a.ts"), "one\n2\nthree\n");
    world.know(&root).await;

    let listing = world.dir(&root, "src").await.unwrap();
    let names: Vec<&str> = listing
        .entries
        .iter()
        .map(|entry| entry.name.as_str())
        .collect();
    assert_eq!(names, ["a.ts"]);
    assert_eq!(
        world.status(&root).await.unwrap().files,
        files(&[("src/a.ts", GitFileState::Modified)])
    );
    let view = world
        .read(&root, &root.join("src").join("a.ts"))
        .await
        .unwrap();
    assert_eq!(view.content, "one\n2\nthree\n");
    assert_eq!(view.changes, tracked(&[(2, 2)], &[], 1, 0));
    assert_eq!(world.list(&root).await.unwrap().files, ["src/a.ts"]);

    let stranger = world.folder("helm stranger");
    let parent = world.dirs.root().to_path_buf();
    let climbing = root.join("..");
    for unknown in [&stranger, &parent, &climbing] {
        refused_as_unknown(&world.dir(unknown, "").await.unwrap_err(), unknown);
        refused_as_unknown(
            &world.read(unknown, &unknown.join("x")).await.unwrap_err(),
            unknown,
        );
        refused_as_unknown(&world.status(unknown).await.unwrap_err(), unknown);
        refused_as_unknown(&world.list(unknown).await.unwrap_err(), unknown);
    }
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_folder_is_known_once_a_session_starts_in_it_and_not_once_the_session_is_gone() {
    let mut world = World::start().await;
    let root = world.folder("helm session folder");
    write(&root.join("a.txt"), "one\n");
    refused_as_unknown(&world.list(&root).await.unwrap_err(), &root);

    let session = world.know(&root).await;
    assert_eq!(world.list(&root).await.unwrap().files, ["a.txt"]);

    world
        .client
        .request::<SessionClose>(&CloseSessionRequest {
            id: session.id,
            force: true,
        })
        .await
        .unwrap();
    // The session is gone once its process has ended.
    let deadline = Instant::now() + PATIENCE;
    let refused = loop {
        match world.read(&root, &root.join("a.txt")).await {
            Err(said) => break said,
            Ok(_) if Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(50)).await
            }
            Ok(view) => panic!("still read once the session closed: {view:?}"),
        }
    };
    refused_as_unknown(&refused, &root);
    world.stop().await;
}

// ---------------------------------------------------------------------------
// Watching (main: files.test.ts) and per-client delivery
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn the_watching_client_alone_is_told_which_files_changed_once_per_burst_and_not_once_it_lets_go()
 {
    let mut world = World::start().await;
    let repo = GitRepo::init(world.folder("helm files-ipc"));
    repo.write("src/a.ts", "one\ntwo\nthree\n");
    repo.commit_all("first");
    let root = repo.path().to_path_buf();
    let other = world.folder("helm other root");
    world.know(&root).await;
    world.know(&other).await;
    let stranger = world.folder("helm stranger");

    let mut bystander = TestClient::connect(&world.endpoint, CAPABILITIES).await;
    bystander
        .subscribe_quietly(CHANGES, FilesChanged::NAME)
        .await;
    world
        .client
        .subscribe_quietly(CHANGES, FilesChanged::NAME)
        .await;

    // A root the host does not know is not watched and is no error.
    world
        .client
        .request::<WatchFiles>(&FilesWatchRequest {
            roots: vec![text(&root), text(&stranger)],
        })
        .await
        .expect("an unknown root is skipped, not refused");
    until_told(
        &mut world.client,
        &root.join("src").join("a.ts"),
        "src/a.ts",
    )
    .await;

    // One burst, told 250 ms after its first event, naming every path.
    let at = Instant::now();
    write(&root.join("src").join("b.ts"), "b\n");
    write(&root.join("src").join("c d.ts"), "c\n");
    write(&root.join("e.md"), "e\n");
    let first = next_change(&mut world.client, PATIENCE)
        .await
        .expect("the burst is told");
    assert!(
        at.elapsed() >= SETTLE,
        "told {:?} after the first write",
        at.elapsed()
    );
    let mut seen = vec![first];
    seen.extend(changes_until_quiet(&mut world.client, Duration::from_millis(800)).await);
    assert_eq!(seen.len(), 1, "one burst, one telling: {seen:?}");
    assert_eq!(seen[0].root.to_lowercase(), text(&root).to_lowercase());
    let paths = seen[0].paths.clone().expect("a burst this small is named");
    for rel in ["src/b.ts", "src/c d.ts", "e.md"] {
        assert!(paths.iter().any(|path| path == rel), "{rel} in {paths:?}");
    }

    // A commit moves the index, HEAD and refs, told as `.git`; git's other
    // churn is not told.
    repo.commit_all("second");
    let told = changes_until_quiet(&mut world.client, Duration::from_millis(1500)).await;
    let paths: Vec<String> = told
        .iter()
        .flat_map(|change| change.paths.clone().unwrap_or_default())
        .collect();
    assert!(paths.iter().any(|path| path == ".git"), "{told:?}");
    assert!(
        paths.iter().all(|path| !path.starts_with(".git/")),
        "{told:?}"
    );

    // The bystander, subscribed but watching nothing, heard none of it.
    assert_eq!(
        next_change(&mut bystander, Duration::from_millis(300)).await,
        None
    );

    // A root left out of the next request is let go; the one named stays.
    world
        .client
        .request::<WatchFiles>(&FilesWatchRequest {
            roots: vec![text(&other)],
        })
        .await
        .unwrap();
    until_told(&mut world.client, &other.join("probe.txt"), "probe.txt").await;
    write(&root.join("src").join("after.ts"), "after\n");
    let after = changes_until_quiet(&mut world.client, Duration::from_millis(800)).await;
    assert!(after.is_empty(), "a root let go is not watched: {after:?}");

    world
        .client
        .request::<WatchFiles>(&FilesWatchRequest { roots: vec![] })
        .await
        .unwrap();
    write(&other.join("probe.txt"), "last\n");
    assert_eq!(
        next_change(&mut world.client, Duration::from_millis(800)).await,
        None
    );
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_file_list_is_reused_until_a_watch_says_the_files_moved() {
    let mut world = World::start().await;
    let root = world.folder("helm files");
    write(&root.join("a.txt"), "x");
    world.know(&root).await;
    world
        .client
        .subscribe_quietly(CHANGES, FilesChanged::NAME)
        .await;

    assert_eq!(world.list(&root).await.unwrap().files, ["a.txt"]);
    write(&root.join("b.txt"), "x");
    assert_eq!(
        world.list(&root).await.unwrap().files,
        ["a.txt"],
        "reused within 30 s"
    );

    world
        .client
        .request::<WatchFiles>(&FilesWatchRequest {
            roots: vec![text(&root)],
        })
        .await
        .unwrap();
    until_told(&mut world.client, &root.join("c.txt"), "c.txt").await;
    let mut listed = world.list(&root).await.unwrap().files;
    listed.sort();
    assert_eq!(listed, ["a.txt", "b.txt", "c.txt"]);
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_that_disconnects_leaves_no_watch_and_the_others_keep_theirs() {
    let mut world = World::start().await;
    let root = world.folder("helm files");
    world.know(&root).await;
    let mut leaving = TestClient::connect(&world.endpoint, CAPABILITIES).await;
    leaving
        .request::<WatchFiles>(&FilesWatchRequest {
            roots: vec![text(&root)],
        })
        .await
        .unwrap();
    drop(leaving);

    world
        .client
        .subscribe_quietly(CHANGES, FilesChanged::NAME)
        .await;
    world
        .client
        .request::<WatchFiles>(&FilesWatchRequest {
            roots: vec![text(&root)],
        })
        .await
        .unwrap();
    until_told(&mut world.client, &root.join("a.txt"), "a.txt").await;
    world.stop().await;
}
