//! Harness templates and making a harness, as today's
//! `core/discovery/templates.test.ts`, `template-authoring.test.ts` and
//! `harness.test.ts` test them, with the same inputs and expectations,
//! against real folders. The link cases are the ones that matter most: a
//! junction on Windows and a symlink on macOS and Linux, each proving that a
//! walk lists it without entering it, a copy never follows it, and a delete
//! unlinks it while what it points at survives byte for byte.
//!
//! The last section drives every `template:*` channel and `harness:create`
//! as a client of the host does, over its socket, with the same inputs and
//! expectations, links included, and scans over the socket for the harness a
//! client made. The seeding at host start and the settings subscribers a new
//! harness's scan root reaches are tested through the host's router in
//! `server/features/templates.rs`.

use std::ffi::OsString;
use std::fs;
use std::path::{MAIN_SEPARATOR, Path, PathBuf};

use floti_host::agent::claude_code::ClaudeCodeSettings;
use floti_host::config_console::snapshots;
use floti_host::platform::links;
use floti_host::platform::socket::Endpoint;
use floti_host::server::{HostConfig, HostRun, backends};
use floti_host::store::Store;
use floti_host::testkit::{RunningHost, TestClient, TestDirs, link_folder};
use floti_host::workspace::discovery::scan::scan;
use floti_host::workspace::templates::authoring::{
    ImportFile, create_template, delete_template, import_into_template, make_substitutable,
    preview_folder_as_template, read_template_detail, rename_template, save_folder_as_template,
    template_name_problems, write_template_metadata,
};
use floti_host::workspace::templates::harness::{
    HarnessCreated, create_harness, harness_name_problems,
};
use floti_host::workspace::templates::reader::{
    TemplateValues, list_templates, preview_template, substitute_template, template_path_value,
};
use floti_host::workspace::templates::seed::{SHIPPED_TEMPLATES, seed_templates};
use floti_host::workspace::templates::template_id_problems;
use floti_protocol::channel::RequestChannel;
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::workspace::{
    AppMode, CreateHarness, CreateHarnessOutcome, CreateHarnessRequest, CreateTemplate,
    CreateTemplateRequest, DeleteTemplate, FolderTemplateKind, FolderTemplatePreview,
    FolderTemplateRequest, HarnessMode, ImportIntoTemplate, ImportIntoTemplateRequest,
    ListTemplates, PreviewFolderTemplate, PreviewTemplate, ReadSettings, ReadTemplateDetail,
    RenameTemplate, RenameTemplateRequest, SaveFolderAsTemplate, SaveFolderAsTemplateRequest,
    SaveFolderAsTemplateResult, ScanForProjects, ScanRequest, SubstituteTemplateFile,
    TemplateDetail, TemplateFileRequest, TemplateListing, TemplateMetadataRequest, TemplatePreview,
    TemplatePreviewRequest, TemplateRef, TemplateWriteResult, WriteTemplateMetadata,
};

/// A folder of its own holding `templates/`, and a store for the writes that
/// snapshot.
struct World {
    root: PathBuf,
    templates: PathBuf,
    store: Store,
    /// Last: fields drop in order, and the folder goes only once the store is closed.
    _dirs: TestDirs,
}

impl World {
    fn new() -> Self {
        let dirs = TestDirs::new();
        let root = dirs.folder("work area");
        let templates = root.join("templates");
        fs::create_dir_all(&templates).unwrap();
        Self {
            store: Store::open(&dirs.data).unwrap(),
            root,
            templates,
            _dirs: dirs,
        }
    }

    fn conn(&self) -> &rusqlite::Connection {
        self.store.connection()
    }

    /// Writes `files` as a template folder. Keys are relative paths.
    fn plant(&self, name: &str, files: &[(&str, &str)]) -> PathBuf {
        let dir = self.templates.join(name);
        for (relative, content) in files {
            write(&dir.join(relative), content);
        }
        dir
    }

    fn create(&self, name: &str, label: Option<&str>) -> bool {
        create_template(
            self.conn(),
            &self.templates,
            &CreateTemplateRequest {
                name: name.into(),
                label: label.map(str::to_owned),
                description: None,
            },
        )
        .ok
    }

    fn harness(&self, name: &str, template: Option<&str>) -> HarnessCreated {
        self.harness_in(&self.root, name, template)
    }

    fn harness_in(&self, dir: &Path, name: &str, template: Option<&str>) -> HarnessCreated {
        create_harness(
            &CreateHarnessRequest {
                mode: HarnessMode::New,
                dir: dir.display().to_string(),
                name: Some(name.into()),
                template: template.map(str::to_owned),
            },
            Some(&self.templates),
        )
        .unwrap()
    }

    fn listed_ids(&self) -> Vec<String> {
        ids(&self.templates)
    }
}

fn ids(dir: &Path) -> Vec<String> {
    list_templates(dir)
        .templates
        .into_iter()
        .map(|choice| choice.id)
        .collect()
}

/// Writes `content` at `path`, making its parents.
fn write(path: &Path, content: &str) -> PathBuf {
    write_bytes(path, content.as_bytes())
}

/// Paths here are joined with forward-slashed relative parts, which every OS
/// the host runs on reads as separators.
fn write_bytes(path: &Path, content: &[u8]) -> PathBuf {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
    path.to_path_buf()
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap()
}

/// Every path under a folder, relative, forward-slashed and sorted. A link
/// is listed and never entered. Knows nothing of templates.
fn tree(dir: &Path) -> Vec<String> {
    fn walk(dir: &Path, prefix: &str, into: &mut Vec<String>) {
        for entry in fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            let path = entry.path();
            into.push(rel.clone());
            if !links::is_link(&path) && path.is_dir() {
                walk(&path, &rel, into);
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, "", &mut out);
    out.sort();
    out
}

fn line_matches(text: &str, wanted: &str) -> bool {
    text.lines().any(|line| line == wanted)
}

fn manifest_value<'a>(manifest: &'a str, key: &str) -> Option<&'a str> {
    let prefix = format!("{key}: \"");
    manifest
        .lines()
        .find_map(|line| line.strip_prefix(&prefix)?.strip_suffix('"'))
}

fn looks_like_iso(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() > 11
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
}

// ---------------------------------------------------------------------------
// listTemplates
// ---------------------------------------------------------------------------

#[test]
fn puts_the_built_in_first_however_the_folder_sorts() {
    let world = World::new();
    world.plant("aaa", &[("template.yaml", "label: \"Aaa\"\n")]);

    let listing = list_templates(&world.templates);
    assert_eq!(world.listed_ids(), ["minimal", "aaa"]);
    assert!(listing.templates[0].built_in);
    assert_eq!(listing.dir, world.templates.display().to_string());
}

#[test]
fn is_a_one_row_picker_when_the_folder_is_not_there_at_all() {
    let world = World::new();
    let listing = list_templates(&world.root.join("nothing-here"));
    assert_eq!(ids(&world.root.join("nothing-here")), ["minimal"]);
    assert!(listing.problems.is_empty());
}

#[test]
fn reads_label_description_and_order_and_falls_back_to_the_folder_name() {
    let world = World::new();
    world.plant(
        "described",
        &[(
            "template.yaml",
            "label: \"A label\"\ndescription: \"A sentence.\"\norder: 3\n",
        )],
    );
    world.plant("bare", &[("a.txt", "x")]);

    let listing = list_templates(&world.templates);
    let described = &listing.templates[1];
    assert_eq!(
        (
            described.id.as_str(),
            described.label.as_str(),
            described.description.as_deref(),
            described.order,
            described.built_in
        ),
        ("described", "A label", Some("A sentence."), Some(3), false)
    );
    let bare = &listing.templates[2];
    assert_eq!(
        (
            bare.id.as_str(),
            bare.label.as_str(),
            bare.description.as_deref(),
            bare.order,
            bare.built_in
        ),
        ("bare", "bare", None, None, false)
    );
    assert_eq!(listing.templates.len(), 3);
}

#[test]
fn sorts_by_order_then_label_with_the_unordered_ones_last() {
    let world = World::new();
    world.plant("one", &[("template.yaml", "label: \"zeta\"\norder: 1\n")]);
    world.plant("two", &[("template.yaml", "label: \"alpha\"\norder: 2\n")]);
    world.plant("three", &[("template.yaml", "label: \"beta\"\n")]);
    world.plant("four", &[("template.yaml", "label: \"aardvark\"\n")]);

    let labels: Vec<String> = list_templates(&world.templates)
        .templates
        .into_iter()
        .map(|choice| choice.label)
        .collect();
    assert_eq!(labels, ["Minimal", "zeta", "alpha", "aardvark", "beta"]);
}

#[test]
fn skips_one_malformed_template_with_a_sentence_and_keeps_the_rest() {
    let world = World::new();
    world.plant("good", &[("template.yaml", "label: \"Good\"\n")]);
    world.plant(
        "broken",
        &[("template.yaml", "label: \"unterminated\n  - [\n")],
    );

    let listing = list_templates(&world.templates);
    assert_eq!(world.listed_ids(), ["minimal", "good"]);
    assert_eq!(listing.problems.len(), 1);
    assert!(
        listing.problems[0].contains("broken"),
        "{:?}",
        listing.problems
    );
}

#[test]
fn will_not_let_a_folder_take_the_built_in_name() {
    let world = World::new();
    world.plant("minimal", &[("template.yaml", "label: \"Impostor\"\n")]);

    let listing = list_templates(&world.templates);
    assert_eq!(world.listed_ids(), ["minimal"]);
    assert_eq!(listing.templates[0].label, "Minimal");
    assert!(
        listing.problems[0].contains("built-in"),
        "{:?}",
        listing.problems
    );
}

#[test]
fn does_not_offer_a_link_as_a_template() {
    let world = World::new();
    let real = world.plant("real", &[("template.yaml", "label: \"Real\"\n")]);
    link_folder(&real, &world.templates.join("linked"));

    let listing = list_templates(&world.templates);
    assert_eq!(world.listed_ids(), ["minimal", "real"]);
    assert!(
        listing.problems.join(" ").contains("linked"),
        "{:?}",
        listing.problems
    );
}

// ---------------------------------------------------------------------------
// previewTemplate
// ---------------------------------------------------------------------------

#[test]
fn describes_the_minimal_scaffold_per_mode() {
    let world = World::new();
    let for_new = preview_template(&world.templates, "minimal", Some(HarnessMode::New));
    assert_eq!(for_new.entries, ["harness.yaml", "repos/", ".claude/"]);

    let for_convert = preview_template(&world.templates, "anything", Some(HarnessMode::Convert));
    assert_eq!(for_convert.entries, ["harness.yaml", ".claude/"]);
    assert_eq!(for_convert.template, "minimal");
}

