//! Profile rows in today's `profiles` table.
//!
//! A profile is edited and launched whole and never queried by its parts, so
//! its lists are JSON columns, and this is a straight mapping both ways.

use std::io;

use floti_protocol::channels::sessions::{Profile, ProfileDraft};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::server::records::{PROFILE_COLUMNS, profile_row};
use crate::{Error, Result};

/// "Now" in the store's timestamp format, as today's app writes it.
const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/// Pinned first in their order, then the rest by name without case. The
/// pin is null for an unpinned profile and SQLite sorts nulls first, so the
/// order is a computed key rather than the plain column.
pub fn list(conn: &Connection) -> Result<Vec<Profile>> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {PROFILE_COLUMNS} FROM profiles ORDER BY \
             CASE WHEN pinned_order IS NULL THEN 1 ELSE 0 END, pinned_order, \
             name COLLATE NOCASE"
        ))
        .map_err(sql("list the profiles"))?;
    statement
        .query_map([], profile_row)
        .and_then(Iterator::collect)
        .map_err(sql("list the profiles"))
}

/// Profile `id`, or `None` when it has been deleted.
pub fn read(conn: &Connection, id: u64) -> Result<Option<Profile>> {
    let Ok(id) = i64::try_from(id) else {
        return Ok(None);
    };
    conn.query_row(
        &format!("SELECT {PROFILE_COLUMNS} FROM profiles WHERE id = ?1"),
        [id],
        profile_row,
    )
    .optional()
    .map_err(sql("read a profile"))
}

/// The profile called `name`, compared without case the way a person types
/// it.
pub fn find_by_name(conn: &Connection, name: &str) -> Result<Option<Profile>> {
    conn.query_row(
        &format!("SELECT {PROFILE_COLUMNS} FROM profiles WHERE name = ?1 COLLATE NOCASE"),
        [name.trim()],
        profile_row,
    )
    .optional()
    .map_err(sql("find a profile by name"))
}

/// `base`, or the first of `base (2)`, `base (3)`, ... no profile has. The
/// suffix is parenthesised because these are read side by side in a list,
/// where `Acme (2)` reads as a copy and `Acme 2` as a second version.
pub fn unique_name(conn: &Connection, base: &str) -> Result<String> {
    let trimmed = base.trim();
    let root = if trimmed.is_empty() {
        "Profile"
    } else {
        trimmed
    };
    if find_by_name(conn, root)?.is_none() {
        return Ok(root.to_owned());
    }
    for n in 2u64.. {
        let candidate = format!("{root} ({n})");
        if find_by_name(conn, &candidate)?.is_none() {
            return Ok(candidate);
        }
    }
    unreachable!("an unbounded range always finds a free name")
}

/// Adds a profile. A name another profile has is refused by the table's
/// unique index.
pub fn create(conn: &Connection, draft: &ProfileDraft) -> Result<Profile> {
    let values = Values::of(draft);
    conn.query_row(
        &format!(
            "INSERT INTO profiles (name, root, overlays, access, model, effort, \
             permission_mode, agent, mcp, opening_prompt, pinned_order) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) \
             RETURNING {PROFILE_COLUMNS}"
        ),
        params![
            values.name,
            draft.root,
            values.overlays,
            values.access,
            draft.model,
            values.effort,
            values.permission_mode,
            draft.agent,
            values.mcp,
            draft.opening_prompt,
            draft.pinned_order,
        ],
        profile_row,
    )
    .map_err(sql("save a profile"))
}

/// Rewrites profile `id` from `draft` and stamps `updated_at`, or `None`
/// when it has been deleted in the meantime.
pub fn update(conn: &Connection, id: u64, draft: &ProfileDraft) -> Result<Option<Profile>> {
    let Ok(id) = i64::try_from(id) else {
        return Ok(None);
    };
    let values = Values::of(draft);
    conn.query_row(
        &format!(
            "UPDATE profiles SET name = ?1, root = ?2, overlays = ?3, access = ?4, \
             model = ?5, effort = ?6, permission_mode = ?7, agent = ?8, mcp = ?9, \
             opening_prompt = ?10, pinned_order = ?11, updated_at = ({NOW}) \
             WHERE id = ?12 RETURNING {PROFILE_COLUMNS}"
        ),
        params![
            values.name,
            draft.root,
            values.overlays,
            values.access,
            draft.model,
            values.effort,
            values.permission_mode,
            draft.agent,
            values.mcp,
            draft.opening_prompt,
            draft.pinned_order,
            id,
        ],
        profile_row,
    )
    .optional()
    .map_err(sql("save a profile"))
}

/// Removes profile `id`; whether there was one to remove.
pub fn delete(conn: &Connection, id: u64) -> Result<bool> {
    let Ok(id) = i64::try_from(id) else {
        return Ok(false);
    };
    conn.execute("DELETE FROM profiles WHERE id = ?1", [id])
        .map(|removed| removed > 0)
        .map_err(sql("delete a profile"))
}

/// Pins `ids` in that order and unpins every other profile, in one
/// transaction: a half-applied reorder is an order nobody asked for.
pub fn set_pinned(conn: &mut Connection, ids: &[u64]) -> Result<()> {
    let transaction = conn.transaction().map_err(sql("pin profiles"))?;
    transaction
        .execute("UPDATE profiles SET pinned_order = NULL", [])
        .map_err(sql("pin profiles"))?;
    for (order, id) in ids.iter().enumerate() {
        let Ok(id) = i64::try_from(*id) else {
            continue;
        };
        transaction
            .execute(
                "UPDATE profiles SET pinned_order = ?1 WHERE id = ?2",
                params![order as i64, id],
            )
            .map_err(sql("pin profiles"))?;
    }
    transaction.commit().map_err(sql("pin profiles"))
}

/// A draft's values as the columns hold them.
struct Values {
    name: String,
    overlays: String,
    access: String,
    mcp: String,
    effort: Option<String>,
    permission_mode: Option<String>,
}

impl Values {
    fn of(draft: &ProfileDraft) -> Self {
        let json = |list: &[String]| serde_json::to_string(list).unwrap_or_else(|_| "[]".into());
        Self {
            name: draft.name.trim().to_owned(),
            overlays: json(&draft.overlays),
            access: json(&draft.access),
            mcp: json(&draft.mcp),
            effort: draft.effort.map(protocol_name),
            permission_mode: draft.permission_mode.map(protocol_name),
        }
    }
}

/// How an enum is stored: by its protocol name, such as `acceptEdits`.
fn protocol_name<T: Serialize>(value: T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn sql(action: &'static str) -> impl Fn(rusqlite::Error) -> Error {
    move |err| Error::io(action, io::Error::other(err))
}
