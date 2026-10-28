//! Reading templates: the picker's listing, what a harness made from one
//! would receive, and writing one into a harness.

use std::fs::OpenOptions;
use std::io;
use std::path::{Path, PathBuf};

use floti_protocol::channels::workspace::{
    HarnessMode, TemplateChoice, TemplateListing, TemplatePreview,
};
use serde_yaml_ng::Value;

use super::{
    DOT_CLAUDE_ALIAS, HARNESS_MANIFEST, KEEP_FILE, MINIMAL_TEMPLATE, TEMPLATE_MANIFEST, TPL_SUFFIX,
    below, collate, entries_of, is_real_dir,
};
use crate::platform::links;

/// The picker's first row, which always works.
pub fn minimal_choice() -> TemplateChoice {
    TemplateChoice {
        id: MINIMAL_TEMPLATE.to_owned(),
        label: "Minimal".to_owned(),
        description: Some(
            "A manifest, an empty repos/ and an empty .claude/. Nothing else.".to_owned(),
        ),
        order: None,
        built_in: true,
    }
}

/// Problems with a template id, as sentences.
///
/// The id is the one value a client chooses that is joined onto the
/// templates folder, so a path is refused by its shape before any join:
/// `..\..\Windows`, `C:\Windows` and `/etc` alike, on every OS.
pub fn template_id_problems(id: &str) -> Vec<String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return vec!["A template name is required.".to_owned()];
    }
    let mut problems = Vec::new();
    if looks_absolute(trimmed) {
        problems.push(format!(
            "\"{trimmed}\" is an absolute path, not a template name."
        ));
    }
    if trimmed.contains(['/', '\\']) {
        problems.push(format!("\"{trimmed}\" is a path, not a template name."));
    }
    if trimmed == "." || trimmed == ".." {
        problems.push(format!("\"{trimmed}\" is not a template name."));
    }
    problems
}

/// Absolute on this OS, or on Windows: a leading separator or a drive.
fn looks_absolute(text: &str) -> bool {
    let bytes = text.as_bytes();
    Path::new(text).is_absolute()
        || text.starts_with(['/', '\\'])
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
}

/// `template.yaml`'s keys.
#[derive(Debug, Default)]
struct Metadata {
    label: Option<String>,
    description: Option<String>,
    order: Option<i32>,
}

/// Reads `template.yaml`. Absent is fine (the folder name is the label);
/// malformed is a sentence about that one template, so the rest of the
/// picker still works.
fn read_metadata(dir: &Path, name: &str) -> Result<Metadata, String> {
    let file = dir.join(TEMPLATE_MANIFEST);
    if links::is_link(&file) {
        return Ok(Metadata::default());
    }
    let Ok(raw) = std::fs::read_to_string(&file) else {
        return Ok(Metadata::default());
    };
    let parsed: Value = serde_yaml_ng::from_str(&raw).map_err(|err| {
        let detail = err.to_string();
        format!(
            "{TEMPLATE_MANIFEST} in \"{name}\" could not be read: {}",
            detail.lines().next().unwrap_or_default()
        )
    })?;
    match parsed {
        Value::Null => Ok(Metadata::default()),
        Value::Mapping(_) => {
            let text = |key: &str| match parsed.get(key) {
                Some(Value::String(text)) if !text.trim().is_empty() => {
                    Some(text.trim().to_owned())
                }
                _ => None,
            };
            let order = match parsed.get("order") {
                Some(Value::Number(number)) => number
                    .as_f64()
                    .filter(|value| value.is_finite() && value.fract() == 0.0)
                    .and_then(|value| i32::try_from(value as i64).ok()),
                _ => None,
            };
            Ok(Metadata {
                label: text("label"),
                description: text("description"),
                order,
            })
        }
        _ => Err(format!(
            "{TEMPLATE_MANIFEST} in \"{name}\" is not a set of keys, so that template was skipped."
        )),
    }
}

