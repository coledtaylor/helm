//! The readable content of a scope, found rather than configured: the files
//! a scope's wikilinks resolve against and its search reads.
//!
//! `notes/`, `context/`, `.claude/skills/` and `docs/` are offered first
//! when they exist, empty or not. Every other top-level folder that holds
//! something readable is offered too, and the scope's own loose files. A
//! root that is offered lists every file inside it, binaries included.
//!
//! `repos/` is not walked: each repository under it is a scope of its own.
//! Links are never followed: an overlay's junction points into a real
//! repository, and one pointing at an ancestor would not end.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs::Metadata;
use std::io::Read;
use std::path::Path;

use floti_protocol::channels::workspace::{
    ContentFile, ContentFileKind, ContentRootKind, ContentScope, Millis,
};

use super::kinds::{content_extension, content_file_kind, counts_as_content};
use crate::config_console::mtime_ms;
use crate::workspace::render::frontmatter::{
    frontmatter_string, frontmatter_tags, parse_note_frontmatter,
};

/// Deep enough for `docs/adr/2026/thing.md`, shallow enough to end.
const MAX_DEPTH: usize = 6;

/// A ceiling, so a scope pointed at something enormous still answers.
const MAX_FILES: usize = 5000;

/// Far enough into a file to pass its frontmatter and first heading.
const HEAD_BYTES: u64 = 8192;

/// Folders the walk does not enter.
pub const CURATED_SKIPPED_DIRS: &[&str] = &[
    "repos",
    "node_modules",
    ".git",
    ".svn",
    ".hg",
    "out",
    "dist",
    "build",
    "coverage",
    "target",
    ".venv",
    "venv",
    "env",
    "__pycache__",
    ".next",
    ".nuxt",
    ".cache",
    ".turbo",
    ".vite",
    "bin",
    "obj",
    "vendor",
    "site-packages",
    ".pytest_cache",
    ".mypy_cache",
    ".idea",
    ".vs",
    ".vscode",
];

/// The roots named by rule, in this order.
const NAMED_ROOTS: [(&str, ContentRootKind, &str); 4] = [
    ("notes", ContentRootKind::Notes, "Notes"),
    ("context", ContentRootKind::Context, "Context"),
    (".claude/skills", ContentRootKind::Skills, "Skills"),
    ("docs", ContentRootKind::Docs, "Docs"),
];

/// Why a root is on the list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootOffer {
    /// Offered by rule, whatever it holds.
    Named,
    /// Offered because a walk found something readable in it.
    Discovered,
}

/// A folder content was found under.
#[derive(Debug, Clone, PartialEq)]
pub struct ContentRoot {
    pub kind: ContentRootKind,
    pub offer: RootOffer,
    /// Relative to the scope, forward-slashed; empty for the scope itself.
    pub rel_path: String,
    pub label: String,
    pub files: u32,
}

/// Every readable file in a scope, grouped by the root it came from.
#[derive(Debug, Clone, PartialEq)]
pub struct ContentTree {
    pub scope: ContentScope,
    pub roots: Vec<ContentRoot>,
    pub files: Vec<ContentFile>,
    /// Folders that could not be read; the rest of the tree stands.
    pub errors: Vec<String>,
}

fn is_skipped(name: &str) -> bool {
    CURATED_SKIPPED_DIRS.contains(&name.to_lowercase().as_str())
}

/// Orders names the way a person reads a list: ignoring case first.
pub(crate) fn name_order(a: &str, b: &str) -> Ordering {
    a.to_lowercase()
        .cmp(&b.to_lowercase())
        .then_with(|| a.cmp(b))
}

/// The first bytes of a file, decoded leniently.
fn read_head(path: &Path) -> String {
    let mut bytes = Vec::new();
    let read =
        std::fs::File::open(path).and_then(|file| file.take(HEAD_BYTES).read_to_end(&mut bytes));
    match read {
        Ok(_) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(_) => String::new(),
    }
}

/// The first ATX heading, a note's title when its frontmatter has none.
fn first_heading(body: &str) -> Option<String> {
    for line in body.split('\n').take(400) {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let hashes = line.bytes().take_while(|byte| *byte == b'#').count();
        if !(1..=6).contains(&hashes) {
            continue;
        }
        let rest = &line[hashes..];
        if !rest.starts_with(|ch: char| ch.is_whitespace()) {
            continue;
        }
        let title = rest.trim_end().trim_end_matches('#').trim();
        if !title.is_empty() {
            return Some(title.to_owned());
        }
    }
    None
}

