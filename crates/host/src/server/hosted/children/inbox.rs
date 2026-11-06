//! The inbox: what each child has told its parent that the parent has not yet
//! heard, kept in floti.db so it outlasts a host restart and reaches a parent
//! resumed in its conversation.
//!
//! **Keyed the way child rows are.** An item names the parent's row and, when
//! it is known, the parent's conversation, and a parent reads the items that
//! name either: a resumed parent is a new row in the same conversation.
//!
//! **Nothing of the conversation.** An item is an event, the child's name as
//! its parent knows it, and the words the event carries: a report's text, a
//! program's own message (cut to 200 characters), an exit code, who stopped
//! it. There is no column for anything the child said or did otherwise.
//!
//! **Seen means handed over.** An item is marked seen only when the answer
//! that carried it has reached its caller ([`mark_seen`]), so a wait that is
//! cancelled, whose connection goes, or that a restart cuts off leaves it
//! unseen for the next.

use rusqlite::params;
use serde_json::{Value, json};

use crate::session::{MAX_MESSAGE_CHARS, SessionId};
use crate::store::Store;
use crate::{Error, Result};

/// What happened to a child.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EventKind {
    /// The child's own `agents_report`, or its program's `done`.
    Report,
    /// It waits on a person: a permission prompt, a question, a sign-in.
    NeedsYou,
    /// It went from working to idle without reporting in that turn.
    TurnEnded,
    /// Its session ended: exited with a code, or stopped.
    Ended,
    /// Its launch failed, or its program reports an error.
    Error,
}

impl EventKind {
    /// The word stored and shown: `report`, `needs_you`, `turn_ended`,
    /// `ended`, `error`.
    pub fn word(self) -> &'static str {
        match self {
            Self::Report => "report",
            Self::NeedsYou => "needs_you",
            Self::TurnEnded => "turn_ended",
            Self::Ended => "ended",
            Self::Error => "error",
        }
    }

    fn from_word(word: &str) -> Option<Self> {
        [
            Self::Report,
            Self::NeedsYou,
            Self::TurnEnded,
            Self::Ended,
            Self::Error,
        ]
        .into_iter()
        .find(|kind| kind.word() == word)
    }
}

/// Who ended a child that did not exit on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StoppedBy {
    /// Its parent, with `agents_stop`.
    Parent,
    /// A person, with Stop in a client.
    Person,
    /// Floti: its parent ended, or the host did.
    Floti,
}

impl StoppedBy {
    /// The word stored.
    pub fn word(self) -> &'static str {
        match self {
            Self::Parent => "parent",
            Self::Person => "person",
            Self::Floti => "floti",
        }
    }

    fn from_word(word: &str) -> Option<Self> {
        [Self::Parent, Self::Person, Self::Floti]
            .into_iter()
            .find(|by| by.word() == word)
    }

    /// As a sentence says it.
    fn said(self) -> &'static str {
        match self {
            Self::Parent => "its parent",
            Self::Person => "a person",
            Self::Floti => "Floti",
        }
    }
}

/// What an event carries beyond its kind and its child.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Facts {
    /// A report's `done`, `stuck` or `note`; a needs-you's kind in words
    /// (`permission prompt`, `question`, `sign-in`); an error's `launch` or
    /// `program`; an ended's `exited` or `stopped`.
    pub state: Option<String>,
    /// A report's text; a program's message; a needs-you's own sentence when
    /// it has no kind; who stopped an ended child.
    pub detail: Option<String>,
    /// How an ended child's program exited.
    pub exit_code: Option<i32>,
}

/// One thing a child told its parent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct News {
    pub id: i64,
    /// The child, as its parent knows it.
    pub child: String,
    pub event: EventKind,
    pub facts: Facts,
    /// When it happened, as the store writes a time.
    pub at: String,
}

/// An item to write: who it is for, from whom, and what.
pub(super) struct Item<'a> {
    pub parent: SessionId,
    pub parent_conversation: Option<&'a str>,
    pub child: Option<SessionId>,
    pub child_name: &'a str,
    pub event: EventKind,
    pub facts: &'a Facts,
}

/// Writes `item`, and the id it was given.
pub(super) fn record(store: &Store, item: &Item<'_>) -> Result<i64> {
    let detail = item
        .facts
        .detail
        .as_deref()
        .map(|text| cut(text, item.event));
    store
        .connection()
        .query_row(
            "INSERT INTO agent_inbox (parent_session_id, parent_conversation_id, \
             child_session_id, child_name, event, state, detail, exit_code) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) RETURNING id",
            params![
                item.parent.0,
                item.parent_conversation,
                item.child.map(|child| child.0),
                item.child_name,
                item.event.word(),
                item.facts.state,
                detail,
                item.facts.exit_code,
            ],
            |row| row.get(0),
        )
        .map_err(sql("record news for an agent's parent"))
}

