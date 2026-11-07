//! What a child's row says, read and written: the links a start records, the
//! children of a session by row and by conversation, and the sessions a
//! lifetime rule ends. A row is an agent-started child when it has a
//! `child_name`; a session a person started never has one, so it counts
//! toward no limit.

use std::io;

use floti_protocol::channels::common::PermissionMode;
use floti_protocol::channels::sessions::Profile;
use rusqlite::{OptionalExtension, Row, params};

use crate::roles::RoleClass;
use crate::server::records::{self, PROFILE_COLUMNS, profile_row};
use crate::session::SessionId;
use crate::store::Store;
use crate::{Error, Result};

/// How far up a chain of parents a depth is counted: past this the chain is a
/// loop, which no start makes, and is read as that deep.
const MAX_DEPTH: u32 = 32;

/// What a start needs to know about the session making it.
pub(super) struct ParentFacts {
    /// The folder it runs in.
    pub cwd: String,
    /// The mode it runs in; none counts as manual.
    pub permission_mode: Option<PermissionMode>,
    /// The conversation it is in now, when its row knows.
    pub conversation_id: Option<String>,
    /// Steps between it and the person's session at the top of its chain: 0
    /// for a person's own session.
    pub depth: u32,
    /// Whether it may start children. A person's session always may.
    pub can_start: bool,
    /// How its own parent calls it, when it is a child.
    pub child_name: Option<String>,
    /// How many starts beyond the starts setting it was allowed.
    pub extra_starts: u32,
}

pub(super) fn parent_facts(store: &Store, id: SessionId) -> Result<ParentFacts> {
    let found = store
        .connection()
        .query_row(
            "SELECT cwd, permission_mode, coalesce(last_claude_session_id, claude_session_id), \
             child_name, can_start, extra_starts FROM sessions WHERE id = ?1",
            [id.0],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, bool>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            },
        )
        .optional()
        .map_err(sql("read the session that is starting an agent"))?;
    let Some((cwd, mode, conversation_id, child_name, can_start, extra_starts)) = found else {
        return Err(Error::Refused(
            "Your session is not in this host's record.".to_owned(),
        ));
    };
    Ok(ParentFacts {
        cwd,
        permission_mode: mode.as_deref().and_then(records::permission_mode_from_name),
        conversation_id,
        depth: depth_of(store, id)?,
        can_start: child_name.is_none() || can_start,
        child_name,
        extra_starts: u32::try_from(extra_starts).unwrap_or(0),
    })
}

/// Steps between session `id` and the top of its chain of parents.
fn depth_of(store: &Store, id: SessionId) -> Result<u32> {
    let mut depth = 0;
    let mut at = id.0;
    while depth < MAX_DEPTH {
        let parent: Option<i64> = store
            .connection()
            .query_row(
                "SELECT parent_session_id FROM sessions WHERE id = ?1 AND child_name IS NOT NULL",
                [at],
                |row| row.get(0),
            )
            .optional()
            .map(Option::flatten)
            .map_err(sql("read a session's depth"))?;
        match parent {
            Some(parent) => {
                depth += 1;
                at = parent;
            }
            None => break,
        }
    }
    // A child whose parent's row is gone is still a child: its depth counts
    // its own step.
    if depth == 0 && is_child(store, id)? {
        depth = 1;
    }
    Ok(depth)
}

fn is_child(store: &Store, id: SessionId) -> Result<bool> {
    store
        .connection()
        .query_row(
            "SELECT child_name IS NOT NULL FROM sessions WHERE id = ?1",
            [id.0],
            |row| row.get(0),
        )
        .optional()
        .map(|found| found.unwrap_or(false))
        .map_err(sql("read a session's depth"))
}

/// One child's row.
pub(super) struct ChildRow {
    pub id: SessionId,
    pub name: String,
    pub role: Option<String>,
    pub backend: String,
    pub cwd: String,
    pub branch: Option<String>,
    pub started_at: String,
    pub outlive: bool,
    pub can_start: bool,
    /// Whether the row says it is running.
    pub running: bool,
    /// The resource class of the role it was started in.
    pub class: RoleClass,
    /// Whether it works in a worktree Floti made for it.
    pub worktree: bool,
    /// The conversation it is in now, when its row knows: what a resume
    /// reopens.
    pub conversation_id: Option<String>,
    /// The mode it ran in.
    pub permission_mode: Option<PermissionMode>,
    /// The profile it ran under.
    pub profile_id: Option<i64>,
}

