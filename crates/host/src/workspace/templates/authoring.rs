//! Authoring a template: the parts of it a file explorer cannot do. Copy a
//! skill you already wrote into one, turn a harness you have been living in
//! into one, and create, rename, describe and delete them. There is no
//! in-app file editor; a template is a plain folder the user edits in their
//! own.
//!
//! Every write lands inside one template folder ([`TemplateGuard`]).
//! `.git` and `node_modules` are never copied, at any depth: they are
//! listed in a folder's preview, marked and unticked, rather than silently
//! pruned. Bytes are copied, never round-tripped through text. The one file
//! written as text is `template.yaml`, through the config console's
//! [`SnapshotWriter`], so it is snapshotted first like every other write the
//! host makes to a file the user keeps.

use std::fs::OpenOptions;
use std::io;
use std::path::{Path, PathBuf};

use floti_protocol::channels::workspace::{
    ConfigWriteReason, CreateTemplateRequest, FolderEntry, FolderTemplateKind,
    FolderTemplatePreview, Millis, RenameTemplateRequest, SaveFolderAsTemplateRequest,
    SaveFolderAsTemplateResult, TemplateDeleteResult, TemplateDetail, TemplateFile,
    TemplateFileRequest, TemplateImportResult, TemplateMetadataRequest, TemplateWriteResult,
    WriteConfigRequest, WriteConfigResult,
};
use rusqlite::Connection;

use super::reader::{is_tpl, rewrite_segment, template_dir, template_id_problems};
use super::{
    Entry, HARNESS_MANIFEST, KEEP_FILE, MINIMAL_TEMPLATE, TEMPLATE_MANIFEST, TPL_SUFFIX, below,
    collate, entries_of, exists, is_real_dir, label, link_on_the_way, mtime, remove_tree,
};
use crate::config_console::{PathGuard, SnapshotWriter, normalize, read_file};
use crate::platform::links;

/// Never copied, at any depth, whatever the user ticks, each with why.
const NEVER_COPIED: &[(&str, &str)] = &[
    (".git", "a repository\u{2019}s history is not a scaffold"),
    ("node_modules", "installed packages are not a scaffold"),
];

/// Refused at the top of a folder being saved as a template, each with why.
const ROOT_REFUSED: &[(&str, &str)] = &[
    (
        HARNESS_MANIFEST,
        "Floti writes this into the new harness, so a template cannot supply one",
    ),
    (
        TEMPLATE_MANIFEST,
        "this is written from the name and description below",
    ),
];

/// Listed and counted but unticked when the dialog opens: `repos/` is the
/// one folder whose purpose is to hold what belongs to this harness rather
/// than to its layout.
const UNTICKED_BY_DEFAULT: &[&str] = &["repos"];

/// Where one entry's count stops: the figure is there to stop a gigabyte
/// being a surprise, and "more than 50,000 files" does that.
const COUNT_BUDGET: u32 = 50_000;

fn refusal_in(table: &[(&str, &'static str)], name: &str) -> Option<&'static str> {
    let name = name.to_lowercase();
    table
        .iter()
        .find(|(entry, _)| *entry == name)
        .map(|(_, why)| *why)
}

fn never_copied(name: &str) -> Option<&'static str> {
    refusal_in(NEVER_COPIED, name)
}

fn refused_at_root(name: &str) -> Option<&'static str> {
    never_copied(name).or_else(|| refusal_in(ROOT_REFUSED, name))
}

/// What a template surface may write: inside one template folder, never
/// under a `.git` or `node_modules`, and never through a link.
pub struct TemplateGuard;

impl PathGuard for TemplateGuard {
    fn check(&self, scope: &Path, path: &Path) -> Result<(), String> {
        assert_template_writable(scope, path)
    }
}

/// Refuses, in a sentence, a write of `path` that is not inside the
/// template folder `scope`.
pub fn assert_template_writable(scope: &Path, path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!(
            "Refusing to write a relative path: {}",
            path.display()
        ));
    }
    let absolute = normalize(path);
    let scope = normalize(scope);
    let Some(segments) = below(&scope, &absolute) else {
        return Err(format!(
            "Refusing to write {}: it is not inside {}.",
            absolute.display(),
            scope.display()
        ));
    };
    if let Some(segment) = segments
        .iter()
        .find(|segment| never_copied(segment).is_some())
    {
        return Err(format!(
            "Refusing to write {}: {segment} is never part of a template.",
            absolute.display()
        ));
    }
    if let Some(link) = link_on_the_way(&scope, &absolute) {
        return Err(format!(
            "Refusing to write {}: {} is a link, and Floti never writes through one.",
            absolute.display(),
            link.display()
        ));
    }
    Ok(())
}