/// A program's message is cut to the length OSC 7501 allows; a report's text
/// is the child's own, at the length `agents_report` took it.
fn cut(text: &str, event: EventKind) -> String {
    match event {
        EventKind::Report => text.to_owned(),
        _ => text.chars().take(MAX_MESSAGE_CHARS).collect(),
    }
}

/// What `parent` has not yet heard, oldest first: the items that name its row
/// or, when it is known, its conversation.
pub(super) fn unseen(
    store: &Store,
    parent: SessionId,
    conversation: Option<&str>,
) -> Result<Vec<News>> {
    let mut select = store
        .connection()
        .prepare(
            "SELECT id, child_name, event, state, detail, exit_code, at FROM agent_inbox \
             WHERE seen_at IS NULL \
             AND (parent_session_id = ?1 OR (?2 IS NOT NULL AND parent_conversation_id = ?2)) \
             ORDER BY id",
        )
        .map_err(sql("read an agent's news"))?;
    select
        .query_map(params![parent.0, conversation], |row| {
            let word: String = row.get(2)?;
            Ok(News {
                id: row.get(0)?,
                child: row.get(1)?,
                event: EventKind::from_word(&word).unwrap_or(EventKind::TurnEnded),
                facts: Facts {
                    state: row.get(3)?,
                    detail: row.get(4)?,
                    exit_code: row.get(5)?,
                },
                at: row.get(6)?,
            })
        })
        .and_then(Iterator::collect::<rusqlite::Result<Vec<_>>>)
        .map_err(sql("read an agent's news"))
}

/// Marks `ids` heard. One already heard stays as it was heard.
pub(super) fn mark_seen(store: &Store, ids: &[i64]) -> Result<()> {
    let mut update = store
        .connection()
        .prepare(
            "UPDATE agent_inbox SET seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
             WHERE id = ?1 AND seen_at IS NULL",
        )
        .map_err(sql("mark an agent's news heard"))?;
    for id in ids {
        update
            .execute([id])
            .map_err(sql("mark an agent's news heard"))?;
    }
    Ok(())
}

impl News {
    /// The line a model reads: the child by name, then what happened.
    pub fn line(&self) -> String {
        let child = &self.child;
        let facts = &self.facts;
        let detail = facts.detail.as_deref().unwrap_or_default();
        match self.event {
            EventKind::Report => match facts.state.as_deref() {
                Some("done") => format!("{child} reported done: {detail}"),
                Some("stuck") => format!("{child} is stuck: {detail}"),
                _ => format!("{child} sent a note: {detail}"),
            },
            EventKind::NeedsYou => match (facts.state.as_deref(), detail) {
                (Some(kind), _) => format!(
                    "{child} needs you: it is waiting on a {kind}. Neither you nor it can answer that; tell your user."
                ),
                (None, text) if !text.is_empty() => format!(
                    "{child} needs you: {text}. Neither you nor it can answer that; tell your user."
                ),
                (None, _) => format!(
                    "{child} needs you. Neither you nor it can answer that; tell your user."
                ),
            },
            EventKind::TurnEnded => format!("{child} ended its turn without reporting."),
            EventKind::Ended => match facts.state.as_deref() {
                Some("stopped") => {
                    let by = facts
                        .detail
                        .as_deref()
                        .and_then(StoppedBy::from_word)
                        .map_or("someone", StoppedBy::said);
                    format!("{child} was stopped by {by}.")
                }
                _ => match facts.exit_code {
                    Some(code) => format!("{child} ended with exit code {code}."),
                    None => format!("{child} ended."),
                },
            },
            EventKind::Error => match facts.state.as_deref() {
                Some("launch") => format!("{child} could not be started: {detail}"),
                _ => format!("{child} reports an error: {detail}"),
            },
        }
    }

    /// The same, for a program to read.
    pub fn json(&self) -> Value {
        let facts = &self.facts;
        let mut news = json!({
            "child": self.child,
            "event": self.event.word(),
            "at": self.at,
        });
        let object = news.as_object_mut().expect("an object");
        if let Some(state) = &facts.state {
            object.insert("state".into(), json!(state));
        }
        if let Some(detail) = &facts.detail {
            // An ended child's detail is who stopped it; any other's is text.
            let key = if self.event == EventKind::Ended {
                "stoppedBy"
            } else {
                "text"
            };
            object.insert(key.into(), json!(detail));
        }
        if let Some(code) = facts.exit_code {
            object.insert("exitCode".into(), json!(code));
        }
        news
    }
}

