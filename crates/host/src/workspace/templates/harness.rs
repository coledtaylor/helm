//! Making a harness, as opposed to finding one.
//!
//! A harness is a folder with a `harness.yaml` in it. Two shapes:
//!
//! - `new`: a folder that does not exist yet. It gets `harness.yaml`,
//!   `repos/` and `.claude/` and nothing else, or, given a template, that
//!   template's tree and a manifest.
//! - `convert`: a folder that already holds repositories. It gets a
//!   `harness.yaml`, with `repos: "."` when it has no `repos/` so the
//!   repositories at its top level stay visible, and a `.claude/`.
//!   Templates do not apply: converting is about a folder somebody already
//!   has, and writing a layout into it would be writing into their work.

use std::path::{Path, PathBuf};

use floti_protocol::channels::workspace::{CreateHarnessRequest, HarnessMode};

use super::reader::{TemplateValues, apply_template, template_id_problems, template_path_value};
use super::{HARNESS_MANIFEST, MINIMAL_TEMPLATE, exists, is_real_dir};
use crate::config_console::normalize;
use crate::config_console::time::now_iso;

/// The manifest format this writer produces; not the host's version, nor
/// the harness's.
pub const HARNESS_FORMAT_VERSION: &str = "1";

/// What making a harness did.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HarnessCreated {
    /// The harness folder, or `None` when nothing was written.
    pub path: Option<PathBuf>,
    /// Written, relative to `path`, in the order written.
    pub created: Vec<String>,
    /// With `path` `None`, why nothing was written; with it set, the
    /// template entries that did not land. No rollback is claimed.
    pub problems: Vec<String>,
}

impl HarnessCreated {
    fn refused(problems: Vec<String>) -> Self {
        Self {
            problems,
            ..Self::default()
        }
    }
}

