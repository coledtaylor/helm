//! The merge rules, each against a real `floti.db` in a temporary folder.

use floti_protocol::channels::carry::{
    CarriedConfigVersion, CarriedConversation, CarriedConversationPart, CarriedSessionName,
    CarriedUsageRow, CarryMerged,
};
use floti_protocol::channels::sessions::{ArchiveMessage, ArchiveRole, ArchiveSessionState};

use super::*;
use crate::config_console::snapshots;
use crate::history::archive::{self, ArchiveInput};
use crate::store::Store;
use crate::testkit::TestDirs;
use crate::workspace::settings;

const ONE: &str = "11111111-1111-4111-8111-111111111111";
const TWO: &str = "22222222-2222-4222-8222-222222222222";
const THREE: &str = "33333333-3333-4333-8333-333333333333";
const T0: u64 = 1_760_000_000_000;
const CEILING: u64 = archive::DEFAULT_CEILING;

struct World {
    store: Store,
    /// Last: the folder goes once nothing in it is open.
    _dirs: TestDirs,
}

impl World {
    fn new() -> Self {
        let dirs = TestDirs::new();
        let store = Store::open(&dirs.data).expect("open the store");
        Self { store, _dirs: dirs }
    }

    fn conn(&self) -> &Connection {
        self.store.connection()
    }

    fn count(&self, sql: &str) -> i64 {
        self.conn().query_row(sql, [], |row| row.get(0)).unwrap()
    }

    /// Archives a transcript the way the host's own pass does.
    fn archive_own(&self, session: &str, messages: &[ArchiveMessage]) {
        archive::archive_transcript(
            self.conn(),
            &ArchiveInput {
                file: &format!("C:\\a home\\{session}.jsonl"),
                session_id: session,
                bytes: 100,
                messages,
            },
        )
        .unwrap();
    }

    fn conversations(&self, parts: &[CarriedConversationPart]) -> CarriedConversationsMerged {
        self.conversations_under(parts, CEILING)
    }

    fn conversations_under(
        &self,
        parts: &[CarriedConversationPart],
        ceiling: u64,
    ) -> CarriedConversationsMerged {
        merge_conversations(self.conn(), &encode(parts), ceiling).unwrap()
    }

    fn texts(&self, session: &str) -> Vec<String> {
        archive::read_conversation(self.conn(), session)
            .unwrap()
            .map(|conversation| conversation.messages.into_iter().map(|m| m.text).collect())
            .unwrap_or_default()
    }
}

fn message(uuid: &str, at: u64, text: &str) -> ArchiveMessage {
    ArchiveMessage {
        uuid: uuid.to_owned(),
        role: if at.is_multiple_of(2) {
            ArchiveRole::User
        } else {
            ArchiveRole::Assistant
        },
        at,
        text: text.to_owned(),
    }
}

fn row(
    session: &str,
    state: ArchiveSessionState,
    messages: &[ArchiveMessage],
) -> CarriedConversation {
    CarriedConversation {
        session_id: session.to_owned(),
        source_file: format!("C:\\Users\\someone\\.claude\\projects\\p\\{session}.jsonl"),
        state,
        first_at: messages.first().map(|m| m.at).or(Some(T0)),
        last_at: messages.last().map(|m| m.at).or(Some(T0 + 9)),
        message_count: if messages.is_empty() {
            7
        } else {
            messages.len() as u32
        },
        raw_bytes: 700,
        stored_bytes: if state == ArchiveSessionState::Evicted {
            0
        } else {
            500
        },
        captured_at: "2026-09-01T10:00:00.000Z".to_owned(),
        evicted_at: (state == ArchiveSessionState::Evicted)
            .then(|| "2026-09-02T10:00:00.000Z".to_owned()),
    }
}

/// A whole conversation in one part.
fn whole(session: &str, messages: &[ArchiveMessage]) -> CarriedConversationPart {
    CarriedConversationPart {
        conversation: row(session, ArchiveSessionState::Archived, messages),
        part: 0,
        messages: messages.to_vec(),
        last: true,
    }
}

/// Part `part` of a conversation whose messages are `all`.
fn part(
    session: &str,
    all: &[ArchiveMessage],
    part: u32,
    messages: &[ArchiveMessage],
    last: bool,
) -> CarriedConversationPart {
    CarriedConversationPart {
        conversation: row(session, ArchiveSessionState::Archived, all),
        part,
        messages: messages.to_vec(),
        last,
    }
}