/// Every template in `dir`, `minimal` first, then by `order:` and label. A
/// folder that is not there is a one-row picker, not an error.
pub fn list_templates(dir: &Path) -> TemplateListing {
    let mut problems = Vec::new();
    let mut templates = vec![minimal_choice()];
    let shown = dir.display().to_string();
    let Ok(entries) = entries_of(dir) else {
        return TemplateListing {
            templates,
            dir: shown,
            problems,
        };
    };

    let mut found = Vec::new();
    for entry in entries {
        if entry.link {
            problems.push(format!(
                "\"{}\" is a link rather than a folder, so it was not offered.",
                entry.name
            ));
            continue;
        }
        if !entry.directory {
            continue;
        }
        if entry.name == MINIMAL_TEMPLATE {
            problems.push(format!(
                "\"{MINIMAL_TEMPLATE}\" is Floti's built-in scaffold, so the folder of that name was not offered."
            ));
            continue;
        }
        match read_metadata(&entry.path, &entry.name) {
            Ok(metadata) => found.push(TemplateChoice {
                label: metadata.label.unwrap_or_else(|| entry.name.clone()),
                id: entry.name,
                description: metadata.description,
                order: metadata.order,
                built_in: false,
            }),
            Err(problem) => problems.push(problem),
        }
    }

    // `order:` first, and a template with none after every template with
    // one: unordered is not zero.
    found.sort_by(
        |a: &TemplateChoice, b: &TemplateChoice| match (a.order, b.order) {
            (Some(x), Some(y)) if x != y => x.cmp(&y),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            _ => collate(&a.label, &b.label),
        },
    );
    templates.extend(found);
    TemplateListing {
        templates,
        dir: shown,
        problems,
    }
}

/// One write a template plans, in the order it is made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Planned {
    /// The file in the template.
    pub source: PathBuf,
    /// Relative to the harness, forward-slashed.
    pub target: String,
    pub kind: PlannedKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlannedKind {
    /// Copied byte for byte.
    File,
    /// A `.tpl`, filled in.
    Template,
    /// A folder a `.gitkeep` declares.
    Directory,
}

#[derive(Debug, Default)]
pub(crate) struct Plan {
    pub entries: Vec<Planned>,
    pub problems: Vec<String>,
}

/// `dot-claude` as `.claude`; every other segment as it is.
pub fn rewrite_segment(name: &str) -> &str {
    if name == DOT_CLAUDE_ALIAS {
        ".claude"
    } else {
        name
    }
}

pub(crate) fn is_tpl(name: &str) -> bool {
    name.len() > TPL_SUFFIX.len() && name.ends_with(TPL_SUFFIX)
}

/// Walks a template into the writes it would make, sorted by name at every
/// level, so two runs write the same files in the same order. A link is
/// reported and never entered.
pub(crate) fn plan_template(template_dir: &Path) -> Plan {
    let mut plan = Plan::default();
    walk(template_dir, "", &mut plan);
    plan
}

fn walk(template_dir: &Path, relative: &str, plan: &mut Plan) {
    let here = if relative.is_empty() {
        template_dir.to_path_buf()
    } else {
        template_dir.join(relative)
    };
    let entries = match entries_of(&here) {
        Ok(entries) => entries,
        Err(err) => {
            let what = if relative.is_empty() {
                "The template"
            } else {
                relative
            };
            plan.problems
                .push(format!("{what} could not be read: {err}"));
            return;
        }
    };
    for entry in entries {
        let source_rel = if relative.is_empty() {
            entry.name.clone()
        } else {
            format!("{relative}/{}", entry.name)
        };
        if relative.is_empty() && entry.name == TEMPLATE_MANIFEST {
            continue;
        }
        if entry.link {
            plan.problems.push(format!(
                "\"{source_rel}\" is a link and was not written. A template may only contain real files and folders."
            ));
            continue;
        }
        let target_rel = source_rel
            .split('/')
            .map(rewrite_segment)
            .collect::<Vec<_>>()
            .join("/");
        if entry.directory {
            walk(template_dir, &source_rel, plan);
            continue;
        }
        if !entry.file {
            plan.problems.push(format!(
                "\"{source_rel}\" is neither a file nor a folder and was not written."
            ));
            continue;
        }
        if entry.name == KEEP_FILE {
            // The marker declares its parent; at the root it declares
            // nothing that is not already there.
            let Some((parent, _)) = target_rel.rsplit_once('/') else {
                continue;
            };
            if guard(parent, plan) {
                plan.entries.push(Planned {
                    source: entry.path,
                    target: parent.to_owned(),
                    kind: PlannedKind::Directory,
                });
            }
            continue;
        }
        let tpl = is_tpl(&entry.name);
        let written = if tpl {
            &target_rel[..target_rel.len() - TPL_SUFFIX.len()]
        } else {
            target_rel.as_str()
        };
        if written.is_empty() || !guard(written, plan) {
            continue;
        }
        if written == HARNESS_MANIFEST {
            // The host writes the manifest, last and always, because its
            // `template:` is the provenance the launcher reads back.
            plan.problems.push(format!(
                "\"{source_rel}\" was skipped: {HARNESS_MANIFEST} is written by Floti, so a template cannot supply one."
            ));
            continue;
        }
        plan.entries.push(Planned {
            source: entry.path,
            target: written.to_owned(),
            kind: if tpl {
                PlannedKind::Template
            } else {
                PlannedKind::File
            },
        });
    }
}

