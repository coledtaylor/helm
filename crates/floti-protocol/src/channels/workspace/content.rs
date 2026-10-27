//! Notes and artifacts opened from the Files view, and their search:
//! `content:*`. Each needs the `files` capability.
//!
//! Rendering happens on the host, so a client carries no grammars and a
//! preview never re-parses a note on its UI thread.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{
    ConfigFileContent, ConfigScopeKind, ConfigSnapshotMeta, Millis, RestoreSnapshotRequest,
    ScopedFile, WriteConfigRequest, WriteConfigResult,
};

request_channel!(
    ListContentScopes = "content:scopes", () => Vec<ContentScope>, needs Files
);
request_channel!(
    /// A file, its bytes, and for markdown the HTML it renders to.
    ReadContentDocument = "content:document", ScopedFile => ContentDocument, needs Files
);
request_channel!(
    /// The same render for text that is not on disk yet.
    RenderContent = "content:render", ContentRenderRequest => RenderedMarkdown, needs Files
);
request_channel!(
    SearchContent = "content:search", ContentSearchRequest => ContentSearchResult, needs Files
);
request_channel!(
    /// Saves a note, through the same snapshots and conflict check as
    /// `config:write`.
    WriteContent = "content:write", WriteConfigRequest => WriteConfigResult, needs Files
);
request_channel!(
    ListContentSnapshots = "content:snapshots", ScopedFile => Vec<ConfigSnapshotMeta>, needs Files
);
request_channel!(
    RestoreContentSnapshot = "content:restore", RestoreSnapshotRequest => WriteConfigResult, needs Files
);
request_channel!(
    /// Mints the address a sandboxed frame may load an HTML artifact from,
    /// pinned to a token the host issued for that file.
    OpenArtifact = "content:artifact", ScopedFile => ArtifactLink, needs Files
);
request_channel!(
    /// Resolves a `[[wikilink]]` an artifact's frame clicked.
    ResolveWikilink = "content:wikilink", WikilinkRequest => WikilinkTarget, needs Files
);

/// A scope whose content can be read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContentScope {
    pub kind: ConfigScopeKind,
    pub path: String,
    pub label: String,
}

/// Why a folder of content is offered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum ContentRootKind {
    Notes,
    Context,
    Skills,
    Docs,
    Root,
    Found,
}

/// How a file opens: rendered, framed, as source, or not at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum ContentFileKind {
    Markdown,
    Html,
    Data,
    Text,
    Source,
    Binary,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContentFile {
    pub path: String,
    /// Relative to the scope, forward-slashed.
    pub rel_path: String,
    /// The `relPath` of the root it was found under.
    pub root: String,
    pub root_kind: ContentRootKind,
    pub kind: ContentFileKind,
    /// The base name without extension: what a wikilink names.
    pub slug: String,
    /// Lower-cased extension without the dot; empty for none.
    pub ext: String,
    pub title: String,
    #[ts(type = "number")]
    pub size: u64,
    pub mtime_ms: Millis,
    /// Frontmatter `type`, `date` and `tags`.
    pub note_type: Option<String>,
    pub date: Option<String>,
    pub tags: Vec<String>,
}

/// Why a listed entry is greyed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum ContentIgnoreReason {
    Gitignore,
    Default,
}

/// One entry of a folder listing. Ignored entries are carried, not dropped.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContentDirEntry {
    pub name: String,
    pub rel_path: String,
    pub path: String,
    pub directory: bool,
    /// A symlink or junction: listed, never descended.
    pub link: bool,
    /// How the file would open; null for a folder.
    pub kind: Option<ContentFileKind>,
    pub ext: String,
    #[ts(type = "number")]
    pub size: u64,
    pub mtime_ms: Millis,
    pub ignored: bool,
    pub ignored_by: Option<ContentIgnoreReason>,
}

/// One folder, read on demand.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContentDirListing {
    pub scope_path: String,
    /// Relative to the scope; empty for the scope folder.
    pub rel_path: String,
    pub entries: Vec<ContentDirEntry>,
    /// How many entries are ignored.
    pub ignored: u32,
    /// What decided the ignores.
    pub ignore_source: ContentIgnoreReason,
    /// Set when the folder could not be read at all.
    pub error: Option<String>,
    pub took_ms: Millis,
}

/// One frontmatter `key: value`, as a chip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContentChip {
    pub key: String,
    pub value: String,
    pub values: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContentHeading {
    pub depth: u32,
    pub text: String,
    pub slug: String,
}

/// One `[[wikilink]]`, and what it points at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContentWikilink {
    /// Exactly what was between the brackets.
    pub target: String,
    pub label: String,
    pub heading: Option<String>,
    /// Absolute path, or null when nothing in the scope matches.
    pub resolved: Option<String>,
}

/// What the source turned out to contain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContentCounts {
    pub tables: u32,
    pub task_items: u32,
    pub task_items_checked: u32,
    pub code_blocks: u32,
    pub highlighted_blocks: u32,
    pub callouts: u32,
    pub wikilinks: u32,
    pub broken_wikilinks: u32,
    pub tags: u32,
    pub headings: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RenderedFrontmatter {
    /// A file with no `---` block has none.
    pub present: bool,
    pub fields: Vec<ContentChip>,
    pub raw: String,
    /// Set when the block is not parseable YAML.
    pub error: Option<String>,
    /// The line the closing fence sits on, 1-based.
    pub end_line: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RenderedMarkdown {
    /// Sanitised HTML. A client injects it and never evaluates it.
    pub html: String,
    pub frontmatter: RenderedFrontmatter,
    pub headings: Vec<ContentHeading>,
    pub links: Vec<ContentWikilink>,
    pub tags: Vec<String>,
    pub words: u32,
    pub counts: ContentCounts,
    /// Languages a code fence asked for that had no grammar.
    pub unknown_languages: Vec<String>,
    pub took_ms: Millis,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContentDocument {
    pub file: ContentFile,
    pub content: ConfigFileContent,
    pub rendered: Option<RenderedMarkdown>,
    /// Set when the file could not be rendered; the source still shows.
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContentRenderRequest {
    pub scope_path: String,
    pub path: String,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchRequest {
    pub scope_path: String,
    pub query: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchLine {
    pub line: u32,
    /// The line, trimmed, with the match inside it.
    pub text: String,
    /// The match's offsets within `text`.
    pub from: u32,
    pub to: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchHit {
    pub path: String,
    pub rel_path: String,
    pub root: String,
    pub title: String,
    pub matches: u32,
    /// The file's own name or title matched.
    pub name_match: bool,
    /// The first few matching lines.
    pub lines: Vec<ContentSearchLine>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchResult {
    pub query: String,
    pub hits: Vec<ContentSearchHit>,
    pub files_searched: u32,
    /// The kinds whose text was read; every file is matched on its name.
    pub body_kinds: Vec<ContentFileKind>,
    pub files_with_text: u32,
    #[ts(type = "number")]
    pub bytes_searched: u64,
    pub total_matches: u32,
    pub took_ms: Millis,
    /// The corpus was read from disk rather than served warm.
    pub cold: bool,
    pub truncated: bool,
}

/// Where a frame may load an HTML artifact from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactLink {
    pub url: String,
    pub token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct WikilinkRequest {
    pub scope_path: String,
    pub target: String,
    /// The artifact the link was clicked in, which `[[index]]` prefers to
    /// resolve beside.
    pub from: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct WikilinkTarget {
    /// The file, or null when nothing matches.
    pub path: Option<String>,
}