#[test]
fn a_conversation_the_host_already_holds_is_kept_whole_and_appears_once() {
    let world = World::new();
    world.archive_own(ONE, &[message("h1", T0, "the host's own words")]);
    // Helm's copy of the same conversation holds different messages.
    let helms = [
        message("c1", T0, "helm's words"),
        message("c2", T0 + 1, "more"),
    ];
    let merged = world.conversations(&[whole(&ONE.to_uppercase(), &helms)]);
    assert_eq!((merged.added, merged.kept, merged.messages), (0, 1, 0));
    assert_eq!(world.texts(ONE), ["the host's own words"]);
    assert_eq!(world.count("SELECT COUNT(*) FROM transcript_sessions"), 1);
    assert_eq!(world.count("SELECT COUNT(*) FROM transcript_messages"), 1);
}

#[test]
fn a_conversation_the_host_dropped_stays_dropped() {
    let world = World::new();
    world.archive_own(ONE, &[message("h1", T0, "dropped later")]);
    archive::evict_to_ceiling(world.conn(), 0).unwrap();
    let merged = world.conversations(&[whole(ONE, &[message("h1", T0, "dropped later")])]);
    assert_eq!((merged.added, merged.kept), (0, 1));
    let held = archive::read_conversation(world.conn(), ONE)
        .unwrap()
        .unwrap();
    assert_eq!(held.state, ArchiveSessionState::Evicted);
    assert!(held.messages.is_empty());
}

#[test]
fn a_copied_conversation_keeps_when_helm_captured_it_and_reads_back_whole() {
    let world = World::new();
    let long = "a sentence that repeats until deflate shortens it. ".repeat(10);
    let messages = [message("c1", T0, "short"), message("c2", T0 + 1, &long)];
    let merged = world.conversations(&[whole(ONE, &messages)]);
    assert_eq!((merged.added, merged.kept, merged.messages), (1, 0, 2));

    let copied = archive::read_conversation(world.conn(), ONE)
        .unwrap()
        .unwrap();
    assert_eq!(copied.state, ArchiveSessionState::Archived);
    assert_eq!(copied.captured_at, "2026-09-01T10:00:00.000Z");
    assert_eq!(copied.message_count, 2);
    assert_eq!((copied.first_at, copied.last_at), (Some(T0), Some(T0 + 1)));
    assert_eq!(copied.messages, messages);
    // Stored with the host's own compression, and measured as stored.
    assert!(copied.stored_bytes < copied.raw_bytes);
    assert_eq!(
        copied.stored_bytes,
        archive::archived_bytes(world.conn()).unwrap()
    );
    // And searchable, like every archived message.
    let found = archive::search_archive(world.conn(), "deflate", 10).unwrap();
    assert!(found.contains_key(ONE));
}

#[test]
fn a_dropped_conversation_is_copied_as_dropped_with_its_figures() {
    let world = World::new();
    let dropped = CarriedConversationPart {
        conversation: row(TWO, ArchiveSessionState::Evicted, &[]),
        part: 0,
        messages: Vec::new(),
        last: true,
    };
    let merged = world.conversations(&[dropped]);
    assert_eq!((merged.added, merged.messages), (1, 0));
    let copied = archive::read_conversation(world.conn(), TWO)
        .unwrap()
        .unwrap();
    assert_eq!(copied.state, ArchiveSessionState::Evicted);
    assert_eq!(
        (copied.message_count, copied.raw_bytes, copied.stored_bytes),
        (7, 700, 0)
    );
    assert_eq!(
        copied.evicted_at.as_deref(),
        Some("2026-09-02T10:00:00.000Z")
    );
    assert_eq!(copied.captured_at, "2026-09-01T10:00:00.000Z");
}

