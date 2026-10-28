//! Today's languages, highlighted by the host as a client asks for them.
//!
//! The list is not written out here. It is read, when the test runs, from the
//! two files that are today's: `packages/core/src/content/highlight.ts` (its
//! alias table and the names it treats as plain text) and
//! `packages/ui/src/lib/languages.ts` (the grammars the app shows by name).
//! The host's own tables are checked against highlight.ts entry for entry,
//! and every name is sent to a running host through a client connection on
//! the three paths that highlight: a fence in `content:render`, a file in
//! `config:render` and an editor's source in `editor:highlight`.
//!
//! A folder is made known the way the Files tests make one known: a session
//! starts in it, driven against the fake agent.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use floti_host::agent::AgentBackend;
use floti_host::fake_agent;
use floti_host::platform::socket::Endpoint;
use floti_host::server::HostConfig;
use floti_host::testkit::{FakeAgent, RunningHost, TestClient, TestDirs};
use floti_host::workspace::render::highlight::{ALIASES, PLAIN};
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::sessions::{SessionStart, StartSessionRequest};
use floti_protocol::channels::workspace::{
    ConfigRendered, ContentRenderRequest, EditorHighlight, HighlightSource, RenderConfigFile,
    RenderContent, RenderedMarkdown, SourceToRender,
};

const CAPABILITIES: &[&str] = &["files", "terminal"];

// ---------------------------------------------------------------------------
// Today's list, read from the app's own files
// ---------------------------------------------------------------------------

/// A file of the JavaScript half of the repository, as text.
fn repo_file(relative: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(relative);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{} cannot be read: {error}", path.display()))
}

/// The lines of the object literal that `opening` starts, up to its `}`.
fn object_lines<'a>(source: &'a str, opening: &str, file: &str) -> Vec<&'a str> {
    let mut lines = source.lines().map(str::trim);
    lines
        .by_ref()
        .find(|line| line.starts_with(opening))
        .unwrap_or_else(|| panic!("{file} has no `{opening}`"));
    lines
        .take_while(|line| !line.starts_with('}'))
        .filter(|line| !line.is_empty() && !line.starts_with("//"))
        .collect()
}

/// `'c++'` as `c++`, and a bare key as itself.
fn unquote(text: &str) -> String {
    let text = text.trim();
    text.strip_prefix('\'')
        .and_then(|rest| rest.strip_suffix('\''))
        .unwrap_or(text)
        .to_owned()
}

/// An object literal's `key: 'value'` entries.
fn object_entries(source: &str, opening: &str, file: &str) -> BTreeMap<String, String> {
    object_lines(source, opening, file)
        .into_iter()
        .map(|line| {
            let entry = line.trim_end_matches(',');
            let (key, value) = entry
                .split_once(':')
                .unwrap_or_else(|| panic!("{file}: `{line}` is not a `key: value` entry"));
            (unquote(key), unquote(value))
        })
        .collect()
}

/// What highlight.ts and languages.ts say, as the test walks it.
struct Today {
    /// highlight.ts's `ALIASES`.
    aliases: BTreeMap<String, String>,
    /// highlight.ts's plain-text names: the set `loaded` starts with.
    plain: BTreeSet<String>,
    /// Every name the test sends: each alias and what it means, each plain
    /// name, and each grammar languages.ts shows by name.
    walked: BTreeSet<String>,
}