/// Refuses a target that leaves the harness, by its shape, and says which.
fn guard(target: &str, plan: &mut Plan) -> bool {
    if looks_absolute(target) {
        plan.problems.push(format!(
            "\"{target}\" is an absolute path and was not written."
        ));
        return false;
    }
    if target
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        plan.problems.push(format!(
            "\"{target}\" points outside the new harness and was not written."
        ));
        return false;
    }
    true
}

/// The four values a `.tpl` is filled in with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateValues {
    pub name: String,
    pub created_at: String,
    pub template: String,
    /// The harness folder, forward-slashed: see [`template_path_value`].
    pub path: String,
}

/// What `{{PATH}}` is filled in with: the harness's absolute folder with the
/// OS's separator written as `/`. The value lands in JSON more often than
/// anywhere else, where a Windows backslash is an escape; every tool that
/// reads those files accepts forward slashes. Only the OS's separator is
/// rewritten: elsewhere a backslash is an ordinary filename character.
pub fn template_path_value(dir: &Path) -> String {
    let text = dir.display().to_string();
    if std::path::MAIN_SEPARATOR == '/' {
        text
    } else {
        text.replace(std::path::MAIN_SEPARATOR, "/")
    }
}

/// The four placeholders and nothing else. An unknown `{{...}}` survives
/// exactly as written, so a typo shows in the file as a typo.
pub fn substitute_template(text: &str, values: &TemplateValues) -> String {
    text.replace("{{NAME}}", &values.name)
        .replace("{{CREATED_AT}}", &values.created_at)
        .replace("{{TEMPLATE}}", &values.template)
        .replace("{{PATH}}", &values.path)
}

/// The folder of template `id` in `templates_dir`, or the sentence saying
/// why there is none. A link where a template would be is not one.
pub(crate) fn template_dir(templates_dir: &Path, id: &str) -> Result<PathBuf, Vec<String>> {
    let problems = template_id_problems(id);
    if !problems.is_empty() {
        return Err(problems);
    }
    let dir = templates_dir.join(id.trim());
    if is_real_dir(&dir) {
        Ok(dir)
    } else {
        Err(vec![format!("There is no template called \"{id}\".")])
    }
}