#[test]
fn lists_a_template_as_the_writer_would_write_it_manifest_first() {
    let world = World::new();
    world.plant(
        "demo",
        &[
            ("template.yaml", "label: \"Demo\"\n"),
            ("CLAUDE.md.tpl", "# {{NAME}}\n"),
            ("dot-claude/settings.json", "{}"),
            ("notes/.gitkeep", ""),
        ],
    );

    let preview = preview_template(&world.templates, "demo", None);
    assert_eq!(
        preview.entries,
        [
            "harness.yaml",
            ".claude/settings.json",
            "CLAUDE.md",
            "notes/"
        ]
    );
    assert!(preview.note.contains("Demo"), "{}", preview.note);
    assert!(preview.problems.is_empty(), "{:?}", preview.problems);
}

#[test]
fn names_exactly_what_the_writer_then_writes_for_the_built_in_and_for_a_template() {
    let world = World::new();
    world.plant(
        "demo",
        &[
            ("template.yaml", "label: \"Demo\"\n"),
            ("CLAUDE.md.tpl", "# {{NAME}}\n"),
            ("dot-claude/settings.json", "{}"),
            ("notes/.gitkeep", ""),
            ("tools/run.mjs", "export {}\n"),
        ],
    );

    for template in ["minimal", "demo"] {
        let preview = preview_template(&world.templates, template, Some(HarnessMode::New));
        let name = format!("from-{template}");
        let result = world.harness(&name, Some(template));
        assert!(
            result.problems.is_empty(),
            "{template}: {:?}",
            result.problems
        );

        // Files, and folders with nothing in them: what a list of what was written names.
        let written = tree(&world.root.join(&name));
        let leaves: Vec<String> = written
            .iter()
            .filter(|path| {
                !written
                    .iter()
                    .any(|other| other.starts_with(&format!("{path}/")))
            })
            .cloned()
            .collect();
        assert_eq!(preview.entries[0], "harness.yaml", "{template}");
        let mut previewed: Vec<String> = preview
            .entries
            .iter()
            .map(|entry| entry.trim_end_matches('/').to_owned())
            .collect();
        previewed.sort();
        assert_eq!(previewed, leaves, "{template}");
    }
}

#[test]
fn says_so_rather_than_listing_nothing_for_a_template_that_is_not_there() {
    let world = World::new();
    let preview = preview_template(&world.templates, "absent", None);
    assert!(preview.entries.is_empty());
    assert_eq!(
        preview.problems,
        ["There is no template called \"absent\"."]
    );
}

// ---------------------------------------------------------------------------
// substituteTemplate, templatePathValue, templateIdProblems
// ---------------------------------------------------------------------------

fn values() -> TemplateValues {
    TemplateValues {
        name: "work".into(),
        created_at: "2026-08-15T00:00:00.000Z".into(),
        template: "demo".into(),
        path: "C:/Users/me/.harness/work".into(),
    }
}

#[test]
fn fills_in_the_four_placeholders_every_occurrence() {
    assert_eq!(
        substitute_template(
            "{{NAME}} {{NAME}} {{TEMPLATE}} {{CREATED_AT}} {{PATH}} {{PATH}}",
            &values()
        ),
        "work work demo 2026-08-15T00:00:00.000Z C:/Users/me/.harness/work C:/Users/me/.harness/work"
    );
}

#[test]
fn leaves_anything_else_exactly_as_written() {
    let source = "${{ github.sha }} {{ NAME }} {{name}} {{UNKNOWN}}";
    assert_eq!(substitute_template(source, &values()), source);
}

#[test]
fn spells_the_platform_path_with_forward_slashes_spaces_intact() {
    let path: PathBuf = ["C:", "Users", "a b", ".harness", "work"]
        .join(MAIN_SEPARATOR.encode_utf8(&mut [0; 4]))
        .into();
    assert_eq!(template_path_value(&path), "C:/Users/a b/.harness/work");
}

#[test]
fn leaves_a_backslash_alone_where_it_is_a_filename_character() {
    if MAIN_SEPARATOR != '/' {
        return;
    }
    assert_eq!(
        template_path_value(Path::new("/home/me/odd\\name")),
        "/home/me/odd\\name"
    );
}

#[test]
fn refuses_a_path_where_a_name_belongs() {
    for id in [
        "..",
        "../x",
        "..\\x",
        "a/b",
        "a\\b",
        "C:\\Windows",
        "/etc",
        "",
    ] {
        assert!(!template_id_problems(id).is_empty(), "{id}");
    }
}

#[test]
fn passes_an_ordinary_folder_name() {
    for id in ["demo", "my-template", "Work Space", "a1"] {
        assert!(template_id_problems(id).is_empty(), "{id}");
    }
}

// ---------------------------------------------------------------------------
// createHarness from a template
// ---------------------------------------------------------------------------

#[test]
fn writes_the_tree_substitutes_only_tpl_and_records_the_provenance() {
    let world = World::new();
    let literal = "runs-on: ${{ matrix.os }}\nname: {{NAME}}\n";
    world.plant(
        "demo",
        &[
            ("template.yaml", "label: \"Demo\"\n"),
            (
                "CLAUDE.md.tpl",
                "# {{NAME}}\n\nfrom {{TEMPLATE}} at {{CREATED_AT}}\n",
            ),
            ("workflow.yml", literal),
            ("dot-claude/settings.json", "{\"model\":\"opus\"}"),
            ("notes/.gitkeep", ""),
        ],
    );

    let result = world.harness("work", Some("demo"));
    let harness = world.root.join("work");

    assert!(result.problems.is_empty(), "{:?}", result.problems);
    assert_eq!(result.path.as_deref(), Some(harness.as_path()));
    assert_eq!(
        tree(&harness),
        [
            ".claude",
            ".claude/settings.json",
            "CLAUDE.md",
            "harness.yaml",
            "notes",
            "workflow.yml"
        ]
    );

    // The .tpl was filled in and lost its extension.
    let claude_md = read(&harness.join("CLAUDE.md"));
    assert!(line_matches(&claude_md, "# work"), "{claude_md}");
    let from = claude_md
        .lines()
        .find_map(|line| line.strip_prefix("from demo at "))
        .unwrap();
    assert!(looks_like_iso(from), "{from}");

    // The non-.tpl file arrived byte for byte, `{{...}}` and all.
    assert_eq!(read(&harness.join("workflow.yml")), literal);

    // Provenance, and the timestamp the .tpl was given is the manifest's.
    let manifest = read(&harness.join("harness.yaml"));
    assert!(line_matches(&manifest, "template: \"demo\""), "{manifest}");
    let created = manifest_value(&manifest, "created").unwrap();
    assert!(claude_md.contains(created), "{claude_md} / {created}");
}

#[test]
fn fills_path_with_the_harness_folder_forward_slashed_so_a_json_tpl_stays_json() {
    let world = World::new();
    // A parent with a space in it: a harness under a profile folder with a
    // space is ordinary and the value must survive it unescaped.
    let parent = world.root.join("with space");
    fs::create_dir_all(&parent).unwrap();
    world.plant(
        "wired",
        &[
            ("PATH.txt.tpl", "{{PATH}}"),
            (
                "dot-claude/settings.json.tpl",
                "{\"hooks\":{\"PostToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"node {{PATH}}/.claude/hooks/post-bash.mjs\"}]}]},\"autoMemoryDirectory\":\"{{PATH}}/memory\"}\n",
            ),
        ],
    );

    let result = world.harness_in(&parent, "my work", Some("wired"));
    let harness = parent.join("my work");
    let expected = harness.display().to_string().replace(MAIN_SEPARATOR, "/");

    assert!(result.problems.is_empty(), "{:?}", result.problems);
    assert!(!expected.contains('\\'));
    assert!(expected.contains("with space/my work"));
    assert_eq!(read(&harness.join("PATH.txt")), expected);

    // The point of the forward slashes: a backslashed Windows path inside a
    // JSON string is an invalid escape, so this parse is what fails without them.
    let settings: serde_json::Value =
        serde_json::from_str(&read(&harness.join(".claude").join("settings.json"))).unwrap();
    assert_eq!(
        settings["autoMemoryDirectory"],
        format!("{expected}/memory")
    );
    assert_eq!(
        settings["hooks"]["PostToolUse"][0]["hooks"][0]["command"],
        format!("node {expected}/.claude/hooks/post-bash.mjs")
    );
}

#[test]
fn does_not_write_the_gitkeep_it_made_the_folder_for() {
    let world = World::new();
    world.plant("demo", &[("notes/.gitkeep", "")]);
    world.harness("work", Some("demo"));

    assert_eq!(tree(&world.root.join("work")), ["harness.yaml", "notes"]);
}

#[test]
fn refuses_a_template_name_that_is_a_path_and_writes_nothing() {
    let world = World::new();
    for template in ["../escape", "..\\escape", "C:\\Windows\\System32"] {
        let result = world.harness("work", Some(template));
        assert_eq!(result.path, None, "{template}");
        assert!(!result.problems.is_empty(), "{template}");
        assert_eq!(tree(&world.root), ["templates"], "{template}");
    }
}

#[test]
fn refuses_a_template_that_is_not_there_and_leaves_no_folder_behind() {
    let world = World::new();
    let result = world.harness("work", Some("absent"));
    assert_eq!(result.path, None);
    assert_eq!(result.problems, ["There is no template called \"absent\"."]);
    assert_eq!(tree(&world.root), ["templates"]);
}

#[test]
fn will_not_follow_a_link_out_of_the_template() {
    let world = World::new();
    let outside = world.root.join("outside");
    write(&outside.join("secret.txt"), "untouched");
    world.plant(
        "hostile",
        &[
            ("template.yaml", "label: \"Hostile\"\n"),
            ("ok.txt", "fine"),
        ],
    );
    link_folder(&outside, &world.templates.join("hostile").join("escape"));

    let result = world.harness("work", Some("hostile"));

    assert_eq!(
        result.path.as_deref(),
        Some(world.root.join("work").as_path())
    );
    let problems = result.problems.join(" ");
    assert!(problems.contains("escape"), "{problems}");
    assert!(problems.contains("link"), "{problems}");
    // The harness has the honest half of the template and nothing else, and
    // what the link pointed at is exactly as it was.
    assert_eq!(tree(&world.root.join("work")), ["harness.yaml", "ok.txt"]);
    assert_eq!(tree(&outside), ["secret.txt"]);
    assert_eq!(read(&outside.join("secret.txt")), "untouched");
}

