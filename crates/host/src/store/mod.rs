//! `floti.db` in Floti's data folder, which only the host opens.
//!
//! It keeps today's schema: the migrations are embedded from
//! `packages/core/drizzle` and recorded in today's `__helm_migrations` table,
//! so a database today's app migrated opens with nothing applied again.
//! It opens with today's pragmas (`packages/core/src/store/db.ts`).
//!
//! `fixtures/migrated-by-today.db` is a database today's app made: core's own
//! `migrate()` run through better-sqlite3, then one settings row and one
//! session row added. The tests open copies of it and never the file itself.

pub mod migrations;

#[cfg(test)]
mod tests;

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::Connection;

pub use migrations::{MIGRATIONS, Migration, MigrationOutcome};

use crate::{Error, Result};

/// The database's file name in the data folder.
pub const DB_FILE: &str = "floti.db";

/// How long a statement waits for another connection's write lock.
const BUSY_TIMEOUT: Duration = Duration::from_millis(5000);

/// The open store.
#[derive(Debug)]
pub struct Store {
    conn: Connection,
    file: PathBuf,
    migrations: MigrationOutcome,
}

impl Store {
    /// Opens `floti.db` in `data_dir`, creating the folder and the file when
    /// they are not there, and migrates it to today's schema.
    pub fn open(data_dir: &Path) -> Result<Self> {
        Self::open_with(data_dir, MIGRATIONS)
    }

    fn open_with(data_dir: &Path, set: &[Migration]) -> Result<Self> {
        std::fs::create_dir_all(data_dir)
            .map_err(|source| Error::path("create the data folder", data_dir, source))?;
        let file = data_dir.join(DB_FILE);
        let mut conn = Connection::open(&file)
            .map_err(|err| Error::path("open", &file, io::Error::other(err)))?;
        configure(&conn)?;
        let migrations = migrations::migrate(&mut conn, set)?;
        Ok(Self {
            conn,
            file,
            migrations,
        })
    }

    /// The database file.
    pub fn file(&self) -> &Path {
        &self.file
    }

    /// What opening it applied.
    pub fn migrations(&self) -> &MigrationOutcome {
        &self.migrations
    }

    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    pub fn connection_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }

    /// Closes the database, reporting a failure to finish writing it.
    pub fn close(self) -> Result<()> {
        self.conn
            .close()
            .map_err(|(_, err)| sql_error("close the store")(err))
    }
}

/// Today's pragmas. WAL lets a read go ahead while a write is in flight;
/// NORMAL syncs at checkpoints, where losing the last transaction to a power
/// cut costs one rescan.
fn configure(conn: &Connection) -> Result<()> {
    let mode: String = conn
        .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))
        .map_err(sql_error("set the store's journal mode"))?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(Error::io(
            "set the store's journal mode",
            io::Error::other(format!("SQLite kept journal mode {mode}")),
        ));
    }
    conn.pragma_update(None, "synchronous", "NORMAL")
        .and_then(|()| conn.pragma_update(None, "foreign_keys", "ON"))
        .and_then(|()| conn.busy_timeout(BUSY_TIMEOUT))
        .map_err(sql_error("set the store's pragmas"))
}

/// Turns a SQLite error into the host's error while doing `action`.
fn sql_error(action: impl Into<String>) -> impl FnOnce(rusqlite::Error) -> Error {
    let action = action.into();
    move |err| Error::io(action, io::Error::other(err))
}
