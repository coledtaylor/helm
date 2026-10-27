//! The store against today's app: its journal, its latest drizzle snapshot,
//! and a database it migrated.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde_json::Value;

use super::migrations::{JOURNAL_TABLE, recorded_tags};
use super::*;
use crate::testkit::TestDirs;

fn drizzle_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/core/drizzle")
}

fn read_json(path: &Path) -> Value {
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|err| panic!("read {}: {err}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("parse {}: {err}", path.display()))
}

/// Today's journal: (idx, tag) in order.
fn journal() -> Vec<(u64, String)> {
    let journal = read_json(&drizzle_dir().join("meta").join("_journal.json"));
    journal["entries"]
        .as_array()
        .expect("the journal has entries")
        .iter()
        .map(|entry| {
            (
                entry["idx"].as_u64().expect("an entry has an idx"),
                entry["tag"]
                    .as_str()
                    .expect("an entry has a tag")
                    .to_owned(),
            )
        })
        .collect()
}

fn carried() -> Vec<&'static str> {
    MIGRATIONS.iter().map(|migration| migration.tag).collect()
}

/// Every way the host's list differs from the journal, one sentence each.
fn journal_differences(journal: &[String], carried: &[&str]) -> Vec<String> {
    let mut problems: Vec<String> = journal
        .iter()
        .filter(|tag| !carried.contains(&tag.as_str()))
        .map(|tag| {
            format!(
                "today's app has migration {tag} and the host does not carry it: add it to MIGRATIONS in crates/host/src/store/migrations.rs"
            )
        })
        .collect();
    problems.extend(
        carried
            .iter()
            .filter(|tag| !journal.iter().any(|known| known == *tag))
            .map(|tag| format!("the host carries {tag}, which today's journal does not list")),
    );
    if problems.is_empty() && journal != carried {
        problems.push(format!(
            "the host applies {carried:?}, out of today's journal order {journal:?}"
        ));
    }
    problems
}

fn copy_of_todays_database(dirs: &TestDirs) -> PathBuf {
    let fixture =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("src/store/fixtures/migrated-by-today.db");
    let file = dirs.data.join(DB_FILE);
    std::fs::copy(&fixture, &file).expect("copy today's database");
    file
}

/// Every schema object but SQLite's own, as SQLite stored its SQL.
fn schema(conn: &Connection) -> Vec<(String, String, String, Option<String>)> {
    let mut statement = conn
        .prepare(
            "SELECT type, name, tbl_name, sql FROM sqlite_master
             WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .unwrap();
    statement
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn journal_rows(conn: &Connection) -> Vec<(String, String)> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT tag, applied_at FROM {JOURNAL_TABLE} ORDER BY rowid"
        ))
        .unwrap();
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn pragma(conn: &Connection, name: &str) -> String {
    conn.query_row(&format!("PRAGMA {name}"), [], |row| {
        row.get::<_, rusqlite::types::Value>(0)
    })
    .map(|value| match value {
        rusqlite::types::Value::Integer(n) => n.to_string(),
        rusqlite::types::Value::Text(text) => text,
        other => format!("{other:?}"),
    })
    .unwrap()
}