#[test]
fn will_not_let_a_template_supply_the_manifest() {
    let world = World::new();
    world.plant(
        "demo",
        &[
            ("harness.yaml.tpl", "name: \"not-yours\"\n"),
            ("a.txt", "x"),
        ],
    );

    let result = world.harness("work", Some("demo"));

    assert!(
        result.problems.join(" ").contains("harness.yaml"),
        "{:?}",
        result.problems
    );
    let manifest = read(&world.root.join("work").join("harness.yaml"));
    assert!(line_matches(&manifest, "name: \"work\""), "{manifest}");
}

#[test]
fn reports_what_it_actually_wrote_when_one_entry_fails_halfway() {
    let world = World::new();
    // Two sources, one target: `a.txt` and `a.txt.tpl` both want `a.txt`. The
    // first wins, the second is refused, and neither is silent.
    world.plant(
        "demo",
        &[
            ("a.txt", "plain"),
            ("a.txt.tpl", "{{NAME}}"),
            ("b.txt", "also written"),
        ],
    );

    let result = world.harness("work", Some("demo"));

    assert_eq!(
        result.path.as_deref(),
        Some(world.root.join("work").as_path())
    );
    assert_eq!(result.created, ["a.txt", "b.txt", "harness.yaml"]);
    assert_eq!(result.problems.len(), 1);
    assert!(
        result.problems[0].contains("a.txt"),
        "{:?}",
        result.problems
    );
    assert_eq!(read(&world.root.join("work").join("a.txt")), "plain");
    assert_eq!(read(&world.root.join("work").join("b.txt")), "also written");
}

#[test]
fn ignores_a_template_when_converting() {
    let world = World::new();
    world.plant("demo", &[("CLAUDE.md.tpl", "# {{NAME}}\n")]);
    fs::create_dir_all(world.root.join("alpha")).unwrap();

    let result = create_harness(
        &CreateHarnessRequest {
            mode: HarnessMode::Convert,
            dir: world.root.display().to_string(),
            name: None,
            template: Some("demo".into()),
        },
        Some(&world.templates),
    )
    .unwrap();

    assert!(result.problems.is_empty(), "{:?}", result.problems);
    let manifest = read(&world.root.join("harness.yaml"));
    assert!(
        line_matches(&manifest, "template: \"minimal\""),
        "{manifest}"
    );
    assert!(!tree(&world.root).contains(&"CLAUDE.md".to_owned()));
}

// ---------------------------------------------------------------------------
// seedTemplates
// ---------------------------------------------------------------------------

fn shipped(relative: &str) -> &'static str {
    SHIPPED_TEMPLATES
        .iter()
        .find(|(path, _)| *path == relative)
        .map(|(_, content)| *content)
        .unwrap()
}

#[test]
fn writes_the_readme_and_the_example_into_a_folder_that_is_not_there() {
    let world = World::new();
    let dir = world.root.join("seeded");
    let result = seed_templates(&dir);

    assert!(result.seeded);
    assert_eq!(result.problem, None);
    let mut created = result.created.clone();
    created.sort();
    let mut expected: Vec<&str> = SHIPPED_TEMPLATES.iter().map(|(path, _)| *path).collect();
    expected.sort_unstable();
    assert_eq!(created, expected);
    assert!(tree(&dir).contains(&"README.md".to_owned()));

    // And what it wrote is a template the engine can read back.
    let listing = list_templates(&dir);
    assert_eq!(ids(&dir), ["minimal", "example"]);
    assert!(listing.problems.is_empty(), "{:?}", listing.problems);
}

#[test]
fn overwrites_nothing_on_a_second_call_however_the_files_have_been_edited() {
    let world = World::new();
    let dir = world.root.join("seeded");
    seed_templates(&dir);
    fs::write(dir.join("README.md"), "mine now").unwrap();

    let again = seed_templates(&dir);
    assert!(!again.seeded);
    assert!(again.created.is_empty());
    assert_eq!(read(&dir.join("README.md")), "mine now");
}

#[test]
fn writes_nothing_into_a_folder_that_is_there_even_empty_or_missing_the_readme() {
    let world = World::new();
    let empty = world.root.join("empty");
    fs::create_dir_all(&empty).unwrap();
    assert!(!seed_templates(&empty).seeded);
    assert!(tree(&empty).is_empty());

    let trimmed = world.root.join("trimmed");
    seed_templates(&trimmed);
    fs::remove_file(trimmed.join("README.md")).unwrap();
    let again = seed_templates(&trimmed);
    assert!(!again.seeded);
    assert!(!trimmed.join("README.md").exists());
}

#[test]
fn re_seeds_once_the_folder_is_gone_which_is_the_whole_of_reset() {
    let world = World::new();
    let dir = world.root.join("seeded");
    seed_templates(&dir);
    fs::write(dir.join("README.md"), "mine now").unwrap();
    fs::remove_dir_all(&dir).unwrap();

    assert!(seed_templates(&dir).seeded);
    assert_eq!(read(&dir.join("README.md")), shipped("README.md"));
}

#[test]
fn produces_a_harness_from_the_shipped_example() {
    let world = World::new();
    let dir = world.root.join("seeded");
    seed_templates(&dir);

    let result = create_harness(
        &CreateHarnessRequest {
            mode: HarnessMode::New,
            dir: world.root.display().to_string(),
            name: Some("work".into()),
            template: Some("example".into()),
        },
        Some(&dir),
    )
    .unwrap();

    assert!(result.problems.is_empty(), "{:?}", result.problems);
    assert_eq!(
        tree(&world.root.join("work")),
        [
            ".claude",
            ".claude/skills",
            "CLAUDE.md",
            "harness.yaml",
            "repos"
        ]
    );
    assert!(line_matches(
        &read(&world.root.join("work").join("CLAUDE.md")),
        "# work"
    ));
}

// ---------------------------------------------------------------------------
// createHarness
// ---------------------------------------------------------------------------

fn new_harness(dir: &Path, name: &str, template: Option<&str>) -> HarnessCreated {
    create_harness(
        &CreateHarnessRequest {
            mode: HarnessMode::New,
            dir: dir.display().to_string(),
            name: Some(name.into()),
            template: template.map(str::to_owned),
        },
        None,
    )
    .unwrap()
}

fn convert(dir: &Path) -> HarnessCreated {
    create_harness(
        &CreateHarnessRequest {
            mode: HarnessMode::Convert,
            dir: dir.display().to_string(),
            name: None,
            template: None,
        },
        None,
    )
    .unwrap()
}

fn project_names(roots: &[&Path]) -> (Vec<String>, Vec<String>) {
    let roots: Vec<String> = roots
        .iter()
        .map(|root| root.display().to_string())
        .collect();
    let result = scan(&roots, false);
    let mut projects: Vec<String> = result.projects.into_iter().map(|p| p.name).collect();
    projects.sort();
    (
        result.harnesses.into_iter().map(|h| h.name).collect(),
        projects,
    )
}

#[test]
fn scaffolds_the_minimum_and_nothing_else_for_the_minimal_template() {
    let dirs = TestDirs::new();
    let root = dirs.folder("harness root");
    let result = new_harness(&root, "work", Some("minimal"));

    assert!(result.problems.is_empty(), "{:?}", result.problems);
    assert_eq!(result.path.as_deref(), Some(root.join("work").as_path()));
    assert_eq!(
        tree(&root.join("work")),
        [".claude", "harness.yaml", "repos"]
    );
}

#[test]
fn defaults_to_the_minimal_template_when_none_is_named() {
    let dirs = TestDirs::new();
    let root = dirs.folder("harness root");
    let result = new_harness(&root, "work", None);

    assert_eq!(result.created, ["repos", ".claude", "harness.yaml"]);
    assert_eq!(
        tree(&root.join("work")),
        [".claude", "harness.yaml", "repos"]
    );
    assert!(line_matches(
        &read(&root.join("work").join("harness.yaml")),
        "template: \"minimal\""
    ));
}

#[test]
fn writes_four_keys_and_no_prose() {
    let dirs = TestDirs::new();
    let root = dirs.folder("harness root");
    new_harness(&root, "work", Some("minimal"));
    let manifest = read(&root.join("work").join("harness.yaml"));

    let keys: Vec<&str> = manifest
        .trim()
        .lines()
        .map(|line| line.split(':').next().unwrap())
        .collect();
    assert_eq!(keys, ["name", "template", "version", "created"]);
    assert!(!manifest.contains('#'));
    assert!(line_matches(&manifest, "name: \"work\""));
    assert!(line_matches(&manifest, "template: \"minimal\""));
    assert!(looks_like_iso(
        manifest_value(&manifest, "created").unwrap()
    ));
}

#[test]
fn produces_a_harness_the_scanner_immediately_sees() {
    let dirs = TestDirs::new();
    let root = dirs.folder("harness root");
    let path = new_harness(&root, "work", None).path.unwrap();
    fs::create_dir_all(path.join("repos").join("alpha")).unwrap();

    let (harnesses, projects) = project_names(&[&path]);

    assert_eq!(harnesses, ["work"]);
    assert_eq!(projects, ["alpha", "work"]);
}

#[test]
fn accepts_a_name_with_spaces_and_dashes() {
    let dirs = TestDirs::new();
    let root = dirs.folder("harness root");
    let result = new_harness(&root, "My Work-Space", None);
    assert!(result.problems.is_empty(), "{:?}", result.problems);
    assert_eq!(
        result.path.as_deref(),
        Some(root.join("My Work-Space").as_path())
    );
}

#[test]
fn refuses_a_name_that_is_not_a_folder_name() {
    let dirs = TestDirs::new();
    let root = dirs.folder("harness root");
    for name in ["", "  ", "a/b", "a\\b", "a:b", "con", "trailing.", ".."] {
        let result = new_harness(&root, name, None);
        assert_eq!(result.path, None, "{name:?}");
        assert!(!result.problems.is_empty(), "{name:?}");
    }
}

#[test]
fn refuses_to_write_into_a_folder_that_already_exists() {
    let dirs = TestDirs::new();
    let root = dirs.folder("harness root");
    fs::create_dir(root.join("work")).unwrap();
    let result = new_harness(&root, "work", None);
    assert_eq!(result.path, None);
    assert_eq!(
        result.problems,
        [format!("{} already exists.", root.join("work").display())]
    );
}