/// Everything wrong with a proposed template name. The reader's shape check
/// first, so a name refused here is refused in the same words; then what
/// only a writer needs: the built-in owns `minimal` in any case, and a name
/// already taken is another template.
pub fn template_name_problems(
    templates_dir: &Path,
    name: &str,
    allow_existing: bool,
) -> Vec<String> {
    let problems = template_id_problems(name);
    if !problems.is_empty() {
        return problems;
    }
    let trimmed = name.trim();
    if trimmed.eq_ignore_ascii_case(MINIMAL_TEMPLATE) {
        return vec![format!(
            "\"{MINIMAL_TEMPLATE}\" is Floti's built-in scaffold, so a template cannot be called that."
        )];
    }
    if !allow_existing && exists(&templates_dir.join(trimmed)) {
        return vec![format!("There is already a template called \"{trimmed}\".")];
    }
    Vec::new()
}

/// `template.yaml` as the host writes it: quoted, so a colon in a label is
/// safe.
fn manifest_text(label: &str, description: &str) -> String {
    let quoted = |text: &str| serde_json::to_string(text).unwrap_or_default();
    let mut lines = vec![format!("label: {}", quoted(label))];
    if !description.trim().is_empty() {
        lines.push(format!("description: {}", quoted(description.trim())));
    }
    format!("{}\n", lines.join("\n"))
}

/// Writes `template.yaml` in `dir` through the console's writer.
fn write_manifest(
    conn: &Connection,
    dir: &Path,
    content: String,
    expected_hash: Option<String>,
    reason: ConfigWriteReason,
) -> Result<WriteConfigResult, String> {
    SnapshotWriter::new(conn, &TemplateGuard).write(&WriteConfigRequest {
        scope_path: dir.display().to_string(),
        path: dir.join(TEMPLATE_MANIFEST).display().to_string(),
        content,
        expected_hash,
        reason,
    })
}

fn refuse(problems: Vec<String>) -> TemplateWriteResult {
    TemplateWriteResult {
        ok: false,
        template: None,
        problems,
    }
}

fn done(template: &str) -> TemplateWriteResult {
    TemplateWriteResult {
        ok: true,
        template: Some(template.to_owned()),
        problems: Vec::new(),
    }
}

/// Scaffolds a template: its folder and a `template.yaml`, and nothing
/// else. A starter layout would be the host's opinion about somebody's
/// workspace.
pub fn create_template(
    conn: &Connection,
    templates_dir: &Path,
    request: &CreateTemplateRequest,
) -> TemplateWriteResult {
    let name = request.name.trim();
    let problems = template_name_problems(templates_dir, name, false);
    if !problems.is_empty() {
        return refuse(problems);
    }
    let dir = templates_dir.join(name);
    if let Err(err) = std::fs::create_dir_all(&dir) {
        return refuse(vec![format!("\"{name}\" could not be created: {err}")]);
    }
    let label = request
        .label
        .as_deref()
        .filter(|label| !label.trim().is_empty())
        .unwrap_or(name);
    // `None` is "this file does not exist", so a `template.yaml` that
    // appeared since the folder was made is a conflict, not an overwrite.
    match write_manifest(
        conn,
        &dir,
        manifest_text(label, request.description.as_deref().unwrap_or_default()),
        None,
        ConfigWriteReason::Create,
    ) {
        Ok(written) if written.ok => done(name),
        Ok(written) if written.conflict.is_some() => refuse(vec![format!(
            "{TEMPLATE_MANIFEST} appeared in \"{name}\" while Floti was creating it, so nothing was written."
        )]),
        Ok(written) => refuse(vec![
            written
                .error
                .unwrap_or_else(|| "The write was refused.".to_owned()),
        ]),
        Err(err) => refuse(vec![err]),
    }
}

