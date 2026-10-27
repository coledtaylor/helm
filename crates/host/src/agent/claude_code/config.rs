//! Claude Code's config files, listed the way the CLI resolves them.
//!
//! A skill is a folder holding a `SKILL.md`, so the file to open is the
//! `SKILL.md` and the name is the folder; a command's namespace is its path
//! (`commands/spec/plan.md` is `/spec:plan`); a workflow is named by the
//! `meta.name` its script declares. Linked folders are not followed, the
//! folders the CLI keeps as working storage are skipped, and no credential
//! file is ever listed. Reads only, and only the head of a file that can
//! carry a description.

use std::cmp::Ordering;
use std::path::{Component, Path, PathBuf};

use floti_protocol::channels::workspace::{ConfigFile, ConfigFileKind, Millis};

use super::ClaudeCodeBackend;
use crate::config_console::{AgentCommand, AgentConfig};
use crate::{Error, Result};

impl ClaudeCodeBackend {
    /// Claude Code's side of the config console: its config folder, its
    /// global config, and `claude` with the environment every session gets,
    /// for `claude mcp` and `claude doctor`.
    ///
    /// The global config is where the CLI keeps it: `.claude.json` in
    /// `CLAUDE_CONFIG_DIR` when that is set, and in the home folder beside
    /// `~/.claude` otherwise.
    pub fn console_agent(&self) -> AgentConfig {
        let settings = self.settings();
        let global_dir = if settings.pass_config_dir {
            settings.config_dir.clone()
        } else {
            settings
                .config_dir
                .parent()
                .map_or_else(|| settings.config_dir.clone(), Path::to_path_buf)
        };
        AgentConfig {
            config_dir: settings.config_dir.clone(),
            global_config: global_dir.join(".claude.json"),
            command: AgentCommand {
                program: settings.program.clone(),
                args: settings.leading_args.clone(),
                env: self.session_env(),
            },
        }
    }
}

/// Deep enough for `commands/spec/section/thing.md`, shallow enough to end.
const MAX_DEPTH: usize = 8;

/// Folders under a config tree that are working storage, not configuration.
const SKIPPED_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "projects",
    "sessions",
    "shell-snapshots",
    "file-history",
    "paste-cache",
    "statsig",
    "cache",
    "debug",
    "downloads",
    "todos",
    "backups",
    "ide",
    "tasks",
    "teams",
    "session-env",
    "chrome",
    "plugins",
    "__pycache__",
];

/// Extensions worth opening as text. Everything else is listed as binary.
const TEXT_EXT: &[&str] = &[
    "md", "markdown", "json", "jsonc", "yaml", "yml", "toml", "txt", "js", "mjs", "cjs", "ts",
    "sh", "ps1", "py", "bat", "cmd",
];

/// The order the config console groups kinds in.
const ORDER: &[ConfigFileKind] = &[
    ConfigFileKind::ClaudeMd,
    ConfigFileKind::Settings,
    ConfigFileKind::SettingsLocal,
    ConfigFileKind::Mcp,
    ConfigFileKind::Skill,
    ConfigFileKind::Command,
    ConfigFileKind::Agent,
    ConfigFileKind::Workflow,
    ConfigFileKind::Hook,
    ConfigFileKind::Rule,
    ConfigFileKind::Other,
];

/// How far into a file a description is looked for: frontmatter and a
/// workflow's `meta` are at the top by definition.
const HEAD_BYTES: usize = 4096;

/// The user's config files, then `project`'s, never one of `credentials`.
pub(super) fn config_files(
    config_dir: &Path,
    project: Option<&Path>,
    credentials: &[PathBuf],
) -> Result<Vec<ConfigFile>> {
    let is_credential = |path: &Path| {
        credentials
            .iter()
            .any(|credential| same_path(credential, path))
    };
    let mut files = scope_files(config_dir, config_dir, false)?;
    if let Some(project) = project {
        files.extend(scope_files(project, &project.join(".claude"), true)?);
    }
    files.retain(|file| !is_credential(Path::new(&file.path)));
    Ok(files)
}

