//! Notes and documents against real folders and a real floti.db: the same
//! inputs and expectations as the desktop's content tests (core's
//! `content.test.ts` and `search.test.ts`, and main's `content.test.ts`),
//! answered by the host's renderer and content service.
//!
//! Every test makes its own folders and its own store, with a space in every
//! path. The last section drives every content channel through a client
//! connection to a running host: a note read and rendered, a draft rendered,
//! a scope searched, a wikilink resolved, a config file rendered, an editor's
//! source highlighted, and artifacts opened, refusals and a file larger than
//! one answer included.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

use floti_host::config_console::{hash_content, normalize, snapshots};
use floti_host::server::{HostConfig, HostRun, backends};
use floti_host::store::Store;
use floti_host::store::projects::{EMPTY_INVENTORY, cache_projects};
use floti_host::testkit::{PATIENCE, RunningHost, TestClient, TestDirs};
use floti_host::workspace::content::ContentService;
use floti_host::workspace::content::guard::ContentGuard;
use floti_host::workspace::content::search::{MAX_HITS, build_corpus, search_corpus};
use floti_host::workspace::content::tree::{
    ContentTree, RootOffer, content_scope, read_content_tree,
};
use floti_host::workspace::render::frontmatter::parse_note_frontmatter;
use floti_host::workspace::render::wikilinks::{
    IndexedFile, WikiIndex, heading_slug, parse_wikilink,
};
use floti_host::workspace::render::{editor_highlight, render_config, render_markdown};
use floti_host::workspace::roots::KnownRoots;
use floti_protocol::channel::{EventChannel, RequestChannel, from_payload, to_payload};
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::workspace::{
    ARTIFACT_PIECE_LEN, AppMode, ArtifactBytes, ArtifactBytesRequest, ArtifactHeader, ArtifactLink,
    ConfigScopeKind, ConfigWriteReason, ContentFileKind, ContentRenderRequest,
    ContentSearchRequest, DiscoveryResult, DiscoveryUpdated, HighlightSource, HostSettingsPatch,
    ListContentScopes, OpenArtifact, Project, ProjectKind, ReadArtifactBytes, ReadContentDocument,
    RenderConfigFile, RenderContent, ResolveWikilink, ScanForProjects, ScanRequest, ScopedFile,
    SearchContent, SourceToRender, WikilinkRequest, WriteConfigRequest, WriteConfigResult,
    WriteSettings,
};
use floti_protocol::{Bytes, Message};
use serde_json::{Value, json};

// ---------------------------------------------------------------------------
// The world: a store, the folders it knows, and the service over them.

struct World {
    store: Arc<Mutex<Store>>,
    sessions: Arc<RwLock<Vec<String>>>,
    content: ContentService,
    /// Last: fields drop in order, and the folder goes only once nothing in it is open.
    dirs: TestDirs,
}

impl World {
    fn new() -> Self {
        let dirs = TestDirs::new();
        let store = Arc::new(Mutex::new(Store::open(&dirs.data).unwrap()));
        let sessions = Arc::new(RwLock::new(Vec::new()));
        let seen = Arc::clone(&sessions);
        let roots = Arc::new(KnownRoots::new(Arc::clone(&store), move || {
            seen.read().unwrap().clone()
        }));
        let content = ContentService::new(Arc::clone(&store), roots);
        Self {
            store,
            sessions,
            content,
            dirs,
        }
    }