fn sql(action: &'static str) -> impl Fn(rusqlite::Error) -> Error {
    move |err| Error::io(action, std::io::Error::other(err))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::TestDirs;

    fn store() -> (TestDirs, Store) {
        let dirs = TestDirs::new();
        let store = Store::open(&dirs.data).expect("open the store");
        (dirs, store)
    }

    fn item<'a>(parent: i64, conversation: Option<&'a str>, facts: &'a Facts) -> Item<'a> {
        Item {
            parent: SessionId(parent),
            parent_conversation: conversation,
            child: Some(SessionId(90)),
            child_name: "reviewer",
            event: EventKind::Report,
            facts,
        }
    }

    fn done(text: &str) -> Facts {
        Facts {
            state: Some("done".into()),
            detail: Some(text.into()),
            exit_code: None,
        }
    }

    #[test]
    fn news_is_read_back_in_order_for_the_parent_it_names_and_for_no_other() {
        let (_dirs, store) = store();
        for (parent, text) in [(1, "first"), (2, "other"), (1, "second")] {
            record(&store, &item(parent, None, &done(text))).unwrap();
        }
        let heard: Vec<String> = unseen(&store, SessionId(1), None)
            .unwrap()
            .into_iter()
            .map(|news| news.facts.detail.unwrap())
            .collect();
        assert_eq!(heard, ["first", "second"]);
    }

    #[test]
    fn a_resumed_parent_in_the_same_conversation_gets_the_news_its_earlier_row_was_sent() {
        let (_dirs, store) = store();
        record(&store, &item(1, Some("conv-a"), &done("while away"))).unwrap();
        let resumed = unseen(&store, SessionId(7), Some("conv-a")).unwrap();
        assert_eq!(resumed.len(), 1);
        assert!(
            unseen(&store, SessionId(7), Some("conv-b"))
                .unwrap()
                .is_empty()
        );
        assert!(unseen(&store, SessionId(7), None).unwrap().is_empty());
    }

    #[test]
    fn seen_news_is_not_read_again_and_unseen_news_is_until_it_is_marked() {
        let (_dirs, store) = store();
        let first = record(&store, &item(1, None, &done("a"))).unwrap();
        record(&store, &item(1, None, &done("b"))).unwrap();
        assert_eq!(unseen(&store, SessionId(1), None).unwrap().len(), 2);
        mark_seen(&store, &[first]).unwrap();
        let left = unseen(&store, SessionId(1), None).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].facts.detail.as_deref(), Some("b"));
        // Marking twice changes nothing.
        mark_seen(&store, &[first]).unwrap();
        assert_eq!(unseen(&store, SessionId(1), None).unwrap().len(), 1);
    }

    #[test]
    fn a_programs_message_is_cut_to_200_characters_and_a_reports_text_is_not() {
        let (_dirs, store) = store();
        let long = "x".repeat(500);
        let facts = Facts {
            state: Some("program".into()),
            detail: Some(long.clone()),
            exit_code: None,
        };
        let error = Item {
            event: EventKind::Error,
            ..item(1, None, &facts)
        };
        record(&store, &error).unwrap();
        record(&store, &item(1, None, &done(&long))).unwrap();
        let news = unseen(&store, SessionId(1), None).unwrap();
        assert_eq!(news[0].facts.detail.as_deref().unwrap().len(), 200);
        assert_eq!(news[1].facts.detail.as_deref().unwrap().len(), 500);
    }

    #[test]
    fn each_event_reads_as_a_line_naming_the_child_and_as_json() {
        let at = String::new;
        let news = |event, state: Option<&str>, detail: Option<&str>, exit_code| News {
            id: 1,
            child: "reviewer".into(),
            event,
            facts: Facts {
                state: state.map(str::to_owned),
                detail: detail.map(str::to_owned),
                exit_code,
            },
            at: at(),
        };
        let report = news(EventKind::Report, Some("done"), Some("All fixed."), None);
        assert_eq!(report.line(), "reviewer reported done: All fixed.");
        assert_eq!(report.json()["text"], "All fixed.");
        assert!(
            news(EventKind::Report, Some("stuck"), Some("Which?"), None)
                .line()
                .starts_with("reviewer is stuck")
        );
        let needs = news(EventKind::NeedsYou, Some("permission prompt"), None, None);
        assert!(needs.line().contains("waiting on a permission prompt"));
        assert!(
            news(EventKind::TurnEnded, None, None, None)
                .line()
                .contains("ended its turn without reporting")
        );
        assert_eq!(
            news(EventKind::Ended, Some("exited"), None, Some(3)).line(),
            "reviewer ended with exit code 3."
        );
        let stopped = news(EventKind::Ended, Some("stopped"), Some("parent"), None);
        assert_eq!(stopped.line(), "reviewer was stopped by its parent.");
        assert_eq!(stopped.json()["stoppedBy"], "parent");
        assert!(
            news(EventKind::Error, Some("launch"), Some("no folder"), None)
                .line()
                .contains("could not be started: no folder")
        );
    }
}