#[test]
fn a_copy_that_stops_part_way_leaves_no_conversation_and_its_retry_duplicates_nothing() {
    let world = World::new();
    let all = [
        message("c1", T0, "first part"),
        message("c2", T0 + 1, "still first"),
        message("c3", T0 + 2, "second part"),
    ];
    // The first part lands, then the copy stops.
    world.conversations(&[part(ONE, &all, 0, &all[..2], false)]);
    assert_eq!(archive::read_conversation(world.conn(), ONE).unwrap(), None);
    assert!(
        archive::search_archive(world.conn(), "first", 10)
            .unwrap()
            .is_empty(),
        "nothing of an unfinished conversation shows"
    );

    // Tried again from the start, it lands whole, once.
    world.conversations(&[part(ONE, &all, 0, &all[..2], false)]);
    let merged = world.conversations(&[part(ONE, &all, 1, &all[2..], true)]);
    assert_eq!((merged.added, merged.messages), (1, 1));
    assert_eq!(
        world.texts(ONE),
        ["first part", "still first", "second part"]
    );
    assert_eq!(world.count("SELECT COUNT(*) FROM transcript_messages"), 3);
    let conversation = archive::read_conversation(world.conn(), ONE)
        .unwrap()
        .unwrap();
    assert_eq!(conversation.message_count, 3);

    // A whole retry after it finished changes nothing.
    let again = world.conversations(&[
        part(ONE, &all, 0, &all[..2], false),
        part(ONE, &all, 1, &all[2..], true),
    ]);
    assert_eq!((again.added, again.kept, again.messages), (0, 2, 0));
    assert_eq!(world.count("SELECT COUNT(*) FROM transcript_messages"), 3);
}

#[test]
fn copied_conversations_past_the_limit_drop_the_oldest_until_the_archive_is_under_it() {
    let world = World::new();
    let text = |seed: u64| -> String {
        let mut state = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
        (0..2000)
            .map(|_| {
                state = state
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1_442_695_040_888_963_407);
                char::from(b'!' + ((state >> 33) % 94) as u8)
            })
            .collect()
    };
    // The host's own conversation is the newest.
    world.archive_own(THREE, &[message("h1", T0 + 300, &text(3))]);
    let own = archive::archived_bytes(world.conn()).unwrap();
    let oldest = [message("c1", T0, &text(1))];
    let older = [message("c2", T0 + 100, &text(2))];
    // Room for two of the three.
    let ceiling = own * 2 + own / 2;
    let merged = world.conversations_under(&[whole(ONE, &oldest), whole(TWO, &older)], ceiling);
    assert_eq!((merged.added, merged.evicted), (2, 1));
    assert!(archive::archived_bytes(world.conn()).unwrap() <= ceiling);
    let state = |id: &str| {
        archive::read_conversation(world.conn(), id)
            .unwrap()
            .unwrap()
            .state
    };
    assert_eq!(state(ONE), ArchiveSessionState::Evicted);
    assert_eq!(state(TWO), ArchiveSessionState::Archived);
    assert_eq!(state(THREE), ArchiveSessionState::Archived);
}

#[test]
fn only_the_conversations_the_host_lacks_are_asked_for() {
    let world = World::new();
    world.archive_own(ONE, &[message("h1", T0, "held")]);
    let asked = [ONE.to_uppercase(), TWO.to_owned(), TWO.to_owned()];
    assert_eq!(missing(world.conn(), &asked).unwrap(), [TWO]);
}

fn name(session: &str, name: &str) -> CarriedSessionName {
    CarriedSessionName {
        session_id: session.to_owned(),
        name: name.to_owned(),
        renamed_at: "2026-09-03T10:00:00.000Z".to_owned(),
    }
}