const CHILD_COLUMNS: &str = "id, child_name, role, backend, cwd, branch, started_at, outlive, \
     can_start, status, child_class, child_worktree, \
     coalesce(last_claude_session_id, claude_session_id), permission_mode, profile_id";

fn child_row(row: &Row<'_>) -> rusqlite::Result<ChildRow> {
    let status: String = row.get(9)?;
    Ok(ChildRow {
        id: SessionId(row.get(0)?),
        name: row.get(1)?,
        role: row.get(2)?,
        backend: row
            .get::<_, Option<String>>(3)?
            .filter(|backend| !backend.trim().is_empty())
            .unwrap_or_default(),
        cwd: row.get(4)?,
        branch: row.get(5)?,
        started_at: row.get(6)?,
        outlive: row.get(7)?,
        can_start: row.get(8)?,
        running: status == "running",
        class: row
            .get::<_, Option<String>>(10)?
            .map_or(RoleClass::Light, |class| RoleClass::from_word(&class)),
        worktree: row.get(11)?,
        conversation_id: row
            .get::<_, Option<String>>(12)?
            .filter(|id| !id.trim().is_empty()),
        permission_mode: row
            .get::<_, Option<String>>(13)?
            .as_deref()
            .and_then(records::permission_mode_from_name),
        profile_id: row.get(14)?,
    })
}

/// Every child `parent` has started, running or not, oldest first: the rows
/// that name its row and, when its conversation is known, the rows that name
/// that conversation, which are the ones an earlier session in it started.
pub(super) fn children_of(
    store: &Store,
    parent: SessionId,
    conversation: Option<&str>,
) -> Result<Vec<ChildRow>> {
    let mut select = store
        .connection()
        .prepare(&format!(
            "SELECT {CHILD_COLUMNS} FROM sessions WHERE child_name IS NOT NULL \
             AND (parent_session_id = ?1 \
                  OR (?2 IS NOT NULL AND parent_conversation_id = ?2)) \
             ORDER BY id"
        ))
        .map_err(sql("read an agent's children"))?;
    select
        .query_map(params![parent.0, conversation], child_row)
        .and_then(Iterator::collect::<rusqlite::Result<Vec<_>>>)
        .map_err(sql("read an agent's children"))
}

/// Every agent-started session the rows say is running.
pub(super) fn agent_sessions_running(store: &Store) -> Result<Vec<SessionId>> {
    let mut select = store
        .connection()
        .prepare("SELECT id FROM sessions WHERE child_name IS NOT NULL AND status = 'running'")
        .map_err(sql("read the agent sessions running"))?;
    select
        .query_map([], |row| row.get(0).map(SessionId))
        .and_then(Iterator::collect::<rusqlite::Result<Vec<_>>>)
        .map_err(sql("read the agent sessions running"))
}

/// A running agent-started session whose role is heavy, and who started it.
pub(super) struct HeavyHolder {
    pub id: SessionId,
    pub name: String,
    /// The session that started it, by its agent name when it is one, else
    /// its session name.
    pub started_by: String,
}

/// Every agent-started session the rows say is running whose role is heavy,
/// oldest first. Sessions a person starts have no class, so hold no slot.
pub(super) fn heavy_running(store: &Store) -> Result<Vec<HeavyHolder>> {
    let mut select = store
        .connection()
        .prepare(
            "SELECT s.id, s.child_name, COALESCE(p.child_name, p.name, 'a session') \
             FROM sessions s LEFT JOIN sessions p ON p.id = s.parent_session_id \
             WHERE s.child_name IS NOT NULL AND s.child_class = 'heavy' \
             AND s.status = 'running' ORDER BY s.id",
        )
        .map_err(sql("read the heavy agents running"))?;
    select
        .query_map([], |row| {
            Ok(HeavyHolder {
                id: SessionId(row.get(0)?),
                name: row.get(1)?,
                started_by: row.get(2)?,
            })
        })
        .and_then(Iterator::collect::<rusqlite::Result<Vec<_>>>)
        .map_err(sql("read the heavy agents running"))
}