#[test]
fn converts_a_folder_of_repos_in_place_without_hiding_them() {
    let dirs = TestDirs::new();
    let root = dirs.folder("harness root");
    fs::create_dir_all(root.join("alpha")).unwrap();
    fs::create_dir_all(root.join("beta")).unwrap();

    let result = convert(&root);
    assert!(result.problems.is_empty(), "{:?}", result.problems);
    assert!(result.created.contains(&"harness.yaml".to_owned()));

    let manifest = read(&root.join("harness.yaml"));
    assert!(line_matches(&manifest, "repos: \".\""), "{manifest}");

    let (harnesses, projects) = project_names(&[&root]);
    assert_eq!(harnesses.len(), 1);
    let mut expected = vec!["alpha".to_owned(), "beta".to_owned(), harnesses[0].clone()];
    expected.sort();
    assert_eq!(projects, expected);
}

#[test]
fn omits_repos_when_converting_a_folder_that_already_has_repos() {
    let dirs = TestDirs::new();
    let root = dirs.folder("harness root");
    fs::create_dir_all(root.join("repos").join("alpha")).unwrap();

    convert(&root);

    let manifest = read(&root.join("harness.yaml"));
    assert!(
        !manifest.lines().any(|line| line.starts_with("repos:")),
        "{manifest}"
    );
    let (_, projects) = project_names(&[&root]);
    assert!(projects.contains(&"alpha".to_owned()), "{projects:?}");
}

#[test]
fn refuses_to_convert_a_folder_that_is_already_a_harness() {
    let dirs = TestDirs::new();
    let root = dirs.folder("harness root");
    fs::write(root.join("harness.yaml"), "name: \"already\"\n").unwrap();
    let result = convert(&root);
    assert_eq!(result.path, None);
    assert_eq!(
        result.problems,
        [format!("{} is already a harness.", root.display())]
    );
}

