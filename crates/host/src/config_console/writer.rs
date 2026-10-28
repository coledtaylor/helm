//! The one writer every change to a config file goes through.
//!
//! Three rules, in this order:
//!
//! 1. Nothing is written outside configuration ([`WriteGuard`]). The console
//!    addresses files by absolute path, so the guard is the floor under any
//!    request.
//! 2. Nothing is written when the bytes on disk are not the bytes the editor
//!    was based on. That is an outside edit, and the write answers it as a
//!    conflict rather than replacing it.
//! 3. Nothing is written until the bytes it replaces are in floti.db. A
//!    snapshot that cannot be taken aborts the write with a sentence, and the
//!    file is left as it was.

use std::path::Path;

use floti_protocol::channels::workspace::{
    ConfigWriteReason, WriteConfigRequest, WriteConfigResult, WriteConflict,
};
use rusqlite::Connection;

use super::files::{PathGuard, hash_content, normalize, read_file, snapshot_key};
use super::snapshots::{self, NewSnapshot};

/// Writes config files, each after a snapshot of what it replaces.
pub struct SnapshotWriter<'a> {
    conn: &'a Connection,
    guard: &'a dyn PathGuard,
}

impl<'a> SnapshotWriter<'a> {
    pub fn new(conn: &'a Connection, guard: &'a dyn PathGuard) -> Self {
        Self { conn, guard }
    }

    pub fn guard(&self) -> &dyn PathGuard {
        self.guard
    }

    pub fn connection(&self) -> &Connection {
        self.conn
    }

    /// Takes a snapshot of `content`, the bytes `path` holds now, under
    /// `scope`. The id, or the sentence a change aborts with.
    pub fn snapshot(
        &self,
        scope: &Path,
        path: &Path,
        content: &str,
        content_hash: &str,
        reason: ConfigWriteReason,
    ) -> Result<u64, String> {
        snapshots::insert(
            self.conn,
            &NewSnapshot {
                scope_path: &normalize(scope).display().to_string(),
                file_path: &snapshot_key(scope, path),
                content,
                content_hash,
                reason,
            },
        )
    }

    /// Replaces a file's bytes. A conflict, a binary file and content that is
    /// already there are answers; a path the guard refuses, a snapshot that
    /// cannot be taken and a disk that refuses the write are the sentence the
    /// client is told.
    pub fn write(&self, request: &WriteConfigRequest) -> Result<WriteConfigResult, String> {
        let scope = Path::new(&request.scope_path);
        let path = Path::new(&request.path);
        self.guard.check(scope, path)?;
        let absolute = normalize(path);
        let current = read_file(&absolute);

        if current.binary {
            return Ok(WriteConfigResult {
                ok: false,
                file: current,
                snapshot_id: None,
                unchanged: false,
                conflict: None,
                error: Some("That file is not text, so Floti will not rewrite it.".to_owned()),
            });
        }

        // No expected hash means "I believe this file does not exist", so a
        // file that has appeared since is a conflict too.
        let disagrees = match &request.expected_hash {
            None => current.exists,
            Some(expected) => &current.hash != expected,
        };
        if disagrees {
            return Ok(WriteConfigResult {
                ok: false,
                conflict: Some(WriteConflict {
                    on_disk_hash: current.hash.clone(),
                    on_disk_content: current.content.clone(),
                    mtime_ms: current.mtime_ms,
                }),
                file: current,
                snapshot_id: None,
                unchanged: false,
                error: None,
            });
        }

        if current.exists && current.content == request.content {
            // Nothing is written, so nothing needs a snapshot.
            return Ok(WriteConfigResult {
                ok: true,
                file: current,
                snapshot_id: None,
                unchanged: true,
                conflict: None,
                error: None,
            });
        }

        let (before, before_hash, reason) = if current.exists {
            (
                current.content.as_str(),
                current.hash.clone(),
                request.reason,
            )
        } else {
            ("", hash_content(""), ConfigWriteReason::Create)
        };
        let snapshot_id = self.snapshot(scope, &absolute, before, &before_hash, reason)?;

        if let Some(parent) = absolute.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| format!("Floti could not create {}: {err}", parent.display()))?;
        }
        std::fs::write(&absolute, request.content.as_bytes())
            .map_err(|err| format!("Floti could not write {}: {err}", absolute.display()))?;

        Ok(WriteConfigResult {
            ok: true,
            file: read_file(&absolute),
            snapshot_id: Some(snapshot_id),
            unchanged: false,
            conflict: None,
            error: None,
        })
    }

    /// Puts a snapshot's bytes back at `path`, after a snapshot of what is
    /// there. A version that records a file that did not exist removes the
    /// file rather than leaving an empty one: an empty `settings.json` is a
    /// parse error, an absent one a layer the agent skips.
    pub fn restore(&self, id: u64, path: &Path) -> Result<WriteConfigResult, String> {
        let Some(snapshot) = snapshots::read(self.conn, id)? else {
            return Ok(WriteConfigResult {
                ok: false,
                file: read_file(path),
                snapshot_id: None,
                unchanged: false,
                conflict: None,
                error: Some("That version is no longer in the snapshot history.".to_owned()),
            });
        };
        let scope = Path::new(&snapshot.meta.scope_path);
        self.guard.check(scope, path)?;
        let absolute = normalize(path);
        let current = read_file(&absolute);

        if snapshot.meta.reason == ConfigWriteReason::Create {
            if !current.exists {
                return Ok(WriteConfigResult {
                    ok: true,
                    file: current,
                    snapshot_id: None,
                    unchanged: true,
                    conflict: None,
                    error: None,
                });
            }
            if current.binary {
                return Err(format!(
                    "{} is not text now, so Floti cannot record it before removing it, and leaves it as it is.",
                    absolute.display()
                ));
            }
            let snapshot_id = self.snapshot(
                scope,
                &absolute,
                &current.content,
                &current.hash,
                ConfigWriteReason::Restore,
            )?;
            std::fs::remove_file(&absolute)
                .map_err(|err| format!("Floti could not remove {}: {err}", absolute.display()))?;
            return Ok(WriteConfigResult {
                ok: true,
                file: read_file(&absolute),
                snapshot_id: Some(snapshot_id),
                unchanged: false,
                conflict: None,
                error: None,
            });
        }

        // The file as it is now is what the user is choosing to discard, so
        // it is the expected hash.
        self.write(&WriteConfigRequest {
            scope_path: snapshot.meta.scope_path.clone(),
            path: absolute.display().to_string(),
            content: snapshot.content,
            expected_hash: current.exists.then_some(current.hash),
            reason: ConfigWriteReason::Restore,
        })
    }
}