/// A session the rows say is running, and where.
pub(super) struct RunningSession {
    pub id: SessionId,
    pub cwd: String,
    /// What to call it: its agent name when an agent started it, else its
    /// session name.
    pub label: String,
}

/// Every session the rows say is running, agent-started or not.
pub(super) fn running_sessions(store: &Store) -> Result<Vec<RunningSession>> {
    let mut select = store
        .connection()
        .prepare(
            "SELECT id, cwd, COALESCE(child_name, name) FROM sessions WHERE status = 'running'",
        )
        .map_err(sql("read the sessions running"))?;
    select
        .query_map([], |row| {
            Ok(RunningSession {
                id: SessionId(row.get(0)?),
                cwd: row.get(1)?,
                label: row.get(2)?,
            })
        })
        .and_then(Iterator::collect::<rusqlite::Result<Vec<_>>>)
        .map_err(sql("read the sessions running"))
}

/// The agent-started rows below `root`, nearest first, however deep.
pub(super) fn descendants(store: &Store, root: SessionId) -> Result<Vec<ChildRow>> {
    let mut select = store
        .connection()
        .prepare(&format!(
            "WITH RECURSIVE tree(id) AS ( \
               SELECT id FROM sessions WHERE parent_session_id = ?1 AND child_name IS NOT NULL \
               UNION \
               SELECT s.id FROM sessions s JOIN tree t ON s.parent_session_id = t.id \
               WHERE s.child_name IS NOT NULL) \
             SELECT {CHILD_COLUMNS} FROM sessions WHERE id IN (SELECT id FROM tree) ORDER BY id"
        ))
        .map_err(sql("read the agents below a session"))?;
    select
        .query_map([root.0], child_row)
        .and_then(Iterator::collect::<rusqlite::Result<Vec<_>>>)
        .map_err(sql("read the agents below a session"))
}

/// The running children of `parent` that end when it does: the ones not
/// started to outlive it.
pub(super) fn ending_with(store: &Store, parent: SessionId) -> Result<Vec<SessionId>> {
    let mut select = store
        .connection()
        .prepare(
            "SELECT id FROM sessions WHERE parent_session_id = ?1 AND child_name IS NOT NULL \
             AND outlive = 0 AND status = 'running' ORDER BY id",
        )
        .map_err(sql("read the agents that end with a session"))?;
    select
        .query_map([parent.0], |row| row.get(0).map(SessionId))
        .and_then(Iterator::collect::<rusqlite::Result<Vec<_>>>)
        .map_err(sql("read the agents that end with a session"))
}

/// The running children that were not started to outlive their parent and
/// whose parent is not running: what is left of a parent that ended while
/// nobody was ending its children.
pub(super) fn orphans(store: &Store) -> Result<Vec<SessionId>> {
    let mut select = store
        .connection()
        .prepare(
            "SELECT s.id FROM sessions s WHERE s.status = 'running' \
             AND s.child_name IS NOT NULL AND s.outlive = 0 \
             AND s.parent_session_id IS NOT NULL \
             AND NOT EXISTS (SELECT 1 FROM sessions p WHERE p.id = s.parent_session_id \
                             AND p.status = 'running')",
        )
        .map_err(sql("read the agents whose parent has ended"))?;
    select
        .query_map([], |row| row.get(0).map(SessionId))
        .and_then(Iterator::collect::<rusqlite::Result<Vec<_>>>)
        .map_err(sql("read the agents whose parent has ended"))
}

/// Whether session `id`'s row says it is running.
pub(super) fn is_running(store: &Store, id: SessionId) -> Result<bool> {
    store
        .connection()
        .query_row(
            "SELECT status = 'running' FROM sessions WHERE id = ?1",
            [id.0],
            |row| row.get(0),
        )
        .optional()
        .map(|found| found.unwrap_or(false))
        .map_err(sql("read whether a session runs"))
}