/// The `<title>` of an HTML file's head.
fn html_title(head: &str) -> Option<String> {
    let lower = head.to_ascii_lowercase();
    let open = lower.find("<title")?;
    let start = open + lower[open..].find('>')? + 1;
    let end = start + lower[start..].find("</title>")?;
    let title = head[start..end]
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    (!title.is_empty()).then_some(title)
}

/// A file's row: its kind, and for prose the title it carries inside it.
pub fn describe_file(
    path: &Path,
    rel_path: &str,
    root: &ContentRoot,
    meta: &Metadata,
) -> ContentFile {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let kind = content_file_kind(&name);
    let raw_ext = content_extension(&name);
    let slug = if raw_ext.is_empty() || raw_ext == name.to_lowercase() {
        name.clone()
    } else {
        name[..name.len() - raw_ext.len()].to_owned()
    };
    let ext = raw_ext.strip_prefix('.').unwrap_or(&raw_ext).to_owned();

    let mut title = if matches!(kind, ContentFileKind::Markdown | ContentFileKind::Html) {
        slug.clone()
    } else {
        name.clone()
    };
    let mut note_type = None;
    let mut date = None;
    let mut tags = Vec::new();
    match kind {
        ContentFileKind::Markdown => {
            let front = parse_note_frontmatter(&read_head(path));
            let data = front.data.as_ref();
            note_type = frontmatter_string(data, "type");
            date = frontmatter_string(data, "date");
            tags = frontmatter_tags(data);
            title = frontmatter_string(data, "title")
                .or_else(|| first_heading(&front.body))
                .unwrap_or_else(|| slug.clone());
            // A skill is addressed by its folder, not by `SKILL.md`.
            if name.eq_ignore_ascii_case("skill.md") {
                let parent = path
                    .parent()
                    .and_then(Path::file_name)
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default();
                title = frontmatter_string(data, "name").unwrap_or(parent);
            }
        }
        ContentFileKind::Html => {
            if let Some(found) = html_title(&read_head(path)) {
                title = found;
            }
        }
        _ => {}
    }

    ContentFile {
        path: path.display().to_string(),
        rel_path: rel_path.to_owned(),
        root: root.rel_path.clone(),
        root_kind: root.kind,
        kind,
        slug,
        ext,
        title,
        size: meta.len(),
        mtime_ms: mtime_ms(meta),
        note_type,
        date,
        tags,
    }
}

/// What a walk of one scope gathers.
struct Walk<'a> {
    scope: &'a Path,
    files: Vec<ContentFile>,
    errors: Vec<String>,
}

impl Walk<'_> {
    fn rel(&self, path: &Path) -> String {
        path.strip_prefix(self.scope)
            .map(|rel| {
                rel.components()
                    .map(|part| part.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/")
            })
            .unwrap_or_default()
    }

    fn walk(&mut self, dir: &Path, root: &mut ContentRoot, depth: usize) {
        if depth > MAX_DEPTH || self.files.len() >= MAX_FILES {
            return;
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(err) => {
                self.errors.push(format!("{}: {err}", dir.display()));
                return;
            }
        };
        for entry in entries.flatten() {
            if self.files.len() >= MAX_FILES {
                return;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            // A link is neither a folder to walk nor a file to list.
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                if !is_skipped(&entry.file_name().to_string_lossy()) {
                    self.walk(&path, root, depth + 1);
                }
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            // Gone between the listing and the look: not there, not listed.
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            let rel = self.rel(&path);
            self.files.push(describe_file(&path, &rel, root, &meta));
            root.files += 1;
        }
    }
}

/// `path` as a scope: absolute, folded, labelled by its folder's name
/// unless `label` says otherwise.
pub fn content_scope(
    path: &Path,
    kind: floti_protocol::channels::workspace::ConfigScopeKind,
    label: Option<&str>,
) -> ContentScope {
    let base = crate::config_console::normalize(path);
    let shown = base.display().to_string();
    let label = label.map(str::to_owned).unwrap_or_else(|| {
        base.file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| shown.clone())
    });
    ContentScope {
        kind,
        path: shown,
        label,
    }
}