/// What a new harness's "What gets written" lists: the manifest first, then
/// everything else by path, from the same walk that writes it.
pub fn preview_template(
    templates_dir: &Path,
    template: &str,
    mode: Option<HarnessMode>,
) -> TemplatePreview {
    let mode = mode.unwrap_or(HarnessMode::New);
    if mode == HarnessMode::Convert || template == MINIMAL_TEMPLATE {
        let (entries, note): (&[&str], &str) = match mode {
            HarnessMode::New => (
                &[HARNESS_MANIFEST, "repos/", ".claude/"],
                "Nothing else. No starter skills, notes or rules - what belongs in a harness is yours to decide.",
            ),
            HarnessMode::Convert => (
                &[HARNESS_MANIFEST, ".claude/"],
                "The manifest records repos: \".\" so the repositories already in this folder stay visible.",
            ),
        };
        return TemplatePreview {
            template: if mode == HarnessMode::Convert {
                MINIMAL_TEMPLATE.to_owned()
            } else {
                template.to_owned()
            },
            entries: entries.iter().map(|entry| (*entry).to_owned()).collect(),
            note: note.to_owned(),
            problems: Vec::new(),
        };
    }

    let dir = match template_dir(templates_dir, template) {
        Ok(dir) => dir,
        Err(problems) => {
            return TemplatePreview {
                template: template.to_owned(),
                entries: Vec::new(),
                note: String::new(),
                problems,
            };
        }
    };
    let label = list_templates(templates_dir)
        .templates
        .into_iter()
        .find(|choice| choice.id == template)
        .map_or_else(|| template.to_owned(), |choice| choice.label);
    let plan = plan_template(&dir);
    let mut entries: Vec<String> = plan
        .entries
        .iter()
        .map(|entry| match entry.kind {
            PlannedKind::Directory => format!("{}/", entry.target),
            _ => entry.target.clone(),
        })
        .collect();
    entries.sort_by(|a, b| collate(a, b));
    entries.insert(0, HARNESS_MANIFEST.to_owned());
    TemplatePreview {
        template: template.to_owned(),
        entries,
        note: format!("Written from the {label} template, laid out as its own folder is."),
        problems: plan.problems,
    }
}

/// What applying a template wrote.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Applied {
    /// Relative to the harness, in the order written.
    pub created: Vec<String>,
    /// What could not be written, as sentences. Never a claim of a rollback.
    pub problems: Vec<String>,
    /// False when the template could not be opened: nothing was written.
    pub applied: bool,
}

/// Writes a template's tree into `target`, a harness folder that exists.
///
/// Partial failure is reported, not rolled back: `created` is what landed
/// and `problems` names the rest. No entry overwrites another, so two
/// sources landing on one target is a sentence rather than a silent winner.
pub fn apply_template(
    templates_dir: &Path,
    template: &str,
    target: &Path,
    values: &TemplateValues,
) -> Applied {
    let dir = match template_dir(templates_dir, template) {
        Ok(dir) => dir,
        Err(problems) => {
            return Applied {
                problems,
                ..Applied::default()
            };
        }
    };
    let plan = plan_template(&dir);
    let mut ordered = plan.entries;
    ordered.sort_by(|a, b| collate(&a.target, &b.target));
    let mut applied = Applied {
        created: Vec::new(),
        problems: plan.problems,
        applied: true,
    };
    for entry in ordered {
        let destination = target.join(entry.target.split('/').collect::<PathBuf>());
        // The second gate, against the real folder rather than the path the
        // template asked for.
        if below(target, &destination).is_none() {
            applied.problems.push(format!(
                "\"{}\" points outside the new harness and was not written.",
                entry.target
            ));
            continue;
        }
        match write_entry(&entry, &destination, values) {
            Ok(()) => applied.created.push(match entry.kind {
                PlannedKind::Directory => format!("{}/", entry.target),
                _ => entry.target,
            }),
            Err(err) => applied
                .problems
                .push(format!("{} could not be written: {err}", entry.target)),
        }
    }
    applied
}

fn write_entry(entry: &Planned, destination: &Path, values: &TemplateValues) -> io::Result<()> {
    if entry.kind == PlannedKind::Directory {
        return std::fs::create_dir_all(destination);
    }
    // The source is read before the destination is made, so a source that
    // cannot be read leaves no empty file behind.
    let filled = match entry.kind {
        PlannedKind::Template => Some(substitute_template(
            &std::fs::read_to_string(&entry.source)?,
            values,
        )),
        _ => None,
    };
    let mut source = match filled {
        None => Some(std::fs::File::open(&entry.source)?),
        Some(_) => None,
    };
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut out = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    match (filled, source.as_mut()) {
        (Some(text), _) => io::Write::write_all(&mut out, text.as_bytes()),
        // The bytes, not text: a template may hold a PNG.
        (None, Some(source)) => io::copy(source, &mut out).map(|_| ()),
        (None, None) => Ok(()),
    }
}