/// A child's place among its parent's agents: what the parent calls it and
/// whose it is. Read when an event is written, never kept: a child may be
/// handed to a resumed parent in between.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Link {
    pub name: String,
    pub parent: SessionId,
    pub conversation: Option<String>,
}

const LINK_COLUMNS: &str = "child_name, parent_session_id, parent_conversation_id";

fn link_row(row: &Row<'_>) -> rusqlite::Result<Link> {
    Ok(Link {
        name: row.get(0)?,
        parent: SessionId(row.get(1)?),
        conversation: row.get(2)?,
    })
}

/// The link of session `id`, when it is a child with a parent.
pub(super) fn link_of(store: &Store, id: SessionId) -> Result<Option<Link>> {
    store
        .connection()
        .query_row(
            &format!(
                "SELECT {LINK_COLUMNS} FROM sessions WHERE id = ?1 \
                 AND child_name IS NOT NULL AND parent_session_id IS NOT NULL"
            ),
            [id.0],
            link_row,
        )
        .optional()
        .map_err(sql("read an agent's parent"))
}

/// How a child's session ended, as its row says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Ended {
    pub link: Link,
    pub exit_code: Option<i32>,
    /// The host ended it, rather than its program finishing on its own.
    pub stopped: bool,
}

/// The link and ending of child `id`, when it is a child with a parent.
pub(super) fn ended_of(store: &Store, id: SessionId) -> Result<Option<Ended>> {
    store
        .connection()
        .query_row(
            &format!(
                "SELECT {LINK_COLUMNS}, exit_code, stopped FROM sessions WHERE id = ?1 \
                 AND child_name IS NOT NULL AND parent_session_id IS NOT NULL"
            ),
            [id.0],
            |row| {
                Ok(Ended {
                    link: link_row(row)?,
                    exit_code: row
                        .get::<_, Option<i64>>(3)?
                        .and_then(|code| i32::try_from(code).ok()),
                    stopped: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(sql("read how an agent ended"))
}

/// What session `id`'s tab says: its label, or its name when it has none.
pub(super) fn label_of(store: &Store, id: SessionId) -> Result<Option<String>> {
    store
        .connection()
        .query_row(
            "SELECT coalesce(nullif(label, ''), name) FROM sessions WHERE id = ?1",
            [id.0],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql("read a session's name"))
}

/// Makes the running children that name `conversation_id` as the
/// conversation their parent was in the children of `session`, which is now
/// in it: the ones whose parent is not running any more, and so would be
/// nobody's. The ids re-adopted.
pub(super) fn readopt(
    store: &Store,
    session: SessionId,
    conversation_id: &str,
) -> Result<Vec<SessionId>> {
    let mut update = store
        .connection()
        .prepare(
            "UPDATE sessions SET parent_session_id = ?1 \
             WHERE child_name IS NOT NULL AND status = 'running' \
             AND parent_conversation_id = ?2 AND id != ?1 \
             AND parent_session_id IS NOT ?1 \
             AND NOT EXISTS (SELECT 1 FROM sessions p WHERE p.id = sessions.parent_session_id \
                             AND p.status = 'running') \
             RETURNING id",
        )
        .map_err(sql("re-adopt an agent's children"))?;
    update
        .query_map(params![session.0, conversation_id], |row| {
            row.get(0).map(SessionId)
        })
        .and_then(Iterator::collect::<rusqlite::Result<Vec<_>>>)
        .map_err(sql("re-adopt an agent's children"))
}

/// Every saved profile, oldest first.
pub(super) fn profiles(store: &Store) -> Result<Vec<Profile>> {
    let mut select = store
        .connection()
        .prepare(&format!(
            "SELECT {PROFILE_COLUMNS} FROM profiles ORDER BY id"
        ))
        .map_err(sql("read the profiles"))?;
    select
        .query_map([], profile_row)
        .and_then(Iterator::collect::<rusqlite::Result<Vec<_>>>)
        .map_err(sql("read the profiles"))
}

fn sql(action: &'static str) -> impl Fn(rusqlite::Error) -> Error {
    move |err| Error::io(action, io::Error::other(err))
}
