//! Counts a project's `.claude/` the way Claude Code resolves it, as
//! `packages/core/src/discovery/claude-inventory.ts` does.
//!
//! A *skill* is a folder holding `SKILL.md`, at any depth; *commands* and
//! *agents* are markdown files at any depth, since namespaced commands
//! (`/spec:plan`) live in subfolders. Links are never followed: a junction
//! pointing back up the tree would otherwise recurse forever.

use std::path::Path;

use floti_protocol::channels::workspace::ClaudeInventory;

use crate::store::projects::EMPTY_INVENTORY;

fn exists(path: &Path) -> bool {
    std::fs::metadata(path).is_ok()
}

fn is_directory(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|meta| meta.is_dir())
}

/// Each entry of `dir` that is a folder or a file, judged without following
/// links (a link is neither); nothing when it cannot be listed.
fn entries(dir: &Path) -> Vec<(std::path::PathBuf, std::fs::FileType)> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    read.filter_map(|entry| {
        let entry = entry.ok()?;
        let kind = entry.file_type().ok()?;
        (!kind.is_symlink()).then(|| (entry.path(), kind))
    })
    .collect()
}

fn count_markdown(dir: &Path) -> u32 {
    entries(dir)
        .into_iter()
        .map(|(path, kind)| {
            if kind.is_dir() {
                count_markdown(&path)
            } else if kind.is_file()
                && path
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().to_lowercase().ends_with(".md"))
            {
                1
            } else {
                0
            }
        })
        .sum()
}

fn count_skills(dir: &Path) -> u32 {
    entries(dir)
        .into_iter()
        .filter(|(_, kind)| kind.is_dir())
        .map(|(path, _)| {
            if exists(&path.join("SKILL.md")) {
                1
            } else {
                count_skills(&path)
            }
        })
        .sum()
}

/// What `project`'s `.claude/` holds, and whether it has a `CLAUDE.md` and a
/// `.mcp.json`. A `CLAUDE.md` counts with no `.claude/` beside it: it alone
/// changes how a session behaves.
pub fn read_claude_inventory(project: &Path) -> ClaudeInventory {
    let claude = project.join(".claude");
    if !is_directory(&claude) {
        return ClaudeInventory {
            claude_md: exists(&project.join("CLAUDE.md")),
            ..EMPTY_INVENTORY
        };
    }
    ClaudeInventory {
        skills: count_skills(&claude.join("skills")),
        commands: count_markdown(&claude.join("commands")),
        agents: count_markdown(&claude.join("agents")),
        hooks: is_directory(&claude.join("hooks")),
        settings: exists(&claude.join("settings.json"))
            || exists(&claude.join("settings.local.json")),
        claude_md: exists(&project.join("CLAUDE.md")),
        mcp: exists(&project.join(".mcp.json")),
    }
}

/// Whether `project` has a `.claude/` folder.
pub fn has_claude_dir(project: &Path) -> bool {
    is_directory(&project.join(".claude"))
}