/// Rewrites `label` and `description`, leaving the rest of the folder alone.
pub fn write_template_metadata(
    conn: &Connection,
    templates_dir: &Path,
    request: &TemplateMetadataRequest,
) -> TemplateWriteResult {
    let id = request.template.trim();
    let dir = match template_dir(templates_dir, id) {
        Ok(dir) => dir,
        Err(problems) => return refuse(problems),
    };
    let current = read_file(&dir.join(TEMPLATE_MANIFEST));
    if current.exists && current.binary {
        return refuse(vec![format!(
            "{TEMPLATE_MANIFEST} in \"{id}\" is not text, so Floti will not rewrite it."
        )]);
    }
    let label = if request.label.trim().is_empty() {
        id
    } else {
        request.label.as_str()
    };
    match write_manifest(
        conn,
        &dir,
        manifest_text(label, &request.description),
        current.exists.then_some(current.hash),
        ConfigWriteReason::Edit,
    ) {
        Ok(written) if written.ok => done(id),
        Ok(written) if written.conflict.is_some() => refuse(vec![format!(
            "{TEMPLATE_MANIFEST} in \"{id}\" changed on disk while the form was open, so nothing was written."
        )]),
        Ok(written) => refuse(vec![
            written
                .error
                .unwrap_or_else(|| "The write was refused.".to_owned()),
        ]),
        Err(err) => refuse(vec![err]),
    }
}

/// Renames a template's folder: a move, not a copy, since a template holds
/// whatever its author put there.
pub fn rename_template(
    templates_dir: &Path,
    request: &RenameTemplateRequest,
) -> TemplateWriteResult {
    let from = request.template.trim();
    let to = request.name.trim();
    let from_problems = template_id_problems(from);
    if !from_problems.is_empty() {
        return refuse(from_problems);
    }
    if from.to_lowercase() == to.to_lowercase() {
        return refuse(vec![format!("It is already called \"{from}\".")]);
    }
    let problems = template_name_problems(templates_dir, to, false);
    if !problems.is_empty() {
        return refuse(problems);
    }
    let source = match template_dir(templates_dir, from) {
        Ok(dir) => dir,
        Err(problems) => return refuse(problems),
    };
    match std::fs::rename(&source, templates_dir.join(to)) {
        Ok(()) => done(to),
        Err(err) => refuse(vec![format!("\"{from}\" could not be renamed: {err}")]),
    }
}

/// Removes a template's folder, unlinking any link in it rather than
/// walking it. Final: there is no undo.
pub fn delete_template(templates_dir: &Path, template: &str) -> TemplateDeleteResult {
    let id = template.trim();
    let dir = match template_dir(templates_dir, id) {
        Ok(dir) => dir,
        Err(problems) => {
            return TemplateDeleteResult {
                ok: false,
                template: None,
                problems,
            };
        }
    };
    match remove_tree(&dir) {
        Ok(()) => TemplateDeleteResult {
            ok: true,
            template: Some(id.to_owned()),
            problems: Vec::new(),
        },
        Err(err) => TemplateDeleteResult {
            ok: false,
            template: None,
            problems: vec![err.to_string()],
        },
    }
}

