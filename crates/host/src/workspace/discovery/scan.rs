//! Turns a list of root paths into the launcher's tree, as
//! `packages/core/src/discovery/scan.ts` does.
//!
//! The shape it looks for, in order:
//!   1. the root itself is a harness (`harness.yaml`) -> the harness and its
//!      repos
//!   2. the root *contains* harnesses -> each one, as above
//!   3. the root's children look like projects -> those children
//!   4. anything else -> the root itself
//!
//! Step 3 is what makes the host useful pointed at a folder of ordinary
//! repositories with no harness anywhere; step 4 is why a folder picked
//! meaning "this one" is what appears, rather than its `src` and `tests`.
//!
//! Paths are compared ignoring case on every OS, as the discovery cache
//! compares them: a row written from one spelling of a Windows folder is
//! the same folder in another.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::time::Instant;

use floti_protocol::channels::workspace::{
    DiscoveryError, DiscoveryResult, Harness, Millis, Project, ProjectKind,
};
use serde_yaml_ng::Value;

use super::git::read_git_states;
use super::inventory::{has_claude_dir, read_claude_inventory};
use crate::config_console::normalize;
use crate::config_console::time::now_iso;

/// The file whose presence makes a folder a harness.
pub const HARNESS_MANIFEST: &str = "harness.yaml";
const REPOS_DIRNAME: &str = "repos";

/// How deep below a root harnesses are looked for: 1 finds
/// `<root>/<harness>`.
const MAX_DEPTH: usize = 1;

/// What makes a folder a project in its own right rather than a container
/// of them: exactly the things the host has something to say about (the git
/// chip, the `.claude/` flag and the instruction file), and no list of
/// ecosystems' manifests that would be wrong for every one not on it.
const PROJECT_MARKERS: [&str; 3] = [".git", ".claude", "CLAUDE.md"];

/// Folders that are never projects, skipped before any reading is spent on
/// them.
const SKIP_DIRS: [&str; 11] = [
    "node_modules",
    ".git",
    ".svn",
    ".hg",
    "dist",
    "build",
    "out",
    ".next",
    ".turbo",
    ".venv",
    "__pycache__",
];

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn is_directory(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|meta| meta.is_dir())
}

/// Whether `path` holds a `harness.yaml`.
pub fn is_harness(path: &Path) -> bool {
    std::fs::metadata(path.join(HARNESS_MANIFEST)).is_ok_and(|meta| meta.is_file())
}

#[derive(Debug, Default)]
struct HarnessManifest {
    name: Option<String>,
    template: Option<String>,
    version: Option<String>,
    /// The `repos:` key, verbatim; [`repos_dir_of`] resolves it.
    repos: Option<String>,
}

/// The manifest's string keys. A manifest that is not a mapping has none;
/// one that cannot be read or parsed is `None`, and the harness is still a
/// harness: the file's presence is the signal, its contents decoration.
fn read_harness_manifest(path: &Path) -> Option<HarnessManifest> {
    let raw = std::fs::read_to_string(path.join(HARNESS_MANIFEST)).ok()?;
    let parsed: Value = serde_yaml_ng::from_str(&raw).ok()?;
    let Value::Mapping(record) = parsed else {
        return Some(HarnessManifest::default());
    };
    let string = |key: &str| record.get(key).and_then(Value::as_str).map(str::to_owned);
    Some(HarnessManifest {
        name: string("name"),
        template: string("template"),
        version: string("version"),
        repos: string("repos"),
    })
}

/// Which folder a harness keeps its repositories in: `repos:`, relative to
/// the harness, or `repos/` when it is absent or empty. `repos: .` is how a
/// folder of repositories becomes a harness without hiding them.
///
/// An absolute `repos:`, or one that climbs out of the harness, falls back
/// to `repos/`: a manifest travels with someone else's workspace, and a
/// line in it must not point a scan at the whole disk.
fn repos_dir_of(harness: &Path, manifest: Option<&HarnessManifest>) -> PathBuf {
    let fallback = harness.join(REPOS_DIRNAME);
    let declared = manifest
        .and_then(|manifest| manifest.repos.as_deref())
        .map(str::trim)
        .unwrap_or_default();
    if declared.is_empty() || Path::new(declared).is_absolute() {
        return fallback;
    }
    let resolved = normalize(&harness.join(declared));
    if resolved.starts_with(harness) {
        resolved
    } else {
        fallback
    }
}

