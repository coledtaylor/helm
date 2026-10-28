//! What a config scope's entries become inside a template, for "import
//! into template": the files the user ticked in a scope's tree, with a
//! skill brought whole, each mapped to where a harness made from the
//! template expects it.
//!
//! The scope is read through the backend's own tree, so nothing the config
//! console would not list - a credential file above all - can be named into
//! a template.

use std::collections::HashSet;
use std::path::Path;

use floti_protocol::channels::workspace::{ConfigFile, ConfigScopeKind, ImportIntoTemplateRequest};

use super::authoring::ImportFile;
use super::below;
use crate::agent::AgentBackend;
use crate::config_console::{config_unit, normalize, project_scope, read_tree, user_scope};

/// The files `request` names, resolved against its scope's tree, and a
/// sentence for each one that was skipped. An `Err` is a refusal of the
/// whole request.
pub fn resolve_import(
    backend: &dyn AgentBackend,
    request: &ImportIntoTemplateRequest,
) -> Result<(Vec<ImportFile>, Vec<String>), String> {
    let console = backend
        .config()
        .and_then(|config| config.console())
        .ok_or_else(|| "No agent on this host has a config console.".to_owned())?;
    let wanted = normalize(Path::new(&request.scope_path));
    let scope = if wanted
        .as_os_str()
        .eq_ignore_ascii_case(normalize(&console.config_dir).as_os_str())
    {
        user_scope(&console.config_dir)
    } else {
        project_scope(&wanted, ConfigScopeKind::Project, None)
    };
    let tree = read_tree(backend, &scope);
    let claude_dir = Path::new(&scope.claude_dir);
    let base = Path::new(&scope.path);

    let mut files = Vec::new();
    let mut problems = Vec::new();
    let mut seen = HashSet::new();
    for path in &request.paths {
        let asked = normalize(Path::new(path));
        let Some(file) = tree.files.iter().find(|file| {
            normalize(Path::new(&file.path))
                .as_os_str()
                .eq_ignore_ascii_case(asked.as_os_str())
        }) else {
            problems.push(format!(
                "{path} is not in {} any more. Re-read the scope and try again.",
                scope.label
            ));
            continue;
        };
        for member in config_unit(&tree.files, file) {
            if !seen.insert(member.path.to_lowercase()) {
                continue;
            }
            match target_for(member, claude_dir, base) {
                Some(target) => files.push(ImportFile {
                    source: Path::new(&member.path).to_path_buf(),
                    target,
                }),
                None => problems.push(format!(
                    "{} is not somewhere a template can hold it, so it was skipped.",
                    member.rel_path
                )),
            }
        }
    }
    Ok((files, problems))
}

/// Where `file` lands in a template: under `.claude/` when it is in the
/// scope's `.claude` folder, at the top when it sits directly in the
/// scope's folder (`CLAUDE.md`, `.mcp.json`), and nowhere otherwise.
fn target_for(file: &ConfigFile, claude_dir: &Path, base: &Path) -> Option<String> {
    let path = Path::new(&file.path);
    if let Some(parts) = below(claude_dir, path) {
        return Some(format!(".claude/{}", parts.join("/")));
    }
    match below(base, path) {
        Some(parts) if parts.len() == 1 => parts.into_iter().next(),
        _ => None,
    }
}