/// What a harness receives a file as: `.tpl` dropped, `dot-claude`
/// rewritten, a `.gitkeep` as the folder it declares; empty when the file is
/// not written at all.
fn target_of(rel: &str, name: &str) -> String {
    let rewritten = rel
        .split('/')
        .map(rewrite_segment)
        .collect::<Vec<_>>()
        .join("/");
    if name == KEEP_FILE {
        return rewritten
            .rsplit_once('/')
            .map_or_else(String::new, |(parent, _)| format!("{parent}/"));
    }
    let written = if is_tpl(&rewritten) {
        &rewritten[..rewritten.len() - TPL_SUFFIX.len()]
    } else {
        rewritten.as_str()
    };
    if written == HARNESS_MANIFEST {
        String::new()
    } else {
        written.to_owned()
    }
}

/// `template.yaml`'s label and description, read as lines: this answer
/// feeds a form whose save rewrites the file, so what it reports is what the
/// two fields say.
struct Manifest {
    exists: bool,
    label: Option<String>,
    description: Option<String>,
    problem: Option<String>,
}

fn read_manifest(dir: &Path) -> Manifest {
    let file = dir.join(TEMPLATE_MANIFEST);
    let content = if links::is_link(&file) {
        None
    } else {
        Some(read_file(&file))
    };
    let Some(content) = content.filter(|content| content.exists) else {
        return Manifest {
            exists: false,
            label: None,
            description: None,
            problem: None,
        };
    };
    if content.binary {
        return Manifest {
            exists: true,
            label: None,
            description: None,
            problem: Some(format!(
                "{TEMPLATE_MANIFEST} is not text, so Floti will not rewrite it."
            )),
        };
    }
    let read = |key: &str| -> Option<String> {
        let prefix = format!("{key}:");
        let line = content
            .content
            .lines()
            .find(|line| line.starts_with(&prefix))?;
        let raw = line[prefix.len()..].trim();
        if raw.is_empty() {
            return None;
        }
        if raw.starts_with('"') {
            return Some(serde_json::from_str::<String>(raw).unwrap_or_else(|_| raw.to_owned()));
        }
        Some(
            raw.strip_prefix('\'')
                .and_then(|rest| rest.strip_suffix('\''))
                .unwrap_or(raw)
                .to_owned(),
        )
    };
    Manifest {
        exists: true,
        label: read("label"),
        description: read("description"),
        problem: None,
    }
}

/// One template's files, for the manager's list: what is in the folder,
/// with what each becomes as a column. A link is listed, so the author can
/// see why it is not written, and never entered.
pub fn read_template_detail(templates_dir: &Path, id: &str) -> TemplateDetail {
    let dir = templates_dir.join(id.trim());
    let empty = |problems: Vec<String>| TemplateDetail {
        id: id.to_owned(),
        dir: dir.display().to_string(),
        label: id.to_owned(),
        description: String::new(),
        has_manifest: false,
        files: Vec::new(),
        file_count: 0,
        total_bytes: 0,
        modified_at_ms: Millis(0.0),
        problems,
    };
    let dir = match template_dir(templates_dir, id) {
        Ok(dir) => dir,
        Err(problems) => return empty(problems),
    };

    let mut files = Vec::new();
    let mut problems = Vec::new();
    let mut modified = std::fs::metadata(&dir).map_or(0.0, |meta| mtime(&meta).0);
    detail_walk(&dir, "", &mut files, &mut problems, &mut modified);

    let manifest = read_manifest(&dir);
    files.sort_by(|a: &TemplateFile, b: &TemplateFile| collate(&a.rel_path, &b.rel_path));
    let mut all_problems: Vec<String> = manifest.problem.into_iter().collect();
    all_problems.extend(problems);
    TemplateDetail {
        id: id.to_owned(),
        dir: dir.display().to_string(),
        label: manifest.label.unwrap_or_else(|| id.to_owned()),
        description: manifest.description.unwrap_or_default(),
        has_manifest: manifest.exists,
        file_count: u32::try_from(files.iter().filter(|file| !file.link).count())
            .unwrap_or(u32::MAX),
        total_bytes: files.iter().map(|file| file.size).sum(),
        files,
        modified_at_ms: Millis(modified),
        problems: all_problems,
    }
}