#[test]
fn the_host_carries_every_migration_in_todays_journal_in_journal_order() {
    let tags: Vec<String> = journal().into_iter().map(|(_, tag)| tag).collect();
    let problems = journal_differences(&tags, &carried());
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

#[test]
fn a_migration_the_host_does_not_carry_is_named() {
    let mut tags: Vec<String> = carried().into_iter().map(str::to_owned).collect();
    tags.push("0016_brand_new_change".to_owned());
    assert_eq!(
        journal_differences(&tags, &carried()),
        [
            "today's app has migration 0016_brand_new_change and the host does not carry it: add it to MIGRATIONS in crates/host/src/store/migrations.rs"
        ]
    );

    let mut reordered = carried();
    reordered.swap(0, 1);
    let tags: Vec<String> = carried().into_iter().map(str::to_owned).collect();
    let problems = journal_differences(&tags, &reordered);
    assert_eq!(problems.len(), 1);
    assert!(problems[0].contains("out of today's journal order"));
}

#[test]
fn statements_are_split_the_way_todays_app_splits_them() {
    let migration = Migration {
        tag: "split",
        sql: "CREATE TABLE a (x);--> statement-breakpoint\n  \n--> statement-breakpoint\n\nCREATE INDEX b ON a (x);\n",
    };
    assert_eq!(
        migration.statements().collect::<Vec<_>>(),
        ["CREATE TABLE a (x);", "CREATE INDEX b ON a (x);"]
    );
}

#[test]
fn an_empty_data_folder_gets_floti_db_with_every_migration_in_journal_order() {
    let dirs = TestDirs::new();
    let data = dirs.data.join("new data folder");

    let store = Store::open(&data).unwrap();

    assert_eq!(store.file(), data.join("floti.db"));
    assert!(data.join("floti.db").is_file());
    assert_eq!(store.migrations().applied, carried());
    assert!(store.migrations().already_applied.is_empty());

    let rows = journal_rows(store.connection());
    assert_eq!(
        rows.iter().map(|(tag, _)| tag.as_str()).collect::<Vec<_>>(),
        carried()
    );
    for (tag, applied_at) in &rows {
        // `Date.prototype.toISOString`: 2026-10-27T09:00:00.000Z
        let bytes = applied_at.as_bytes();
        assert!(
            applied_at.len() == 24
                && bytes[4] == b'-'
                && bytes[10] == b'T'
                && bytes[19] == b'.'
                && applied_at.ends_with('Z'),
            "{tag} was recorded at {applied_at}"
        );
    }

    let conn = store.connection();
    assert_eq!(pragma(conn, "journal_mode"), "wal");
    assert_eq!(pragma(conn, "synchronous"), "1");
    assert_eq!(pragma(conn, "foreign_keys"), "1");
    assert_eq!(pragma(conn, "busy_timeout"), "5000");
    store.close().unwrap();
}

#[derive(Debug, PartialEq, Eq)]
struct Column {
    sql_type: String,
    not_null: bool,
    primary_key: bool,
}

#[derive(Debug, PartialEq, Eq)]
struct Index {
    columns: Vec<String>,
    unique: bool,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct Table {
    columns: BTreeMap<String, Column>,
    indexes: BTreeMap<String, Index>,
}

/// The tables drizzle records for the last migration in today's journal.
fn latest_snapshot() -> BTreeMap<String, Table> {
    let (idx, _) = journal().pop().expect("the journal has a migration");
    let snapshot = read_json(
        &drizzle_dir()
            .join("meta")
            .join(format!("{idx:04}_snapshot.json")),
    );
    let tables = snapshot["tables"]
        .as_object()
        .expect("the snapshot has tables");
    tables
        .iter()
        .map(|(name, table)| {
            // A key over several columns is recorded on the table, not on
            // each column.
            let composite_key: BTreeSet<&str> = table["compositePrimaryKeys"]
                .as_object()
                .unwrap()
                .values()
                .flat_map(|key| key["columns"].as_array().unwrap())
                .map(|column| column.as_str().unwrap())
                .collect();
            let columns = table["columns"]
                .as_object()
                .unwrap()
                .values()
                .map(|column| {
                    let column_name = column["name"].as_str().unwrap();
                    (
                        column_name.to_owned(),
                        Column {
                            sql_type: column["type"].as_str().unwrap().to_lowercase(),
                            not_null: column["notNull"].as_bool().unwrap(),
                            primary_key: column["primaryKey"].as_bool().unwrap()
                                || composite_key.contains(column_name),
                        },
                    )
                })
                .collect();
            let indexes = table["indexes"]
                .as_object()
                .unwrap()
                .values()
                .map(|index| {
                    (
                        index["name"].as_str().unwrap().to_owned(),
                        Index {
                            columns: index["columns"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .map(|column| column.as_str().unwrap().to_owned())
                                .collect(),
                            unique: index["isUnique"].as_bool().unwrap(),
                        },
                    )
                })
                .collect();
            (name.clone(), Table { columns, indexes })
        })
        .collect()
}

/// The same tables, read from a database. Only ordinary tables count:
/// drizzle does not model the FTS table and its shadow tables, or the
/// migration journal.
fn database_tables(
    conn: &Connection,
    names: impl IntoIterator<Item = String>,
) -> BTreeMap<String, Table> {
    names
        .into_iter()
        .map(|name| {
            let mut table = Table::default();
            let mut info = conn
                .prepare(&format!("PRAGMA table_info(`{name}`)"))
                .unwrap();
            let columns = info
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(1)?,
                        Column {
                            sql_type: row.get::<_, String>(2)?.to_lowercase(),
                            not_null: row.get::<_, i64>(3)? != 0,
                            primary_key: row.get::<_, i64>(5)? != 0,
                        },
                    ))
                })
                .unwrap();
            for column in columns {
                let (column_name, column) = column.unwrap();
                table.columns.insert(column_name, column);
            }
            // origin 'c' is an index a CREATE INDEX made; primary keys and
            // UNIQUE constraints are drizzle's columns, not its indexes.
            let mut list = conn
                .prepare(&format!("PRAGMA index_list(`{name}`)"))
                .unwrap();
            let indexes: Vec<(String, bool)> = list
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)? != 0,
                        row.get::<_, String>(3)?,
                    ))
                })
                .unwrap()
                .map(Result::unwrap)
                .filter(|(_, _, origin)| origin == "c")
                .map(|(index, unique, _)| (index, unique))
                .collect();
            for (index, unique) in indexes {
                let mut info = conn
                    .prepare(&format!("PRAGMA index_info(`{index}`)"))
                    .unwrap();
                let columns = info
                    .query_map([], |row| row.get::<_, String>(2))
                    .unwrap()
                    .collect::<rusqlite::Result<_>>()
                    .unwrap();
                table.indexes.insert(index, Index { columns, unique });
            }
            (name, table)
        })
        .collect()
}

