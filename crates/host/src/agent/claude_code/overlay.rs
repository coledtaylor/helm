//! A harness project as a plugin folder `--plugin-dir` accepts, and its
//! instructions composed into one `--append-system-prompt-file`.
//!
//! A plugin is a folder with a manifest and convention folders beside it,
//! which is what a `.claude/` folder almost is. So each overlay is a folder in
//! the launch's own folder holding a generated manifest and links into the
//! real thing:
//!
//! ```text
//! <launch>/overlays/acme/
//! ├── .claude-plugin/plugin.json      generated
//! ├── skills/     ──link──▶  acme/.claude/skills (or acme/.agents/skills)
//! ├── commands/   ──link──▶  acme/.claude/commands
//! ├── agents/     ──link──▶  acme/.claude/agents
//! └── workflows/  ──link──▶  acme/.claude/workflows
//! ```
//!
//! A harness with skills in both shapes gets a real `skills/` folder holding
//! a link per skill, `.claude`'s winning a name both have. `hooks/` is never
//! composed: a hook's commands are written against its own repository's
//! folder, and an overlay's session runs somewhere else. A link that cannot be
//! made (a filesystem without links) falls back to a copy.

use std::path::{Path, PathBuf};

use crate::agent::LaunchFolder;
use crate::agent::harness::{HarnessProject, Skills, is_same_or_ancestor};
use crate::platform::links::{FolderLinks, Native as Links};
use crate::{Error, Result};

/// The folder in a launch folder that holds its overlays.
const OVERLAYS_DIR: &str = "overlays";

/// One overlay built for a launch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Overlay {
    /// The plugin name its skills are namespaced under.
    pub name: String,
    pub project: HarnessProject,
    /// The plugin folder passed with `--plugin-dir`.
    pub dir: PathBuf,
}

/// The plugin name for a project: its folder's name, lowercased and reduced
/// to what a namespace can use, or `overlay` when nothing is left.
pub fn overlay_plugin_name(project: &Path) -> String {
    let base = project
        .file_name()
        .map(|name| name.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let mut clean = String::new();
    for c in base.chars() {
        let keep = c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-');
        let c = if keep { c } else { '-' };
        if c == '-' && clean.ends_with('-') {
            continue;
        }
        clean.push(c);
    }
    let clean = clean.trim_matches(|c| matches!(c, '-' | '.' | '_'));
    if clean.is_empty() {
        "overlay".to_owned()
    } else {
        clean.to_owned()
    }
}

/// Plugin names for one launch's overlays, made distinct: two projects can
/// share a folder name, and the CLI namespaces skills by plugin name.
pub fn overlay_plugin_names(projects: &[PathBuf]) -> Vec<String> {
    let mut taken = std::collections::HashSet::new();
    projects
        .iter()
        .map(|project| {
            let base = overlay_plugin_name(project);
            let mut name = base.clone();
            let mut n = 2;
            while !taken.insert(name.clone()) {
                name = format!("{base}-{n}");
                n += 1;
            }
            name
        })
        .collect()
}

/// Builds an overlay for each project in `folder`, with the warnings worth
/// saying.
pub(super) fn build_overlays(
    projects: &[PathBuf],
    folder: &LaunchFolder,
    warnings: &mut Vec<String>,
) -> Result<Vec<Overlay>> {
    let names = overlay_plugin_names(projects);
    let mut overlays = Vec::new();
    for (project, name) in projects.iter().zip(names) {
        let project = HarnessProject::read(project);
        if project.parts().is_empty() {
            warnings.push(format!(
                "{} has no .claude/ or .agents/ directory and no CLAUDE.md or AGENTS.md to compose.",
                project.path.display()
            ));
        }
        for skill in &project.shadowed_skills {
            warnings.push(format!(
                "The skill {skill} is in both .claude/skills and .agents/skills of {}; the one in .claude/skills is used.",
                project.path.display()
            ));
        }
        let dir = folder.path().join(OVERLAYS_DIR).join(&name);
        build_one(&project, &name, &dir)?;
        overlays.push(Overlay { name, project, dir });
    }
    Ok(overlays)
}

fn build_one(project: &HarnessProject, name: &str, dir: &Path) -> Result<()> {
    let manifest_dir = dir.join(".claude-plugin");
    std::fs::create_dir_all(&manifest_dir)
        .map_err(|source| Error::path("create an overlay", &manifest_dir, source))?;
    let manifest = serde_json::json!({
        "name": name,
        "version": "0.0.0",
        "description": format!("Floti overlay for {}", project.path.display()),
    });
    let manifest_file = manifest_dir.join("plugin.json");
    std::fs::write(
        &manifest_file,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&manifest).expect("json")
        ),
    )
    .map_err(|source| Error::path("write", &manifest_file, source))?;

    match &project.skills {
        Skills::None => {}
        Skills::Folder(skills) => link(skills, &dir.join("skills"))?,
        Skills::Each(each) => {
            let skills = dir.join("skills");
            std::fs::create_dir_all(&skills)
                .map_err(|source| Error::path("create", &skills, source))?;
            for (skill, source) in each {
                link(source, &skills.join(skill))?;
            }
        }
    }
    for (target, part) in [
        (&project.commands, "commands"),
        (&project.subagents, "agents"),
        (&project.workflows, "workflows"),
    ] {
        if let Some(target) = target {
            link(target, &dir.join(part))?;
        }
    }
    Ok(())
}