/// Whether two paths name the same file, ignoring case on every OS: a
/// credential is left out of a listing whenever it might be the same file,
/// and leaving out a look-alike costs nothing.
fn same_path(a: &Path, b: &Path) -> bool {
    a.as_os_str().eq_ignore_ascii_case(b.as_os_str())
}

/// One scope's files, sorted by kind and then name. `loose` adds the
/// `CLAUDE.md` and `.mcp.json` beside a project's `.claude`.
fn scope_files(base: &Path, claude_dir: &Path, loose: bool) -> Result<Vec<ConfigFile>> {
    let mut files = Vec::new();
    match std::fs::read_dir(claude_dir) {
        Ok(_) => walk(base, claude_dir, claude_dir, 0, &mut files),
        // A project with no `.claude` is the normal case.
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(source) => return Err(Error::path("list", claude_dir, source)),
    }
    if loose {
        for (name, kind) in [
            ("CLAUDE.md", ConfigFileKind::ClaudeMd),
            (".mcp.json", ConfigFileKind::Mcp),
        ] {
            let path = base.join(name);
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            if meta.is_file() {
                files.push(entry(
                    &path,
                    name.to_owned(),
                    kind,
                    name.to_owned(),
                    &meta,
                    None,
                    false,
                ));
            }
        }
    }
    files.sort_by(|a, b| {
        rank(a.kind)
            .cmp(&rank(b.kind))
            .then_with(|| compare_names(&a.name, &b.name))
            .then_with(|| a.rel_path.cmp(&b.rel_path))
    });
    Ok(files)
}

fn rank(kind: ConfigFileKind) -> usize {
    ORDER.iter().position(|k| *k == kind).unwrap_or(ORDER.len())
}

fn compare_names(a: &str, b: &str) -> Ordering {
    a.to_lowercase()
        .cmp(&b.to_lowercase())
        .then_with(|| a.cmp(b))
}

fn walk(base: &Path, claude_dir: &Path, dir: &Path, depth: usize, files: &mut Vec<ConfigFile>) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for item in entries.flatten() {
        let Ok(kind) = item.file_type() else {
            continue;
        };
        let path = item.path();
        let name = item.file_name().to_string_lossy().into_owned();
        // `file_type` does not follow links, so a linked folder is neither a
        // dir nor a file here and is not walked into.
        if kind.is_dir() {
            if !SKIPPED_DIRS.contains(&name.to_lowercase().as_str()) {
                walk(base, claude_dir, &path, depth + 1, files);
            }
            continue;
        }
        if !kind.is_file() {
            continue;
        }
        let inside = parts(claude_dir, &path);
        let Some((what, what_name)) = classify(&inside) else {
            continue;
        };
        // Deleted between the listing and here: not there, so not listed.
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        let binary = !extension(&name).is_some_and(|ext| TEXT_EXT.contains(&ext.as_str()));
        let (display_name, description) = if binary {
            (what_name, None)
        } else if what == ConfigFileKind::Workflow {
            let meta = workflow_meta(&read_head(&path));
            (meta.name.unwrap_or(what_name), meta.description)
        } else if matches!(
            what,
            ConfigFileKind::Skill | ConfigFileKind::Agent | ConfigFileKind::Command
        ) {
            (
                what_name,
                frontmatter_field(&read_head(&path), "description"),
            )
        } else {
            (what_name, None)
        };
        let rel = parts(base, &path).join("/");
        files.push(entry(
            &path,
            rel,
            what,
            display_name,
            &meta,
            description,
            binary,
        ));
    }
}

fn entry(
    path: &Path,
    rel_path: String,
    kind: ConfigFileKind,
    name: String,
    meta: &std::fs::Metadata,
    description: Option<String>,
    binary: bool,
) -> ConfigFile {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0.0, |at| at.as_secs_f64() * 1_000.0);
    ConfigFile {
        path: path.display().to_string(),
        rel_path,
        kind,
        name,
        size: meta.len(),
        mtime_ms: Millis(mtime),
        description,
        binary,
    }
}