/// The folders in `path` that could be projects: not links, not dotted, not
/// skipped; sorted ignoring case.
fn list_dirs(path: &Path) -> std::io::Result<Vec<String>> {
    let mut names: Vec<String> = std::fs::read_dir(path)?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            // Not followed: a link is not a folder here.
            let kind = entry.file_type().ok()?;
            let name = entry.file_name().to_string_lossy().into_owned();
            (kind.is_dir() && !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_str()))
                .then_some(name)
        })
        .collect();
    names.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()).then(a.cmp(b)));
    Ok(names)
}

fn describe_project(path: &Path, kind: ProjectKind, harness_path: Option<&Path>) -> Project {
    Project {
        path: text(path),
        name: path
            .file_name()
            .map_or_else(|| text(path), |name| name.to_string_lossy().into_owned()),
        kind,
        harness_path: harness_path.map(text),
        has_claude_dir: has_claude_dir(path),
        inventory: read_claude_inventory(path),
        git: None,
    }
}

/// A harness and every project in its repos folder. The harness is itself a
/// project: it has its own `.claude/` and is where a session launches from.
fn scan_harness(path: &Path) -> (Harness, Vec<Project>) {
    let manifest = read_harness_manifest(path);
    let repos_dir = repos_dir_of(path, manifest.as_ref());
    let repo_names = if is_directory(&repos_dir) {
        list_dirs(&repos_dir).unwrap_or_default()
    } else {
        Vec::new()
    };
    let repo_paths: Vec<PathBuf> = repo_names.iter().map(|name| repos_dir.join(name)).collect();
    let mut projects = vec![describe_project(path, ProjectKind::Harness, Some(path))];
    projects.extend(
        repo_paths
            .iter()
            .map(|repo| describe_project(repo, ProjectKind::Repo, Some(path))),
    );
    let manifest = manifest.unwrap_or_default();
    let harness = Harness {
        path: text(path),
        name: manifest.name.unwrap_or_else(|| projects[0].name.clone()),
        template: manifest.template,
        version: manifest.version,
        repo_paths: repo_paths.iter().map(|repo| text(repo)).collect(),
    };
    (harness, projects)
}

/// Whether `path` carries any of [`PROJECT_MARKERS`]. Existence only, not
/// kind: a git worktree's `.git` is a file.
fn looks_like_project(path: &Path) -> bool {
    PROJECT_MARKERS
        .iter()
        .any(|marker| std::fs::metadata(path.join(marker)).is_ok())
}

#[derive(Default)]
struct Walk {
    harnesses: Vec<Harness>,
    projects: Vec<Project>,
    errors: Vec<DiscoveryError>,
    seen: HashSet<String>,
}

impl Walk {
    fn add(&mut self, found: Vec<Project>) {
        for project in found {
            if self.seen.insert(project.path.to_lowercase()) {
                self.projects.push(project);
            }
        }
    }

    fn visit(&mut self, path: &Path, depth: usize) {
        if is_harness(path) {
            let (harness, found) = scan_harness(path);
            self.harnesses.push(harness);
            self.add(found);
            return;
        }
        if depth >= MAX_DEPTH {
            // Out of budget to look deeper: what we stand on is a project.
            self.add(vec![describe_project(path, ProjectKind::Folder, None)]);
            return;
        }
        let children = match list_dirs(path) {
            Ok(children) => children,
            Err(err) => {
                self.errors.push(DiscoveryError {
                    path: text(path),
                    message: err.to_string(),
                });
                return;
            }
        };
        let children: Vec<PathBuf> = children.iter().map(|name| path.join(name)).collect();
        let harnesses: Vec<&PathBuf> = children.iter().filter(|child| is_harness(child)).collect();
        if !harnesses.is_empty() {
            // A folder of harnesses: its other children are whatever else
            // lives beside them, not projects.
            for child in harnesses {
                self.visit(child, depth + 1);
            }
            return;
        }
        // No harness below, so the folder is a container of projects or a
        // project, and only a child that looks like a project says which.
        // Never the converse: a folder of repositories with a CLAUDE.md at
        // its top is still a container.
        if !children.iter().any(|child| looks_like_project(child)) {
            self.add(vec![describe_project(path, ProjectKind::Folder, None)]);
            return;
        }
        self.add(
            children
                .iter()
                .map(|child| describe_project(child, ProjectKind::Folder, None))
                .collect(),
        );
    }
}

