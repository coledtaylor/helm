//! Harness templates: a folder the user wrote that becomes a new harness,
//! as `core/discovery/templates.ts`, `template-authoring.ts` and
//! `harness.ts` make them today.
//!
//! The whole mechanism is "copy a folder, fill in four placeholders": a
//! template makes a harness, and from then on the harness is the user's. The
//! format's rules:
//!
//! - Substitution is `.tpl`-only: `x.yml.tpl` is filled in and written as
//!   `x.yml`, and `x.yml` is copied byte for byte, `{{...}}` and all.
//! - `dot-claude/` is written as `.claude/`, for tools that drop dot folders.
//! - An empty folder is declared with a `.gitkeep`, which is not itself
//!   written.
//! - Anything that leaves the harness is refused: absolute targets, `..`,
//!   and links.
//!
//! Templates live in the templates folder, `templates` in the host's config
//! folder ([`templates_folder`]), which is the user's to edit. The shipped
//! README and example are written there at host start only when the folder
//! is absent ([`seed`]), so nothing there is ever overwritten.
//!
//! A link (a junction on Windows, a symlink on macOS and Linux) is never
//! walked. Every walk here asks [`links::is_link`] before it asks whether an
//! entry is a folder, because a junction answers yes to both and the order
//! decides whether a delete removes a template or the repository it points
//! at; and every delete goes through [`links::remove_tree`], which unlinks a
//! link and never enters it.
//!
//! - [`reader`]: listing, previewing and applying templates.
//! - [`authoring`]: creating, renaming, deleting, describing and filling
//!   templates, and saving a folder as one.
//! - [`harness`]: making a harness, from the built-in scaffold or a template.
//! - [`import`]: what a config scope's entries become inside a template.
//! - [`seed`]: the shipped README and example.

pub mod authoring;
pub mod harness;
pub mod import;
pub mod reader;
pub mod seed;

use std::cmp::Ordering;
use std::io;
use std::path::{Component, Path, PathBuf};

use crate::config_console::normalize;
use crate::platform::folders::Folders;
use crate::platform::links;

pub use reader::template_id_problems;

/// The metadata file at the root of a template.
pub const TEMPLATE_MANIFEST: &str = "template.yaml";

/// The manifest the host writes into every harness, template or not.
pub const HARNESS_MANIFEST: &str = "harness.yaml";

/// Written as `.claude`.
pub const DOT_CLAUDE_ALIAS: &str = "dot-claude";

/// Declares a folder that has nothing in it. Not itself written.
pub const KEEP_FILE: &str = ".gitkeep";

/// The one extension that opts a file in to substitution. Dropped on write.
pub const TPL_SUFFIX: &str = ".tpl";

/// The built-in scaffold's id, and what a harness records when no template
/// was named. It is code, not a folder: nothing in the templates folder can
/// change or break it.
pub const MINIMAL_TEMPLATE: &str = "minimal";

/// Where the user's templates live: `templates` in the host's config folder.
pub fn templates_folder(folders: &Folders) -> PathBuf {
    folders.config.join("templates")
}

/// One folder entry, with the link question asked first: a link is neither
/// a folder nor a file here, whatever it points at.
#[derive(Debug, Clone)]
pub(crate) struct Entry {
    pub name: String,
    pub path: PathBuf,
    pub link: bool,
    pub directory: bool,
    pub file: bool,
}

/// `dir`'s entries, sorted by name without case.
pub(crate) fn entries_of(dir: &Path) -> io::Result<Vec<Entry>> {
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let link = links::is_link(&path);
        let meta = if link {
            None
        } else {
            std::fs::symlink_metadata(&path).ok()
        };
        entries.push(Entry {
            name: entry.file_name().to_string_lossy().into_owned(),
            directory: meta.as_ref().is_some_and(std::fs::Metadata::is_dir),
            file: meta.as_ref().is_some_and(std::fs::Metadata::is_file),
            link,
            path,
        });
    }
    entries.sort_by(|a, b| collate(&a.name, &b.name));
    Ok(entries)
}

/// Names and paths compared the way a person reads a list: without case,
/// then by their exact text so the order is the same on every run.
pub(crate) fn collate(a: &str, b: &str) -> Ordering {
    a.to_lowercase()
        .cmp(&b.to_lowercase())
        .then_with(|| a.cmp(b))
}

/// Whether `path` is a real folder: there, a folder, and not a link to one.
pub(crate) fn is_real_dir(path: &Path) -> bool {
    !links::is_link(path) && std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir())
}

/// Whether anything, a link included, is at `path`.
pub(crate) fn exists(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

/// `candidate`'s components below `root`, both made absolute and folded
/// first, or `None` when it is `root` itself or not under it.
pub(crate) fn below(root: &Path, candidate: &Path) -> Option<Vec<String>> {
    let root = normalize(root);
    let candidate = normalize(candidate);
    let rest = candidate.strip_prefix(&root).ok()?;
    let parts: Vec<String> = rest
        .components()
        .filter_map(|part| match part {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    (!parts.is_empty()).then_some(parts)
}

/// The first link at or above `path` and below `root`, if any: a write
/// through one would land wherever the link points.
pub(crate) fn link_on_the_way(root: &Path, path: &Path) -> Option<PathBuf> {
    let parts = below(root, path)?;
    let mut at = normalize(root);
    for part in parts {
        at.push(part);
        if links::is_link(&at) {
            return Some(at);
        }
    }
    None
}

/// Removes `path` and everything in it, unlinking every link it meets and
/// never walking into one.
pub(crate) fn remove_tree(path: &Path) -> crate::Result<()> {
    links::remove_tree(&links::Native, path)
}

/// `path` relative to `base`, forward-slashed, or `path` itself when it is
/// not below it.
pub(crate) fn label(base: &Path, path: &Path) -> String {
    below(base, path).map_or_else(|| path.display().to_string(), |parts| parts.join("/"))
}

/// The modification time of `meta`, in epoch ms.
pub(crate) fn mtime(meta: &std::fs::Metadata) -> floti_protocol::channels::workspace::Millis {
    crate::config_console::mtime_ms(meta)
}