#[test]
fn a_session_the_host_has_named_keeps_its_name() {
    let world = World::new();
    world
        .conn()
        .execute(
            "INSERT INTO history_names (session_id, name) VALUES (?, 'the host''s name')",
            [ONE],
        )
        .unwrap();
    let merged = merge_names(
        world.conn(),
        &[
            name(&ONE.to_uppercase(), "helm's name"),
            name(TWO, "named in helm"),
        ],
    )
    .unwrap();
    assert_eq!(merged, CarryMerged { added: 1, kept: 1 });
    let named = |id: &str| -> (String, String) {
        world
            .conn()
            .query_row(
                "SELECT name, renamed_at FROM history_names WHERE session_id = ?",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
    };
    assert_eq!(named(ONE).0, "the host's name");
    assert_eq!(
        named(TWO),
        (
            "named in helm".to_owned(),
            "2026-09-03T10:00:00.000Z".to_owned()
        )
    );
    assert_eq!(world.count("SELECT COUNT(*) FROM history_names"), 2);
}

fn version(content: &str, hash: &str, created_at: &str) -> CarriedConfigVersion {
    CarriedConfigVersion {
        scope_path: "C:\\a repo".to_owned(),
        file_path: ".claude/settings.json".to_owned(),
        content: content.to_owned(),
        content_hash: hash.to_owned(),
        reason: "approve".to_owned(),
        created_at: created_at.to_owned(),
    }
}

#[test]
fn a_config_version_the_host_has_is_not_added_again_and_a_new_one_keeps_its_time_and_reason() {
    let world = World::new();
    world
        .conn()
        .execute(
            "INSERT INTO config_snapshots (project_path, file_path, content, content_hash, reason, created_at)
             VALUES ('C:\\a repo', '.claude/settings.json', '{\"host\":1}', 'h-host', 'edit', '2026-09-05T00:00:00.000Z')",
            [],
        )
        .unwrap();
    let merged = merge_versions(
        world.conn(),
        &[
            // The host's own version, sent back.
            version("{\"host\":1}", "h-host", "2026-09-05T00:00:00.000Z"),
            // An older version only Helm had.
            version("{\"helm\":1}", "h-helm", "2026-09-01T00:00:00.000Z"),
        ],
    )
    .unwrap();
    assert_eq!(merged, CarryMerged { added: 1, kept: 1 });

    let listed = snapshots::list(world.conn(), "C:\\a repo", ".claude/settings.json").unwrap();
    assert_eq!(
        listed
            .iter()
            .map(|meta| (meta.content_hash.as_str(), meta.created_at.as_str()))
            .collect::<Vec<_>>(),
        [
            ("h-host", "2026-09-05T00:00:00.000Z"),
            ("h-helm", "2026-09-01T00:00:00.000Z"),
        ],
        "newest first by when each was taken"
    );
    let copied = snapshots::read(world.conn(), listed[1].id)
        .unwrap()
        .unwrap();
    assert_eq!(copied.content, "{\"helm\":1}");
    let reason: String = world
        .conn()
        .query_row(
            "SELECT reason FROM config_snapshots WHERE content_hash = 'h-helm'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(reason, "approve");

    let again = merge_versions(
        world.conn(),
        &[version(
            "{\"helm\":1}",
            "h-helm",
            "2026-09-01T00:00:00.000Z",
        )],
    )
    .unwrap();
    assert_eq!(again, CarryMerged { added: 0, kept: 1 });
}

fn usage(uuid: &str, input: u64) -> CarriedUsageRow {
    CarriedUsageRow {
        uuid: uuid.to_owned(),
        at: T0,
        model: "claude-opus-5".to_owned(),
        input,
        output: 2,
        cache_write5m: 3,
        cache_write1h: 4,
        cache_read: 5,
    }
}

#[test]
fn usage_the_host_has_for_a_message_is_kept() {
    let world = World::new();
    merge_usage(world.conn(), &[usage("a1", 10)]).unwrap();
    let merged = merge_usage(world.conn(), &[usage("a1", 999), usage("a2", 20)]).unwrap();
    assert_eq!(merged, CarryMerged { added: 1, kept: 1 });
    let kept = crate::usage::read_kept(world.conn(), 0).unwrap();
    let mut inputs: Vec<(String, u64)> =
        kept.into_iter().map(|row| (row.uuid, row.input)).collect();
    inputs.sort();
    assert_eq!(inputs, [("a1".to_owned(), 10), ("a2".to_owned(), 20)]);
}

#[test]
fn finishing_is_recorded_once_and_is_not_a_host_setting() {
    let world = World::new();
    assert_eq!(status(world.conn()).unwrap().finished_at, None);
    let before = settings::read(world.conn()).unwrap();
    let first = finish(world.conn()).unwrap();
    let at = first.finished_at.expect("recorded");
    assert!(at.ends_with('Z'), "{at}");
    assert_eq!(
        finish(world.conn()).unwrap().finished_at.as_deref(),
        Some(at.as_str())
    );
    assert_eq!(status(world.conn()).unwrap().finished_at, Some(at));
    assert_eq!(settings::read(world.conn()).unwrap(), before);
}