fn detail_walk(
    at: &Path,
    relative: &str,
    files: &mut Vec<TemplateFile>,
    problems: &mut Vec<String>,
    modified: &mut f64,
) {
    let entries = match entries_of(at) {
        Ok(entries) => entries,
        Err(err) => {
            let what = if relative.is_empty() {
                "The template"
            } else {
                relative
            };
            problems.push(format!("{what} could not be read: {err}"));
            return;
        }
    };
    for entry in entries {
        let rel = if relative.is_empty() {
            entry.name.clone()
        } else {
            format!("{relative}/{}", entry.name)
        };
        if entry.link {
            problems.push(format!(
                "\"{rel}\" is a link. A template may only contain real files and folders, so it is not written."
            ));
            files.push(TemplateFile {
                rel_path: rel,
                target: String::new(),
                size: 0,
                mtime_ms: Millis(0.0),
                substituted: false,
                link: true,
            });
            continue;
        }
        if entry.directory {
            detail_walk(&entry.path, &rel, files, problems, modified);
            continue;
        }
        if !entry.file || (relative.is_empty() && entry.name == TEMPLATE_MANIFEST) {
            continue;
        }
        // Gone since the listing: not there, so not listed.
        let Ok(meta) = std::fs::symlink_metadata(&entry.path) else {
            continue;
        };
        let at_ms = mtime(&meta).0;
        if at_ms > *modified {
            *modified = at_ms;
        }
        files.push(TemplateFile {
            target: target_of(&rel, &entry.name),
            substituted: is_tpl(&entry.name),
            rel_path: rel,
            size: meta.len(),
            mtime_ms: Millis(at_ms),
            link: false,
        });
    }
}

/// Renames one file to `x.tpl`, which opts it in to substitution. A binary
/// is refused: substitution reads a file as text and writes it back.
pub fn make_substitutable(
    templates_dir: &Path,
    request: &TemplateFileRequest,
) -> TemplateWriteResult {
    let id = request.template.trim();
    let dir = match template_dir(templates_dir, id) {
        Ok(dir) => dir,
        Err(problems) => return refuse(problems),
    };
    let segments: Vec<&str> = request
        .path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    let not_here = || {
        refuse(vec![format!(
            "\"{}\" is not a file in this template.",
            request.path
        )])
    };
    if segments.is_empty()
        || segments
            .iter()
            .any(|segment| *segment == "." || *segment == ".." || segment.contains('\\'))
    {
        return not_here();
    }
    let source = dir.join(segments.iter().collect::<PathBuf>());
    if below(&dir, &source).is_none() || link_on_the_way(&dir, &source).is_some() {
        return not_here();
    }
    let rel = segments.join("/");
    if rel == TEMPLATE_MANIFEST {
        return refuse(vec![format!(
            "{TEMPLATE_MANIFEST} describes the template rather than being written into a harness."
        )]);
    }
    if is_tpl(&rel) {
        return refuse(vec![format!("\"{rel}\" is already substituted.")]);
    }
    let current = read_file(&source);
    if !current.exists {
        return refuse(vec![format!(
            "\"{rel}\" is no longer there. Re-read the template and try again."
        )]);
    }
    if current.binary {
        return refuse(vec![format!(
            "\"{rel}\" is not text. Substitution reads a file as text and writes it back, so a binary marked substitutable would arrive corrupted."
        )]);
    }
    let renamed = PathBuf::from(format!("{}{TPL_SUFFIX}", source.display()));
    if exists(&renamed) {
        return refuse(vec![format!("\"{rel}{TPL_SUFFIX}\" is already there.")]);
    }
    match std::fs::rename(&source, &renamed) {
        Ok(()) => done(id),
        Err(err) => refuse(vec![format!("\"{rel}\" could not be renamed: {err}")]),
    }
}

/// One file to copy into a template: where it is, read only, and what it
/// becomes, relative to the template and forward-slashed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportFile {
    pub source: PathBuf,
    pub target: String,
}