impl Today {
    fn read() -> Self {
        const HIGHLIGHT: &str = "packages/core/src/content/highlight.ts";
        const LANGUAGES: &str = "packages/ui/src/lib/languages.ts";
        let highlight = repo_file(HIGHLIGHT);
        let aliases = object_entries(&highlight, "const ALIASES", HIGHLIGHT);
        let plain: BTreeSet<String> = highlight
            .lines()
            .find_map(|line| {
                line.trim()
                    .strip_prefix("const loaded = new Set<string>([")
                    .and_then(|rest| rest.split_once("])"))
                    .map(|(names, _)| names.to_owned())
            })
            .unwrap_or_else(|| panic!("{HIGHLIGHT} has no `const loaded` set"))
            .split(',')
            .map(unquote)
            .collect();
        let names = object_entries(&repo_file(LANGUAGES), "const NAMES", LANGUAGES);
        assert!(!aliases.is_empty(), "{HIGHLIGHT}'s ALIASES read as empty");
        assert!(!plain.is_empty(), "{HIGHLIGHT}'s plain set read as empty");
        assert!(!names.is_empty(), "{LANGUAGES}'s NAMES read as empty");

        let walked = aliases
            .iter()
            .flat_map(|(alias, name)| [alias.clone(), name.clone()])
            .chain(plain.iter().cloned())
            .chain(names.into_keys())
            .collect();
        Self {
            aliases,
            plain,
            walked,
        }
    }

    /// highlight.ts's `normaliseLanguage`.
    fn normalise(&self, raw: &str) -> String {
        let lower = raw.trim().to_lowercase();
        self.aliases.get(&lower).cloned().unwrap_or(lower)
    }

    /// Whether highlight.ts highlights `raw` as plain text by design.
    fn is_plain(&self, raw: &str) -> bool {
        let name = self.normalise(raw);
        name == "plaintext" || self.plain.contains(&name)
    }

    fn languages(&self) -> impl Iterator<Item = &str> {
        self.walked
            .iter()
            .map(String::as_str)
            .filter(|name| !self.is_plain(name))
    }

    fn plain_names(&self) -> impl Iterator<Item = &str> {
        self.walked
            .iter()
            .map(String::as_str)
            .filter(|name| self.is_plain(name))
    }
}

/// A source for a grammar to colour, by the language it is in. Most share
/// one; a grammar that needs its own constructs to show them has its own.
fn sample(language: &str) -> &'static str {
    match language {
        "bat" => "@echo off\nREM build it\nset COUNT=42\nif \"%COUNT%\"==\"42\" echo done",
        "css" | "scss" | "less" | "sass" => "a.note { color: #fff; margin: 4px; }",
        "diff" => "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old line\n+new line",
        "docker" => "FROM node:20\nRUN npm ci\nENV MODE=\"production\"",
        "html" | "xml" | "vue" | "svelte" | "astro" => {
            "<div class=\"note\">\n  <a href=\"/x\">link</a>\n</div>"
        }
        "ini" => "; settings\n[section]\nkey = \"value\"\ncount = 42",
        "json" | "jsonc" | "json5" => "{ \"name\": \"floti\", \"count\": 42, \"on\": true }",
        "markdown" | "mdx" => "# Heading\n\nSome *emphasis* and `code`.\n\n- [a link](https://x)",
        // PHP is code only inside its tag; outside it is the page's text.
        "php" => "<?php\n// note\n$count = 42;\necho \"done\";",
        "powershell" => "# note\n$count = 42\nWrite-Host \"done $count\" -NoNewline",
        "shellscript" => "# note\nif [ -n \"$COUNT\" ]; then\n  echo \"done\" 42\nfi",
        "sql" => "SELECT name, 42 FROM notes WHERE kind = 'done';",
        "toml" => "[package]\nname = \"floti\"\nversion = 42",
        "yaml" => "# note\nname: \"floti\"\ncount: 42",
        _ => "// note\nif (count == 42) { return \"done\"; }",
    }
}

/// Each token span's light and dark colours in `html`, or why one has none.
fn token_colours(html: &str) -> Result<(BTreeSet<String>, BTreeSet<String>), String> {
    let mut light = BTreeSet::new();
    let mut dark = BTreeSet::new();
    for rest in html.split("<span style=\"").skip(1) {
        let style = rest.split('"').next().unwrap_or_default();
        let colour = |side: &str| {
            style
                .split(';')
                .find_map(|part| part.strip_prefix(&format!("--shiki-{side}:#")))
                .map(|hex| format!("#{hex}"))
        };
        match (colour("light"), colour("dark")) {
            (Some(l), Some(d)) => {
                light.insert(l);
                dark.insert(d);
            }
            _ => return Err(format!("a token without both colours: {style}")),
        }
    }
    Ok((light, dark))
}

