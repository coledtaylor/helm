//! Today's migrations, embedded from `packages/core/drizzle` at compile time,
//! and the migrator that applies them the way `packages/core/src/store/migrate.ts`
//! does.
//!
//! The `.sql` files stay the one source: [`MIGRATIONS`] names each journal
//! tag once and `include_str!` reads its file, so a tag here with no file
//! fails the build, and a test fails naming any tag in
//! `drizzle/meta/_journal.json` that is missing here. A new migration in
//! today's app is carried by adding its tag to the end of the list.

use rusqlite::{Connection, params};

use super::sql_error;
use crate::Result;

/// The table that records which migrations a database has, shared with
/// today's app so a database it migrated opens with nothing applied again.
pub const JOURNAL_TABLE: &str = "__helm_migrations";

/// The marker drizzle-kit puts between statements, instead of a bare `;`
/// that a trigger body or a default expression may contain.
const STATEMENT_BREAKPOINT: &str = "--> statement-breakpoint";

/// One migration: its journal tag and its SQL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Migration {
    pub tag: &'static str,
    pub sql: &'static str,
}

impl Migration {
    /// The statements in order, split as `scripts/embed-migrations.mjs` splits
    /// them: on the breakpoint marker, trimmed, empty ones dropped.
    pub fn statements(&self) -> impl Iterator<Item = &'static str> {
        self.sql
            .split(STATEMENT_BREAKPOINT)
            .map(str::trim)
            .filter(|statement| !statement.is_empty())
    }
}

macro_rules! drizzle_migrations {
    ($($tag:literal),* $(,)?) => {
        &[$(
            Migration {
                tag: $tag,
                sql: include_str!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../../packages/core/drizzle/",
                    $tag,
                    ".sql"
                )),
            },
        )*]
    };
}

/// Every migration today's app has, in journal order.
pub static MIGRATIONS: &[Migration] = drizzle_migrations![
    "0000_purple_silver_fox",
    "0001_calm_cloak",
    "0002_unknown_namorita",
    "0003_smart_nightmare",
    "0004_tan_naoko",
    "0005_puzzling_pete_wisdom",
    "0006_perfect_pestilence",
    "0007_pink_tinkerer",
    "0008_lyrical_yellow_claw",
    "0009_wet_ozymandias",
    "0010_shocking_starbolt",
    "0011_brave_senator_kelly",
    "0012_hesitant_richard_fisk",
    "0013_cooing_roxanne_simpson",
    "0014_cultured_shinobi_shaw",
    "0015_motionless_prism",
];

/// What opening a database applied.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MigrationOutcome {
    /// Tags applied now, in order.
    pub applied: Vec<&'static str>,
    /// Tags the database already had.
    pub already_applied: Vec<&'static str>,
}

/// Applies each migration in `set` the database has not recorded, in order,
/// each in its own transaction with its journal row, so a failure leaves the
/// database at the last complete migration rather than part way through one.
pub fn migrate(conn: &mut Connection, set: &[Migration]) -> Result<MigrationOutcome> {
    // Spelled as migrate.ts spells it, so SQLite stores the same text and a
    // database either one made has the same schema.
    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS {JOURNAL_TABLE} (\n      tag TEXT PRIMARY KEY,\n      applied_at TEXT NOT NULL\n    )"
    ))
    .map_err(sql_error("create the migration journal"))?;

    let done = recorded_tags(conn)?;
    let mut outcome = MigrationOutcome::default();

    for migration in set {
        if done.iter().any(|tag| tag == migration.tag) {
            outcome.already_applied.push(migration.tag);
            continue;
        }
        apply(conn, migration).map_err(sql_error(format!("apply migration {}", migration.tag)))?;
        outcome.applied.push(migration.tag);
    }

    Ok(outcome)
}

/// The tags the database has recorded.
pub fn recorded_tags(conn: &Connection) -> Result<Vec<String>> {
    let read = || -> rusqlite::Result<Vec<String>> {
        let mut statement = conn.prepare(&format!("SELECT tag FROM {JOURNAL_TABLE}"))?;
        statement
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()
    };
    read().map_err(sql_error("read the migration journal"))
}

fn apply(conn: &mut Connection, migration: &Migration) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    for statement in migration.statements() {
        tx.execute_batch(statement)?;
    }
    // The time as `Date.prototype.toISOString` writes it, as today's app
    // records it.
    tx.execute(
        &format!(
            "INSERT INTO {JOURNAL_TABLE} (tag, applied_at)
             VALUES (?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
        ),
        params![migration.tag],
    )?;
    tx.commit()
}