/// `path`'s components below `from`.
fn parts(from: &Path, path: &Path) -> Vec<String> {
    path.strip_prefix(from)
        .unwrap_or(path)
        .components()
        .filter_map(|part| match part {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect()
}

fn extension(name: &str) -> Option<String> {
    let dot = name.rfind('.').filter(|&dot| dot > 0)?;
    Some(name[dot + 1..].to_lowercase())
}

fn strip_suffix_ci<'a>(text: &'a str, suffix: &str) -> &'a str {
    if text.len() >= suffix.len()
        && text.is_char_boundary(text.len() - suffix.len())
        && text[text.len() - suffix.len()..].eq_ignore_ascii_case(suffix)
    {
        &text[..text.len() - suffix.len()]
    } else {
        text
    }
}

/// What a file inside a config folder is, from its path as the CLI decides
/// it, with the name it is addressed by.
fn classify(inside: &[String]) -> Option<(ConfigFileKind, String)> {
    let file = inside.last()?;
    let lower = file.to_lowercase();
    let top = inside.first()?.as_str();
    let tail = &inside[1..];

    if inside.len() == 1 {
        return Some(match lower.as_str() {
            "settings.json" => (ConfigFileKind::Settings, "settings.json".into()),
            "settings.local.json" => (ConfigFileKind::SettingsLocal, "settings.local.json".into()),
            "claude.md" => (ConfigFileKind::ClaudeMd, "CLAUDE.md".into()),
            ".mcp.json" => (ConfigFileKind::Mcp, ".mcp.json".into()),
            _ => (ConfigFileKind::Other, file.clone()),
        });
    }
    let kind = match top {
        "skills" => {
            if lower == "skill.md" {
                // `skills/a/b/SKILL.md` is `b`.
                let name = tail
                    .len()
                    .checked_sub(2)
                    .and_then(|at| tail.get(at))
                    .or_else(|| tail.first())
                    .unwrap_or(file);
                (ConfigFileKind::Skill, name.clone())
            } else {
                (ConfigFileKind::Other, tail.join("/"))
            }
        }
        "commands" if lower.ends_with(".md") => (
            ConfigFileKind::Command,
            strip_suffix_ci(&tail.join(":"), ".md").to_owned(),
        ),
        "agents" if lower.ends_with(".md") => (
            ConfigFileKind::Agent,
            strip_suffix_ci(&tail.join("/"), ".md").to_owned(),
        ),
        "workflows" if tail.len() == 1 && lower.ends_with(".js") => (
            ConfigFileKind::Workflow,
            strip_suffix_ci(file, ".js").to_owned(),
        ),
        "hooks" => (ConfigFileKind::Hook, tail.join("/")),
        "rules" => (
            ConfigFileKind::Rule,
            strip_suffix_ci(&tail.join("/"), ".md").to_owned(),
        ),
        _ => (ConfigFileKind::Other, inside.join("/")),
    };
    Some(kind)
}

fn read_head(path: &Path) -> String {
    use std::io::Read;
    let mut head = Vec::with_capacity(HEAD_BYTES);
    if let Ok(file) = std::fs::File::open(path) {
        let _ = file.take(HEAD_BYTES as u64).read_to_end(&mut head);
    }
    String::from_utf8_lossy(&head).into_owned()
}

/// A top-level scalar from a file's frontmatter, unquoted.
fn frontmatter_field(text: &str, key: &str) -> Option<String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let lines: Vec<&str> = text
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();
    if lines.first()?.trim() != "---" {
        return None;
    }
    // No closing fence means no frontmatter.
    let end = lines.iter().skip(1).position(|line| line.trim() == "---")? + 1;
    lines[1..end].iter().find_map(|line| {
        if line.starts_with(char::is_whitespace) {
            return None;
        }
        let (name, value) = line.split_once(':')?;
        let name = name.trim_end();
        let valid = !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
        if !valid || name != key {
            return None;
        }
        let value = value.trim();
        let value = value.strip_prefix(['\'', '"']).unwrap_or(value);
        let value = value.strip_suffix(['\'', '"']).unwrap_or(value);
        (!value.is_empty()).then(|| value.to_owned())
    })
}

/// A workflow's literal `export const meta = { name, description }`.
#[derive(Debug, Default, PartialEq, Eq)]
struct WorkflowMeta {
    name: Option<String>,
    description: Option<String>,
}