/// Everything readable in `scope`.
pub fn read_content_tree(scope: &ContentScope) -> ContentTree {
    let base = Path::new(&scope.path);
    let mut walk = Walk {
        scope: base,
        files: Vec::new(),
        errors: Vec::new(),
    };
    let mut roots: Vec<ContentRoot> = Vec::new();

    // The scope's own loose files, listed when there are some.
    let mut loose = ContentRoot {
        kind: ContentRootKind::Root,
        offer: RootOffer::Named,
        rel_path: String::new(),
        label: scope.label.clone(),
        files: 0,
    };
    let top: Vec<std::fs::DirEntry> = match std::fs::read_dir(base) {
        Ok(entries) => entries.flatten().collect(),
        Err(err) => {
            walk.errors.push(format!("{}: {err}", base.display()));
            Vec::new()
        }
    };
    for entry in &top {
        if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        walk.files.push(describe_file(&path, &name, &loose, &meta));
        loose.files += 1;
    }
    if loose.files > 0 {
        roots.push(loose);
    }

    let mut claimed: Vec<String> = Vec::new();
    for (rel, kind, label) in NAMED_ROOTS {
        let path = rel
            .split('/')
            .fold(base.to_path_buf(), |path, part| path.join(part));
        let is_dir = std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_dir());
        if !is_dir {
            continue;
        }
        claimed.push(rel.split('/').next().unwrap_or(rel).to_lowercase());
        let mut root = ContentRoot {
            kind,
            offer: RootOffer::Named,
            rel_path: rel.to_owned(),
            label: label.to_owned(),
            files: 0,
        };
        walk.walk(&path, &mut root, 1);
        roots.push(root);
    }

    let mut discovered: Vec<ContentRoot> = Vec::new();
    for entry in &top {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if !kind.is_dir() || kind.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let lower = name.to_lowercase();
        if is_skipped(&name) || claimed.contains(&lower) || name.starts_with('.') {
            continue;
        }
        let mut root = ContentRoot {
            kind: ContentRootKind::Found,
            offer: RootOffer::Discovered,
            rel_path: name.clone(),
            label: name,
            files: 0,
        };
        let before = walk.files.len();
        walk.walk(&entry.path(), &mut root, 1);
        if walk.files[before..]
            .iter()
            .any(|file| counts_as_content(file.kind))
        {
            discovered.push(root);
        } else {
            walk.files.truncate(before);
        }
    }
    discovered.sort_by(|a, b| name_order(&a.label, &b.label));
    roots.extend(discovered);

    // Newest first inside a root: a notes folder is a journal.
    let order: HashMap<&str, usize> = roots
        .iter()
        .enumerate()
        .map(|(index, root)| (root.rel_path.as_str(), index))
        .collect();
    let mut files = walk.files;
    files.sort_by(|a, b| {
        let rank = |file: &ContentFile| order.get(file.root.as_str()).copied().unwrap_or(99);
        rank(a)
            .cmp(&rank(b))
            .then_with(|| b.mtime_ms.0.total_cmp(&a.mtime_ms.0))
            .then_with(|| name_order(&a.rel_path, &b.rel_path))
    });

    ContentTree {
        scope: scope.clone(),
        roots,
        files,
        errors: walk.errors,
    }
}

/// A row for a file the tree does not list: one a wikilink reached in a
/// folder the walk did not enter, or one opened from the Files view.
pub fn describe_unlisted(scope: &Path, path: &Path, size: u64, mtime: Millis) -> ContentFile {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string());
    let rel = path
        .strip_prefix(scope)
        .map(|rel| {
            rel.components()
                .map(|part| part.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_else(|_| path.display().to_string().replace('\\', "/"));
    let slug = match name.rfind('.') {
        Some(dot) if dot + 1 < name.len() => name[..dot].to_owned(),
        _ => name.clone(),
    };
    let ext = content_extension(&name);
    ContentFile {
        path: path.display().to_string(),
        rel_path: rel,
        root: String::new(),
        root_kind: ContentRootKind::Found,
        kind: content_file_kind(&name),
        slug,
        ext: ext.strip_prefix('.').unwrap_or(&ext).to_owned(),
        title: name,
        size,
        mtime_ms: mtime,
        note_type: None,
        date: None,
        tags: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_title_comes_from_the_first_heading_without_its_closing_hashes() {
        assert_eq!(
            first_heading("intro\n## Report Center ##\n").as_deref(),
            Some("Report Center")
        );
        assert_eq!(first_heading("#NoSpace\n####### seven\n"), None);
        assert_eq!(
            html_title("<html><head><TITLE>\n A  lesson </title>").as_deref(),
            Some("A lesson")
        );
    }
}