/// Copies chosen files into a template as plain files, with no link back to
/// their source: a template travels, and a reference to somebody's
/// `~/.claude` would produce nothing on another machine. The sources are
/// only read. A target already there is replaced, and named as replaced.
pub fn import_into_template(
    templates_dir: &Path,
    template: &str,
    files: &[ImportFile],
) -> TemplateImportResult {
    let failed = |problems: Vec<String>| TemplateImportResult {
        ok: false,
        created: Vec::new(),
        replaced: Vec::new(),
        problems,
    };
    let dir = match template_dir(templates_dir, template.trim()) {
        Ok(dir) => dir,
        Err(problems) => return failed(problems),
    };
    if files.is_empty() {
        return failed(vec!["Nothing was selected.".to_owned()]);
    }

    let mut created = Vec::new();
    let mut replaced = Vec::new();
    let mut problems = Vec::new();
    for file in files {
        let destination = dir.join(file.target.split('/').collect::<PathBuf>());
        if let Err(err) = assert_template_writable(&dir, &destination) {
            problems.push(format!("\"{}\" was not copied: {err}", file.target));
            continue;
        }
        let is_file = !links::is_link(&file.source)
            && std::fs::symlink_metadata(&file.source).is_ok_and(|meta| meta.is_file());
        if !is_file {
            problems.push(format!(
                "\"{}\" was not copied: its source is not a file.",
                file.target
            ));
            continue;
        }
        let existed = exists(&destination);
        let copied = destination
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|()| std::fs::copy(&file.source, &destination));
        match copied {
            Ok(_) if existed => replaced.push(file.target.clone()),
            Ok(_) => created.push(file.target.clone()),
            Err(err) => problems.push(format!("\"{}\" could not be copied: {err}", file.target)),
        }
    }
    TemplateImportResult {
        ok: !created.is_empty() || !replaced.is_empty(),
        created,
        replaced,
        problems,
    }
}

/// A tree's count, made by the same walk the copy makes.
#[derive(Default)]
struct Measured {
    files: u32,
    bytes: u64,
    truncated: bool,
    /// Links met and not followed, relative to the entry.
    links: Vec<String>,
}

fn measure_tree(dir: &Path, base: &Path, into: &mut Measured) {
    if into.files >= COUNT_BUDGET {
        into.truncated = true;
        return;
    }
    // Unreadable is not a count of zero anywhere it matters: the entry is
    // still listed and the user still decides.
    let Ok(entries) = entries_of(dir) else {
        return;
    };
    for entry in entries {
        if entry.link {
            into.links.push(label(base, &entry.path));
            continue;
        }
        if never_copied(&entry.name).is_some() {
            continue;
        }
        if entry.directory {
            measure_tree(&entry.path, base, into);
            if into.truncated {
                return;
            }
            continue;
        }
        if !entry.file {
            continue;
        }
        into.files += 1;
        if into.files >= COUNT_BUDGET {
            into.truncated = true;
            return;
        }
        into.bytes += size_of(&entry.path);
    }
}

fn size_of(path: &Path) -> u64 {
    std::fs::symlink_metadata(path).map_or(0, |meta| meta.len())
}