/// Links `link` to `target`, or copies `target` there where no link can be
/// made.
fn link(target: &Path, link: &Path) -> Result<()> {
    if Links.link_folder(target, link).is_ok() {
        return Ok(());
    }
    copy_folder(target, link)
}

fn copy_folder(from: &Path, to: &Path) -> Result<()> {
    std::fs::create_dir_all(to).map_err(|source| Error::path("create", to, source))?;
    let entries = std::fs::read_dir(from).map_err(|source| Error::path("list", from, source))?;
    for entry in entries.flatten() {
        let source = entry.path();
        let destination = to.join(entry.file_name());
        if source.is_dir() {
            copy_folder(&source, &destination)?;
        } else {
            std::fs::copy(&source, &destination)
                .map_err(|err| Error::path("copy", &source, err))?;
        }
    }
    Ok(())
}

/// The composed project instructions for `overlays`, or `None` when there is
/// nothing to compose.
///
/// An overlay that is the working folder or above it is left out: Claude
/// Code loads every `CLAUDE.md`, and with the launch's settings every
/// `AGENTS.md`, from its working folder up, so composing it would give the
/// session the same instructions twice.
pub(super) fn compose_instructions(overlays: &[Overlay], cwd: &Path) -> Option<String> {
    let mut parts = Vec::new();
    let mut any_agents_md = false;
    for overlay in overlays {
        if is_same_or_ancestor(&overlay.project.path, cwd) {
            continue;
        }
        for file in overlay.project.instruction_files() {
            let Ok(content) = std::fs::read_to_string(file) else {
                continue;
            };
            let path = overlay.project.path.display();
            let is_agents_md = overlay.project.agents_md.as_ref() == Some(file);
            any_agents_md |= is_agents_md;
            let heading = if is_agents_md {
                format!("## Project instructions: {path} (AGENTS.md)")
            } else {
                format!("## Project instructions: {path}")
            };
            parts.push(format!(
                "{heading}\n\nThese apply to work in `{path}`, composed into this session as the `{}` overlay.\n\n{}",
                overlay.name,
                content.trim()
            ));
        }
    }
    if parts.is_empty() {
        return None;
    }
    let files = if any_agents_md {
        "instruction files"
    } else {
        "CLAUDE.md files"
    };
    Some(format!(
        "# Composed project instructions\n\nThe following {files} belong to projects composed into this session as overlays. The session's working directory is not theirs, so each block says which project it governs.\n\n{}\n",
        parts.join("\n\n---\n\n")
    ))
}
