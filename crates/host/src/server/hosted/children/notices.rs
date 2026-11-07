//! Standing notices: what the host keeps for a person who is not looking.
//!
//! A notice stands on the host while it holds, with no client attached:
//!
//! - *needs you*: a child is waiting on a person. It is read off the activity
//!   pass ([`super::news`]), so it stands while the activity says waiting, goes
//!   when the child stops waiting or ends, and is rebuilt from the activity
//!   after a restart. It is kept in memory and is never dismissed;
//! - *limit*: a start a limit refused. A row in `notices`, kept across a
//!   restart until a client dismisses it or its parent ends. A new refusal by
//!   the same limit for the same parent replaces the old one;
//! - *error*: a launch that failed, or a child that ended in error. A row in
//!   `notices` kept the same way.
//!
//! The list goes to every client on `notices:changed` (the features module
//! serves it); dismissing is for every client, and so is allowing more starts.

use std::io;

use floti_protocol::channels::sessions::{NoticeKind, NoticeLimit, StandingNotice};
use rusqlite::params;

use super::rows;
use crate::server::hosted::Hosted;
use crate::session::{SessionId, allow_starts};
use crate::store::Store;
use crate::workspace::settings;
use crate::{Error, Result};

/// The id of the notice that child `child` needs a person.
fn needs_you_id(child: SessionId) -> String {
    format!("needs-you-{}", child.0)
}

/// A session's id as the protocol says it.
fn id_number(id: SessionId) -> u64 {
    u64::try_from(id.0).unwrap_or_default()
}

/// The id of stored notice `row`.
fn stored_id(row: i64) -> String {
    format!("notice-{row}")
}

/// The row a stored notice's id names.
fn stored_row(id: &str) -> Option<i64> {
    id.strip_prefix("notice-")?.parse().ok()
}

/// The notice that child `child` of `parent` waits on `text`.
pub(super) fn needs_you(
    child: SessionId,
    child_name: &str,
    parent: SessionId,
    parent_name: &str,
    text: &str,
    since: String,
) -> StandingNotice {
    StandingNotice {
        id: needs_you_id(child),
        kind: NoticeKind::NeedsYou,
        parent_id: id_number(parent),
        parent_name: parent_name.to_owned(),
        child_id: Some(id_number(child)),
        child_name: Some(child_name.to_owned()),
        text: text.to_owned(),
        since,
        limit: None,
        allow_more: None,
    }
}

/// What a refused start leaves.
pub(super) struct Limit<'a> {
    pub limit: NoticeLimit,
    pub text: &'a str,
    /// For the starts limit, how many starts Allow adds.
    pub allow_more: Option<u32>,
}

fn limit_word(limit: NoticeLimit) -> &'static str {
    match limit {
        NoticeLimit::Children => "children",
        NoticeLimit::Sessions => "sessions",
        NoticeLimit::Depth => "depth",
        NoticeLimit::Starts => "starts",
        NoticeLimit::Heavy => "heavy",
    }
}

fn limit_of(word: &str) -> Option<NoticeLimit> {
    Some(match word {
        "children" => NoticeLimit::Children,
        "sessions" => NoticeLimit::Sessions,
        "depth" => NoticeLimit::Depth,
        "starts" => NoticeLimit::Starts,
        "heavy" => NoticeLimit::Heavy,
        _ => return None,
    })
}

/// Records that `parent`'s start was refused by `refusal`, in place of the
/// notice the same limit left for the same parent before.
pub(super) fn record_limit(
    store: &Store,
    parent: SessionId,
    parent_name: &str,
    refusal: &Limit<'_>,
) -> Result<()> {
    let word = limit_word(refusal.limit);
    store
        .connection()
        .execute(
            "DELETE FROM notices WHERE kind = 'limit' AND parent_session_id = ?1 \
             AND limit_kind = ?2",
            params![parent.0, word],
        )
        .map_err(sql("replace a limit notice"))?;
    store
        .connection()
        .execute(
            "INSERT INTO notices (kind, parent_session_id, parent_name, text, limit_kind, \
             allow_more) VALUES ('limit', ?1, ?2, ?3, ?4, ?5)",
            params![
                parent.0,
                parent_name,
                refusal.text,
                word,
                refusal.allow_more.map(i64::from)
            ],
        )
        .map_err(sql("record a limit notice"))?;
    Ok(())
}