/// What saving a folder as a template would copy, before anything is:
/// each top-level entry with the files and bytes that would land.
pub fn preview_folder_as_template(dir: &str, kind: FolderTemplateKind) -> FolderTemplatePreview {
    let path = normalize(Path::new(dir));
    let empty = |problems: Vec<String>| FolderTemplatePreview {
        dir: path.display().to_string(),
        kind,
        entries: Vec::new(),
        file_count: 0,
        total_bytes: 0,
        note: String::new(),
        problems,
    };
    if dir.trim().is_empty() {
        return empty(vec!["Choose a folder first.".to_owned()]);
    }
    if !is_real_dir(&path) {
        return empty(vec![format!("{} is not a folder.", path.display())]);
    }
    let top = match entries_of(&path) {
        Ok(top) => top,
        Err(err) => return empty(vec![format!("{} could not be read: {err}", path.display())]),
    };

    let mut entries = Vec::new();
    let mut problems = Vec::new();
    for entry in top {
        if entry.link {
            problems.push(format!(
                "\"{}\" is a link and will not be copied or followed.",
                entry.name
            ));
            entries.push(FolderEntry {
                name: entry.name,
                directory: false,
                file_count: 0,
                bytes: 0,
                truncated: false,
                included: false,
                refused: Some("a template may only contain real files and folders".to_owned()),
                link: true,
            });
            continue;
        }
        if !entry.directory && !entry.file {
            continue;
        }
        let refused = refused_at_root(&entry.name);
        let measured = if entry.directory {
            let mut measured = Measured::default();
            measure_tree(&entry.path, &entry.path, &mut measured);
            measured
        } else {
            Measured {
                files: 1,
                bytes: size_of(&entry.path),
                ..Measured::default()
            }
        };
        for link in &measured.links {
            problems.push(format!(
                "\"{}/{link}\" is a link and will not be copied or followed.",
                entry.name
            ));
        }
        let unticked = UNTICKED_BY_DEFAULT.contains(&entry.name.to_lowercase().as_str());
        entries.push(FolderEntry {
            included: refused.is_none() && !unticked,
            refused: refused.map(str::to_owned),
            name: entry.name,
            directory: entry.directory,
            file_count: measured.files,
            bytes: measured.bytes,
            truncated: measured.truncated,
            link: false,
        });
    }

    let ticked = entries.iter().filter(|entry| entry.included);
    let (file_count, total_bytes) = ticked.fold((0u32, 0u64), |(files, bytes), entry| {
        (files.saturating_add(entry.file_count), bytes + entry.bytes)
    });
    FolderTemplatePreview {
        dir: path.display().to_string(),
        kind,
        entries,
        file_count,
        total_bytes,
        note: match kind {
            FolderTemplateKind::Harness => "Ticked folders are copied whole. Untick anything that belongs to this harness rather than to the layout - Floti cannot tell a journal from a scaffold.",
            FolderTemplateKind::Folder => "Ticked folders are copied whole. dot-claude/ is kept as it is; a harness made from this template receives it as .claude/.",
        }
        .to_owned(),
        problems,
    }
}

/// What a copy wrote.
#[derive(Default)]
struct Copied {
    files: Vec<String>,
    bytes: u64,
    problems: Vec<String>,
}

/// Copies a tree byte for byte, refusing what the count refused and
/// following nothing.
fn copy_tree(from: &Path, to: &Path, base: &Path, into: &mut Copied) {
    let entries = match entries_of(from) {
        Ok(entries) => entries,
        Err(err) => {
            into.problems
                .push(format!("{} could not be read: {err}", label(base, from)));
            return;
        }
    };
    if let Err(err) = std::fs::create_dir_all(to) {
        into.problems
            .push(format!("{} could not be created: {err}", label(base, from)));
        return;
    }
    for entry in entries {
        let rel = label(base, &entry.path);
        if entry.link {
            into.problems.push(format!(
                "\"{rel}\" is a link and was not copied. A template may only contain real files and folders."
            ));
            continue;
        }
        if let Some(why) = never_copied(&entry.name) {
            into.problems
                .push(format!("\"{rel}\" was not copied: {why}."));
            continue;
        }
        if entry.directory {
            copy_tree(&entry.path, &to.join(&entry.name), base, into);
            continue;
        }
        if !entry.file {
            into.problems.push(format!(
                "\"{rel}\" is neither a file nor a folder and was not copied."
            ));
            continue;
        }
        match std::fs::copy(&entry.path, to.join(&entry.name)) {
            Ok(bytes) => {
                into.files.push(rel);
                into.bytes += bytes;
            }
            Err(err) => into
                .problems
                .push(format!("\"{rel}\" could not be copied: {err}")),
        }
    }
}

/// Copies `source` to `destination`, which must not exist.
fn copy_new(source: &Path, destination: &Path) -> io::Result<u64> {
    let mut from = std::fs::File::open(source)?;
    let mut to = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    io::copy(&mut from, &mut to)
}

