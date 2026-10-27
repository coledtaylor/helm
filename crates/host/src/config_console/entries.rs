//! Creating, renaming and removing an entry in a config scope, each through
//! the snapshot-first writer.
//!
//! - A rename is a copy and then a delete, never a filesystem move: a move
//!   leaves no row, so the old bytes could not come back and the new ones
//!   would have no history. Each destination gets a `create` row (restoring
//!   it removes the file again) and each source a `rename` row (restoring it
//!   puts the bytes back).
//! - Nothing is removed until everything is recorded. The rows for a set go
//!   in together, then the files come off the disk, so a snapshot that fails
//!   part way leaves the disk untouched.
//! - A file that is not text stops the whole operation: the history holds
//!   text, and the console will not move or remove bytes it cannot put back.

use std::path::{Path, PathBuf};

use floti_protocol::channels::workspace::{
    ConfigFile, ConfigFileKind, ConfigScope, ConfigScopeKind, ConfigWriteReason, CreatableKind,
    CreateConfigResult, DeleteConfigResult, DeletedConfigFile, MovedFile, RenameConfigResult,
    WriteConfigRequest,
};

use super::files::{normalize, read_file, snapshot_key};
use super::names::{
    check_name, config_unit, creatable, is_renamable, parse_frontmatter, plan_file, rename_refusal,
};
use super::writer::SnapshotWriter;

/// A scope-relative, forward-slashed path made absolute.
fn absolute(scope: &ConfigScope, rel_path: &str) -> PathBuf {
    normalize(
        &rel_path
            .split('/')
            .fold(PathBuf::from(&scope.path), |path, part| path.join(part)),
    )
}

fn rel_path_of(scope: &ConfigScope, path: &Path) -> String {
    snapshot_key(Path::new(&scope.path), path)
}

/// One file read whole, with the hash of the bytes read, so the row records
/// the content it stores.
struct ReadFile {
    path: PathBuf,
    content: String,
    hash: String,
}

/// Every file in a set, or the sentence naming the one the console will
/// not touch. Read before anything changes, so a set holding a binary is
/// refused whole.
fn read_all(scope: &ConfigScope, paths: &[PathBuf]) -> Result<Vec<ReadFile>, String> {
    paths
        .iter()
        .map(|path| {
            let current = read_file(path);
            if !current.exists {
                return Err(format!(
                    "{} is no longer there. Re-read the scope and try again.",
                    rel_path_of(scope, path)
                ));
            }
            if current.binary {
                return Err(format!(
                    "{} is not text, so Floti cannot record it before moving or removing it - and it will not touch bytes it cannot put back.",
                    rel_path_of(scope, path)
                ));
            }
            Ok(ReadFile {
                path: path.clone(),
                content: current.content,
                hash: current.hash,
            })
        })
        .collect()
}

/// Removes folders the operation emptied, deepest first, up to and never
/// including the scope's `.claude` folder, whose absence is what the scope
/// reports as not existing.
fn prune_empty_dirs(from: &Path, claude_dir: &Path) {
    let stop = normalize(claude_dir);
    let mut dir = normalize(from);
    while dir != stop && dir.starts_with(&stop) {
        let empty = std::fs::read_dir(&dir).is_ok_and(|mut entries| entries.next().is_none());
        if !empty || std::fs::remove_dir(&dir).is_err() {
            return;
        }
        if !dir.pop() {
            return;
        }
    }
}