/// Reserved on Windows whatever the extension; refused on every OS, since a
/// harness is a folder people copy between machines.
fn is_reserved(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or_default().to_lowercase();
    matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || ((stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

/// Problems with a proposed folder name, as sentences. Spaces and dashes
/// are ordinary in a folder name; these are the ones Windows refuses.
pub fn harness_name_problems(name: &str) -> Vec<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return vec!["A name is required.".to_owned()];
    }
    let mut problems = Vec::new();
    if trimmed == "." || trimmed == ".." {
        problems.push(format!("\"{trimmed}\" is not a folder name."));
    }
    if trimmed.contains(['<', '>', ':', '"', '/', '\\', '|', '?', '*']) {
        problems.push("A name cannot contain \\ / : * ? \" < > | or a path separator.".to_owned());
    }
    if is_reserved(trimmed) {
        problems.push(format!(
            "\"{trimmed}\" is a reserved device name on Windows."
        ));
    }
    // Windows strips both, so `dev.` would be made as `dev` and every path
    // built from the name would be wrong.
    if trimmed.ends_with('.') || trimmed.ends_with(' ') {
        problems.push("A name cannot end with a space or a dot.".to_owned());
    }
    problems
}

/// The manifest, written by hand: four keys, five when converting, no
/// comments. A JSON string is a valid YAML double-quoted scalar, so JSON is
/// the escaping.
fn manifest(name: &str, template: &str, created: &str, repos: Option<&str>) -> String {
    let quoted = |text: &str| serde_json::to_string(text).unwrap_or_default();
    let mut lines = vec![
        format!("name: {}", quoted(name)),
        format!("template: {}", quoted(template)),
        format!("version: {}", quoted(HARNESS_FORMAT_VERSION)),
        format!("created: {}", quoted(created)),
    ];
    if let Some(repos) = repos {
        lines.push(format!("repos: {}", quoted(repos)));
    }
    format!("{}\n", lines.join("\n"))
}

/// Makes a harness as `request` asks, from `templates_dir` when it names a
/// template. A refusal writes nothing; a failure to write once the folder is
/// made is the `Err` sentence.
pub fn create_harness(
    request: &CreateHarnessRequest,
    templates_dir: Option<&Path>,
) -> Result<HarnessCreated, String> {
    let dir = normalize(Path::new(&request.dir));
    match request.mode {
        HarnessMode::New => create_new(request, &dir, templates_dir),
        HarnessMode::Convert => convert(request, &dir),
    }
}

fn create_new(
    request: &CreateHarnessRequest,
    dir: &Path,
    templates_dir: Option<&Path>,
) -> Result<HarnessCreated, String> {
    let name = request
        .name
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_owned();
    let template = request
        .template
        .as_deref()
        .map(str::trim)
        .filter(|template| !template.is_empty())
        .unwrap_or(MINIMAL_TEMPLATE)
        .to_owned();
    let mut problems = harness_name_problems(&name);
    if !is_real_dir(dir) {
        problems.push(format!("{} is not a folder.", dir.display()));
    }
    if template != MINIMAL_TEMPLATE {
        let id_problems = template_id_problems(&template);
        let valid = id_problems.is_empty();
        problems.extend(id_problems);
        match templates_dir {
            None => problems.push("Templates are not available in this run.".to_owned()),
            // Asked before the folder is made: a template that is not there
            // must leave nothing behind.
            Some(templates) if valid && !is_real_dir(&templates.join(&template)) => {
                problems.push(format!("There is no template called \"{template}\"."));
            }
            Some(_) => {}
        }
    }
    if !problems.is_empty() {
        return Ok(HarnessCreated::refused(problems));
    }

    let target = dir.join(&name);
    if exists(&target) {
        // Neither an overwrite nor a merge: the caller asked to create one.
        let why = if exists(&target.join(HARNESS_MANIFEST)) {
            format!("{} is already a harness.", target.display())
        } else {
            format!("{} already exists.", target.display())
        };
        return Ok(HarnessCreated::refused(vec![why]));
    }

    let created_at = now_iso();
    make_dir(&target)?;
    let mut created = Vec::new();
    let mut problems = Vec::new();
    if template == MINIMAL_TEMPLATE {
        for folder in ["repos", ".claude"] {
            make_dir(&target.join(folder))?;
            created.push(folder.to_owned());
        }
    } else {
        // The template's tree first and the manifest last, so `template:`
        // is what the host wrote and a partial apply still leaves a harness
        // the launcher sees.
        let applied = apply_template(
            templates_dir.unwrap_or(dir),
            &template,
            &target,
            &TemplateValues {
                name: name.clone(),
                created_at: created_at.clone(),
                template: template.clone(),
                path: template_path_value(&target),
            },
        );
        created.extend(applied.created);
        problems.extend(applied.problems);
    }
    write(
        &target.join(HARNESS_MANIFEST),
        &manifest(&name, &template, &created_at, None),
    )?;
    created.push(HARNESS_MANIFEST.to_owned());
    Ok(HarnessCreated {
        path: Some(target),
        created,
        problems,
    })
}

fn convert(request: &CreateHarnessRequest, dir: &Path) -> Result<HarnessCreated, String> {
    if !is_real_dir(dir) {
        return Ok(HarnessCreated::refused(vec![format!(
            "{} is not a folder.",
            dir.display()
        )]));
    }
    if exists(&dir.join(HARNESS_MANIFEST)) {
        return Ok(HarnessCreated::refused(vec![format!(
            "{} is already a harness.",
            dir.display()
        )]));
    }
    let name = request
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            dir.file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default()
        });
    // A folder that already has `repos/` means what the default means.
    let repos = (!is_real_dir(&dir.join("repos"))).then_some(".");
    // Always `minimal`: a converted folder was never built from a template,
    // whatever the caller passed.
    write(
        &dir.join(HARNESS_MANIFEST),
        &manifest(&name, MINIMAL_TEMPLATE, &now_iso(), repos),
    )?;
    let mut created = vec![HARNESS_MANIFEST.to_owned()];
    let claude = dir.join(".claude");
    if !is_real_dir(&claude) {
        make_dir(&claude)?;
        created.push(".claude".to_owned());
    }
    Ok(HarnessCreated {
        path: Some(dir.to_path_buf()),
        created,
        problems: Vec::new(),
    })
}

fn make_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path)
        .map_err(|err| format!("Floti could not create {}: {err}", path.display()))
}

fn write(path: &Path, content: &str) -> Result<(), String> {
    std::fs::write(path, content)
        .map_err(|err| format!("Floti could not write {}: {err}", path.display()))
}