/// Why `html` is not coloured by a grammar in both themes, if it is not:
/// every token carries both colours, and the tokens show at least two of
/// each, so it is not one foreground.
fn coloured_by_a_grammar(html: &str) -> Result<(), String> {
    let (light, dark) = token_colours(html)?;
    if light.len() < 2 || dark.len() < 2 {
        return Err(format!("one colour only: light {light:?}, dark {dark:?}"));
    }
    Ok(())
}

/// The `<pre data-language=...>` block in a rendered note.
fn code_block(html: &str) -> Option<&str> {
    let start = html.find("<pre data-language=")?;
    let end = html[start..].find("</pre>")? + start;
    Some(&html[start..end])
}

// ---------------------------------------------------------------------------
// The world: a host with a client connected and a folder it knows
// ---------------------------------------------------------------------------

struct World {
    host: Option<RunningHost>,
    client: TestClient,
    /// A folder a session runs in, so content requests may name it.
    scope: PathBuf,
    _agent: FakeAgent,
    /// Last: fields drop in order.
    _dirs: TestDirs,
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
        let mut client = TestClient::connect(&endpoint, CAPABILITIES).await;
        let scope = dirs.folder("notes and code");
        client
            .request::<SessionStart>(&StartSessionRequest {
                cwd: text(&scope),
                cols: 80,
                rows: 24,
                ..StartSessionRequest::default()
            })
            .await
            .expect("a session starts in the folder");
        Self {
            host: Some(host),
            client,
            scope,
            _agent: agent,
            _dirs: dirs,
        }
    }

    async fn stop(mut self) {
        if let Some(host) = self.host.take() {
            host.stop(HostStopReason::Stop).await;
        }
    }

    /// A note holding one fence labelled `info`, rendered as a draft.
    async fn fence(&mut self, info: &str, code: &str) -> RenderedMarkdown {
        self.client
            .request::<RenderContent>(&ContentRenderRequest {
                scope_path: text(&self.scope),
                path: text(&self.scope.join("note.md")),
                source: format!("# Sample\n\n```{info}\n{code}\n```\n"),
            })
            .await
            .unwrap_or_else(|error| panic!("a note with a {info} fence: {}", error.message))
    }

    async fn config_file(&mut self, path: &str, source: &str) -> ConfigRendered {
        self.client
            .request::<RenderConfigFile>(&SourceToRender {
                path: path.to_owned(),
                source: source.to_owned(),
            })
            .await
            .unwrap_or_else(|error| panic!("config:render of {path}: {}", error.message))
    }

    async fn editor(&mut self, path: &str, source: &str) -> EditorHighlight {
        self.client
            .request::<HighlightSource>(&SourceToRender {
                path: path.to_owned(),
                source: source.to_owned(),
            })
            .await
            .unwrap_or_else(|error| panic!("editor:highlight of {path}: {}", error.message))
    }
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// The file a language is sent as to `config:render` and `editor:highlight`:
/// its name is the extension, as an editor's file names it.
fn sample_path(name: &str) -> String {
    format!("sample.{name}")
}