/// Records that a child of `parent` called `child_name` ended in error or
/// never started, in place of an earlier notice about the same child.
pub(super) fn record_error(
    store: &Store,
    parent: SessionId,
    parent_name: &str,
    child: Option<SessionId>,
    child_name: &str,
    text: &str,
) -> Result<()> {
    let child = child.map(|child| child.0);
    store
        .connection()
        .execute(
            "DELETE FROM notices WHERE kind = 'error' AND parent_session_id = ?1 \
             AND child_name = ?2 AND child_session_id IS ?3",
            params![parent.0, child_name, child],
        )
        .map_err(sql("replace an error notice"))?;
    store
        .connection()
        .execute(
            "INSERT INTO notices (kind, parent_session_id, parent_name, child_session_id, \
             child_name, text) VALUES ('error', ?1, ?2, ?3, ?4, ?5)",
            params![parent.0, parent_name, child, child_name, text],
        )
        .map_err(sql("record an error notice"))?;
    Ok(())
}

/// The notices the database keeps, oldest first.
pub(super) fn stored(store: &Store) -> Result<Vec<StandingNotice>> {
    let mut select = store
        .connection()
        .prepare(
            "SELECT id, kind, parent_session_id, parent_name, child_session_id, child_name, \
             text, limit_kind, allow_more, since FROM notices ORDER BY id",
        )
        .map_err(sql("read the notices"))?;
    let rows = select
        .query_map([], |row| {
            let kind: String = row.get(1)?;
            let limit: Option<String> = row.get(7)?;
            Ok(StandingNotice {
                id: stored_id(row.get(0)?),
                kind: if kind == "limit" {
                    NoticeKind::Limit
                } else {
                    NoticeKind::Error
                },
                parent_id: id_number(SessionId(row.get(2)?)),
                parent_name: row.get(3)?,
                child_id: row
                    .get::<_, Option<i64>>(4)?
                    .map(|id| id_number(SessionId(id))),
                child_name: row.get(5)?,
                text: row.get(6)?,
                since: row.get(9)?,
                limit: limit.as_deref().and_then(limit_of),
                allow_more: row
                    .get::<_, Option<i64>>(8)?
                    .and_then(|more| u32::try_from(more).ok()),
            })
        })
        .and_then(Iterator::collect::<rusqlite::Result<Vec<_>>>)
        .map_err(sql("read the notices"))?;
    Ok(rows)
}

/// Removes the notices under `parent`, which has ended. Whether any went.
pub(super) fn remove_for_parent(store: &Store, parent: SessionId) -> Result<bool> {
    store
        .connection()
        .execute(
            "DELETE FROM notices WHERE parent_session_id = ?1",
            [parent.0],
        )
        .map(|removed| removed > 0)
        .map_err(sql("remove the notices of a session that ended"))
}

/// Removes the notices whose parent is not running: the parents that ended
/// while no host was there to say so.
pub(super) fn remove_unowned(store: &Store) -> Result<()> {
    store
        .connection()
        .execute(
            "DELETE FROM notices WHERE parent_session_id NOT IN \
             (SELECT id FROM sessions WHERE status = 'running')",
            [],
        )
        .map(|_| ())
        .map_err(sql("remove the notices of sessions that ended"))
}

impl Hosted {
    /// The notices standing now: the children that need a person, then the
    /// refusals and errors the host has kept.
    ///
    /// # Errors
    ///
    /// A sentence when the host's record cannot be read.
    pub(crate) fn standing_notices(&self) -> std::result::Result<Vec<StandingNotice>, String> {
        let mut list = self.children.news.needs_you_notices();
        list.extend(stored(&self.ledger.store()).map_err(|err| err.to_string())?);
        Ok(list)
    }

    /// Counts the changes to the standing notices, for the feature that sends
    /// them to the clients to wait on.
    pub(crate) fn notices_changes(&self) -> tokio::sync::watch::Receiver<u64> {
        self.children.news.notices_changes()
    }