/// Walks `roots`, reading each project's git state when `include_git`.
/// A root that is not a folder, or a folder that cannot be listed, is an
/// error in the result rather than a failure.
pub fn scan(roots: &[String], include_git: bool) -> DiscoveryResult {
    let started = Instant::now();
    let roots: Vec<PathBuf> = roots
        .iter()
        .map(|root| normalize(Path::new(root)))
        .collect();
    let mut walk = Walk::default();
    for root in &roots {
        if !is_directory(root) {
            walk.errors.push(DiscoveryError {
                path: text(root),
                message: "not a directory".into(),
            });
            continue;
        }
        walk.visit(root, 0);
    }
    if include_git {
        let paths: Vec<String> = walk.projects.iter().map(|p| p.path.clone()).collect();
        let states = read_git_states(&paths);
        for project in &mut walk.projects {
            project.git = states.get(&project.path).cloned().flatten();
        }
    }
    walk.projects.sort_by(|a, b| {
        a.path
            .to_lowercase()
            .cmp(&b.path.to_lowercase())
            .then(a.path.cmp(&b.path))
    });
    DiscoveryResult {
        roots: roots.iter().map(|root| text(root)).collect(),
        harnesses: walk.harnesses,
        projects: walk.projects,
        errors: walk.errors,
        scanned_at: now_iso(),
        duration_ms: Millis(started.elapsed().as_secs_f64() * 1000.0),
    }
}

/// `path`'s components, folded and lower-cased.
fn folded(path: &str) -> Vec<String> {
    normalize(Path::new(path))
        .components()
        .filter(|part| !matches!(part, Component::CurDir))
        .map(|part| part.as_os_str().to_string_lossy().to_lowercase())
        .collect()
}

/// Whether `path` is `root` or sits under it, ignoring case.
pub fn is_within(root: &str, path: &str) -> bool {
    let root = folded(root);
    let path = folded(path);
    path.len() >= root.len() && path[..root.len()] == root[..]
}

/// The cached rows a completed scan has disproved: under a root it walked
/// with no error at or below it, and not returned by the walk. A root that
/// errored, the unplugged drive, keeps everything under it, and a row under
/// no current root is not this scan's to judge.
pub fn disproved_project_paths(cached: &[String], result: &DiscoveryResult) -> Vec<String> {
    let trusted: Vec<&String> = result
        .roots
        .iter()
        .filter(|root| {
            !result
                .errors
                .iter()
                .any(|error| is_within(root, &error.path))
        })
        .collect();
    if trusted.is_empty() {
        return Vec::new();
    }
    let found: HashSet<String> = result
        .projects
        .iter()
        .map(|project| project.path.to_lowercase())
        .collect();
    cached
        .iter()
        .filter(|path| {
            !found.contains(&path.to_lowercase())
                && trusted.iter().any(|root| is_within(root, path))
        })
        .cloned()
        .collect()
}

/// The cached rows removing the root `removed` orphans: under it, and under
/// none of the roots that remain.
pub fn orphaned_project_paths(
    cached: &[String],
    removed: &str,
    remaining: &[String],
) -> Vec<String> {
    cached
        .iter()
        .filter(|path| {
            is_within(removed, path) && !remaining.iter().any(|root| is_within(root, path))
        })
        .cloned()
        .collect()
}