/// Read as text; the script is never run. Only a plain literal counts,
/// because that is all the CLI recognises.
fn workflow_meta(text: &str) -> WorkflowMeta {
    let Some(block) = meta_block(text) else {
        return WorkflowMeta::default();
    };
    WorkflowMeta {
        name: meta_field(block, "name"),
        description: meta_field(block, "description"),
    }
}

fn meta_block(text: &str) -> Option<&str> {
    let mut rest = text;
    loop {
        let at = rest.find("export")?;
        let after = &rest[at + "export".len()..];
        rest = after;
        let after = after.strip_prefix(char::is_whitespace)?.trim_start();
        let Some(after) = after.strip_prefix("const") else {
            continue;
        };
        let Some(after) = after.strip_prefix(char::is_whitespace) else {
            continue;
        };
        let Some(after) = after.trim_start().strip_prefix("meta") else {
            continue;
        };
        let Some(after) = after.trim_start().strip_prefix('=') else {
            continue;
        };
        let Some(after) = after.trim_start().strip_prefix('{') else {
            continue;
        };
        return after.find('}').map(|end| &after[..end]);
    }
}

fn meta_field(block: &str, key: &str) -> Option<String> {
    let mut from = 0;
    while let Some(found) = block[from..].find(key) {
        let at = from + found;
        from = at + key.len();
        let before_ok = block[..at]
            .chars()
            .next_back()
            .is_none_or(|c| c.is_whitespace() || matches!(c, ',' | '\'' | '"'));
        if !before_ok {
            continue;
        }
        let mut rest = &block[at + key.len()..];
        rest = rest.strip_prefix(['\'', '"']).unwrap_or(rest);
        let Some(rest) = rest.trim_start().strip_prefix(':') else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(quote) = rest
            .chars()
            .next()
            .filter(|c| matches!(c, '\'' | '"' | '`'))
        else {
            continue;
        };
        let body = &rest[1..];
        let Some(end) = body.find(quote) else {
            continue;
        };
        let value = body[..end].trim();
        if value.is_empty() || value.contains("${") {
            return None;
        }
        return Some(value.to_owned());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(inside: &[&str]) -> Option<(ConfigFileKind, String)> {
        classify(&inside.iter().map(|p| (*p).to_owned()).collect::<Vec<_>>())
    }

    #[test]
    fn files_are_named_the_way_the_cli_addresses_them() {
        assert_eq!(
            names(&["skills", "think", "SKILL.md"]),
            Some((ConfigFileKind::Skill, "think".into()))
        );
        assert_eq!(
            names(&["skills", "a", "b", "SKILL.md"]),
            Some((ConfigFileKind::Skill, "b".into()))
        );
        assert_eq!(
            names(&["commands", "spec", "plan.md"]),
            Some((ConfigFileKind::Command, "spec:plan".into()))
        );
        assert_eq!(
            names(&["agents", "reviewer.md"]),
            Some((ConfigFileKind::Agent, "reviewer".into()))
        );
        assert_eq!(
            names(&["workflows", "ship.js"]),
            Some((ConfigFileKind::Workflow, "ship".into()))
        );
        assert_eq!(
            names(&["settings.local.json"]),
            Some((ConfigFileKind::SettingsLocal, "settings.local.json".into()))
        );
        assert_eq!(
            names(&["skills", "think", "notes.md"]),
            Some((ConfigFileKind::Other, "think/notes.md".into()))
        );
    }

    #[test]
    fn a_description_comes_from_frontmatter_and_a_workflow_from_its_literal_meta() {
        assert_eq!(
            frontmatter_field(
                "---\r\nname: x\r\ndescription: 'Does a thing'\r\n---\r\nbody",
                "description"
            ),
            Some("Does a thing".into())
        );
        assert_eq!(
            frontmatter_field("---\ndescription: open", "description"),
            None
        );
        assert_eq!(frontmatter_field("no frontmatter", "description"), None);
        assert_eq!(
            workflow_meta("export const meta = { name: 'ship', description: \"Ships it\" }\n"),
            WorkflowMeta {
                name: Some("ship".into()),
                description: Some("Ships it".into())
            }
        );
        assert_eq!(
            workflow_meta("export const meta = { name: `x-${y}` }").name,
            None
        );
    }
}