/// Copies the ticked entries of a folder into a new template, the same call
/// behind "save this harness as a template" and "import a folder as a
/// template". `dot-claude/` is copied as it is: the alias is applied when a
/// harness is written, not undone on the way in. The manifest is written
/// last, so a copy that failed half way leaves a folder rather than a broken
/// picker row.
pub fn save_folder_as_template(
    conn: &Connection,
    templates_dir: &Path,
    request: &SaveFolderAsTemplateRequest,
) -> SaveFolderAsTemplateResult {
    let fail = |problems: Vec<String>| SaveFolderAsTemplateResult {
        ok: false,
        template: None,
        problems,
        created: Vec::new(),
        file_count: 0,
        total_bytes: 0,
    };
    let source = normalize(Path::new(&request.dir));
    if !is_real_dir(&source) {
        return fail(vec![format!("{} is not a folder.", source.display())]);
    }
    let name = request.name.trim();
    let name_problems = template_name_problems(templates_dir, name, false);
    if !name_problems.is_empty() {
        return fail(name_problems);
    }
    if request.include.is_empty() {
        return fail(vec![
            "Nothing was ticked, so there is nothing to copy.".to_owned(),
        ]);
    }
    let wanted: Vec<String> = request
        .include
        .iter()
        .map(|entry| entry.to_lowercase())
        .collect();
    let top = match entries_of(&source) {
        Ok(top) => top,
        Err(err) => {
            return fail(vec![format!(
                "{} could not be read: {err}",
                source.display()
            )]);
        }
    };
    let dir = templates_dir.join(name);
    if let Err(err) = std::fs::create_dir_all(&dir) {
        return fail(vec![format!("\"{name}\" could not be created: {err}")]);
    }

    let mut copied = Copied::default();
    for entry in top
        .iter()
        .filter(|entry| wanted.contains(&entry.name.to_lowercase()))
    {
        copy_top(entry, &dir, &source, &mut copied);
    }

    let label = if request.label.trim().is_empty() {
        name
    } else {
        request.label.as_str()
    };
    let written = write_manifest(
        conn,
        &dir,
        manifest_text(label, &request.description),
        None,
        ConfigWriteReason::Create,
    );
    let file_count = u32::try_from(copied.files.len()).unwrap_or(u32::MAX);
    match written {
        Ok(written) if written.ok => SaveFolderAsTemplateResult {
            ok: true,
            template: Some(name.to_owned()),
            problems: copied.problems,
            created: copied.files,
            file_count,
            total_bytes: copied.bytes,
        },
        other => {
            let why = match other {
                Ok(written) => written
                    .error
                    .unwrap_or_else(|| "the write was refused".to_owned()),
                Err(err) => err,
            };
            let mut problems = vec![format!(
                "\"{name}\" was written but {TEMPLATE_MANIFEST} could not be: {why}."
            )];
            problems.extend(copied.problems);
            SaveFolderAsTemplateResult {
                ok: false,
                template: None,
                problems,
                created: copied.files,
                file_count,
                total_bytes: copied.bytes,
            }
        }
    }
}

fn copy_top(entry: &Entry, dir: &Path, source: &Path, copied: &mut Copied) {
    if entry.link {
        copied.problems.push(format!(
            "\"{}\" is a link and was not copied. A template may only contain real files and folders.",
            entry.name
        ));
        return;
    }
    if let Some(why) = refused_at_root(&entry.name) {
        copied
            .problems
            .push(format!("\"{}\" was not copied: {why}.", entry.name));
        return;
    }
    if entry.directory {
        copy_tree(&entry.path, &dir.join(&entry.name), source, copied);
        return;
    }
    if !entry.file {
        return;
    }
    match copy_new(&entry.path, &dir.join(&entry.name)) {
        Ok(bytes) => {
            copied.files.push(entry.name.clone());
            copied.bytes += bytes;
        }
        Err(err) => copied
            .problems
            .push(format!("\"{}\" could not be copied: {err}", entry.name)),
    }
}