/// Records every file, then removes every file. The rows go in one
/// transaction, so a failure leaves no row and nothing removed.
fn snapshot_then_remove(
    writer: &SnapshotWriter<'_>,
    scope: &ConfigScope,
    files: &[ReadFile],
    reason: ConfigWriteReason,
) -> Result<Vec<DeletedConfigFile>, String> {
    let scope_path = Path::new(&scope.path);
    for file in files {
        writer.guard().check(scope_path, &file.path)?;
    }
    let transaction = writer.connection().unchecked_transaction().map_err(|err| {
        format!("Floti could not take the snapshots first, so it changed nothing: {err}")
    })?;
    let rows = files
        .iter()
        .map(|file| {
            Ok(DeletedConfigFile {
                path: file.path.display().to_string(),
                rel_path: rel_path_of(scope, &file.path),
                snapshot_id: writer.snapshot(
                    scope_path,
                    &file.path,
                    &file.content,
                    &file.hash,
                    reason,
                )?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    transaction.commit().map_err(|err| {
        format!("Floti could not take the snapshots first, so it changed nothing: {err}")
    })?;

    for file in files {
        if let Err(err) = std::fs::remove_file(&file.path)
            && err.kind() != std::io::ErrorKind::NotFound
        {
            return Err(format!(
                "Floti recorded {} but could not remove it: {err}",
                file.path.display()
            ));
        }
    }
    let claude_dir = Path::new(&scope.claude_dir);
    for file in files {
        if let Some(parent) = file.path.parent() {
            prune_empty_dirs(parent, claude_dir);
        }
    }
    Ok(rows)
}

fn refused_create(error: String) -> CreateConfigResult {
    CreateConfigResult {
        ok: false,
        path: None,
        rel_path: None,
        snapshot_id: None,
        error: Some(error),
    }
}

/// Scaffolds a new entry. A name already taken is refused before anything
/// is written; for a skill the folder is the name, so a bare folder counts.
pub fn create(
    writer: &SnapshotWriter<'_>,
    scope: &ConfigScope,
    kind: CreatableKind,
    name: &str,
) -> Result<CreateConfigResult, String> {
    let plan = match plan_file(kind, name, scope.kind == ConfigScopeKind::User) {
        Ok(plan) => plan,
        Err(error) => return Ok(refused_create(error)),
    };
    if let Some(dir) = &plan.dir_rel_path
        && absolute(scope, dir).exists()
    {
        return Ok(refused_create(format!(
            "{} already has a skill called {}.",
            scope.label, plan.address
        )));
    }
    let target = absolute(scope, &plan.rel_path);
    if target.exists() {
        return Ok(refused_create(format!(
            "{} is already there. Open it instead of creating it.",
            plan.rel_path
        )));
    }

    let written = writer.write(&WriteConfigRequest {
        scope_path: scope.path.clone(),
        path: target.display().to_string(),
        content: plan.content,
        // "I believe this does not exist": a file that appeared since the
        // check above is a conflict, not an overwrite.
        expected_hash: None,
        reason: ConfigWriteReason::Create,
    })?;
    if !written.ok {
        return Ok(refused_create(if written.conflict.is_some() {
            format!(
                "{} appeared on disk while Floti was creating it, so nothing was written.",
                plan.rel_path
            )
        } else {
            written
                .error
                .unwrap_or_else(|| "The write was refused.".to_owned())
        }));
    }
    Ok(CreateConfigResult {
        ok: true,
        path: Some(target.display().to_string()),
        rel_path: Some(plan.rel_path),
        snapshot_id: written.snapshot_id,
        error: None,
    })
}

/// `name:` made to follow a rename, only when it named exactly the old
/// address: a name set to something else was set on purpose.
fn retitle_frontmatter(content: &str, from: &str, to: &str) -> String {
    let Some(parsed) = parse_frontmatter(content) else {
        return content.to_owned();
    };
    let declared = parsed
        .fields
        .iter()
        .find(|(key, _)| key == "name")
        .map(|(_, value)| value.as_str());
    if declared != Some(from) {
        return content.to_owned();
    }
    let mut lines: Vec<String> = content.split('\n').map(str::to_owned).collect();
    for line in lines
        .iter_mut()
        .take(parsed.end_line.saturating_sub(1))
        .skip(1)
    {
        let is_name = line
            .strip_prefix("name")
            .is_some_and(|rest| rest.trim_start().starts_with(':'));
        if is_name {
            let cr = if line.ends_with('\r') { "\r" } else { "" };
            *line = format!("name: {to}{cr}");
            break;
        }
    }
    lines.join("\n")
}

/// The last step of an address: a skill's folder, an agent's file name.
fn leaf_of(name: &str) -> &str {
    name.rsplit('/').next().unwrap_or(name)
}

fn refused_rename(error: String) -> RenameConfigResult {
    RenameConfigResult {
        ok: false,
        path: None,
        rel_path: None,
        moved: Vec::new(),
        snapshot_ids: Vec::new(),
        frontmatter_renamed: false,
        error: Some(error),
    }
}

/// Moves an entry to a new name. A skill's whole folder moves into a sibling
/// with the new name, keeping its layout; a command, agent or rule is
/// addressed by its path, so the new name is the new path, and the folders
/// it emptied go.
pub fn rename(
    writer: &SnapshotWriter<'_>,
    scope: &ConfigScope,
    files: &[ConfigFile],
    file: &ConfigFile,
    name: &str,
) -> Result<RenameConfigResult, String> {
    if !is_renamable(file.kind) {
        return Ok(refused_rename(
            rename_refusal(file.kind)
                .unwrap_or("That file cannot be renamed here.")
                .to_owned(),
        ));
    }
    let addressed_from = normalize(Path::new(&file.path));
    let (moves, addressed_to, new_leaf) = if file.kind == ConfigFileKind::Skill {
        let leaf = match check_name(ConfigFileKind::Skill, name) {
            Ok(segments) => segments.into_iter().next().unwrap_or_default(),
            Err(error) => return Ok(refused_rename(error)),
        };
        let Some(from_dir) = addressed_from.parent().map(Path::to_path_buf) else {
            return Ok(refused_rename(
                "That skill has no folder to move.".to_owned(),
            ));
        };
        let to_dir = from_dir
            .parent()
            .map_or_else(|| PathBuf::from(&leaf), |parent| parent.join(&leaf));
        if to_dir == from_dir {
            return Ok(refused_rename(format!("It is already called {leaf}.")));
        }
        if to_dir.exists() {
            return Ok(refused_rename(format!(
                "{} already has a skill called {leaf}.",
                scope.label
            )));
        }
        let moved_to = |path: &Path| match path.strip_prefix(&from_dir) {
            Ok(rest) => to_dir.join(rest),
            Err(_) => to_dir.join(path.file_name().unwrap_or_default()),
        };
        let moves: Vec<(PathBuf, PathBuf)> = config_unit(files, file)
            .into_iter()
            .map(|member| {
                let from = normalize(Path::new(&member.path));
                let to = moved_to(&from);
                (from, to)
            })
            .collect();
        (moves, moved_to(&addressed_from), leaf)
    } else {
        let Some(kind) = creatable(file.kind) else {
            return Ok(refused_rename(
                "That file cannot be renamed here.".to_owned(),
            ));
        };
        let plan = match plan_file(kind, name, scope.kind == ConfigScopeKind::User) {
            Ok(plan) => plan,
            Err(error) => return Ok(refused_rename(error)),
        };
        let to = absolute(scope, &plan.rel_path);
        if to == addressed_from {
            return Ok(refused_rename(format!(
                "It is already called {}.",
                plan.address
            )));
        }
        if to.exists() {
            return Ok(refused_rename(format!(
                "{} is already there.",
                plan.rel_path
            )));
        }
        let address = plan.address.trim_start_matches('/').replace(':', "/");
        let leaf = leaf_of(&address).to_owned();
        (vec![(addressed_from.clone(), to.clone())], to, leaf)
    };

    let sources: Vec<PathBuf> = moves.iter().map(|(from, _)| from.clone()).collect();
    let read = match read_all(scope, &sources) {
        Ok(read) => read,
        Err(error) => return Ok(refused_rename(error)),
    };
    let scope_path = Path::new(&scope.path);
    for (from, to) in &moves {
        writer.guard().check(scope_path, from)?;
        writer.guard().check(scope_path, to)?;
    }

    // The addressed file's own `name:` follows it, for the two kinds that
    // declare one. Computed apart from what was read: the source rows must
    // hold the bytes that were on disk.
    let declares_name = matches!(file.kind, ConfigFileKind::Skill | ConfigFileKind::Agent);
    let mut frontmatter_renamed = false;
    let mut snapshot_ids = Vec::new();
    for (index, ((_, to), source)) in moves.iter().zip(&read).enumerate() {
        let content = if declares_name && source.path == addressed_from {
            let retitled = retitle_frontmatter(&source.content, leaf_of(&file.name), &new_leaf);
            frontmatter_renamed = retitled != source.content;
            retitled
        } else {
            source.content.clone()
        };
        let written = writer.write(&WriteConfigRequest {
            scope_path: scope.path.clone(),
            path: to.display().to_string(),
            content,
            expected_hash: None,
            reason: ConfigWriteReason::Create,
        });
        match written {
            Ok(result) if result.ok => snapshot_ids.extend(result.snapshot_id),
            Ok(_) => {
                return Ok(refused_rename(format!(
                    "{} could not be written, so the rename stopped. Nothing has been removed; {index} of {} files were copied.",
                    rel_path_of(scope, to),
                    moves.len()
                )));
            }
            Err(error) if index == 0 => return Err(error),
            Err(error) => {
                return Err(format!(
                    "{error} The rename stopped: nothing has been removed; {index} of {} files were copied.",
                    moves.len()
                ));
            }
        }
    }

    let removed = snapshot_then_remove(writer, scope, &read, ConfigWriteReason::Rename)?;
    snapshot_ids.extend(removed.iter().map(|row| row.snapshot_id));

    Ok(RenameConfigResult {
        ok: true,
        rel_path: Some(rel_path_of(scope, &addressed_to)),
        path: Some(addressed_to.display().to_string()),
        moved: moves
            .iter()
            .map(|(from, to)| MovedFile {
                from: from.display().to_string(),
                to: to.display().to_string(),
            })
            .collect(),
        snapshot_ids,
        frontmatter_renamed,
        error: None,
    })
}

/// Removes an entry, recording each file first. Each row is ordinary
/// per-file history, so undoing a delete is restoring a version.
pub fn delete(
    writer: &SnapshotWriter<'_>,
    scope: &ConfigScope,
    files: &[ConfigFile],
    file: &ConfigFile,
) -> Result<DeleteConfigResult, String> {
    let paths: Vec<PathBuf> = config_unit(files, file)
        .into_iter()
        .map(|member| normalize(Path::new(&member.path)))
        .collect();
    let read = match read_all(scope, &paths) {
        Ok(read) => read,
        Err(error) => {
            return Ok(DeleteConfigResult {
                ok: false,
                removed: Vec::new(),
                error: Some(error),
            });
        }
    };
    Ok(DeleteConfigResult {
        ok: true,
        removed: snapshot_then_remove(writer, scope, &read, ConfigWriteReason::Delete)?,
        error: None,
    })
}
