//! A config file as the console sees it: its bytes and their hash, which
//! paths count as configuration, and the key a file's snapshots are kept
//! under.

use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use floti_protocol::channels::workspace::{ConfigFileContent, Millis};

use super::sha256;

/// `path` made absolute and with `.` and `..` folded away, without asking the
/// disk, so a path that climbs out of a scope is seen to before anything
/// opens it.
pub fn normalize(path: &Path) -> PathBuf {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let mut out = PathBuf::new();
    for part in absolute.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                // Never above the root: `/..` is `/`.
                if !matches!(
                    out.components().next_back(),
                    None | Some(Component::RootDir | Component::Prefix(_))
                ) {
                    out.pop();
                }
            }
            other => out.push(other),
        }
    }
    out
}

/// `path`'s components below `base`, or `None` when it is not under it.
fn below(base: &Path, path: &Path) -> Option<Vec<String>> {
    path.strip_prefix(base).ok().map(|rest| {
        rest.components()
            .filter_map(|part| match part {
                Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
                _ => None,
            })
            .collect()
    })
}

/// The time a file was last written, in epoch ms; zero when the OS cannot
/// say.
pub fn mtime_ms(meta: &std::fs::Metadata) -> Millis {
    Millis(
        meta.modified()
            .ok()
            .and_then(|at| at.duration_since(UNIX_EPOCH).ok())
            .map_or(0.0, |at| at.as_secs_f64() * 1_000.0),
    )
}

/// The hash a write of `content` would leave on disk.
pub fn hash_content(content: &str) -> String {
    sha256::hex_digest(content.as_bytes())
}

/// A file as it is now. The hash is over the bytes on disk rather than over
/// decoded text, so a CRLF file an editor turned LF is a different file, as
/// a conflict check needs it to be. Bytes that hold a NUL or are not UTF-8
/// are binary: their content is not sent, and no write replaces them.
pub fn read_file(path: &Path) -> ConfigFileContent {
    let path = normalize(path);
    let shown = path.display().to_string();
    let Ok(meta) = std::fs::metadata(&path) else {
        return ConfigFileContent {
            path: shown,
            exists: false,
            content: String::new(),
            hash: String::new(),
            size: 0,
            mtime_ms: Millis(0.0),
            binary: false,
        };
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return ConfigFileContent {
            path: shown,
            exists: true,
            content: String::new(),
            hash: String::new(),
            size: meta.len(),
            mtime_ms: mtime_ms(&meta),
            binary: true,
        };
    };
    let hash = sha256::hex_digest(&bytes);
    let text = if bytes.contains(&0) {
        None
    } else {
        String::from_utf8(bytes).ok()
    };
    ConfigFileContent {
        path: shown,
        exists: true,
        binary: text.is_none(),
        content: text.unwrap_or_default(),
        hash,
        size: meta.len(),
        mtime_ms: mtime_ms(&meta),
    }
}

/// Which paths one surface may write through the
/// [`SnapshotWriter`](super::SnapshotWriter): the writer's snapshot, conflict
/// and text rules are the same for every surface, and the guard is the one
/// thing each decides for itself.
pub trait PathGuard: Send + Sync {
    /// Refuses, in a sentence, a write of `path` under `scope`.
    fn check(&self, scope: &Path, path: &Path) -> Result<(), String>;
}

/// Which paths the console may write: configuration, inside the scope a
/// request names. The agent's own config folder is configuration throughout,
/// whatever it is called.
#[derive(Debug, Clone)]
pub struct WriteGuard {
    agent_config_dir: PathBuf,
}

impl WriteGuard {
    pub fn new(agent_config_dir: &Path) -> Self {
        Self {
            agent_config_dir: normalize(agent_config_dir),
        }
    }

    /// Refuses, in a sentence, a path that is relative, outside `scope`, or
    /// not configuration: under a `.claude` folder, or a `CLAUDE.md` or
    /// `.mcp.json` at the top of the scope. The scope check stops a request
    /// from using one scope's history to write into another's tree.
    pub fn check(&self, scope: &Path, path: &Path) -> Result<(), String> {
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
        let name = segments.last().map(String::as_str).unwrap_or_default();
        let in_claude_dir = segments.iter().any(|segment| segment == ".claude")
            || scope.file_name().is_some_and(|last| last == ".claude")
            || scope == self.agent_config_dir;
        let loose =
            segments.len() == 1 && (name.eq_ignore_ascii_case("claude.md") || name == ".mcp.json");
        if (in_claude_dir && !segments.is_empty()) || loose {
            Ok(())
        } else {
            Err(format!(
                "Refusing to write {}: only files under a .claude folder, a CLAUDE.md, or a .mcp.json are configuration.",
                absolute.display()
            ))
        }
    }
}

impl PathGuard for WriteGuard {
    fn check(&self, scope: &Path, path: &Path) -> Result<(), String> {
        WriteGuard::check(self, scope, path)
    }
}

/// The key a file's snapshots are kept under: its path below the scope,
/// forward-slashed.
pub fn snapshot_key(scope: &Path, path: &Path) -> String {
    let scope = normalize(scope);
    let path = normalize(path);
    match below(&scope, &path) {
        Some(segments) => segments.join("/"),
        None => path.display().to_string().replace('\\', "/"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_that_climbs_out_of_its_scope_is_outside_it() {
        let root = std::env::temp_dir().join("floti scope");
        let guard = WriteGuard::new(&root.join("home").join(".claude"));
        let outside = root.join("project").join("..").join("elsewhere.json");
        let refused = guard.check(&root.join("project"), &outside).unwrap_err();
        assert!(refused.contains("not inside"), "{refused}");
        assert!(
            guard
                .check(
                    &root.join("project"),
                    &root.join("project").join(".claude").join("settings.json")
                )
                .is_ok()
        );
        assert!(
            guard
                .check(
                    &root.join("project"),
                    &root.join("project").join("CLAUDE.md")
                )
                .is_ok()
        );
        let not_config = guard
            .check(
                &root.join("project"),
                &root.join("project").join("src").join("a.ts"),
            )
            .unwrap_err();
        assert!(not_config.contains("configuration"), "{not_config}");
        assert!(guard.check(&root, Path::new("relative.json")).is_err());
    }

    #[test]
    fn the_agents_config_folder_is_configuration_whatever_it_is_called() {
        let dir = std::env::temp_dir().join("claude config");
        let guard = WriteGuard::new(&dir);
        assert!(guard.check(&dir, &dir.join("settings.json")).is_ok());
        assert!(
            WriteGuard::new(&std::env::temp_dir().join("other"))
                .check(&dir, &dir.join("settings.json"))
                .is_err()
        );
    }
}