    /// `name` as a folder discovery found, `kind` of it.
    fn scanned(&self, name: &str, kind: ProjectKind) -> PathBuf {
        let path = self.dirs.folder(name);
        let project = Project {
            path: path.display().to_string(),
            name: name.to_owned(),
            kind,
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
        normalize(&path)
    }

    fn add_profile(&self, root: &Path) {
        let store = self.store.lock().unwrap();
        store
            .connection()
            .execute(
                "INSERT INTO profiles (name, root, overlays) VALUES (?1, ?2, ?3)",
                rusqlite::params!["Outside", root.display().to_string(), json!([]).to_string()],
            )
            .unwrap();
    }

    /// From here on, the store refuses every snapshot.
    fn break_snapshots(&self) {
        self.store
            .lock()
            .unwrap()
            .connection()
            .execute_batch(
                "CREATE TRIGGER no_snapshots BEFORE INSERT ON config_snapshots \
                 BEGIN SELECT RAISE(ABORT, 'the disk is full'); END;",
            )
            .unwrap();
    }

    fn snapshot_count(&self) -> i64 {
        self.store
            .lock()
            .unwrap()
            .connection()
            .query_row("SELECT count(*) FROM config_snapshots", [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    fn snapshot_content(&self, id: u64) -> String {
        let store = self.store.lock().unwrap();
        snapshots::read(store.connection(), id)
            .unwrap()
            .unwrap()
            .content
    }

    fn write(
        &self,
        scope: &Path,
        path: &Path,
        content: &str,
        expected: Option<String>,
    ) -> Result<WriteConfigResult, String> {
        self.content.write(&WriteConfigRequest {
            scope_path: scope.display().to_string(),
            path: path.display().to_string(),
            content: content.to_owned(),
            expected_hash: expected,
            reason: ConfigWriteReason::Edit,
        })
    }
}

fn put(path: &Path, content: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}

fn text(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap()
}

fn shown(path: &Path) -> String {
    path.display().to_string()
}

/// core's fixture: named roots, a scope-root file, a nested repository, a
/// folder of scripts, a folder of bytes and an empty named root.
fn fixture(root: &Path) {
    put(
        &root.join("notes").join("alpha.md"),
        &[
            "---",
            "type: journal",
            "date: 2026-08-10",
            "tags: [helm, notes]",
            "---",
            "",
            "# Alpha",
            "",
            "Links to [[beta]] and [[nowhere]].",
            "",
        ]
        .join("\n"),
    );
    put(
        &root.join("notes").join("beta.md"),
        "# Beta\n\nAlpha mentions geofencing here.\n",
    );
    put(
        &root
            .join(".claude")
            .join("skills")
            .join("think")
            .join("SKILL.md"),
        "---\nname: think\n---\n\n# think\n",
    );
    put(&root.join("docs").join("SPEC.md"), "# Spec\n");
    put(&root.join("README.md"), "# Readme\n");
    put(
        &root
            .join("repos")
            .join("other")
            .join("notes")
            .join("hidden.md"),
        "# Hidden\n",
    );
    put(
        &root.join("tools").join("rebuild.py"),
        "# rebuild\nprint(\"ok\")\n",
    );
    put(&root.join("tools").join("notes.png"), "not really a png");
    put(
        &root.join("screenshots").join("one.png"),
        "not really a png",
    );
    std::fs::create_dir_all(root.join("context")).unwrap();
}

fn tree_of(root: &Path) -> ContentTree {
    read_content_tree(&content_scope(
        root,
        ConfigScopeKind::Harness,
        Some("fixture"),
    ))
}

fn index_of(files: &[(&'static str, &'static str, &'static str)]) -> WikiIndex {
    WikiIndex::build(files.iter().map(|(path, rel_path, slug)| IndexedFile {
        path,
        rel_path,
        slug,
    }))
}

// ---------------------------------------------------------------------------
// Frontmatter, wikilinks and the renderer (core's content.test.ts).

#[test]
fn frontmatter_parses_lists_and_leaves_the_body_behind() {
    let parsed = parse_note_frontmatter("---\ntype: journal\ntags: [a, b]\n---\n\n# Title\n");
    assert!(parsed.present);
    assert_eq!(parsed.body.trim(), "# Title");
    let tags = parsed
        .fields
        .iter()
        .find(|field| field.key == "tags")
        .unwrap();
    assert_eq!(tags.values, ["a", "b"]);
}

#[test]
fn frontmatter_treats_an_unclosed_fence_as_a_document() {
    let parsed = parse_note_frontmatter("---\nnot closed\n\n# Title\n");
    assert!(!parsed.present);
    assert!(parsed.body.contains("# Title"));
}

#[test]
fn frontmatter_reports_a_broken_block_rather_than_rendering_it_as_text() {
    let parsed = parse_note_frontmatter("---\n: : :\n\ta\n---\nbody\n");
    assert!(parsed.present);
    assert!(parsed.error.is_some());
    assert_eq!(parsed.body.trim(), "body");
}

const VAULT: [(&str, &str, &str); 3] = [
    ("C:/v/notes/beta.md", "notes/beta.md", "beta"),
    ("C:/v/docs/beta.md", "docs/beta.md", "beta"),
    ("C:/v/notes/gamma.md", "notes/gamma.md", "gamma"),
];

#[test]
fn a_wikilink_splits_its_heading_before_its_alias() {
    let link = parse_wikilink("note#Section|Read this", false);
    assert_eq!(link.target, "note");
    assert_eq!(link.heading.as_deref(), Some("Section"));
    assert_eq!(link.label, "Read this");
}

#[test]
fn a_wikilink_resolves_by_bare_name_prefers_a_path_spelling_and_breaks_on_nothing() {
    let index = index_of(&VAULT);
    let resolve = |raw: &str| index.resolve(&parse_wikilink(raw, false), None);
    assert_eq!(resolve("gamma").as_deref(), Some("C:/v/notes/gamma.md"));
    assert_eq!(resolve("docs/beta").as_deref(), Some("C:/v/docs/beta.md"));
    assert_eq!(resolve("nothing-here"), None);
}

#[test]
fn headings_slug_the_same_way_on_both_ends() {
    assert_eq!(
        heading_slug("The Mechanism: what it does"),
        "the-mechanism-what-it-does"
    );
}

#[test]
fn rendering_never_emits_the_frontmatter_as_text() {
    let out = render_markdown("---\ntype: journal\n---\n\n# Hello\n", None, None);
    assert!(!out.html.contains("type: journal"), "{}", out.html);
    assert!(out.html.contains("<h1"));
    assert!(out.frontmatter.present);
    let first = &out.frontmatter.fields[0];
    assert_eq!(
        (
            first.key.as_str(),
            first.value.as_str(),
            first.values.clone()
        ),
        ("type", "journal", vec!["journal".to_owned()])
    );
}

#[test]
fn rendering_keeps_gfm_tables_and_task_list_state() {
    let out = render_markdown(
        "| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- [x] done\n- [ ] not done\n",
        None,
        None,
    );
    assert_eq!(out.counts.tables, 1);
    assert_eq!(out.counts.task_items, 2);
    assert_eq!(out.counts.task_items_checked, 1);
    assert!(out.html.contains("checked"));
}

#[test]
fn a_fenced_block_is_highlighted_in_both_themes_and_labelled_with_its_language() {
    let out = render_markdown("```ts\nconst a: number = 1\n```\n", None, None);
    assert_eq!(out.counts.code_blocks, 1);
    assert_eq!(out.counts.highlighted_blocks, 1);
    assert!(
        out.html.contains("data-language=\"typescript\""),
        "{}",
        out.html
    );
    assert!(out.html.contains("--shiki-light"));
    assert!(out.html.contains("--shiki-dark"));
}

#[test]
fn an_unknown_language_is_plain_text_and_listed() {
    let out = render_markdown("```notalanguage\nhello\n```\n", None, None);
    assert_eq!(out.counts.code_blocks, 1);
    assert_eq!(out.counts.highlighted_blocks, 0);
    assert_eq!(out.unknown_languages, ["notalanguage"]);
}

#[test]
fn a_broken_wikilink_is_marked_and_a_live_one_resolved() {
    let index = index_of(&[("C:/v/notes/beta.md", "notes/beta.md", "beta")]);
    let out = render_markdown("See [[beta]] and [[missing]].\n", Some(&index), None);
    assert_eq!(out.counts.wikilinks, 2);
    assert_eq!(out.counts.broken_wikilinks, 1);
    assert!(
        out.html
            .contains("data-wikilink-path=\"C:/v/notes/beta.md\"")
    );
    assert!(out.html.contains("wikilink-broken"));
}

#[test]
fn a_bracket_inside_code_is_not_a_wikilink() {
    let out = render_markdown("Inline `[[not a link]]` stays.\n", None, None);
    assert_eq!(out.counts.wikilinks, 0);
    assert!(out.html.contains("[[not a link]]"));
}

#[test]
fn a_wikilink_whose_alias_is_markup_is_still_one_link() {
    let index = index_of(&[("C:/v/notes/beta.md", "notes/beta.md", "beta")]);
    for alias in ["`code`", "**bold**", "_thin_"] {
        let out = render_markdown(&format!("See [[beta|{alias}]] now.\n"), Some(&index), None);
        assert_eq!(out.counts.wikilinks, 1, "{alias}");
        assert_eq!(out.counts.broken_wikilinks, 0, "{alias}");
        assert!(
            out.html
                .contains("data-wikilink-path=\"C:/v/notes/beta.md\""),
            "{alias}"
        );
        assert!(!out.html.contains("[["), "{alias}: {}", out.html);
    }
}

#[test]
fn an_ordinary_wikilink_after_a_spanned_one_is_still_found() {
    let index = index_of(&[
        ("C:/v/notes/beta.md", "notes/beta.md", "beta"),
        ("C:/v/notes/gamma.md", "notes/gamma.md", "gamma"),
    ]);
    let out = render_markdown(
        "Off [[beta|`alias`]], then see [[gamma]] after.\n",
        Some(&index),
        None,
    );
    assert_eq!(out.counts.wikilinks, 2);
    assert_eq!(out.counts.broken_wikilinks, 0);
    let targets: Vec<&str> = out.links.iter().map(|link| link.target.as_str()).collect();
    assert_eq!(targets, ["beta", "gamma"]);
    assert!(
        out.html
            .contains("data-wikilink-path=\"C:/v/notes/gamma.md\"")
    );
}

#[test]
fn a_spanned_link_is_labelled_with_its_alias_text_and_no_markup() {
    let index = index_of(&[("C:/v/notes/beta.md", "notes/beta.md", "beta")]);
    let out = render_markdown("See [[beta|`project-pane-hub`]].\n", Some(&index), None);
    assert_eq!(out.links[0].label, "project-pane-hub");
    assert!(out.html.contains(">project-pane-hub</a>"), "{}", out.html);
    assert!(!out.html.contains("<code>"));
}

#[test]
fn an_unclosed_or_block_spanning_bracket_pair_stays_the_text_it_is() {
    for source in [
        "A stray [[open `bracket` with no closer.\n",
        "A pair [[across `code`\n\nand a paragraph]] break.\n",
    ] {
        let out = render_markdown(source, None, None);
        assert_eq!(out.counts.wikilinks, 0, "{source}");
        assert!(out.html.contains("[["), "{source}");
    }
}

#[test]
fn a_callout_renders_as_an_admonition_not_a_quotation() {
    let out = render_markdown(
        "> [!warning] Supersedes the SDK draft\n> The body.\n",
        None,
        None,
    );
    assert_eq!(out.counts.callouts, 1);
    assert!(
        out.html.contains("data-callout=\"warning\""),
        "{}",
        out.html
    );
    assert!(out.html.contains("Supersedes the SDK draft"));
    assert!(!out.html.contains("[!warning]"));
}

#[test]
fn tags_are_shown_and_hashes_that_are_not_tags_ignored() {
    let out = render_markdown(
        "A #helm tag, see https://x.test/#frag and issue #12.\n",
        None,
        None,
    );
    assert_eq!(out.tags, ["helm"]);
}

#[test]
fn no_script_a_note_contains_survives_sanitising() {
    let out = render_markdown(
        "Hello\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n\
         <a href=\"javascript:alert(1)\">x</a> <iframe src=\"https://x.test\"></iframe>\n",
        None,
        None,
    );
    let lower = out.html.to_lowercase();
    for banned in ["<script", "onerror", "javascript:", "<iframe"] {
        assert!(!lower.contains(banned), "{banned} survived: {}", out.html);
    }
}

#[test]
fn every_heading_gets_an_anchor_a_wikilink_can_aim_at() {
    let out = render_markdown("# One\n\n## Two Words\n", None, None);
    let slugs: Vec<&str> = out
        .headings
        .iter()
        .map(|heading| heading.slug.as_str())
        .collect();
    assert_eq!(slugs, ["one", "two-words"]);
    assert!(out.html.contains("data-heading=\"two-words\""));
}

// ---------------------------------------------------------------------------
// The tree (core's readContentTree tests).

#[test]
fn the_tree_finds_the_named_roots_the_scope_root_and_nothing_inside_repos() {
    let dirs = TestDirs::new();
    let root = dirs.folder("my harness");
    fixture(&root);
    let tree = tree_of(&root);
    let roots: Vec<&str> = tree
        .roots
        .iter()
        .map(|root| root.rel_path.as_str())
        .collect();
    for expected in ["notes", "docs", ".claude/skills", ""] {
        assert!(roots.contains(&expected), "{expected} in {roots:?}");
    }
    assert!(
        !tree
            .files
            .iter()
            .any(|file| file.rel_path.starts_with("repos/"))
    );
    let alpha = tree.files.iter().find(|file| file.slug == "alpha").unwrap();
    assert_eq!(alpha.note_type.as_deref(), Some("journal"));
    assert_eq!(alpha.tags, ["helm", "notes"]);
    assert_eq!(alpha.title, "Alpha");
    let skill = tree
        .files
        .iter()
        .find(|file| file.rel_path == ".claude/skills/think/SKILL.md")
        .unwrap();
    assert_eq!(skill.title, "think");
}

#[test]
fn the_tree_offers_a_folder_of_scripts_and_not_one_of_bytes() {
    let dirs = TestDirs::new();
    let root = dirs.folder("my harness");
    fixture(&root);
    let tree = tree_of(&root);
    let rels: Vec<&str> = tree
        .roots
        .iter()
        .map(|root| root.rel_path.as_str())
        .collect();
    assert!(rels.contains(&"tools"));
    assert!(!rels.contains(&"screenshots"));
    assert!(
        !tree
            .files
            .iter()
            .any(|file| file.rel_path == "screenshots/one.png")
    );
    let tools = tree
        .roots
        .iter()
        .find(|root| root.rel_path == "tools")
        .unwrap();
    assert_eq!(tools.offer, RootOffer::Discovered);
}

#[test]
fn the_tree_lists_every_file_inside_a_root_it_offers_binary_included() {
    let dirs = TestDirs::new();
    let root = dirs.folder("my harness");
    fixture(&root);
    let tree = tree_of(&root);
    let find = |rel: &str| tree.files.iter().find(|file| file.rel_path == rel).unwrap();
    let in_tools: Vec<&str> = tree
        .files
        .iter()
        .filter(|file| file.root == "tools")
        .map(|file| file.rel_path.as_str())
        .collect();
    assert!(in_tools.contains(&"tools/rebuild.py"));
    assert!(in_tools.contains(&"tools/notes.png"));
    assert_eq!(find("tools/rebuild.py").kind, ContentFileKind::Source);
    assert_eq!(find("tools/notes.png").kind, ContentFileKind::Binary);
    assert_eq!(find("tools/rebuild.py").ext, "py");
    assert_eq!(find("tools/rebuild.py").title, "rebuild.py");
    assert_eq!(find("tools/notes.png").title, "notes.png");
}

#[test]
fn the_tree_gives_a_dotfile_a_name_rather_than_an_empty_one() {
    let dirs = TestDirs::new();
    let root = dirs.folder("my harness");
    fixture(&root);
    put(&root.join("tools").join(".gitignore"), "out/\n");
    let tree = tree_of(&root);
    let dotfile = tree
        .files
        .iter()
        .find(|file| file.rel_path == "tools/.gitignore")
        .unwrap();
    assert_eq!(dotfile.title, ".gitignore");
    assert_eq!(dotfile.slug, ".gitignore");
    assert_eq!(dotfile.kind, ContentFileKind::Source);
}

#[test]
fn the_tree_keeps_an_empty_named_root_badged_named() {
    let dirs = TestDirs::new();
    let root = dirs.folder("my harness");
    fixture(&root);
    let tree = tree_of(&root);
    let context = tree
        .roots
        .iter()
        .find(|root| root.rel_path == "context")
        .unwrap();
    assert_eq!(context.files, 0);
    assert_eq!(context.offer, RootOffer::Named);
    assert!(!tree.files.iter().any(|file| file.root == "context"));
}

// ---------------------------------------------------------------------------
// Search (core's content.test.ts and search.test.ts).

#[test]
fn search_matches_inside_a_word_and_reports_the_line() {
    let dirs = TestDirs::new();
    let root = dirs.folder("my harness");
    fixture(&root);
    let tree = tree_of(&root);
    let result = search_corpus(
        &build_corpus("scope", &tree.files),
        "geofenc",
        true,
        MAX_HITS,
    );
    assert_eq!(result.total_matches, 1);
    assert!(result.hits[0].lines[0].text.contains("geofencing"));
}

#[test]
fn search_finds_an_html_file_by_name_without_reading_its_contents() {
    let dirs = TestDirs::new();
    let root = dirs.folder("my harness");
    fixture(&root);
    put(
        &root.join("notes").join("dashboard.html"),
        "<style>notes { color: red }</style>",
    );
    let tree = tree_of(&root);
    let corpus = build_corpus("scope", &tree.files);
    let by_name = search_corpus(&corpus, "dashboard", true, MAX_HITS);
    let hit = by_name
        .hits
        .iter()
        .find(|hit| hit.rel_path == "notes/dashboard.html")
        .unwrap();
    assert!(hit.name_match);
    let by_body = search_corpus(&corpus, "color: red", true, MAX_HITS);
    assert!(
        !by_body
            .hits
            .iter()
            .any(|hit| hit.rel_path == "notes/dashboard.html")
    );
}

/// One file per kind, each saying "quokka" in its body, so a kind whose body
/// is skipped shows as a count that comes up short.
const BODIES: [(&str, &str); 6] = [
    (
        "notes/zebra.md",
        "# Zebra\n\nQuokka quokka.\nA QUOKKA again.\n",
    ),
    ("notes/data.json", "{ \"animal\": \"quokka\" }\n"),
    ("notes/plain.txt", "quokka, then quokka\n"),
    ("notes/tool.py", "print(\"quokka\")\n"),
    ("notes/page.html", "<p>quokka quokka quokka</p>\n"),
    ("notes/blob.png", "quokka in bytes"),
];
const READ: [&str; 4] = [
    "notes/zebra.md",
    "notes/data.json",
    "notes/plain.txt",
    "notes/tool.py",
];

fn search_fixture(root: &Path) -> floti_host::workspace::content::search::ContentCorpus {
    for (rel, body) in BODIES {
        put(&root.join(rel), body);
    }
    // Past the 4 MB ceiling and full of the word, so reading it would show.
    let huge = "quokka filler line\n".repeat((4 * 1024 * 1024 + 4096) / 19 + 1);
    put(&root.join("notes").join("huge.md"), &huge);
    let tree = read_content_tree(&content_scope(root, ConfigScopeKind::Project, None));
    let mut listed: Vec<&str> = tree
        .files
        .iter()
        .map(|file| file.rel_path.as_str())
        .collect();
    listed.sort_unstable();
    let mut expected: Vec<&str> = BODIES.iter().map(|(rel, _)| *rel).collect();
    expected.push("notes/huge.md");
    expected.sort_unstable();
    assert_eq!(listed, expected);
    build_corpus("scope", &tree.files)
}

fn occurrences(term: &str) -> u32 {
    let term = term.to_lowercase();
    READ.iter()
        .map(|rel| {
            let body = BODIES.iter().find(|(path, _)| path == rel).unwrap().1;
            u32::try_from(body.to_lowercase().matches(&term).count()).unwrap()
        })
        .sum()
}

#[test]
fn search_reads_bodies_for_markdown_data_text_and_source_only_and_says_so() {
    let dirs = TestDirs::new();
    let corpus = search_fixture(&dirs.folder("search scope"));
    let result = search_corpus(&corpus, "quokka", true, MAX_HITS);
    let mut kinds = result.body_kinds.clone();
    kinds.sort_by_key(|kind| format!("{kind:?}"));
    assert_eq!(
        kinds,
        [
            ContentFileKind::Data,
            ContentFileKind::Markdown,
            ContentFileKind::Source,
            ContentFileKind::Text
        ]
    );
    assert_eq!(result.files_searched, 7);
    assert_eq!(result.files_with_text, 4);
    let mut matched: Vec<(&str, u32)> = result
        .hits
        .iter()
        .map(|hit| (hit.rel_path.as_str(), hit.matches))
        .collect();
    matched.sort_unstable();
    assert_eq!(
        matched,
        [
            ("notes/data.json", 1),
            ("notes/plain.txt", 2),
            ("notes/tool.py", 1),
            ("notes/zebra.md", 3)
        ]
    );
}

#[test]
fn search_matches_a_file_over_4_mb_by_its_name_only() {
    let dirs = TestDirs::new();
    let corpus = search_fixture(&dirs.folder("search scope"));
    let result = search_corpus(&corpus, "huge", true, MAX_HITS);
    let hits: Vec<(&str, bool, u32)> = result
        .hits
        .iter()
        .map(|hit| (hit.rel_path.as_str(), hit.name_match, hit.matches))
        .collect();
    assert_eq!(hits, [("notes/huge.md", true, 0)]);
    assert_eq!(
        search_corpus(&corpus, "filler", true, MAX_HITS).total_matches,
        0
    );
}

#[test]
fn search_totals_every_occurrence_for_terms_that_match_many_part_of_a_word_or_nothing() {
    let dirs = TestDirs::new();
    let corpus = search_fixture(&dirs.folder("search scope"));
    for term in ["quokka", "QUOKKA", "okk", "quokka.", "wombat"] {
        let result = search_corpus(&corpus, term, false, MAX_HITS);
        assert_eq!(result.total_matches, occurrences(term), "{term}");
    }
    assert_eq!(occurrences("wombat"), 0);
    assert!(
        search_corpus(&corpus, "wombat", false, MAX_HITS)
            .hits
            .is_empty()
    );
}

#[test]
fn search_caps_the_hit_list_at_200_files_and_keeps_counting_past_it() {
    let dirs = TestDirs::new();
    let root = dirs.folder("search cap");
    for i in 0..205 {
        put(
            &root.join("notes").join(format!("n{i:03}.md")),
            "needle and needle\n",
        );
    }
    let tree = read_content_tree(&content_scope(&root, ConfigScopeKind::Project, None));
    assert_eq!(tree.files.len(), 205);
    let result = search_corpus(
        &build_corpus("scope", &tree.files),
        "needle",
        true,
        MAX_HITS,
    );
    assert_eq!(result.hits.len(), 200);
    assert!(result.truncated);
    assert_eq!(result.total_matches, 205 * 2);
}

// ---------------------------------------------------------------------------
// The write guard (core's assertContentWritable tests).

#[test]
fn the_guard_allows_a_script_an_extensionless_file_a_note_and_a_skill() {
    let dirs = TestDirs::new();
    let v = dirs.folder("v");
    for rel in [
        "tools/rebuild.py",
        "LICENSE",
        "notes/a.md",
        ".claude/skills/x/SKILL.md",
    ] {
        let path = rel.split('/').fold(v.clone(), |path, part| path.join(part));
        assert_eq!(ContentGuard::check(&v, &path), Ok(()), "{rel}");
    }
}

#[test]
fn the_guard_refuses_outside_the_scope_a_nested_repository_and_a_binary() {
    let dirs = TestDirs::new();
    let v = dirs.folder("v");
    let outside = v.join("..").join("other").join("notes").join("a.md");
    assert!(
        ContentGuard::check(&v, &outside)
            .unwrap_err()
            .contains("not inside")
    );
    let nested = v.join("repos").join("x").join("notes").join("a.md");
    assert!(
        ContentGuard::check(&v, &nested)
            .unwrap_err()
            .contains("not content")
    );
    let binary = v.join("notes").join("a.exe");
    assert!(
        ContentGuard::check(&v, &binary)
            .unwrap_err()
            .contains("binary")
    );
}

// ---------------------------------------------------------------------------
// The service: scopes, reading, rendering, searching, wikilinks, artifacts.

#[test]
fn scopes_are_harnesses_then_projects_then_profile_roots_read_per_call() {
    let world = World::new();
    let project = world.scanned("a project", ProjectKind::Folder);
    let harness = world.scanned("the harness", ProjectKind::Harness);
    let outside = world.dirs.folder("elsewhere tooling");
    let session = world.dirs.folder("a session folder");
    world.sessions.write().unwrap().push(shown(&session));

    let lower = |world: &World| -> Vec<String> {
        world
            .content
            .scopes()
            .unwrap()
            .iter()
            .map(|scope| scope.path.to_lowercase())
            .collect()
    };
    assert_eq!(
        lower(&world),
        [
            shown(&harness).to_lowercase(),
            shown(&project).to_lowercase()
        ]
    );

    // Asked again, which is what Refresh does: the list is read per call.
    world.add_profile(&outside);
    let scopes = world.content.scopes().unwrap();
    assert_eq!(scopes.len(), 3);
    assert_eq!(scopes[0].kind, ConfigScopeKind::Harness);
    assert_eq!(scopes[0].label, "the harness");
    assert_eq!(
        scopes[2].path.to_lowercase(),
        shown(&normalize(&outside)).to_lowercase()
    );
    assert_eq!(scopes[2].label, "elsewhere tooling");

    // A session's folder is reachable without being offered.
    put(&session.join("notes").join("today.md"), "# Today\n");
    let document = world
        .content
        .document(
            &shown(&session),
            &shown(&session.join("notes").join("today.md")),
        )
        .unwrap();
    assert_eq!(document.file.title, "Today");
}

#[test]
fn a_document_reads_renders_and_resolves_its_wikilinks_against_its_scope() {
    let world = World::new();
    let scope = world.scanned("my harness", ProjectKind::Harness);
    fixture(&scope);
    let alpha = scope.join("notes").join("alpha.md");

    let document = world
        .content
        .document(&shown(&scope), &shown(&alpha))
        .unwrap();
    assert_eq!(document.file.rel_path, "notes/alpha.md");
    assert_eq!(document.file.note_type.as_deref(), Some("journal"));
    assert_eq!(document.content.hash, hash_content(&text(&alpha)));
    let rendered = document.rendered.unwrap();
    assert_eq!(rendered.counts.wikilinks, 2);
    assert_eq!(rendered.counts.broken_wikilinks, 1);
    let beta = rendered
        .links
        .iter()
        .find(|link| link.target == "beta")
        .unwrap();
    assert_eq!(
        beta.resolved.as_deref().map(str::to_lowercase),
        Some(shown(&scope.join("notes").join("beta.md")).to_lowercase())
    );
    assert_eq!(document.error, None);

    // A file the walk never listed opens with its real kind.
    let script = scope.join("repos").join("other").join("build.py");
    put(&script, "print(1)\n");
    let unlisted = world
        .content
        .document(&shown(&scope), &shown(&script))
        .unwrap();
    assert_eq!(unlisted.file.kind, ContentFileKind::Source);
    assert_eq!(unlisted.file.rel_path, "repos/other/build.py");
    assert!(unlisted.rendered.is_none());

    // A file that went away says so; the source pane shows nothing.
    let gone = world
        .content
        .document(&shown(&scope), &shown(&scope.join("notes").join("gone.md")))
        .unwrap();
    assert_eq!(
        gone.error.as_deref(),
        Some("That file is not there any more.")
    );
    assert!(!gone.content.exists);

    // A draft renders against the same scope.
    let draft = world
        .content
        .render(
            &shown(&scope),
            &shown(&alpha),
            "Now [[beta]] and [[gamma]].\n",
        )
        .unwrap();
    assert_eq!(draft.counts.broken_wikilinks, 1);

    // The frame's clicks resolve beside the file they came from.
    let link = world
        .content
        .wikilink(&shown(&scope), "beta", &shown(&alpha))
        .unwrap();
    assert!(link.is_some());
    assert_eq!(
        world
            .content
            .wikilink(&shown(&scope), "nowhere", &shown(&alpha)),
        Ok(None)
    );
}

#[test]
fn a_search_is_cold_once_then_warm_and_a_save_makes_it_cold_again() {
    let world = World::new();
    let scope = world.scanned("my harness", ProjectKind::Harness);
    fixture(&scope);
    let first = world.content.search(&shown(&scope), "geofenc").unwrap();
    assert!(first.cold);
    assert_eq!(first.total_matches, 1);
    assert!(
        !world
            .content
            .search(&shown(&scope), "geofenc")
            .unwrap()
            .cold
    );

    let beta = scope.join("notes").join("beta.md");
    let before = hash_content(&text(&beta));
    world
        .write(
            &scope,
            &beta,
            "# Beta\n\ngeofencing and geofences.\n",
            Some(before),
        )
        .unwrap();
    let after = world.content.search(&shown(&scope), "geofenc").unwrap();
    assert!(after.cold);
    assert_eq!(after.total_matches, 2);
}

/// main's fixture: a note, its neighbour, an artifact linking to one of them
/// and to nothing, a script beside it, and a secret one folder up.
const SECRET: &str = "TOP SECRET BYTES";

fn artifact_world() -> (World, PathBuf, PathBuf) {
    let world = World::new();
    let scope = world.scanned("alpha project", ProjectKind::Folder);
    let notes = scope.join("notes");
    put(&notes.join("first.md"), "# First\n\nSee [[second]].\n");
    put(&notes.join("second.md"), "# Second\n");
    put(
        &notes.join("lesson.html"),
        "<!doctype html><html><head><title>Lesson</title></head><body><p>Read [[second]] and [[unwritten]].</p></body></html>\n",
    );
    put(&notes.join("chart.js"), "window.chart = 1\n");
    put(&scope.join("secret.txt"), SECRET);
    (world, scope, notes)
}

#[test]
fn an_artifact_refuses_a_path_out_of_its_folder_encoded_or_not_and_leaks_no_bytes() {
    let (world, scope, notes) = artifact_world();
    let link = world
        .content
        .artifact(&shown(&scope), &shown(&notes.join("lesson.html")))
        .unwrap();
    assert!(
        link.url
            .starts_with(&format!("floti-artifact://{}/", link.token))
    );
    assert!(link.url.ends_with("/lesson.html"));
    let base = &link.url[..link.url.rfind('/').unwrap()];

    for escape in [
        "..%2fsecret.txt",
        "../secret.txt",
        "..%5csecret.txt",
        "%2e%2e/secret.txt",
    ] {
        let answer = world.content.serve_artifact(&format!("{base}/{escape}"));
        assert_ne!(answer.status, 200, "{escape}");
        assert!(
            !String::from_utf8_lossy(&answer.body).contains(SECRET),
            "{escape} leaked"
        );
    }
    assert_eq!(
        world
            .content
            .serve_artifact(&format!("{base}/..%2fsecret.txt"))
            .status,
        403
    );
    // A token the host never minted addresses nothing.
    assert_eq!(
        world
            .content
            .serve_artifact("floti-artifact://0123456789abcdef/lesson.html")
            .status,
        404
    );
    assert_eq!(
        world
            .content
            .serve_artifact("https://x.test/lesson.html")
            .status,
        400
    );

    // Only a folder the host knows can be pinned.
    let stranger = world.dirs.folder("stranger");
    put(&stranger.join("page.html"), "<p>x</p>");
    let refused = world
        .content
        .artifact(&shown(&stranger), &shown(&stranger.join("page.html")))
        .unwrap_err();
    assert!(refused.contains("is not a folder Floti knows"), "{refused}");
}

#[test]
fn an_artifacts_neighbour_is_served_under_a_policy_that_names_no_network() {
    let (world, scope, notes) = artifact_world();
    let link = world
        .content
        .artifact(&shown(&scope), &shown(&notes.join("lesson.html")))
        .unwrap();
    let base = &link.url[..link.url.rfind('/').unwrap()];
    let sibling = world.content.serve_artifact(&format!("{base}/chart.js"));
    assert_eq!(sibling.status, 200);
    assert_eq!(sibling.body, std::fs::read(notes.join("chart.js")).unwrap());
    assert_eq!(
        sibling.header("content-type"),
        Some("text/javascript; charset=utf-8")
    );
    assert_eq!(sibling.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(sibling.header("cache-control"), Some("no-store"));
    let csp = sibling.header("content-security-policy").unwrap();
    let directives: Vec<&str> = csp.split(';').map(str::trim).collect();
    assert!(directives.contains(&"default-src 'none'"));
    assert!(directives.contains(&"connect-src 'none'"));
    assert!(!csp.contains("http:") && !csp.contains("https:"), "{csp}");
}

#[test]
fn an_artifact_is_told_which_wikilinks_resolve_and_nothing_about_where() {
    let (world, scope, notes) = artifact_world();
    let link = world
        .content
        .artifact(&shown(&scope), &shown(&notes.join("lesson.html")))
        .unwrap();
    let entry = world.content.serve_artifact(&link.url);
    assert_eq!(entry.status, 200);
    assert_eq!(
        entry.header("content-type"),
        Some("text/html; charset=utf-8")
    );
    let html = String::from_utf8(entry.body).unwrap();

    let open = "<script type=\"application/json\" data-helm-wikilinks>";
    let start = html.find(open).unwrap() + open.len();
    let end = start + html[start..].find("</script>").unwrap();
    let island: Value = serde_json::from_str(&html[start..end]).unwrap();
    assert_eq!(island, json!({ "second": true, "unwritten": false }));
    assert!(html.find(open).unwrap() < html.rfind("</body>").unwrap());

    let lower = html.to_lowercase();
    for path in [
        world.dirs.root().to_path_buf(),
        scope.clone(),
        notes.clone(),
    ] {
        let path = shown(&path);
        let escaped = serde_json::to_string(&path).unwrap();
        for spelling in [
            path.clone(),
            path.replace('\\', "/"),
            escaped[1..escaped.len() - 1].to_owned(),
        ] {
            assert!(
                !lower.contains(&spelling.to_lowercase()),
                "{spelling} leaked"
            );
        }
    }

    // A neighbour is served verbatim, with no bootstrap.
    let base = &link.url[..link.url.rfind('/').unwrap()];
    let script = world.content.serve_artifact(&format!("{base}/chart.js"));
    assert!(!String::from_utf8_lossy(&script.body).contains("data-helm-wikilinks"));
}

#[test]
fn the_editor_highlighter_stops_past_its_ceiling_and_says_so() {
    let big = "const value = \"x\"\n".repeat((512 * 1024 + 1024) / 18 + 1);
    let too_large = editor_highlight("notes/big.ts", &big);
    assert!(too_large.too_large);
    assert!(!too_large.highlighted);
    assert!(too_large.lines.is_empty());

    let small = editor_highlight("notes/small.ts", "const value = 1\n");
    assert!(!small.too_large);
    assert!(small.highlighted);
    assert!(!small.lines.is_empty());
}

#[test]
fn a_config_file_renders_as_markdown_or_as_highlighted_source() {
    let note = render_config("CLAUDE.md", "# Rules\n\n- one\n");
    assert!(note.code.is_none());
    assert!(note.markdown.unwrap().html.contains("<h1"));
    let settings = render_config("settings.json", "{ \"model\": \"opus\" }\n");
    assert!(settings.markdown.is_none());
    let code = settings.code.unwrap();
    assert!(code.highlighted);
    assert!(code.html.contains("--shiki-dark"));
}

// ---------------------------------------------------------------------------
// Writing a note: snapshot first, conflicts, aborts, history and restore.

#[test]
fn a_save_takes_a_snapshot_of_the_old_bytes_before_writing_the_new() {
    let world = World::new();
    let scope = world.scanned("my harness", ProjectKind::Harness);
    let note = scope.join("notes").join("today.md");
    put(&note, "# Before\n");

    let saved = world
        .write(&scope, &note, "# After\n", Some(hash_content("# Before\n")))
        .unwrap();
    assert!(saved.ok);
    assert_eq!(text(&note), "# After\n");
    assert_eq!(saved.file.hash, hash_content("# After\n"));
    let id = saved.snapshot_id.unwrap();
    assert_eq!(world.snapshot_content(id), "# Before\n");

    // Saving the same bytes again writes nothing and takes no snapshot.
    let again = world
        .write(&scope, &note, "# After\n", Some(hash_content("# After\n")))
        .unwrap();
    assert!(again.unchanged);
    assert_eq!(world.snapshot_count(), 1);
}

#[test]
fn a_save_over_a_file_that_changed_outside_is_a_conflict_and_writes_nothing() {
    let world = World::new();
    let scope = world.scanned("my harness", ProjectKind::Harness);
    let note = scope.join("notes").join("today.md");
    put(&note, "# Opened\n");
    let opened = hash_content("# Opened\n");
    put(&note, "# Changed by an agent\n");

    let answer = world
        .write(&scope, &note, "# Mine\n", Some(opened))
        .unwrap();
    assert!(!answer.ok);
    let conflict = answer.conflict.unwrap();
    assert_eq!(conflict.on_disk_content, "# Changed by an agent\n");
    assert_eq!(
        conflict.on_disk_hash,
        hash_content("# Changed by an agent\n")
    );
    assert_eq!(text(&note), "# Changed by an agent\n");
    assert_eq!(world.snapshot_count(), 0);

    // No expected hash means "this file is new", so an existing one conflicts.
    let fresh = world.write(&scope, &note, "# Mine\n", None).unwrap();
    assert!(fresh.conflict.is_some());
}

#[test]
fn a_save_whose_snapshot_cannot_be_taken_is_aborted_and_the_file_left_alone() {
    let world = World::new();
    let scope = world.scanned("my harness", ProjectKind::Harness);
    let note = scope.join("notes").join("today.md");
    put(&note, "# Before\n");
    world.break_snapshots();

    let refused = world
        .write(&scope, &note, "# After\n", Some(hash_content("# Before\n")))
        .unwrap_err();
    assert!(refused.contains("could not take a snapshot"), "{refused}");
    assert!(refused.contains("the disk is full"), "{refused}");
    assert_eq!(text(&note), "# Before\n");

    let created = scope.join("notes").join("new.md");
    assert!(world.write(&scope, &created, "# New\n", None).is_err());
    assert!(!created.exists());
}

#[test]
fn a_notes_snapshots_list_newest_first_and_a_restore_snapshots_the_current_bytes_first() {
    let world = World::new();
    let scope = world.scanned("my harness", ProjectKind::Harness);
    let note = scope.join("notes").join("today.md");
    put(&note, "one\n");
    world
        .write(&scope, &note, "two\n", Some(hash_content("one\n")))
        .unwrap();
    world
        .write(&scope, &note, "three\n", Some(hash_content("two\n")))
        .unwrap();

    let versions = world
        .content
        .snapshots(&shown(&scope), &shown(&note))
        .unwrap();
    assert_eq!(versions.len(), 2);
    assert_eq!(versions[0].file_path, "notes/today.md");
    assert_eq!(
        versions[0].scope_path.to_lowercase(),
        shown(&scope).to_lowercase()
    );
    assert_eq!(world.snapshot_content(versions[0].id), "two\n");
    assert_eq!(world.snapshot_content(versions[1].id), "one\n");

    let oldest = versions[1].id;
    let restored = world.content.restore(oldest, &shown(&note)).unwrap();
    assert!(restored.ok);
    assert_eq!(text(&note), "one\n");
    let taken = restored.snapshot_id.unwrap();
    assert_eq!(world.snapshot_content(taken), "three\n");

    let after = world
        .content
        .snapshots(&shown(&scope), &shown(&note))
        .unwrap();
    assert_eq!(after.len(), 3);
    assert_eq!(after[0].id, taken);
    assert_eq!(after[0].reason, ConfigWriteReason::Restore);

    // The next read sees the restored bytes, not a cached tree's.
    let document = world
        .content
        .document(&shown(&scope), &shown(&note))
        .unwrap();
    assert_eq!(document.content.content, "one\n");
}

#[test]
fn a_restore_whose_scope_is_no_longer_known_is_refused() {
    let world = World::new();
    let session = world.dirs.folder("a session folder");
    world.sessions.write().unwrap().push(shown(&session));
    let note = session.join("notes").join("today.md");
    put(&note, "one\n");
    let saved = world
        .write(&session, &note, "two\n", Some(hash_content("one\n")))
        .unwrap();
    world.sessions.write().unwrap().clear();

    let refused = world
        .content
        .restore(saved.snapshot_id.unwrap(), &shown(&note))
        .unwrap_err();
    assert!(refused.contains("is not a folder Floti knows"), "{refused}");
    assert_eq!(text(&note), "two\n");
}

// ---------------------------------------------------------------------------
// Refusals: what a save may never touch.

#[test]
fn a_save_is_refused_for_a_relative_path() {
    let world = World::new();
    let scope = world.scanned("my harness", ProjectKind::Harness);
    let refused = world
        .write(&scope, Path::new("notes/today.md"), "x", None)
        .unwrap_err();
    assert!(
        refused.starts_with("Refusing to write a relative path"),
        "{refused}"
    );
}

#[test]
fn a_save_is_refused_outside_the_scope() {
    let world = World::new();
    let scope = world.scanned("my harness", ProjectKind::Harness);
    let other = world.scanned("another project", ProjectKind::Folder);
    for path in [
        other.join("notes").join("a.md"),
        scope.join("..").join("another project").join("a.md"),
        scope.clone(),
    ] {
        let refused = world.write(&scope, &path, "x", None).unwrap_err();
        assert!(refused.contains("is not inside"), "{refused}");
        assert!(!path.join("a.md").exists());
    }
    assert!(!other.join("notes").join("a.md").exists());
}

#[test]
fn a_save_is_refused_under_repos_node_modules_git_or_build() {
    let world = World::new();
    let scope = world.scanned("my harness", ProjectKind::Harness);
    for folder in ["repos", "node_modules", ".git", "build", "Repos"] {
        let path = scope.join(folder).join("inner").join("a.md");
        let refused = world.write(&scope, &path, "x", None).unwrap_err();
        assert!(
            refused.ends_with(&format!("{folder} is not content.")),
            "{folder}: {refused}"
        );
        assert!(!path.exists());
    }
    assert_eq!(world.snapshot_count(), 0);
}

#[test]
fn a_save_is_refused_for_a_binary_file() {
    let world = World::new();
    let scope = world.scanned("my harness", ProjectKind::Harness);
    let image = scope.join("notes").join("chart.png");
    put(&image, "bytes");
    let refused = world
        .write(&scope, &image, "x", Some(hash_content("bytes")))
        .unwrap_err();
    assert!(
        refused.ends_with("the content viewer edits text, not binary files."),
        "{refused}"
    );
    assert_eq!(text(&image), "bytes");
}

#[test]
fn a_save_to_a_scope_that_is_neither_a_content_scope_nor_a_known_root_is_refused() {
    let world = World::new();
    world.scanned("my harness", ProjectKind::Harness);
    let stranger = world.dirs.folder("stranger");
    let note = stranger.join("note.md");
    put(&note, "mine\n");
    let refused = world
        .write(
            &stranger,
            &note,
            "overwritten\n",
            Some(hash_content("mine\n")),
        )
        .unwrap_err();
    assert_eq!(
        refused,
        format!(
            "{} is not a folder Floti knows, so it will not list or read it.",
            shown(&stranger)
        )
    );
    assert_eq!(text(&note), "mine\n");
    assert!(
        world
            .content
            .snapshots(&shown(&stranger), &shown(&note))
            .is_err()
    );
    assert!(world.content.search(&shown(&stranger), "mine").is_err());
}

// ---------------------------------------------------------------------------
// Over a client connection: an artifact opened, and every load its frame
// makes, answered by a running host through its socket.

const CAPABILITIES: &[&str] = &["files", "terminal"];
const DISCOVERY: u64 = 1;

/// A host whose one scan root is main's artifact fixture, with a client
/// connected to it that has made the folder a known scope.
struct Wire {
    host: Option<RunningHost>,
    client: TestClient,
    /// The scope as the scan found it.
    scope: String,
    notes: PathBuf,
    /// Last: fields drop in order.
    dirs: TestDirs,
}

impl Wire {
    async fn start() -> Self {
        Self::start_with(|_| {}).await
    }

    /// The same host, with `prepare` writing more into the folder before it
    /// is scanned.
    async fn start_with(prepare: impl FnOnce(&Path)) -> Self {
        let dirs = TestDirs::new();
        let root = dirs.folder("alpha project");
        let notes = root.join("notes");
        put(&notes.join("first.md"), "# First\n\nSee [[second]].\n");
        put(&notes.join("second.md"), "# Second\n");
        put(
            &notes.join("lesson.html"),
            "<!doctype html><html><head><title>Lesson</title></head><body><p>Read [[second]] and [[unwritten]].</p></body></html>\n",
        );
        put(&notes.join("chart.js"), "window.chart = 1\n");
        put(&root.join("secret.txt"), SECRET);
        prepare(&root);

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
                node: None,
            },
        });
        let mut client = TestClient::connect(&endpoint, CAPABILITIES).await;
        settled(&mut client).await;

        // The folder becomes a known scope the way a user makes it one: a
        // scan root, scanned.
        client
            .request::<WriteSettings>(&HostSettingsPatch {
                scan_roots: Some(vec![shown(&root)]),
                ..HostSettingsPatch::default()
            })
            .await
            .expect("the scan root is kept");
        let found = client
            .request::<ScanForProjects>(&ScanRequest {
                include_git: Some(false),
            })
            .await
            .expect("a scan answers");
        let scope = found
            .projects
            .iter()
            .find(|project| normalize(Path::new(&project.path)) == normalize(&root))
            .unwrap_or_else(|| panic!("the scan did not find the folder: {found:?}"))
            .path
            .clone();
        Self {
            host: Some(host),
            client,
            scope,
            notes: normalize(&notes),
            dirs,
        }
    }

    async fn stop(mut self) {
        if let Some(host) = self.host.take() {
            host.stop(HostStopReason::Stop).await;
        }
    }

    async fn open(&mut self, scope: &str, file: &Path) -> Result<ArtifactLink, String> {
        self.client
            .request::<OpenArtifact>(&ScopedFile {
                scope_path: scope.to_owned(),
                path: shown(file),
            })
            .await
            .map_err(|error| error.message)
    }

    async fn load(&mut self, url: &str, offset: u64) -> ArtifactBytes {
        self.client
            .request::<ReadArtifactBytes>(&ArtifactBytesRequest {
                url: url.to_owned(),
                offset,
            })
            .await
            .unwrap_or_else(|error| panic!("{url} was not answered: {error:?}"))
    }

    /// The lesson's address and the folder part of it its neighbours share.
    async fn lesson(&mut self) -> (ArtifactLink, String) {
        let scope = self.scope.clone();
        let lesson = self.notes.join("lesson.html");
        let link = self.open(&scope, &lesson).await.expect("the lesson opens");
        let base = link.url[..link.url.rfind('/').unwrap()].to_owned();
        (link, base)
    }
}

/// Waits out the scan a host runs as it starts, so the test's own scan is
/// the one that answers.
async fn settled(client: &mut TestClient) {
    let start = client.subscribe_on(DISCOVERY, DiscoveryUpdated::NAME).await;
    if let Message::Snapshot(snapshot) = &start {
        let state: Option<DiscoveryResult> = from_payload(&snapshot.state).unwrap();
        if state.is_some() {
            return;
        }
    }
    let deadline = Instant::now() + PATIENCE;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match client.next(left).await {
            Some(Message::Event(event)) if event.subscription == DISCOVERY => return,
            Some(_) => continue,
            None => panic!("the host's first scan did not finish within {PATIENCE:?}"),
        }
    }
}

fn header<'a>(answer: &'a ArtifactBytes, name: &str) -> Option<&'a str> {
    answer
        .headers
        .iter()
        .find(|header| header.name == name)
        .map(|header| header.value.as_str())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_opens_an_artifact_and_its_neighbour_over_the_wire_under_a_policy_that_names_no_network()
 {
    let mut wire = Wire::start().await;
    let (link, base) = wire.lesson().await;
    assert!(
        link.url
            .starts_with(&format!("floti-artifact://{}/", link.token))
    );
    assert!(link.url.ends_with("/lesson.html"));

    // A request that leaves the offset out is answered from the first byte.
    let bare = to_payload(&json!({ "url": link.url })).unwrap();
    let entry: ArtifactBytes = from_payload(
        &wire
            .client
            .request_on(ReadArtifactBytes::NAME, bare)
            .await
            .expect("the entry is answered"),
    )
    .unwrap();
    assert_eq!(entry.status, 200);
    assert_eq!(
        header(&entry, "content-type"),
        Some("text/html; charset=utf-8")
    );
    assert_eq!(entry.total_bytes, entry.body.len() as u64);
    let html = String::from_utf8(entry.body.0.clone()).unwrap();
    let open = "<script type=\"application/json\" data-helm-wikilinks>";
    let start = html.find(open).unwrap() + open.len();
    let end = start + html[start..].find("</script>").unwrap();
    let island: Value = serde_json::from_str(&html[start..end]).unwrap();
    assert_eq!(island, json!({ "second": true, "unwritten": false }));
    let lower = html.to_lowercase();
    for path in [
        wire.dirs.root().to_path_buf(),
        PathBuf::from(&wire.scope),
        wire.notes.clone(),
    ] {
        let path = shown(&path);
        let escaped = serde_json::to_string(&path).unwrap();
        for spelling in [
            path.clone(),
            path.replace('\\', "/"),
            escaped[1..escaped.len() - 1].to_owned(),
        ] {
            assert!(
                !lower.contains(&spelling.to_lowercase()),
                "{spelling} leaked"
            );
        }
    }

    // The entry read from an offset is the same document, sliced.
    let rest = wire.load(&link.url, 10).await;
    assert_eq!(rest.status, 200);
    assert_eq!(rest.total_bytes, entry.total_bytes);
    assert_eq!(rest.body.as_slice(), &entry.body.as_slice()[10..]);

    let sibling = wire.load(&format!("{base}/chart.js"), 0).await;
    assert_eq!(sibling.status, 200);
    assert_eq!(
        sibling.body.as_slice(),
        std::fs::read(wire.notes.join("chart.js")).unwrap()
    );
    assert_eq!(
        header(&sibling, "content-type"),
        Some("text/javascript; charset=utf-8")
    );
    assert_eq!(header(&sibling, "x-content-type-options"), Some("nosniff"));
    assert_eq!(header(&sibling, "cache-control"), Some("no-store"));
    let csp = header(&sibling, "content-security-policy").unwrap();
    let directives: Vec<&str> = csp.split(';').map(str::trim).collect();
    assert!(directives.contains(&"default-src 'none'"));
    assert!(directives.contains(&"connect-src 'none'"));
    assert!(!csp.contains("http:") && !csp.contains("https:"), "{csp}");

    wire.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_is_refused_an_artifact_load_with_the_status_and_text_the_host_serves() {
    let mut wire = Wire::start().await;
    let (_, base) = wire.lesson().await;

    for escape in [
        "..%2fsecret.txt",
        "../secret.txt",
        "..%5csecret.txt",
        "%2e%2e/secret.txt",
    ] {
        let answer = wire.load(&format!("{base}/{escape}"), 0).await;
        assert_ne!(answer.status, 200, "{escape}");
        assert!(
            !String::from_utf8_lossy(answer.body.as_slice()).contains(SECRET),
            "{escape} leaked"
        );
    }

    let refused = |status: u16, text: &str| ArtifactBytes {
        status,
        headers: vec![ArtifactHeader {
            name: "content-type".into(),
            value: "text/plain; charset=utf-8".into(),
        }],
        total_bytes: text.len() as u64,
        body: Bytes(text.as_bytes().to_vec()),
    };
    let forbidden = format!("{base}/..%2fsecret.txt");
    assert_eq!(wire.load(&forbidden, 0).await, refused(403, "Forbidden"));
    // A refusal is its whole text, whatever offset was asked for.
    assert_eq!(wire.load(&forbidden, 4).await, refused(403, "Forbidden"));
    assert_eq!(
        wire.load("floti-artifact://0123456789abcdef/lesson.html", 0)
            .await,
        refused(404, "Not found")
    );
    assert_eq!(
        wire.load(&format!("{base}/missing.css"), 0).await,
        refused(404, "Not found")
    );
    assert_eq!(
        wire.load("https://x.test/lesson.html", 0).await,
        refused(400, "Bad request")
    );
    assert_eq!(
        wire.load(&format!("{base}/%zz.js"), 0).await,
        refused(400, "Bad request")
    );

    // Only a folder the host knows can be pinned.
    let stranger = wire.dirs.folder("stranger");
    put(&stranger.join("page.html"), "<p>x</p>");
    let refused = wire
        .open(&shown(&stranger), &stranger.join("page.html"))
        .await
        .unwrap_err();
    assert!(refused.contains("is not a folder Floti knows"), "{refused}");

    wire.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_artifact_larger_than_a_piece_reaches_the_client_byte_for_byte_and_the_connection_stays_up()
 {
    let mut wire = Wire::start().await;
    // About two and a half pieces of bytes that are not text.
    let len = ARTIFACT_PIECE_LEN as usize * 5 / 2 + 17;
    let video: Vec<u8> = (0..len).map(|at| (at * 31 % 251) as u8 | 0x80).collect();
    std::fs::write(wire.notes.join("clip.bin"), &video).unwrap();
    let (_, base) = wire.lesson().await;
    let url = format!("{base}/clip.bin");

    let mut arrived = Vec::with_capacity(len);
    let mut pieces = 0;
    loop {
        let piece = wire.load(&url, arrived.len() as u64).await;
        assert_eq!(piece.status, 200);
        assert_eq!(piece.total_bytes, len as u64);
        assert_eq!(
            header(&piece, "content-type"),
            Some("application/octet-stream")
        );
        assert!(piece.body.len() as u64 <= ARTIFACT_PIECE_LEN);
        assert!(!piece.body.is_empty(), "a piece before the end is empty");
        arrived.extend_from_slice(piece.body.as_slice());
        pieces += 1;
        if arrived.len() as u64 == piece.total_bytes {
            break;
        }
    }
    assert_eq!(pieces, 3);
    assert!(arrived == video, "the pieces do not add up to the file");

    // Past the end there is nothing more, and that is not a refusal.
    let past = wire.load(&url, len as u64 + 5).await;
    assert_eq!((past.status, past.total_bytes), (200, len as u64));
    assert!(past.body.is_empty());

    // The same connection still answers.
    let scopes = wire
        .client
        .request::<ListContentScopes>(&())
        .await
        .expect("the connection is still up");
    assert!(
        scopes.iter().any(|scope| scope.path == wire.scope),
        "{scopes:?}"
    );

    wire.stop().await;
}

/// A note with everything the renderer reports on: frontmatter, two
/// headings, a live and a broken wikilink, a tag, markup that must not
/// survive, a fence with a grammar and one without.
const WIRE_NOTE: &str = "---\n\
type: journal\n\
date: 2026-08-10\n\
---\n\
\n\
# Alpha\n\
\n\
## Two Words\n\
\n\
Links to [[second]] and [[nowhere]], tagged #wire.\n\
\n\
<script>alert(1)</script>\n\
\n\
<img src=x onerror=alert(1)>\n\
\n\
<a href=\"javascript:alert(1)\">x</a> <iframe src=\"https://x.test\"></iframe>\n\
\n\
```ts\n\
const a: number = 1\n\
```\n\
\n\
```notalanguage\n\
hello\n\
```\n";

fn same_file(resolved: Option<&str>, expected: &Path) -> bool {
    resolved.is_some_and(|path| {
        shown(&normalize(Path::new(path))).to_lowercase() == shown(expected).to_lowercase()
    })
}

fn assert_no_script_survives(html: &str) {
    let lower = html.to_lowercase();
    for banned in ["<script", "onerror", "javascript:", "<iframe"] {
        assert!(!lower.contains(banned), "{banned} survived: {html}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_reads_and_renders_a_note_over_the_wire_sanitised_with_its_chips_headings_wikilinks_tags_and_counts()
 {
    let mut wire =
        Wire::start_with(|root| put(&root.join("notes").join("alpha.md"), WIRE_NOTE)).await;
    let scope = wire.scope.clone();
    let alpha = wire.notes.join("alpha.md");

    let document = wire
        .client
        .request::<ReadContentDocument>(&ScopedFile {
            scope_path: scope.clone(),
            path: shown(&alpha),
        })
        .await
        .expect("the note is read");
    assert_eq!(document.file.rel_path, "notes/alpha.md");
    assert_eq!(document.file.kind, ContentFileKind::Markdown);
    assert_eq!(document.file.note_type.as_deref(), Some("journal"));
    assert_eq!(document.content.content, WIRE_NOTE);
    assert_eq!(document.content.hash, hash_content(WIRE_NOTE));
    assert_eq!(document.error, None);

    let rendered = document.rendered.expect("a note is rendered");
    assert_no_script_survives(&rendered.html);
    assert!(
        !rendered.html.contains("type: journal"),
        "{}",
        rendered.html
    );
    assert!(rendered.frontmatter.present);
    let chips: Vec<(&str, &str)> = rendered
        .frontmatter
        .fields
        .iter()
        .map(|chip| (chip.key.as_str(), chip.value.as_str()))
        .collect();
    assert_eq!(chips, [("type", "journal"), ("date", "2026-08-10")]);
    let headings: Vec<(u32, &str, &str)> = rendered
        .headings
        .iter()
        .map(|heading| (heading.depth, heading.text.as_str(), heading.slug.as_str()))
        .collect();
    assert_eq!(
        headings,
        [(1, "Alpha", "alpha"), (2, "Two Words", "two-words")]
    );
    let second = rendered
        .links
        .iter()
        .find(|link| link.target == "second")
        .expect("the live link is listed");
    assert!(
        same_file(second.resolved.as_deref(), &wire.notes.join("second.md")),
        "{second:?}"
    );
    let nowhere = rendered
        .links
        .iter()
        .find(|link| link.target == "nowhere")
        .expect("the broken link is listed");
    assert_eq!(nowhere.resolved, None);
    assert!(rendered.html.contains("wikilink-broken"));
    assert_eq!(rendered.tags, ["wire"]);
    assert_eq!(rendered.counts.headings, 2);
    assert_eq!(rendered.counts.wikilinks, 2);
    assert_eq!(rendered.counts.broken_wikilinks, 1);
    assert_eq!(rendered.counts.tags, 1);
    assert_eq!(rendered.counts.code_blocks, 2);
    assert_eq!(rendered.counts.highlighted_blocks, 1);
    assert!(rendered.html.contains("data-language=\"typescript\""));
    assert!(rendered.html.contains("--shiki-light"));
    assert!(rendered.html.contains("--shiki-dark"));
    assert_eq!(rendered.unknown_languages, ["notalanguage"]);
    assert!(rendered.words > 0);

    // A draft renders against the same scope, before it is on disk.
    let draft = wire
        .client
        .request::<RenderContent>(&ContentRenderRequest {
            scope_path: scope.clone(),
            path: shown(&alpha),
            source: "# Draft\n\nNow [[first]] and [[gamma]].\n\n<script>alert(2)</script>\n"
                .to_owned(),
        })
        .await
        .expect("the draft is rendered");
    assert_no_script_survives(&draft.html);
    assert_eq!(draft.counts.wikilinks, 2);
    assert_eq!(draft.counts.broken_wikilinks, 1);
    assert!(
        draft.links.iter().any(|link| link.target == "first"
            && same_file(link.resolved.as_deref(), &wire.notes.join("first.md"))),
        "{:?}",
        draft.links
    );
    assert!(!draft.frontmatter.present);

    // A file that went away says so; one outside every scope is refused.
    let gone = wire
        .client
        .request::<ReadContentDocument>(&ScopedFile {
            scope_path: scope.clone(),
            path: shown(&wire.notes.join("gone.md")),
        })
        .await
        .expect("a missing file is answered");
    assert_eq!(
        gone.error.as_deref(),
        Some("That file is not there any more.")
    );
    assert!(!gone.content.exists);
    let stranger = wire.dirs.folder("stranger");
    put(&stranger.join("note.md"), "# Not here\n");
    assert!(
        wire.client
            .request::<ReadContentDocument>(&ScopedFile {
                scope_path: shown(&stranger),
                path: shown(&stranger.join("note.md")),
            })
            .await
            .is_err()
    );

    wire.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_searches_a_scope_and_resolves_a_wikilink_over_the_wire() {
    let mut wire = Wire::start_with(|root| {
        put(
            &root.join("notes").join("beta.md"),
            "# Beta\n\nAlpha mentions geofencing here.\n",
        );
    })
    .await;
    let scope = wire.scope.clone();

    let search = |query: &str| ContentSearchRequest {
        scope_path: scope.clone(),
        query: query.to_owned(),
    };
    let first = wire
        .client
        .request::<SearchContent>(&search("geofenc"))
        .await
        .expect("the search answers");
    assert_eq!(first.query, "geofenc");
    assert!(first.cold);
    assert_eq!(first.total_matches, 1);
    let hit = match first.hits.as_slice() {
        [hit] => hit,
        hits => panic!("one file holds the term: {hits:?}"),
    };
    assert_eq!(hit.rel_path, "notes/beta.md");
    assert_eq!(hit.matches, 1);
    assert!(!hit.name_match);
    let line = &hit.lines[0];
    assert_eq!(line.line, 3);
    assert_eq!(&line.text[line.from as usize..line.to as usize], "geofenc");
    assert!(first.body_kinds.contains(&ContentFileKind::Markdown));
    assert!(!first.body_kinds.contains(&ContentFileKind::Html));

    // The second search is served warm; an HTML file matches by its name.
    let warm = wire
        .client
        .request::<SearchContent>(&search("lesson"))
        .await
        .expect("the search answers");
    assert!(!warm.cold);
    assert!(
        warm.hits
            .iter()
            .any(|hit| hit.rel_path == "notes/lesson.html" && hit.name_match),
        "{:?}",
        warm.hits
    );
    let none = wire
        .client
        .request::<SearchContent>(&search("nothing matches this"))
        .await
        .expect("the search answers");
    assert_eq!((none.total_matches, none.hits.len()), (0, 0));

    // A link an artifact's frame clicks resolves beside the artifact.
    let lesson = shown(&wire.notes.join("lesson.html"));
    let resolve = |target: &str| WikilinkRequest {
        scope_path: scope.clone(),
        target: target.to_owned(),
        from: lesson.clone(),
    };
    let found = wire
        .client
        .request::<ResolveWikilink>(&resolve("second"))
        .await
        .expect("the link is resolved");
    assert!(
        same_file(found.path.as_deref(), &wire.notes.join("second.md")),
        "{found:?}"
    );
    let missing = wire
        .client
        .request::<ResolveWikilink>(&resolve("unwritten"))
        .await
        .expect("a link to nothing is answered");
    assert_eq!(missing.path, None);

    wire.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_renders_a_config_file_and_highlights_an_editors_source_over_the_wire() {
    let mut wire = Wire::start().await;

    let note = wire
        .client
        .request::<RenderConfigFile>(&SourceToRender {
            path: "CLAUDE.md".to_owned(),
            source: "# Rules\n\n- one\n\n<script>alert(1)</script>\n".to_owned(),
        })
        .await
        .expect("a config note renders");
    assert!(note.code.is_none());
    let markdown = note.markdown.expect("markdown renders as markdown");
    assert!(markdown.html.contains("<h1"));
    assert_no_script_survives(&markdown.html);

    let settings = wire
        .client
        .request::<RenderConfigFile>(&SourceToRender {
            path: "settings.json".to_owned(),
            source: "{ \"model\": \"opus\" }\n".to_owned(),
        })
        .await
        .expect("a settings file renders");
    assert!(settings.markdown.is_none());
    let code = settings.code.expect("json renders as source");
    assert!(code.highlighted);
    assert_eq!(code.language, "json");
    assert!(code.html.contains("--shiki-light"));
    assert!(code.html.contains("--shiki-dark"));

    let small = wire
        .client
        .request::<HighlightSource>(&SourceToRender {
            path: "notes/small.ts".to_owned(),
            source: "const value = 1\nconst other = 2\n".to_owned(),
        })
        .await
        .expect("a small source is highlighted");
    assert!(small.highlighted);
    assert!(!small.too_large);
    assert_eq!(small.language, "typescript");
    assert!(small.lines.len() >= 2, "{:?}", small.lines);
    assert!(
        small.lines[0].contains("--shiki-dark"),
        "{}",
        small.lines[0]
    );

    // Past the ceiling the editor is told so, and gets no lines.
    let big = "const value = \"x\"\n".repeat((512 * 1024 + 1024) / 18 + 1);
    let too_large = wire
        .client
        .request::<HighlightSource>(&SourceToRender {
            path: "notes/big.ts".to_owned(),
            source: big,
        })
        .await
        .expect("a large source is answered");
    assert!(too_large.too_large);
    assert!(!too_large.highlighted);
    assert!(too_large.lines.is_empty());

    wire.stop().await;
}