    /// A client dismisses notice `id`, for every client. A notice that is
    /// gone, and a needs-you notice, which goes by itself when its child stops
    /// waiting, are left as they are.
    ///
    /// # Errors
    ///
    /// A sentence when the host's record cannot be written.
    pub(crate) fn dismiss_notice(&self, id: &str) -> std::result::Result<(), String> {
        let Some(row) = stored_row(id) else {
            return Ok(());
        };
        let removed = self
            .ledger
            .store()
            .connection()
            .execute("DELETE FROM notices WHERE id = ?1", [row])
            .map_err(|err| sql("dismiss a notice")(err).to_string())?;
        if removed > 0 {
            self.children.news.notices_moved();
        }
        Ok(())
    }

    /// A client lets `parent` start as many more children as the starts
    /// setting says, after its starts limit refused it; the starts notice
    /// goes. No other session's allowance changes. Without a starts notice
    /// standing for `parent` nothing is added: two clients pressing Allow
    /// together add the starts once.
    ///
    /// Answers how many more starts `parent` may make now.
    ///
    /// # Errors
    ///
    /// A sentence when the host's record cannot be read or written.
    pub(crate) fn allow_more_starts(&self, parent: u64) -> std::result::Result<u32, String> {
        let parent = SessionId(i64::try_from(parent).map_err(|err| err.to_string())?);
        let added = {
            let store = self.ledger.store();
            let standing: bool = store
                .connection()
                .query_row(
                    "SELECT EXISTS (SELECT 1 FROM notices WHERE kind = 'limit' \
                     AND parent_session_id = ?1 AND limit_kind = 'starts')",
                    [parent.0],
                    |row| row.get(0),
                )
                .map_err(|err| sql("read a starts notice")(err).to_string())?;
            if !standing {
                return Ok(0);
            }
            let more = settings::read(store.connection())
                .map_err(|err| err.to_string())?
                .agent_starts_per_parent;
            allow_starts(&store, parent, more).map_err(|err| err.to_string())?;
            store
                .connection()
                .execute(
                    "DELETE FROM notices WHERE kind = 'limit' AND parent_session_id = ?1 \
                     AND limit_kind = 'starts'",
                    [parent.0],
                )
                .map_err(|err| sql("remove a starts notice")(err).to_string())?;
            more
        };
        self.children.news.notices_moved();
        Ok(added)
    }

    /// `limit` refused a start of `parent`: the notice stands until it is
    /// dismissed, the parent is allowed more, or the parent ends. Answers the
    /// refusal's sentence.
    pub(super) fn limit_refused(&self, parent: SessionId, refusal: Limit<'_>) -> String {
        let store = self.ledger.store();
        let name = rows::label_of(&store, parent)
            .ok()
            .flatten()
            .unwrap_or_default();
        if let Err(err) = record_limit(&store, parent, &name, &refusal) {
            log_line!("floti host: {err}");
        }
        drop(store);
        self.children.news.notices_moved();
        refusal.text.to_owned()
    }

    /// A child of `link`'s parent ended in error, or never started: the
    /// notice stands until it is dismissed or the parent ends.
    pub(super) fn error_noticed(&self, link: &rows::Link, child: Option<SessionId>, text: &str) {
        let store = self.ledger.store();
        let parent = rows::label_of(&store, link.parent)
            .ok()
            .flatten()
            .unwrap_or_default();
        if let Err(err) = record_error(&store, link.parent, &parent, child, &link.name, text) {
            log_line!("floti host: {err}");
        }
        drop(store);
        self.children.news.notices_moved();
    }

    /// Session `session` has ended: the notices under it go with it.
    pub(super) fn notices_of_ended(&self, session: SessionId) {
        match remove_for_parent(&self.ledger.store(), session) {
            Ok(true) => self.children.news.notices_moved(),
            Ok(false) => {}
            Err(err) => log_line!("floti host: {err}"),
        }
    }
}

fn sql(action: &'static str) -> impl Fn(rusqlite::Error) -> Error {
    move |err| Error::io(action, io::Error::other(err))
}