#[test]
fn a_new_database_has_the_tables_columns_and_indexes_of_todays_latest_snapshot() {
    let dirs = TestDirs::new();
    let store = Store::open(&dirs.data).unwrap();
    let expected = latest_snapshot();

    let mut statement = store
        .connection()
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table'
             AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'transcript_fts%'
             AND name <> ?1",
        )
        .unwrap();
    let names: BTreeSet<String> = statement
        .query_map([JOURNAL_TABLE], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        names,
        expected.keys().cloned().collect::<BTreeSet<_>>(),
        "the host's tables differ from today's"
    );

    let actual = database_tables(store.connection(), names);
    for (name, table) in &expected {
        assert_eq!(&actual[name], table, "table {name} differs from today's");
    }
}

#[test]
fn a_new_database_has_exactly_the_schema_todays_app_makes() {
    let dirs = TestDirs::new();
    let fresh = Store::open(&dirs.folder("fresh")).unwrap();
    copy_of_todays_database(&dirs);
    let today = Store::open(&dirs.data).unwrap();

    // Includes what drizzle does not model: the FTS table, its shadow tables
    // and the migration journal.
    let names: Vec<String> = schema(today.connection())
        .into_iter()
        .map(|(_, name, _, _)| name)
        .collect();
    assert!(
        names.iter().any(|name| name == "transcript_fts"),
        "{names:?}"
    );
    assert_eq!(schema(fresh.connection()), schema(today.connection()));
}

#[test]
fn a_database_todays_app_migrated_opens_with_nothing_applied_again_and_its_rows_intact() {
    let dirs = TestDirs::new();
    let file = copy_of_todays_database(&dirs);
    let before = {
        let conn = Connection::open(&file).unwrap();
        journal_rows(&conn)
    };
    assert!(!before.is_empty(), "the fixture records today's migrations");

    let store = Store::open(&dirs.data).unwrap();

    // Today's migrations are all recorded, so only a migration added since
    // the fixture was made may be applied, and none of today's again.
    let recorded: Vec<&str> = before.iter().map(|(tag, _)| tag.as_str()).collect();
    let expected_new: Vec<&str> = carried()
        .into_iter()
        .filter(|tag| !recorded.contains(tag))
        .collect();
    assert_eq!(store.migrations().applied, expected_new);
    assert_eq!(store.migrations().already_applied, recorded);

    let after = journal_rows(store.connection());
    assert_eq!(
        &after[..before.len()],
        &before[..],
        "recorded times changed"
    );

    let conn = store.connection();
    let theme: String = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = 'theme'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(theme, "\"dark\"");
    let session: (String, String, String, String) = conn
        .query_row(
            "SELECT name, cwd, status, started_at FROM sessions",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(
        session,
        (
            "fixture session".to_owned(),
            "C:/fixture project".to_owned(),
            "exited".to_owned(),
            "2026-10-01T09:00:00.000Z".to_owned()
        )
    );
}

#[test]
fn a_database_missing_the_latest_migrations_gets_only_those() {
    let dirs = TestDirs::new();
    let older = MIGRATIONS.len() - 3;
    Store::open_with(&dirs.data, &MIGRATIONS[..older])
        .unwrap()
        .close()
        .unwrap();

    let store = Store::open(&dirs.data).unwrap();

    assert_eq!(store.migrations().applied, carried()[older..]);
    assert_eq!(store.migrations().already_applied, carried()[..older]);
    assert_eq!(
        recorded_tags(store.connection()).unwrap().len(),
        MIGRATIONS.len()
    );

    let fresh = Store::open(&dirs.folder("fresh")).unwrap();
    assert_eq!(schema(store.connection()), schema(fresh.connection()));
}

#[test]
fn opening_again_applies_nothing() {
    let dirs = TestDirs::new();
    Store::open(&dirs.data).unwrap().close().unwrap();
    let store = Store::open(&dirs.data).unwrap();
    assert!(store.migrations().applied.is_empty());
    assert_eq!(store.migrations().already_applied, carried());
}

#[test]
fn each_migration_is_applied_in_its_own_transaction() {
    static SET: &[Migration] = &[
        Migration {
            tag: "0000_first",
            sql: "CREATE TABLE first (x INTEGER);",
        },
        Migration {
            tag: "0001_broken",
            sql: "CREATE TABLE second (x INTEGER);--> statement-breakpoint\nCREATE TABLE first (x INTEGER);",
        },
        Migration {
            tag: "0002_never_reached",
            sql: "CREATE TABLE third (x INTEGER);",
        },
    ];
    let dirs = TestDirs::new();

    let err = Store::open_with(&dirs.data, SET).unwrap_err();
    assert!(
        err.to_string()
            .starts_with("could not apply migration 0001_broken: "),
        "{err}"
    );

    let conn = Connection::open(dirs.data.join(DB_FILE)).unwrap();
    let tables: Vec<String> = schema(&conn)
        .into_iter()
        .filter(|(kind, ..)| kind == "table")
        .map(|(_, name, ..)| name)
        .collect();
    assert_eq!(tables, [JOURNAL_TABLE, "first"]);
    assert_eq!(recorded_tags(&conn).unwrap(), ["0000_first"]);
}