/// Fails naming every problem at once, so one run lists every language.
fn assert_none(problems: Vec<String>) {
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

#[test]
fn the_hosts_language_tables_are_the_ones_highlight_ts_resolves_with() {
    let today = Today::read();
    let host_aliases: BTreeMap<String, String> = ALIASES
        .iter()
        .map(|(alias, name)| ((*alias).to_owned(), (*name).to_owned()))
        .collect();
    assert_eq!(
        host_aliases, today.aliases,
        "the host's ALIASES against highlight.ts's"
    );
    assert_eq!(
        ALIASES.len(),
        host_aliases.len(),
        "the host's ALIASES repeat an alias"
    );
    let host_plain: BTreeSet<String> = PLAIN.iter().map(|name| (*name).to_owned()).collect();
    assert_eq!(
        host_plain, today.plain,
        "the host's PLAIN against highlight.ts's"
    );

    // The list was read whole: the languages that once fell back to plain
    // text or to JavaScript's grammar are in it.
    let walked: BTreeSet<String> = today
        .languages()
        .map(|name| today.normalise(name))
        .collect();
    for language in ["typescript", "tsx", "powershell", "toml", "docker", "ini"] {
        assert!(
            walked.contains(language),
            "{language} is not in the walked list: {walked:?}"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn every_language_today_highlights_is_coloured_in_both_themes_through_content_config_and_editor_highlighting()
 {
    let today = Today::read();
    let mut world = World::start().await;
    let mut problems = Vec::new();
    for name in today.languages() {
        let language = today.normalise(name);
        let code = sample(&language);
        let path = sample_path(name);

        let note = world.fence(name, code).await;
        let label = format!("<pre data-language=\"{language}\"");
        if note.counts.highlighted_blocks != 1 {
            problems.push(format!(
                "content:render {name}: {} highlighted blocks",
                note.counts.highlighted_blocks
            ));
        }
        if !note.unknown_languages.is_empty() {
            problems.push(format!(
                "content:render {name}: named unknown {:?}",
                note.unknown_languages
            ));
        }
        match code_block(&note.html) {
            Some(block) if block.starts_with(&label) => {
                if let Err(why) = coloured_by_a_grammar(block) {
                    problems.push(format!("content:render {name}: {why}"));
                }
            }
            _ => problems.push(format!(
                "content:render {name}: no {label} in {}",
                note.html
            )),
        }

        let rendered = world.config_file(&path, code).await;
        if language == "markdown" {
            // A markdown file is rendered as a note, as today.
            if rendered.code.is_some() || rendered.markdown.is_none() {
                problems.push(format!("config:render {path}: not rendered as markdown"));
            }
        } else {
            match rendered.code {
                Some(block) if block.highlighted && block.language == language => {
                    if let Err(why) = coloured_by_a_grammar(&block.html) {
                        problems.push(format!("config:render {path}: {why}"));
                    }
                }
                Some(block) => problems.push(format!(
                    "config:render {path}: highlighted {} as {}",
                    block.highlighted, block.language
                )),
                None => problems.push(format!("config:render {path}: rendered as markdown")),
            }
        }

        let editor = world.editor(&path, code).await;
        if !editor.highlighted || editor.too_large || editor.language != language {
            problems.push(format!(
                "editor:highlight {path}: highlighted {}, too large {}, as {}",
                editor.highlighted, editor.too_large, editor.language
            ));
        } else if let Err(why) = coloured_by_a_grammar(&editor.lines.concat()) {
            problems.push(format!("editor:highlight {path}: {why}"));
        }
    }
    world.stop().await;
    assert_none(problems);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_plain_text_name_comes_back_plain_through_content_config_and_editor_highlighting() {
    let today = Today::read();
    let mut world = World::start().await;
    let mut problems = Vec::new();
    let code = "a < b and 42 \"words\"";
    for name in today.plain_names() {
        let path = sample_path(name);

        let note = world.fence(name, code).await;
        if note.counts.highlighted_blocks != 0 || note.counts.code_blocks != 1 {
            problems.push(format!("content:render {name:?}: {:?}", note.counts));
        }
        if !note.html.contains("a &lt; b") {
            problems.push(format!(
                "content:render {name:?}: the text is not there escaped"
            ));
        }

        match world.config_file(&path, code).await.code {
            Some(block) if !block.highlighted && block.language == "plaintext" => {}
            other => problems.push(format!("config:render {path}: {other:?}")),
        }

        let editor = world.editor(&path, code).await;
        if editor.highlighted || editor.too_large || editor.language != "plaintext" {
            problems.push(format!(
                "editor:highlight {path}: highlighted {}, too large {}, as {}",
                editor.highlighted, editor.too_large, editor.language
            ));
        }
    }
    world.stop().await;
    assert_none(problems);
}