#[test]
fn passes_ordinary_harness_names() {
    for name in ["dev", "my-work", "Work Space", "a1"] {
        assert!(harness_name_problems(name).is_empty(), "{name}");
    }
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

#[test]
fn refuses_a_path_an_absolute_the_built_in_name_and_a_name_already_taken() {
    let world = World::new();
    let dir = &world.templates;
    assert_eq!(template_name_problems(dir, "", false).len(), 1);
    assert_eq!(template_name_problems(dir, "../escape", false).len(), 1);
    assert!(!template_name_problems(dir, "C:\\Windows", false).is_empty());
    assert!(template_name_problems(dir, "minimal", false)[0].contains("built-in"));
    // Case-folded, because Windows would let a `Minimal` folder shadow the row
    // that always works and the reader refuses only the exact name.
    assert!(template_name_problems(dir, "MINIMAL", false)[0].contains("built-in"));

    fs::create_dir(dir.join("taken")).unwrap();
    assert!(template_name_problems(dir, "taken", false)[0].contains("already a template"));
    assert!(template_name_problems(dir, "taken", true).is_empty());
}

#[test]
fn accepts_an_ordinary_template_name() {
    let world = World::new();
    assert!(template_name_problems(&world.templates, "client-work", false).is_empty());
}

// ---------------------------------------------------------------------------
// Create, metadata, rename, delete
// ---------------------------------------------------------------------------

#[test]
fn scaffolds_a_manifest_and_an_empty_tree_and_the_picker_then_offers_it() {
    let world = World::new();
    let result = create_template(
        world.conn(),
        &world.templates,
        &CreateTemplateRequest {
            name: "client-work".into(),
            label: Some("Client work".into()),
            description: Some("One sentence.".into()),
        },
    );

    assert!(result.ok, "{:?}", result.problems);
    assert_eq!(result.template.as_deref(), Some("client-work"));
    assert_eq!(
        tree(&world.templates.join("client-work")),
        ["template.yaml"]
    );

    let listing = list_templates(&world.templates);
    assert_eq!(world.listed_ids(), ["minimal", "client-work"]);
    assert_eq!(listing.templates[1].label, "Client work");
    assert_eq!(
        listing.templates[1].description.as_deref(),
        Some("One sentence.")
    );
}

#[test]
fn uses_the_folder_name_when_no_label_is_given_and_writes_nothing_twice() {
    let world = World::new();
    world.create("bare", None);
    assert!(read(&world.templates.join("bare").join("template.yaml")).contains("\"bare\""));

    let again = create_template(
        world.conn(),
        &world.templates,
        &CreateTemplateRequest {
            name: "bare".into(),
            label: None,
            description: None,
        },
    );
    assert!(!again.ok);
    assert!(
        again.problems[0].contains("already a template"),
        "{:?}",
        again.problems
    );
}

#[test]
fn refuses_to_create_a_template_whose_name_is_a_path_and_writes_nothing() {
    let world = World::new();
    assert!(!world.create("../escape", None));
    assert!(tree(&world.templates).is_empty());
}

#[test]
fn records_the_manifest_in_the_snapshot_table_because_it_goes_through_the_consoles_write() {
    let world = World::new();
    assert_eq!(snapshots::count(world.conn()).unwrap(), 0);

    world.create("recorded", Some("Recorded"));
    let dir = world.templates.join("recorded").display().to_string();
    let reasons = |world: &World| -> Vec<String> {
        snapshots::list(world.conn(), &dir, "template.yaml")
            .unwrap()
            .into_iter()
            .map(|row| {
                serde_json::to_value(row.reason)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect()
    };
    assert_eq!(reasons(&world), ["create"]);

    write_template_metadata(
        world.conn(),
        &world.templates,
        &TemplateMetadataRequest {
            template: "recorded".into(),
            label: "Renamed".into(),
            description: String::new(),
        },
    );
    // Newest first, and the edit's row holds what was there before it.
    assert_eq!(reasons(&world), ["edit", "create"]);
}

#[test]
fn rewrites_label_and_description_without_touching_the_rest_of_the_folder() {
    let world = World::new();
    world.create("work", Some("Work"));
    write(
        &world.templates.join("work").join("CLAUDE.md.tpl"),
        "# {{NAME}}\n",
    );

    let result = write_template_metadata(
        world.conn(),
        &world.templates,
        &TemplateMetadataRequest {
            template: "work".into(),
            label: "Renamed label".into(),
            description: "A new sentence.".into(),
        },
    );

    assert!(result.ok, "{:?}", result.problems);
    let listing = list_templates(&world.templates);
    assert_eq!(listing.templates[1].label, "Renamed label");
    assert_eq!(
        listing.templates[1].description.as_deref(),
        Some("A new sentence.")
    );
    assert_eq!(
        read(&world.templates.join("work").join("CLAUDE.md.tpl")),
        "# {{NAME}}\n"
    );
}

#[test]
fn quotes_a_label_containing_a_colon_which_bare_yaml_would_not_survive() {
    let world = World::new();
    world.create("work", None);
    write_template_metadata(
        world.conn(),
        &world.templates,
        &TemplateMetadataRequest {
            template: "work".into(),
            label: "Work: the sequel".into(),
            description: String::new(),
        },
    );

    let listing = list_templates(&world.templates);
    assert!(listing.problems.is_empty(), "{:?}", listing.problems);
    assert_eq!(listing.templates[1].label, "Work: the sequel");
}

#[test]
fn refuses_metadata_for_a_template_that_is_not_there() {
    let world = World::new();
    let result = write_template_metadata(
        world.conn(),
        &world.templates,
        &TemplateMetadataRequest {
            template: "nothing".into(),
            label: "x".into(),
            description: String::new(),
        },
    );
    assert!(!result.ok);
    assert!(
        result.problems[0].contains("no template called"),
        "{:?}",
        result.problems
    );
}

fn rename(world: &World, template: &str, name: &str) -> bool {
    rename_template(
        &world.templates,
        &RenameTemplateRequest {
            template: template.into(),
            name: name.into(),
        },
    )
    .ok
}

#[test]
fn moves_the_whole_folder_and_keeps_its_contents() {
    let world = World::new();
    world.create("before", Some("Before"));
    write(
        &world.templates.join("before").join("notes").join("a.md"),
        "hello",
    );

    assert!(rename(&world, "before", "after"));
    assert!(!world.templates.join("before").exists());
    assert_eq!(
        read(&world.templates.join("after").join("notes").join("a.md")),
        "hello"
    );
}

#[test]
fn refuses_a_rename_to_a_name_that_is_taken_the_built_in_name_and_its_own_name() {
    let world = World::new();
    world.create("a", None);
    world.create("b", None);

    assert!(!rename(&world, "a", "b"));
    assert!(!rename(&world, "a", "minimal"));
    assert!(!rename(&world, "a", "a"));
    assert!(world.templates.join("a").exists());
}

#[test]
fn removes_the_folder_and_everything_in_it() {
    let world = World::new();
    world.create("gone", None);
    write(
        &world
            .templates
            .join("gone")
            .join("deep")
            .join("nested")
            .join("a.txt"),
        "x",
    );

    let result = delete_template(&world.templates, "gone");

    assert!(result.ok, "{:?}", result.problems);
    assert!(!world.templates.join("gone").exists());
    assert!(tree(&world.templates).is_empty());
}

#[test]
fn unlinks_a_link_rather_than_walking_into_what_it_points_at() {
    let world = World::new();
    let canary = world.root.join("canary");
    write(&canary.join("do-not-touch.txt"), "untouched");
    world.create("hostile", None);
    link_folder(&canary, &world.templates.join("hostile").join("escape"));

    let result = delete_template(&world.templates, "hostile");

    assert!(result.ok, "{:?}", result.problems);
    assert!(!world.templates.join("hostile").exists());
    // The claim is about the bytes, not about a filename being absent.
    assert_eq!(read(&canary.join("do-not-touch.txt")), "untouched");
}

#[test]
fn refuses_a_delete_whose_name_climbs_out_and_removes_nothing() {
    let world = World::new();
    fs::create_dir_all(world.root.join("sibling")).unwrap();
    let result = delete_template(&world.templates, "../sibling");
    assert!(!result.ok);
    assert!(world.root.join("sibling").exists());
}

#[test]
fn refuses_to_delete_a_template_that_is_itself_a_link_and_leaves_its_target() {
    let world = World::new();
    let canary = world.root.join("canary");
    write(&canary.join("do-not-touch.txt"), "untouched");
    link_folder(&canary, &world.templates.join("linked"));

    let result = delete_template(&world.templates, "linked");

    assert!(!result.ok);
    assert_eq!(read(&canary.join("do-not-touch.txt")), "untouched");
}

// ---------------------------------------------------------------------------
// Detail and `.tpl`
// ---------------------------------------------------------------------------

#[test]
fn lists_every_file_with_what_a_harness_would_receive_it_as() {
    let world = World::new();
    world.create("shaped", Some("Shaped"));
    let dir = world.templates.join("shaped");
    write(&dir.join("CLAUDE.md.tpl"), "# {{NAME}}\n");
    write(&dir.join("workflow.yml"), "on: push\n");
    write(&dir.join("dot-claude").join("settings.json"), "{}\n");
    write(&dir.join("notes").join(".gitkeep"), "");

    let detail = read_template_detail(&world.templates, "shaped");

    assert_eq!(detail.label, "Shaped");
    assert_eq!(detail.file_count, 4);
    let mapped: Vec<String> = detail
        .files
        .iter()
        .map(|file| format!("{} -> {}", file.rel_path, file.target))
        .collect();
    assert_eq!(
        mapped,
        [
            "CLAUDE.md.tpl -> CLAUDE.md",
            "dot-claude/settings.json -> .claude/settings.json",
            "notes/.gitkeep -> notes/",
            "workflow.yml -> workflow.yml"
        ]
    );
    let substituted: Vec<&str> = detail
        .files
        .iter()
        .filter(|file| file.substituted)
        .map(|file| file.rel_path.as_str())
        .collect();
    assert_eq!(substituted, ["CLAUDE.md.tpl"]);
    // `template.yaml` describes the template rather than being content of it.
    assert!(
        !detail
            .files
            .iter()
            .any(|file| file.rel_path == "template.yaml")
    );
}

#[test]
fn names_a_link_rather_than_leaving_it_out_of_the_list() {
    let world = World::new();
    let canary = world.root.join("canary");
    write(&canary.join("inside.txt"), "untouched");
    world.create("linky", None);
    link_folder(&canary, &world.templates.join("linky").join("escape"));

    let detail = read_template_detail(&world.templates, "linky");

    let listed: Vec<&str> = detail
        .files
        .iter()
        .map(|file| file.rel_path.as_str())
        .collect();
    assert_eq!(listed, ["escape"]);
    assert!(detail.files[0].link);
    assert!(
        detail.problems.join(" ").contains("escape"),
        "{:?}",
        detail.problems
    );
    // A link is not a file the template contributes.
    assert_eq!(detail.file_count, 0);
}

#[test]
fn says_which_template_is_not_there_rather_than_reporting_an_empty_one() {
    let world = World::new();
    let detail = read_template_detail(&world.templates, "nothing");
    assert!(
        detail.problems[0].contains("no template called"),
        "{:?}",
        detail.problems
    );
}

fn substitute(world: &World, template: &str, path: &str) -> (bool, Vec<String>) {
    let result = make_substitutable(
        &world.templates,
        &TemplateFileRequest {
            template: template.into(),
            path: path.into(),
        },
    );
    (result.ok, result.problems)
}

#[test]
fn renames_a_file_to_tpl_and_the_engine_then_substitutes_it() {
    let world = World::new();
    world.create("sub", None);
    write(
        &world.templates.join("sub").join("CLAUDE.md"),
        "# {{NAME}}\n",
    );

    let (ok, problems) = substitute(&world, "sub", "CLAUDE.md");

    assert!(ok, "{problems:?}");
    assert!(!world.templates.join("sub").join("CLAUDE.md").exists());
    let created = world.harness("made", Some("sub"));
    assert!(created.problems.is_empty(), "{:?}", created.problems);
    assert_eq!(read(&world.root.join("made").join("CLAUDE.md")), "# made\n");
}

#[test]
fn refuses_a_binary_a_file_already_substituted_and_the_manifest() {
    let world = World::new();
    world.create("sub", None);
    let dir = world.templates.join("sub");
    write_bytes(&dir.join("logo.png"), &[0x89, 0x50, 0x00, 0x01, 0x02]);
    write(&dir.join("a.md.tpl"), "x");

    let (_, problems) = substitute(&world, "sub", "logo.png");
    assert!(problems[0].contains("not text"), "{problems:?}");
    assert!(!substitute(&world, "sub", "a.md.tpl").0);
    assert!(!substitute(&world, "sub", "template.yaml").0);
    assert!(dir.join("logo.png").exists());
}

#[test]
fn refuses_a_substitution_path_that_climbs_out_of_the_template() {
    let world = World::new();
    world.create("sub", None);
    write(&world.root.join("outside.md"), "x");
    assert!(!substitute(&world, "sub", "../../outside.md").0);
    assert!(world.root.join("outside.md").exists());
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

#[test]
fn copies_files_in_as_plain_bytes_and_reports_created_against_replaced() {
    let world = World::new();
    world.create("target", None);
    let source = write(
        &world.root.join("project/.claude/skills/think/SKILL.md"),
        "body\n",
    );
    let files = [ImportFile {
        source: source.clone(),
        target: ".claude/skills/think/SKILL.md".into(),
    }];
    let copied = world.templates.join("target/.claude/skills/think/SKILL.md");

    let first = import_into_template(&world.templates, "target", &files);
    assert_eq!(first.created, [".claude/skills/think/SKILL.md"]);
    assert!(first.replaced.is_empty());
    assert_eq!(read(&copied), "body\n");

    fs::write(&source, "edited\n").unwrap();
    let second = import_into_template(&world.templates, "target", &files);
    assert!(second.created.is_empty());
    assert_eq!(second.replaced, [".claude/skills/think/SKILL.md"]);
    assert_eq!(read(&copied), "edited\n");
}

#[test]
fn copies_bytes_rather_than_text_so_a_bundled_binary_survives() {
    let world = World::new();
    world.create("target", None);
    let bytes = [0x00, 0xff, 0x10, 0x89, 0x50];
    let source = write_bytes(&world.root.join("logo.png"), &bytes);

    import_into_template(
        &world.templates,
        "target",
        &[ImportFile {
            source,
            target: ".claude/skills/think/logo.png".into(),
        }],
    );

    assert_eq!(
        fs::read(world.templates.join("target/.claude/skills/think/logo.png")).unwrap(),
        bytes
    );
}

#[test]
fn refuses_a_source_that_is_a_link_rather_than_copying_what_it_points_at() {
    let world = World::new();
    world.create("target", None);
    let canary = world.root.join("canary");
    write(&canary.join("do-not-touch.txt"), "untouched");
    let link = world.root.join("linked");
    link_folder(&canary, &link);

    let result = import_into_template(
        &world.templates,
        "target",
        &[ImportFile {
            source: link,
            target: ".claude/skills/think/SKILL.md".into(),
        }],
    );

    assert!(!result.ok);
    assert!(result.created.is_empty());
    assert!(!world.templates.join("target").join(".claude").exists());
    assert_eq!(read(&canary.join("do-not-touch.txt")), "untouched");
}

#[test]
fn refuses_a_target_that_climbs_out_of_the_template_and_writes_nothing_there() {
    let world = World::new();
    world.create("target", None);
    let source = write(&world.root.join("a.md"), "x");

    let result = import_into_template(
        &world.templates,
        "target",
        &[ImportFile {
            source,
            target: "../../escaped.md".into(),
        }],
    );

    assert!(!result.ok);
    assert!(
        result.problems[0].contains("escaped.md"),
        "{:?}",
        result.problems
    );
    assert!(!world.root.join("escaped.md").exists());
}

#[test]
fn refuses_a_target_that_would_write_through_a_link_inside_the_template() {
    let world = World::new();
    world.create("target", None);
    let canary = world.root.join("canary");
    fs::create_dir_all(&canary).unwrap();
    link_folder(&canary, &world.templates.join("target").join("escape"));
    let source = write(&world.root.join("a.md"), "x");

    let result = import_into_template(
        &world.templates,
        "target",
        &[ImportFile {
            source,
            target: "escape/a.md".into(),
        }],
    );

    assert!(!result.ok);
    assert!(result.problems[0].contains("link"), "{:?}", result.problems);
    assert!(tree(&canary).is_empty());
}

// ---------------------------------------------------------------------------
// A folder becomes a template
// ---------------------------------------------------------------------------

/// A harness with the things somebody would want to leave behind.
fn plant_harness(world: &World) -> PathBuf {
    plant_harness_in(&world.root)
}

/// [`plant_harness`] under `parent`.
fn plant_harness_in(parent: &Path) -> PathBuf {
    let dir = parent.join("my-harness");
    write(&dir.join("harness.yaml"), "name: my-harness\n");
    write(&dir.join("CLAUDE.md"), "# my-harness\n");
    write(&dir.join(".claude/skills/think/SKILL.md"), "skill\n");
    write(&dir.join("notes/journal.md"), "a private journal\n");
    write(&dir.join("repos/thing/README.md"), "a checkout\n");
    write(&dir.join(".git/HEAD"), "ref: refs/heads/main\n");
    write(
        &dir.join("tools/node_modules/left-pad/index.js"),
        "module.exports = 1\n",
    );
    write(&dir.join("tools/run.mjs"), "console.log(1)\n");
    dir
}

fn preview(
    dir: &Path,
    kind: FolderTemplateKind,
) -> floti_protocol::channels::workspace::FolderTemplatePreview {
    preview_folder_as_template(&dir.display().to_string(), kind)
}

fn save(
    world: &World,
    dir: &Path,
    name: &str,
    label: &str,
    include: Vec<String>,
) -> floti_protocol::channels::workspace::SaveFolderAsTemplateResult {
    save_folder_as_template(
        world.conn(),
        &world.templates,
        &SaveFolderAsTemplateRequest {
            dir: dir.display().to_string(),
            kind: FolderTemplateKind::Harness,
            name: name.into(),
            label: label.into(),
            description: String::new(),
            include,
        },
    )
}

fn ticked(preview: &floti_protocol::channels::workspace::FolderTemplatePreview) -> Vec<String> {
    preview
        .entries
        .iter()
        .filter(|entry| entry.included)
        .map(|entry| entry.name.clone())
        .collect()
}

#[test]
fn lists_the_top_level_unticks_the_instance_data_and_counts_what_is_ticked() {
    let world = World::new();
    let dir = plant_harness(&world);

    let preview = preview(&dir, FolderTemplateKind::Harness);
    let entry = |name: &str| {
        preview
            .entries
            .iter()
            .find(|entry| entry.name == name)
            .unwrap()
    };

    let mut names: Vec<&str> = preview
        .entries
        .iter()
        .map(|entry| entry.name.as_str())
        .collect();
    names.sort_unstable();
    assert_eq!(
        names,
        [
            ".claude",
            ".git",
            "CLAUDE.md",
            "harness.yaml",
            "notes",
            "repos",
            "tools"
        ]
    );
    // The defaults, and each is listed rather than pruned.
    assert!(!entry("harness.yaml").included);
    assert!(!entry(".git").included);
    assert!(!entry("repos").included);
    assert!(entry(".claude").included);
    assert!(entry("notes").included);
    assert!(entry("tools").included);

    // `harness.yaml` and `.git` are refused whatever the user ticks; `repos` is
    // merely unticked, because a repos/ scaffold is a defensible thing to want.
    assert!(entry("harness.yaml").refused.is_some());
    assert!(entry(".git").refused.is_some());
    assert!(entry("repos").refused.is_none());

    // `tools/node_modules` is not counted: it is never copied, at any depth.
    assert_eq!(entry("tools").file_count, 1);
    // Ticked by default: CLAUDE.md, .claude/skills/think/SKILL.md,
    // notes/journal.md, tools/run.mjs.
    assert_eq!(preview.file_count, 4);
    assert!(preview.total_bytes > 0);
}

#[test]
fn names_a_link_at_the_top_level_and_never_follows_one_below_it() {
    let world = World::new();
    let canary = world.root.join("canary");
    write(&canary.join("do-not-touch.txt"), "untouched");
    let dir = plant_harness(&world);
    link_folder(&canary, &dir.join("escape"));
    link_folder(&canary, &dir.join("tools").join("deep-escape"));

    let preview = preview(&dir, FolderTemplateKind::Harness);
    let escape = preview
        .entries
        .iter()
        .find(|entry| entry.name == "escape")
        .unwrap();

    assert!(escape.link);
    assert!(!escape.included);
    let problems = preview.problems.join(" ");
    assert!(problems.contains("escape"), "{problems}");
    assert!(problems.contains("deep-escape"), "{problems}");
    // The link's target contributes nothing to the count.
    let tools = preview
        .entries
        .iter()
        .find(|entry| entry.name == "tools")
        .unwrap();
    assert_eq!(tools.file_count, 1);
}

#[test]
fn copies_what_was_ticked_leaves_out_what_was_not_and_writes_a_manifest() {
    let world = World::new();
    let dir = plant_harness(&world);
    let include = ticked(&preview(&dir, FolderTemplateKind::Harness));

    let result = save_folder_as_template(
        world.conn(),
        &world.templates,
        &SaveFolderAsTemplateRequest {
            dir: dir.display().to_string(),
            kind: FolderTemplateKind::Harness,
            name: "frozen".into(),
            label: "Frozen".into(),
            description: "A harness, frozen.".into(),
            include,
        },
    );

    assert!(result.ok, "{:?}", result.problems);
    assert_eq!(
        tree(&world.templates.join("frozen")),
        [
            ".claude",
            ".claude/skills",
            ".claude/skills/think",
            ".claude/skills/think/SKILL.md",
            "CLAUDE.md",
            "notes",
            "notes/journal.md",
            "template.yaml",
            "tools",
            "tools/run.mjs"
        ]
    );
    // The manifest a harness gets is the host's to write, so it is not carried in.
    assert!(!world.templates.join("frozen").join("harness.yaml").exists());
    assert_eq!(result.file_count, 4);

    let listing = list_templates(&world.templates);
    assert_eq!(world.listed_ids(), ["minimal", "frozen"]);
    assert_eq!(listing.templates[1].label, "Frozen");
}

#[test]
fn refuses_harness_yaml_even_when_it_is_ticked_rather_than_authoring_a_broken_template() {
    let world = World::new();
    let dir = plant_harness(&world);

    let result = save(
        &world,
        &dir,
        "frozen",
        "",
        vec!["harness.yaml".into(), "CLAUDE.md".into()],
    );

    assert!(!world.templates.join("frozen").join("harness.yaml").exists());
    assert!(world.templates.join("frozen").join("CLAUDE.md").exists());
    assert!(
        result.problems.join(" ").contains("harness.yaml"),
        "{:?}",
        result.problems
    );
}

#[test]
fn does_not_recurse_into_a_link_and_what_it_pointed_at_is_untouched() {
    let world = World::new();
    let canary = world.root.join("canary");
    write(&canary.join("do-not-touch.txt"), "untouched");
    let dir = plant_harness(&world);
    link_folder(&canary, &dir.join("tools").join("deep-escape"));

    let result = save(&world, &dir, "frozen", "", vec!["tools".into()]);

    assert!(result.ok, "{:?}", result.problems);
    assert_eq!(
        tree(&world.templates.join("frozen")),
        ["template.yaml", "tools", "tools/run.mjs"]
    );
    assert!(
        result.problems.join(" ").contains("deep-escape"),
        "{:?}",
        result.problems
    );
    assert_eq!(read(&canary.join("do-not-touch.txt")), "untouched");
}

#[test]
fn keeps_dot_claude_verbatim_and_a_harness_made_from_it_receives_claude() {
    let world = World::new();
    let folder = world.root.join("authored-elsewhere");
    write(&folder.join("dot-claude/skills/think/SKILL.md"), "skill\n");
    write(&folder.join("CLAUDE.md.tpl"), "# {{NAME}}\n");

    let include = ticked(&preview(&folder, FolderTemplateKind::Folder));
    let saved = save_folder_as_template(
        world.conn(),
        &world.templates,
        &SaveFolderAsTemplateRequest {
            dir: folder.display().to_string(),
            kind: FolderTemplateKind::Folder,
            name: "imported".into(),
            label: "Imported".into(),
            description: String::new(),
            include,
        },
    );
    assert!(saved.ok, "{:?}", saved.problems);
    // Verbatim in the template: the alias is applied by the writer rather
    // than undone on the way in.
    assert!(world.templates.join("imported").join("dot-claude").exists());
    assert!(world.listed_ids().contains(&"imported".to_owned()));

    world.harness("from-imported", Some("imported"));
    assert_eq!(
        read(
            &world
                .root
                .join("from-imported/.claude/skills/think/SKILL.md")
        ),
        "skill\n"
    );
    assert_eq!(
        read(&world.root.join("from-imported").join("CLAUDE.md")),
        "# from-imported\n"
    );
}

#[test]
fn refuses_a_name_that_is_taken_and_leaves_the_existing_template_alone() {
    let world = World::new();
    world.create("taken", Some("Taken"));
    let dir = plant_harness(&world);

    let result = save(&world, &dir, "taken", "", vec!["CLAUDE.md".into()]);

    assert!(!result.ok);
    assert_eq!(tree(&world.templates.join("taken")), ["template.yaml"]);
}

// ---------------------------------------------------------------------------
// Over a client connection
// ---------------------------------------------------------------------------

/// A host over a test's folders, with a client connected to it. The
/// templates folder is the host's own, `templates` in its config folder,
/// seeded as the host started. Claude Code (the fake claude, never run) is
/// the agent whose config console a template imports from.
struct Wire {
    host: RunningHost,
    client: TestClient,
    templates: PathBuf,
    /// Where a test's harnesses, folders and link targets go, outside the
    /// templates folder.
    root: PathBuf,
    /// Last: fields drop in order.
    dirs: TestDirs,
}

/// The fake `claude` (`test/fake-agents/claude-code.mjs`), run by Node.
fn fake_claude() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("test")
        .join("fake-agents")
        .join("claude-code.mjs")
}

fn wire_config(dirs: &TestDirs, endpoint: &Endpoint) -> HostConfig {
    let claude = ClaudeCodeSettings {
        search_first: Vec::new(),
        program: "node".into(),
        leading_args: vec![fake_claude().into_os_string()],
        config_dir: dirs.home.join(".claude"),
        pass_config_dir: true,
        api_key_set: false,
    };
    HostConfig {
        folders: dirs.folders(),
        endpoint: endpoint.clone(),
        backends: backends(&dirs.user_env(), Some(claude)),
        inherited_env: std::env::vars_os()
            .filter(|(key, _)| key != "SHELL")
            .chain([(OsString::from("SHELL"), OsString::from("/bin/sh"))])
            .collect(),
        run: HostRun {
            mode: AppMode::Dev,
            home: Some(dirs.home.clone()),
        },
    }
}

impl Wire {
    async fn start() -> Self {
        Self::after(|_| {}).await
    }

    /// A host started once `prepare` has had the folders.
    async fn after(prepare: impl FnOnce(&TestDirs)) -> Self {
        let dirs = TestDirs::new();
        prepare(&dirs);
        let root = dirs.folder("work area");
        let endpoint = dirs.endpoint();
        let host = RunningHost::start(wire_config(&dirs, &endpoint));
        let client = TestClient::connect(&endpoint, &[]).await;
        Self {
            host,
            client,
            templates: dirs.config.join("templates"),
            root,
            dirs,
        }
    }

    async fn stop(self) {
        self.host.stop(HostStopReason::Stop).await;
    }

    /// Asks `C` and expects an answer rather than an error: every refusal on
    /// these channels is a result naming its problems.
    async fn ask<C: RequestChannel>(&mut self, request: &C::Request) -> C::Response {
        self.client
            .request::<C>(request)
            .await
            .unwrap_or_else(|error| panic!("`{}` failed: {}", C::NAME, error.message))
    }

    async fn listing(&mut self) -> TemplateListing {
        self.ask::<ListTemplates>(&()).await
    }

    async fn listed_ids(&mut self) -> Vec<String> {
        self.listing()
            .await
            .templates
            .into_iter()
            .map(|choice| choice.id)
            .collect()
    }

    async fn create(&mut self, name: &str) -> TemplateWriteResult {
        self.ask::<CreateTemplate>(&CreateTemplateRequest {
            name: name.into(),
            label: None,
            description: None,
        })
        .await
    }

    async fn preview(&mut self, template: &str) -> TemplatePreview {
        self.ask::<PreviewTemplate>(&TemplatePreviewRequest {
            template: template.into(),
            mode: Some(HarnessMode::New),
        })
        .await
    }

    async fn detail(&mut self, template: &str) -> TemplateDetail {
        self.ask::<ReadTemplateDetail>(&TemplateRef {
            template: template.into(),
        })
        .await
    }

    async fn delete(&mut self, template: &str) -> bool {
        let result = self
            .ask::<DeleteTemplate>(&TemplateRef {
                template: template.into(),
            })
            .await;
        result.ok
    }

    async fn harness(&mut self, dir: &Path, name: &str, template: &str) -> CreateHarnessOutcome {
        self.ask::<CreateHarness>(&CreateHarnessRequest {
            mode: HarnessMode::New,
            dir: dir.display().to_string(),
            name: Some(name.into()),
            template: Some(template.into()),
        })
        .await
    }

    async fn folder_preview(&mut self, dir: &Path) -> FolderTemplatePreview {
        self.ask::<PreviewFolderTemplate>(&FolderTemplateRequest {
            dir: dir.display().to_string(),
            kind: FolderTemplateKind::Harness,
        })
        .await
    }

    async fn save_folder(
        &mut self,
        dir: &Path,
        name: &str,
        include: Vec<String>,
    ) -> SaveFolderAsTemplateResult {
        self.ask::<SaveFolderAsTemplate>(&SaveFolderAsTemplateRequest {
            dir: dir.display().to_string(),
            kind: FolderTemplateKind::Harness,
            name: name.into(),
            label: "Frozen".into(),
            description: "A harness, frozen.".into(),
            include,
        })
        .await
    }

    async fn roots(&mut self) -> Vec<String> {
        self.ask::<ReadSettings>(&()).await.scan_roots
    }
}

/// Every file under `dir` with its bytes, a link listed and never entered:
/// what a link's target held, to compare before and after.
fn contents(dir: &Path) -> Vec<(String, Option<Vec<u8>>)> {
    tree(dir)
        .into_iter()
        .map(|relative| {
            let path = dir.join(&relative);
            let bytes =
                (!links::is_link(&path) && path.is_file()).then(|| fs::read(&path).unwrap());
            (relative, bytes)
        })
        .collect()
}

/// A folder outside every template, of text and bytes, for a link to point at.
fn plant_canary(parent: &Path) -> PathBuf {
    let canary = parent.join("canary");
    write(&canary.join("do-not-touch.txt"), "untouched");
    write_bytes(
        &canary.join("deep").join("blob.bin"),
        &[0x89, 0x00, 0xff, 0x0d, 0x0a],
    );
    canary
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_makes_a_harness_from_a_template_with_its_values_filled_in_and_a_scan_lists_it() {
    let mut wire = Wire::start().await;
    let literal = "runs-on: ${{ matrix.os }}\nname: {{NAME}}\n";
    for (relative, content) in [
        ("template.yaml", "label: \"Demo\"\n"),
        (
            "CLAUDE.md.tpl",
            "# {{NAME}}\n\nfrom {{TEMPLATE}} at {{CREATED_AT}}\n",
        ),
        ("workflow.yml", literal),
        ("dot-claude/settings.json", "{\"model\":\"opus\"}"),
        ("notes/.gitkeep", ""),
    ] {
        write(&wire.templates.join("demo").join(relative), content);
    }
    let parent = wire.root.join("harnesses");
    fs::create_dir_all(&parent).unwrap();

    let outcome = wire.harness(&parent, "work", "demo").await;

    let harness = parent.join("work");
    let path = harness.display().to_string();
    assert!(outcome.problems.is_empty(), "{:?}", outcome.problems);
    assert_eq!(outcome.path.as_deref(), Some(path.as_str()));
    assert!(outcome.roots.contains(&path), "{:?}", outcome.roots);
    assert_eq!(
        tree(&harness),
        [
            ".claude",
            ".claude/settings.json",
            "CLAUDE.md",
            "harness.yaml",
            "notes",
            "workflow.yml"
        ]
    );
    let claude_md = read(&harness.join("CLAUDE.md"));
    assert!(line_matches(&claude_md, "# work"), "{claude_md}");
    let from = claude_md
        .lines()
        .find_map(|line| line.strip_prefix("from demo at "))
        .unwrap();
    assert!(looks_like_iso(from), "{from}");
    assert_eq!(read(&harness.join("workflow.yml")), literal);
    let manifest = read(&harness.join("harness.yaml"));
    assert!(line_matches(&manifest, "name: \"work\""), "{manifest}");
    assert!(line_matches(&manifest, "template: \"demo\""), "{manifest}");
    assert!(claude_md.contains(manifest_value(&manifest, "created").unwrap()));

    // The manifest is one a scan recognises: a scan over the wire lists it.
    let scanned = wire
        .ask::<ScanForProjects>(&ScanRequest {
            include_git: Some(false),
        })
        .await;
    let found: Vec<(&str, &str)> = scanned
        .harnesses
        .iter()
        .map(|harness| (harness.name.as_str(), harness.path.as_str()))
        .collect();
    assert!(found.contains(&("work", path.as_str())), "{found:?}");
    let made = scanned
        .harnesses
        .iter()
        .find(|harness| harness.name == "work")
        .unwrap();
    assert_eq!(made.template.as_deref(), Some("demo"));

    wire.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_is_refused_a_harness_with_a_bad_name_or_over_an_existing_folder_and_nothing_is_written()
 {
    let mut wire = Wire::start().await;
    let parent = wire.root.join("harnesses");
    fs::create_dir_all(&parent).unwrap();
    let roots = wire.roots().await;

    for name in ["", "  ", "a/b", "a\\b", "a:b", "con", "trailing.", ".."] {
        let outcome = wire.harness(&parent, name, "minimal").await;
        assert_eq!(outcome.path, None, "{name:?}");
        assert!(!outcome.problems.is_empty(), "{name:?}");
        assert_eq!(outcome.roots, roots, "{name:?}");
        assert_eq!(tree(&wire.root), ["harnesses"], "{name:?}");
    }

    for template in ["../escape", "..\\escape", "absent"] {
        let outcome = wire.harness(&parent, "work", template).await;
        assert_eq!(outcome.path, None, "{template}");
        assert!(!outcome.problems.is_empty(), "{template}");
        assert_eq!(tree(&wire.root), ["harnesses"], "{template}");
    }

    write(&parent.join("work").join("mine.txt"), "mine");
    let outcome = wire.harness(&parent, "work", "minimal").await;
    assert_eq!(outcome.path, None);
    assert_eq!(
        outcome.problems,
        [format!("{} already exists.", parent.join("work").display())]
    );
    assert_eq!(outcome.roots, roots);
    assert_eq!(tree(&parent.join("work")), ["mine.txt"]);
    assert_eq!(read(&parent.join("work").join("mine.txt")), "mine");

    assert_eq!(wire.roots().await, roots);
    wire.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_lists_previews_and_reads_templates_and_a_broken_manifest_does_not_fail_the_listing()
 {
    let mut wire = Wire::start().await;
    let templates = wire.templates.clone();
    write(
        &templates.join("good").join("template.yaml"),
        "label: \"Good\"\n",
    );
    write(
        &templates.join("broken").join("template.yaml"),
        "label: \"unterminated\n  - [\n",
    );
    for (relative, content) in [
        ("template.yaml", "label: \"Demo\"\n"),
        ("CLAUDE.md.tpl", "# {{NAME}}\n"),
        ("workflow.yml", "on: push\n"),
        ("dot-claude/settings.json", "{}"),
        ("notes/.gitkeep", ""),
    ] {
        write(&templates.join("demo").join(relative), content);
    }

    let listing = wire.listing().await;
    let ids: Vec<&str> = listing.templates.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(ids[0], "minimal");
    for id in ["example", "good", "demo"] {
        assert!(ids.contains(&id), "{ids:?}");
    }
    assert!(!ids.contains(&"broken"), "{ids:?}");
    assert_eq!(listing.problems.len(), 1, "{:?}", listing.problems);
    assert!(
        listing.problems[0].contains("broken"),
        "{:?}",
        listing.problems
    );
    assert_eq!(listing.dir, templates.display().to_string());

    let preview = wire.preview("demo").await;
    assert_eq!(
        preview.entries,
        [
            "harness.yaml",
            ".claude/settings.json",
            "CLAUDE.md",
            "notes/",
            "workflow.yml"
        ]
    );
    assert!(preview.note.contains("Demo"), "{}", preview.note);
    assert!(preview.problems.is_empty(), "{:?}", preview.problems);
    let absent = wire.preview("absent").await;
    assert!(absent.entries.is_empty());
    assert_eq!(absent.problems, ["There is no template called \"absent\"."]);

    let detail = wire.detail("demo").await;
    assert_eq!(detail.label, "Demo");
    assert!(detail.has_manifest);
    assert_eq!(detail.file_count, 4);
    let mapped: Vec<String> = detail
        .files
        .iter()
        .map(|file| format!("{} -> {}", file.rel_path, file.target))
        .collect();
    assert_eq!(
        mapped,
        [
            "CLAUDE.md.tpl -> CLAUDE.md",
            "dot-claude/settings.json -> .claude/settings.json",
            "notes/.gitkeep -> notes/",
            "workflow.yml -> workflow.yml"
        ]
    );

    // A name that reaches outside the folder reads nothing there.
    write(
        &wire.dirs.config.join("outside").join("template.yaml"),
        "label: \"Out\"\n",
    );
    for template in ["../outside", "..\\outside"] {
        let preview = wire.preview(template).await;
        assert!(
            preview.entries.is_empty(),
            "{template}: {:?}",
            preview.entries
        );
        assert!(!preview.problems.is_empty(), "{template}");
        let detail = wire.detail(template).await;
        assert!(detail.files.is_empty(), "{template}: {:?}", detail.files);
        assert!(!detail.problems.is_empty(), "{template}");
    }

    wire.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_creates_describes_renames_fills_and_deletes_a_template_in_the_templates_folder() {
    let mut wire = Wire::start().await;
    let templates = wire.templates.clone();

    let created = wire.create("draft").await;
    assert_eq!(
        created,
        TemplateWriteResult {
            ok: true,
            template: Some("draft".into()),
            problems: Vec::new()
        }
    );
    assert_eq!(tree(&templates.join("draft")), ["template.yaml"]);

    let described = wire
        .ask::<WriteTemplateMetadata>(&TemplateMetadataRequest {
            template: "draft".into(),
            label: "Draft kit".into(),
            description: "For drafts.".into(),
        })
        .await;
    assert!(described.ok, "{:?}", described.problems);
    let listing = wire.listing().await;
    let draft = listing.templates.iter().find(|t| t.id == "draft").unwrap();
    assert_eq!(
        (draft.label.as_str(), draft.description.as_deref()),
        ("Draft kit", Some("For drafts."))
    );

    let renamed = wire
        .ask::<RenameTemplate>(&RenameTemplateRequest {
            template: "draft".into(),
            name: "final".into(),
        })
        .await;
    assert_eq!(
        renamed.template.as_deref(),
        Some("final"),
        "{:?}",
        renamed.problems
    );
    assert!(!templates.join("draft").exists());
    let ids = wire.listed_ids().await;
    assert!(ids.contains(&"final".to_owned()) && !ids.contains(&"draft".to_owned()));
    assert_eq!(wire.detail("final").await.label, "Draft kit");

    write(&templates.join("final").join("CLAUDE.md"), "# {{NAME}}\n");
    let filled = wire
        .ask::<SubstituteTemplateFile>(&TemplateFileRequest {
            template: "final".into(),
            path: "CLAUDE.md".into(),
        })
        .await;
    assert!(filled.ok, "{:?}", filled.problems);
    assert!(!templates.join("final").join("CLAUDE.md").exists());
    assert!(templates.join("final").join("CLAUDE.md.tpl").exists());
    let parent = wire.root.clone();
    let made = wire.harness(&parent, "made", "final").await;
    assert!(made.problems.is_empty(), "{:?}", made.problems);
    assert_eq!(read(&parent.join("made").join("CLAUDE.md")), "# made\n");

    assert!(wire.delete("final").await);
    assert!(!templates.join("final").exists());
    assert!(!wire.listed_ids().await.contains(&"final".to_owned()));

    wire.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_is_refused_a_template_name_or_path_that_reaches_outside_the_templates_folder() {
    let mut wire = Wire::start().await;
    let config = wire.dirs.config.clone();
    let sibling = config.join("sibling");
    write(&sibling.join("keep.txt"), "kept");
    write(&config.join("outside.md"), "outside");
    assert!(wire.create("kit").await.ok);
    let before = contents(&config);

    for name in ["../escape", "..\\escape", "/escape"] {
        assert!(!wire.create(name).await.ok, "create {name}");
        let renamed = wire
            .ask::<RenameTemplate>(&RenameTemplateRequest {
                template: "kit".into(),
                name: name.into(),
            })
            .await;
        assert!(!renamed.ok, "rename to {name}");
        let saved = wire.save_folder(&wire.root.clone(), name, vec![]).await;
        assert!(!saved.ok, "save a folder as {name}");
    }
    for template in ["../sibling", "..\\sibling"] {
        assert!(!wire.delete(template).await, "delete {template}");
        let described = wire
            .ask::<WriteTemplateMetadata>(&TemplateMetadataRequest {
                template: template.into(),
                label: "Taken over".into(),
                description: String::new(),
            })
            .await;
        assert!(!described.ok, "describe {template}");
        let renamed = wire
            .ask::<RenameTemplate>(&RenameTemplateRequest {
                template: template.into(),
                name: "stolen".into(),
            })
            .await;
        assert!(!renamed.ok, "rename {template}");
        let imported = wire
            .ask::<ImportIntoTemplate>(&ImportIntoTemplateRequest {
                template: template.into(),
                scope_path: wire.dirs.home.join(".claude").display().to_string(),
                paths: Vec::new(),
            })
            .await;
        assert!(!imported.ok, "import into {template}");
    }
    for path in ["../../outside.md", "..\\..\\outside.md"] {
        let filled = wire
            .ask::<SubstituteTemplateFile>(&TemplateFileRequest {
                template: "kit".into(),
                path: path.into(),
            })
            .await;
        assert!(!filled.ok, "fill {path}");
    }

    assert_eq!(contents(&config), before);
    assert_eq!(tree(&wire.templates.join("kit")), ["template.yaml"]);
    wire.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_imports_a_skill_from_the_user_scope_as_its_whole_folder() {
    let mut wire = Wire::after(|dirs| {
        let skill = dirs.home.join(".claude").join("skills").join("think");
        write(
            &skill.join("SKILL.md"),
            "---\nname: think\ndescription: Think it through.\n---\nUse {{NAME}} as written.\n",
        );
        write(&skill.join("reference.md"), "# reference\n");
    })
    .await;
    let claude = wire.dirs.home.join(".claude");
    let skill = claude.join("skills").join("think");
    assert!(wire.create("kit").await.ok);

    let result = wire
        .ask::<ImportIntoTemplate>(&ImportIntoTemplateRequest {
            template: "kit".into(),
            scope_path: claude.display().to_string(),
            paths: vec![skill.join("SKILL.md").display().to_string()],
        })
        .await;

    assert!(result.problems.is_empty(), "{:?}", result.problems);
    let mut created = result.created.clone();
    created.sort();
    assert_eq!(
        created,
        [
            ".claude/skills/think/SKILL.md",
            ".claude/skills/think/reference.md"
        ]
    );
    let copied = wire.templates.join("kit/.claude/skills/think");
    assert_eq!(
        fs::read(copied.join("SKILL.md")).unwrap(),
        fs::read(skill.join("SKILL.md")).unwrap()
    );
    assert_eq!(read(&copied.join("reference.md")), "# reference\n");

    let gone = claude.join("skills").join("gone").join("SKILL.md");
    let refused = wire
        .ask::<ImportIntoTemplate>(&ImportIntoTemplateRequest {
            template: "kit".into(),
            scope_path: claude.display().to_string(),
            paths: vec![gone.display().to_string()],
        })
        .await;
    assert!(!refused.ok);
    assert_eq!(
        refused.problems,
        [format!(
            "{} is not in User any more. Re-read the scope and try again.",
            gone.display()
        )]
    );

    wire.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_previews_a_folder_as_a_template_and_saves_what_was_ticked() {
    let mut wire = Wire::start().await;
    let dir = plant_harness_in(&wire.root);

    let preview = wire.folder_preview(&dir).await;
    let mut names: Vec<&str> = preview.entries.iter().map(|e| e.name.as_str()).collect();
    names.sort_unstable();
    assert_eq!(
        names,
        [
            ".claude",
            ".git",
            "CLAUDE.md",
            "harness.yaml",
            "notes",
            "repos",
            "tools"
        ]
    );
    let include = ticked(&preview);
    let mut sorted_include = include.clone();
    sorted_include.sort();
    assert_eq!(sorted_include, [".claude", "CLAUDE.md", "notes", "tools"]);
    assert_eq!(preview.file_count, 4);

    let saved = wire.save_folder(&dir, "frozen", include).await;

    assert!(saved.ok, "{:?}", saved.problems);
    assert_eq!(saved.file_count, 4);
    assert_eq!(
        tree(&wire.templates.join("frozen")),
        [
            ".claude",
            ".claude/skills",
            ".claude/skills/think",
            ".claude/skills/think/SKILL.md",
            "CLAUDE.md",
            "notes",
            "notes/journal.md",
            "template.yaml",
            "tools",
            "tools/run.mjs"
        ]
    );
    let listing = wire.listing().await;
    let frozen = listing.templates.iter().find(|t| t.id == "frozen").unwrap();
    assert_eq!(frozen.label, "Frozen");

    // A name already taken leaves that template alone.
    let again = wire
        .save_folder(&dir, "frozen", vec!["CLAUDE.md".into()])
        .await;
    assert!(!again.ok);
    assert_eq!(tree(&wire.templates.join("frozen")).len(), 10);

    wire.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_link_in_a_template_is_never_walked_when_a_client_lists_previews_applies_or_deletes_it() {
    let mut wire = Wire::start().await;
    let canary = plant_canary(&wire.root);
    let before = contents(&canary);
    let templates = wire.templates.clone();
    write(
        &templates.join("hostile").join("template.yaml"),
        "label: \"Hostile\"\n",
    );
    write(&templates.join("hostile").join("ok.txt"), "fine");
    link_folder(&canary, &templates.join("hostile").join("escape"));
    link_folder(&canary, &templates.join("linked"));

    // Listed: a template that is itself a link is not offered, and is named.
    let listing = wire.listing().await;
    let ids: Vec<&str> = listing.templates.iter().map(|t| t.id.as_str()).collect();
    assert!(ids.contains(&"hostile"), "{ids:?}");
    assert!(!ids.contains(&"linked"), "{ids:?}");
    assert!(
        listing.problems.join(" ").contains("linked"),
        "{:?}",
        listing.problems
    );

    // Previewed and read: the link is named, and nothing behind it is listed.
    let preview = wire.preview("hostile").await;
    assert_eq!(preview.entries, ["harness.yaml", "ok.txt"]);
    assert!(
        preview.problems.join(" ").contains("escape"),
        "{:?}",
        preview.problems
    );
    let detail = wire.detail("hostile").await;
    let mut listed: Vec<(&str, bool)> = detail
        .files
        .iter()
        .map(|file| (file.rel_path.as_str(), file.link))
        .collect();
    listed.sort_unstable();
    assert_eq!(listed, [("escape", true), ("ok.txt", false)]);
    assert_eq!(detail.file_count, 1);

    // Applied: the harness has the template's own half and nothing else.
    let parent = wire.root.join("harnesses");
    fs::create_dir_all(&parent).unwrap();
    let outcome = wire.harness(&parent, "work", "hostile").await;
    assert_eq!(
        outcome.path.as_deref(),
        Some(parent.join("work").display().to_string().as_str())
    );
    let problems = outcome.problems.join(" ");
    assert!(
        problems.contains("escape") && problems.contains("link"),
        "{problems}"
    );
    assert_eq!(tree(&parent.join("work")), ["harness.yaml", "ok.txt"]);

    // Deleted: the link inside is unlinked; a template that is a link is refused.
    assert!(wire.delete("hostile").await);
    assert!(!templates.join("hostile").exists());
    assert!(!wire.delete("linked").await);

    assert_eq!(contents(&canary), before);
    wire.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_link_in_a_folder_saved_as_a_template_is_never_walked_over_the_wire() {
    let mut wire = Wire::start().await;
    let canary = plant_canary(&wire.root);
    let before = contents(&canary);
    let dir = plant_harness_in(&wire.root);
    link_folder(&canary, &dir.join("escape"));
    link_folder(&canary, &dir.join("tools").join("deep-escape"));

    let preview = wire.folder_preview(&dir).await;
    let entry = |name: &str| {
        preview
            .entries
            .iter()
            .find(|entry| entry.name == name)
            .unwrap()
    };
    assert!(entry("escape").link);
    assert!(!entry("escape").included);
    assert_eq!(entry("tools").file_count, 1);
    let problems = preview.problems.join(" ");
    assert!(
        problems.contains("escape") && problems.contains("deep-escape"),
        "{problems}"
    );

    let saved = wire.save_folder(&dir, "frozen", vec!["tools".into()]).await;
    assert!(saved.ok, "{:?}", saved.problems);
    assert_eq!(
        tree(&wire.templates.join("frozen")),
        ["template.yaml", "tools", "tools/run.mjs"]
    );
    assert!(
        saved.problems.join(" ").contains("deep-escape"),
        "{:?}",
        saved.problems
    );

    assert!(wire.delete("frozen").await);
    assert_eq!(contents(&canary), before);
    // The folder it was saved from still has its links, unwalked and intact.
    assert!(links::is_link(&dir.join("escape")));
    assert!(links::is_link(&dir.join("tools").join("deep-escape")));
    wire.stop().await;
}
