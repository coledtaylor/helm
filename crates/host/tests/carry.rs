//! Helm's own data carried into a real host over `carry:*`, the way Helm's
//! main process sends it: a host whose `floti.db` already holds some of it,
//! a copy that stops part way and is tried again, then everything read back
//! through History, the archive, the config console and usage.
//!
//! The rows sent are a Helm database's: archived conversations whose
//! transcripts are gone, their usage, names given in History and config file
//! versions. Every folder is temporary and every conversation a fixture; no
//! agent runs.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use floti_host::agent::AgentBackend;
use floti_host::agent::claude_code::{ClaudeCodeBackend, ClaudeCodeSettings};
use floti_host::history::archive::{self, ArchiveInput};
use floti_host::platform::process_tree::Native as NativeTree;
use floti_host::server::HostConfig;
use floti_host::store::Store;
use floti_host::testkit::{PATIENCE, RunningHost, TestClient, TestDirs};
use floti_protocol::channel::from_payload;
use floti_protocol::channels::carry::{
    CarriedConfigVersion, CarriedConfigVersions, CarriedConversation, CarriedConversationPart,
    CarriedConversations, CarriedSessionName, CarriedSessionNames, CarriedUsageRow,
    CarriedUsageRows, CarryConversations, CarryFinish, CarryMerged, CarryMissing, CarryNames,
    CarrySessionIds, CarryStatusRead, CarryUsage, CarryVersions,
};
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::sessions::{
    ArchiveConversation, ArchiveMessage, ArchiveRole, ArchiveSessionState, HistoryQuery,
    HistoryRefresh, HistorySession, HistorySessionRef, HistorySessions, ReadArchiveStats,
    ReadUsage, UsageChanged, UsageSnapshot,
};
use floti_protocol::channels::workspace::{
    ListConfigSnapshots, ReadConfigSnapshot, ScopedFile, SnapshotRef,
};
use floti_protocol::{EventChannel, Message};
use serde_json::json;

const ONE: &str = "11111111-1111-4111-8111-111111111111";
const TWO: &str = "22222222-2222-4222-8222-222222222222";
const THREE: &str = "33333333-3333-4333-8333-333333333333";
const FOUR: &str = "44444444-4444-4444-8444-444444444444";
const T0: u64 = 1_760_000_000_000;
const DAY_MS: u64 = 86_400_000;
const SETTINGS: &str = ".claude/settings.json";

/// A home with Claude Code's config folder in it, a project, and the host's
/// data folder, its `floti.db` already holding some of what Helm will send.
struct World {
    dirs: TestDirs,
    config: PathBuf,
    project: PathBuf,
    /// What one of the host's own conversations takes in the archive.
    own_bytes: u64,
    now: u64,
}

impl World {
    fn new() -> Self {
        let dirs = TestDirs::new();
        let config = dirs.home.join(".claude");
        std::fs::create_dir_all(config.join("projects")).unwrap();
        let project = dirs.folder("a repo");
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let mut world = Self {
            dirs,
            config,
            project,
            own_bytes: 0,
            now,
        };
        // Every conversation was recorded in History; none of their
        // transcripts is left.
        for (id, at) in [
            (ONE, T0 + 500),
            (TWO, T0 + 100),
            (THREE, T0),
            (FOUR, T0 - 100),
        ] {
            world.prompt(id, at, "a prompt");
        }
        world.seed_host();
        world
    }

    fn scope(&self) -> String {
        self.project.display().to_string()
    }

    fn prompt(&self, id: &str, at: u64, text: &str) {
        use std::io::Write as _;
        let line = json!({
            "display": text,
            "pastedContents": {},
            "timestamp": at,
            "project": self.project.display().to_string(),
            "sessionId": id,
        });
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.config.join("history.jsonl"))
            .unwrap()
            .write_all(format!("{line}\n").as_bytes())
            .unwrap();
    }

    /// What the host held before Helm sent anything: its own archive of ONE,
    /// a name for it, a version of the settings file, usage of one message,
    /// and an archive limit with room for two conversations and a half.
    fn seed_host(&mut self) {
        let store = Store::open(&self.dirs.data).expect("open the host's store");
        let conn = store.connection();
        archive::archive_transcript(
            conn,
            &ArchiveInput {
                file: "gone.jsonl",
                session_id: ONE,
                bytes: 10,
                messages: &[message("host-1", T0 + 500, &noise(1, 2000))],
            },
        )
        .unwrap();
        self.own_bytes = archive::archived_bytes(conn).unwrap();
        let ceiling = self.own_bytes * 2 + self.own_bytes / 2;
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?, ?)",
            rusqlite::params![archive::CEILING_SETTING, ceiling.to_string()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO history_names (session_id, name) VALUES (?, 'named on the host')",
            [ONE],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO config_snapshots
               (project_path, file_path, content, content_hash, reason, created_at)
             VALUES (?, ?, '{\"host\":true}', 'hash-host', 'edit', '2026-09-05T00:00:00.000Z')",
            rusqlite::params![self.scope(), SETTINGS],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO usage_messages (uuid, at, model, input_tokens, output_tokens)
             VALUES ('shared', ?, 'claude-opus-5', 7, 0)",
            [(self.now - 2 * DAY_MS) as i64],
        )
        .unwrap();
        store.close().unwrap();
    }

    fn config(&self) -> HostConfig {
        let backend = ClaudeCodeBackend::new(
            ClaudeCodeSettings {
                search_first: Vec::new(),
                program: "claude".into(),
                leading_args: Vec::new(),
                config_dir: self.config.clone(),
                pass_config_dir: true,
                api_key_set: false,
            },
            Arc::new(NativeTree),
        );
        HostConfig {
            run: Default::default(),
            folders: self.dirs.folders(),
            endpoint: self.dirs.endpoint(),
            backends: vec![Arc::new(backend) as Arc<dyn AgentBackend>],
            inherited_env: Vec::new(),
        }
    }
}

fn message(uuid: &str, at: u64, text: &str) -> ArchiveMessage {
    ArchiveMessage {
        uuid: uuid.to_owned(),
        role: if uuid.ends_with('1') {
            ArchiveRole::User
        } else {
            ArchiveRole::Assistant
        },
        at,
        text: text.to_owned(),
    }
}

/// `len` characters deflate cannot shorten much, different for each `seed`.
fn noise(seed: u64, len: usize) -> String {
    let mut state = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
    (0..len)
        .map(|_| {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            char::from(b'!' + ((state >> 33) % 94) as u8)
        })
        .collect()
}

/// A conversation as Helm's database holds it.
struct Helms {
    id: &'static str,
    state: ArchiveSessionState,
    messages: Vec<ArchiveMessage>,
}

impl Helms {
    fn row(&self) -> CarriedConversation {
        CarriedConversation {
            session_id: self.id.to_owned(),
            source_file: format!(
                "C:\\Users\\someone\\.claude\\projects\\p\\{}.jsonl",
                self.id
            ),
            state: self.state,
            first_at: self.messages.first().map(|m| m.at).or(Some(T0 - 100)),
            last_at: self.messages.last().map(|m| m.at).or(Some(T0 - 90)),
            message_count: if self.messages.is_empty() {
                4
            } else {
                self.messages.len() as u32
            },
            raw_bytes: 4000,
            stored_bytes: 0,
            captured_at: "2026-09-01T10:00:00.000Z".to_owned(),
            evicted_at: (self.state == ArchiveSessionState::Evicted)
                .then(|| "2026-09-02T10:00:00.000Z".to_owned()),
        }
    }

    /// Part `part`, holding `messages[range]`.
    fn part(
        &self,
        part: u32,
        range: std::ops::Range<usize>,
        last: bool,
    ) -> CarriedConversationPart {
        CarriedConversationPart {
            conversation: self.row(),
            part,
            messages: self.messages[range].to_vec(),
            last,
        }
    }

    fn whole(&self) -> CarriedConversationPart {
        self.part(0, 0..self.messages.len(), true)
    }
}

/// What Helm's database holds.
fn helm_db(
    world: &World,
) -> (
    Vec<Helms>,
    CarriedSessionNames,
    CarriedConfigVersions,
    CarriedUsageRows,
) {
    let conversations = vec![
        // The host archived ONE itself; Helm's copy says something else.
        Helms {
            id: ONE,
            state: ArchiveSessionState::Archived,
            messages: vec![message("helm-1", T0 + 500, "helm's own words")],
        },
        // Larger than one batch: three messages in two parts.
        Helms {
            id: TWO,
            state: ArchiveSessionState::Archived,
            messages: vec![
                message("two-1", T0 + 100, &noise(21, 700)),
                message("two-2", T0 + 101, &noise(22, 700)),
                message("two-3", T0 + 102, &noise(23, 700)),
            ],
        },
        // The oldest: past the host's limit once copied.
        Helms {
            id: THREE,
            state: ArchiveSessionState::Archived,
            messages: vec![message("three-1", T0, &noise(3, 2000))],
        },
        // Already dropped in Helm.
        Helms {
            id: FOUR,
            state: ArchiveSessionState::Evicted,
            messages: Vec::new(),
        },
    ];
    let names = CarriedSessionNames {
        names: vec![
            CarriedSessionName {
                session_id: ONE.to_owned(),
                name: "named in Helm".to_owned(),
                renamed_at: "2026-09-03T10:00:00.000Z".to_owned(),
            },
            CarriedSessionName {
                session_id: TWO.to_uppercase(),
                name: "the release plan".to_owned(),
                renamed_at: "2026-09-03T10:00:00.000Z".to_owned(),
            },
        ],
    };
    let version = |content: &str, hash: &str, created_at: &str| CarriedConfigVersion {
        scope_path: world.scope(),
        file_path: SETTINGS.to_owned(),
        content: content.to_owned(),
        content_hash: hash.to_owned(),
        reason: "edit".to_owned(),
        created_at: created_at.to_owned(),
    };
    let versions = CarriedConfigVersions {
        versions: vec![
            version("{\"host\":true}", "hash-host", "2026-09-05T00:00:00.000Z"),
            version("{\"helm\":true}", "hash-helm", "2026-09-01T00:00:00.000Z"),
        ],
    };
    let usage = |uuid: &str, at: u64, input: u64| CarriedUsageRow {
        uuid: uuid.to_owned(),
        at,
        model: "claude-opus-5".to_owned(),
        input,
        output: 100,
        cache_write5m: 0,
        cache_write1h: 0,
        cache_read: 0,
    };
    let rows = CarriedUsageRows {
        rows: vec![
            usage("two-2", world.now - DAY_MS, 1000),
            usage("two-3", world.now - DAY_MS, 1000),
            usage("shared", world.now - 2 * DAY_MS, 999),
        ],
    };
    (conversations, names, versions, rows)
}

async fn missing(client: &mut TestClient, ids: &[&str]) -> Vec<String> {
    client
        .request::<CarryMissing>(&CarrySessionIds {
            session_ids: ids.iter().map(|id| (*id).to_owned()).collect(),
        })
        .await
        .unwrap()
        .session_ids
}

async fn conversation(
    client: &mut TestClient,
    id: &str,
) -> Option<floti_protocol::channels::sessions::ArchivedConversation> {
    client
        .request::<ArchiveConversation>(&HistorySessionRef {
            session_id: id.to_owned(),
        })
        .await
        .unwrap()
}

fn listed<'a>(sessions: &'a [HistorySession], id: &str) -> &'a HistorySession {
    sessions
        .iter()
        .find(|session| session.session_id.eq_ignore_ascii_case(id))
        .unwrap_or_else(|| panic!("{id} is in History"))
}

#[tokio::test(flavor = "multi_thread")]
async fn helms_data_is_merged_into_a_host_that_already_holds_some_of_it_once_and_survives_a_stopped_copy()
 {
    let world = World::new();
    let (conversations, names, versions, usage) = helm_db(&world);
    let [one, two, three, four] = &conversations[..] else {
        unreachable!()
    };
    let config = world.config();
    let endpoint = config.endpoint.clone();
    let host = RunningHost::start(config);

    // The first attempt: the host has not had Helm's data, and the copy stops
    // after the first part of a conversation, its connection gone.
    let mut first = TestClient::connect(&endpoint, &[]).await;
    let status = first.request::<CarryStatusRead>(&()).await.unwrap();
    assert_eq!(status.finished_at, None);
    let ids = [ONE, TWO, THREE, FOUR];
    assert_eq!(missing(&mut first, &ids).await, [TWO, THREE, FOUR]);
    first
        .request::<CarryConversations>(&CarriedConversations {
            parts: vec![two.part(0, 0..2, false)],
        })
        .await
        .unwrap();
    drop(first);

    // The next start finds it unfinished, with no part of TWO showing.
    let mut client = TestClient::connect(&endpoint, &[]).await;
    let status = client.request::<CarryStatusRead>(&()).await.unwrap();
    assert_eq!(status.finished_at, None);
    assert_eq!(conversation(&mut client, TWO).await, None);
    assert_eq!(missing(&mut client, &ids).await, [TWO, THREE, FOUR]);

    // It runs again, in batches, with other requests answered between them.
    let batch = |parts: Vec<CarriedConversationPart>| CarriedConversations { parts };
    let merged = client
        .request::<CarryConversations>(&batch(vec![one.whole(), two.part(0, 0..2, false)]))
        .await
        .unwrap();
    assert_eq!((merged.added, merged.kept, merged.messages), (0, 1, 2));
    let between = client
        .request::<HistorySessions>(&HistoryQuery::default())
        .await
        .unwrap();
    assert!(between.total <= 4);
    let merged = client
        .request::<CarryConversations>(&batch(vec![
            two.part(1, 2..3, true),
            three.whole(),
            four.whole(),
        ]))
        .await
        .unwrap();
    assert_eq!((merged.added, merged.messages, merged.evicted), (3, 2, 1));
    let merged = client.request::<CarryNames>(&names).await.unwrap();
    assert_eq!(merged, CarryMerged { added: 1, kept: 1 });
    let merged = client.request::<CarryVersions>(&versions).await.unwrap();
    assert_eq!(merged, CarryMerged { added: 1, kept: 1 });
    let merged = client.request::<CarryUsage>(&usage).await.unwrap();
    assert_eq!(merged, CarryMerged { added: 2, kept: 1 });
    let finished = client.request::<CarryFinish>(&()).await.unwrap();
    let at = finished.finished_at.clone().expect("the copy is recorded");
    assert_eq!(
        client.request::<CarryStatusRead>(&()).await.unwrap(),
        finished
    );

    // History: the host's name stands, Helm's is added, and the
    // conversations show what the archive holds of each.
    client.request::<HistoryRefresh>(&()).await.unwrap();
    let page = client
        .request::<HistorySessions>(&HistoryQuery::default())
        .await
        .unwrap();
    assert_eq!(page.total, 4);
    let one_row = listed(&page.sessions, ONE);
    assert_eq!(one_row.label.as_deref(), Some("named on the host"));
    assert_eq!(one_row.archive, Some(ArchiveSessionState::Archived));
    let two_row = listed(&page.sessions, TWO);
    assert_eq!(two_row.label.as_deref(), Some("the release plan"));
    assert_eq!(
        (two_row.archive, two_row.archived_messages),
        (Some(ArchiveSessionState::Archived), Some(3))
    );
    // The oldest went to keep the archive under its limit.
    assert_eq!(
        listed(&page.sessions, THREE).archive,
        Some(ArchiveSessionState::Evicted)
    );
    assert_eq!(
        listed(&page.sessions, FOUR).archive,
        Some(ArchiveSessionState::Evicted)
    );

    // The archive: the host's conversation unchanged, TWO whole and once.
    let kept = conversation(&mut client, ONE).await.unwrap();
    assert_eq!(
        kept.messages
            .iter()
            .map(|m| m.uuid.as_str())
            .collect::<Vec<_>>(),
        ["host-1"]
    );
    let copied = conversation(&mut client, TWO).await.unwrap();
    assert_eq!(copied.messages, two.messages);
    assert_eq!(copied.captured_at, "2026-09-01T10:00:00.000Z");
    let dropped = conversation(&mut client, THREE).await.unwrap();
    assert_eq!(dropped.state, ArchiveSessionState::Evicted);
    assert!(dropped.messages.is_empty());
    let helms_dropped = conversation(&mut client, FOUR).await.unwrap();
    assert_eq!(
        (helms_dropped.state, helms_dropped.message_count),
        (ArchiveSessionState::Evicted, 4)
    );
    let stats = client.request::<ReadArchiveStats>(&()).await.unwrap();
    assert_eq!((stats.sessions, stats.evicted_sessions), (2, 2));
    assert!(stats.stored_bytes <= stats.max_bytes);
    assert_eq!(stats.max_bytes, world.own_bytes * 2 + world.own_bytes / 2);

    // The config console lists both versions, newest first, and opens Helm's.
    let file = ScopedFile {
        scope_path: world.scope(),
        path: world.project.join(SETTINGS).display().to_string(),
    };
    let listed_versions = client.request::<ListConfigSnapshots>(&file).await.unwrap();
    assert_eq!(
        listed_versions
            .iter()
            .map(|meta| meta.content_hash.as_str())
            .collect::<Vec<_>>(),
        ["hash-host", "hash-helm"]
    );
    let opened = client
        .request::<ReadConfigSnapshot>(&SnapshotRef {
            id: listed_versions[1].id,
        })
        .await
        .unwrap()
        .unwrap();
    assert_eq!(opened.content, "{\"helm\":true}");

    // Usage: the week's spend counts the copied usage of TWO, whose
    // transcript is gone, and the host's own row for the shared message.
    let readings = client.request::<ReadUsage>(&()).await.unwrap();
    let spend = readings
        .iter()
        .find_map(|reading| reading.spend.as_ref())
        .expect("a spend over the week");
    assert_eq!((spend.week.messages, spend.week.tokens.input), (3, 2007));

    // Everything sent again merges nothing new, and the record stands.
    let again = client
        .request::<CarryConversations>(&batch(vec![
            one.whole(),
            two.part(0, 0..2, false),
            two.part(1, 2..3, true),
            three.whole(),
            four.whole(),
        ]))
        .await
        .unwrap();
    assert_eq!((again.added, again.messages, again.evicted), (0, 0, 0));
    assert_eq!(client.request::<CarryNames>(&names).await.unwrap().added, 0);
    assert_eq!(
        client
            .request::<CarryVersions>(&versions)
            .await
            .unwrap()
            .added,
        0
    );
    assert_eq!(client.request::<CarryUsage>(&usage).await.unwrap().added, 0);
    assert_eq!(
        client
            .request::<CarryFinish>(&())
            .await
            .unwrap()
            .finished_at,
        Some(at)
    );
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_device_that_is_not_an_admin_cannot_copy_into_the_host() {
    let world = World::new();
    let config = world.config();
    let endpoint = config.endpoint.clone();
    let host = RunningHost::start(config);
    let _admin = TestClient::connect(&endpoint, &[]).await;
    let mut viewer =
        TestClient::connect_as(&endpoint, "a phone", floti_host::devices::Role::Viewer, &[]).await;
    let refused = viewer.request::<CarryFinish>(&()).await.unwrap_err();
    assert!(refused.message.contains("admin"), "{}", refused.message);
    let refused = viewer
        .request::<CarryNames>(&CarriedSessionNames { names: Vec::new() })
        .await
        .unwrap_err();
    assert!(refused.message.contains("admin"), "{}", refused.message);
    host.stop(HostStopReason::Stop).await;
}

/// The readings a `usage:changed` subscription starts with.
fn usage_snapshot(message: Message) -> Vec<UsageSnapshot> {
    match message {
        Message::Snapshot(snapshot) => from_payload(&snapshot.state).unwrap(),
        other => panic!("expected a snapshot, got {other:?}"),
    }
}

/// The next `usage:changed` event on `subscription`.
async fn next_usage(client: &mut TestClient, subscription: u64) -> Vec<UsageSnapshot> {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        match client.next(left).await {
            Some(Message::Event(event)) if event.subscription == subscription => {
                return from_payload(&event.payload).unwrap();
            }
            Some(_) => {}
            None => panic!("no usage reading within {PATIENCE:?}"),
        }
    }
}

fn week_messages(readings: &[UsageSnapshot]) -> u32 {
    readings
        .iter()
        .find_map(|reading| reading.spend.as_ref())
        .expect("a spend over the week")
        .week
        .messages
}

#[tokio::test(flavor = "multi_thread")]
async fn usage_copied_from_helm_is_counted_in_the_next_reading_every_subscriber_receives() {
    let world = World::new();
    let config = world.config();
    let endpoint = config.endpoint.clone();
    let host = RunningHost::start(config);
    let mut copier = TestClient::connect(&endpoint, &[]).await;
    let mut watcher = TestClient::connect(&endpoint, &[]).await;

    // The host's own kept row is counted from the start.
    let first = usage_snapshot(copier.subscribe_on(7, UsageChanged::NAME).await);
    assert_eq!(week_messages(&first), 1);
    let watched = usage_snapshot(watcher.subscribe_on(8, UsageChanged::NAME).await);
    assert_eq!(week_messages(&watched), 1);

    let row = |uuid: &str, at: u64| CarriedUsageRow {
        uuid: uuid.to_owned(),
        at,
        model: "claude-opus-5".to_owned(),
        input: 1000,
        output: 100,
        cache_write5m: 0,
        cache_write1h: 0,
        cache_read: 0,
    };
    let merged = copier
        .request::<CarryUsage>(&CarriedUsageRows {
            rows: vec![
                row("copied-1", world.now - DAY_MS),
                row("copied-2", world.now - 3 * DAY_MS),
            ],
        })
        .await
        .unwrap();
    assert_eq!(merged, CarryMerged { added: 2, kept: 0 });

    assert_eq!(week_messages(&next_usage(&mut copier, 7).await), 3);
    assert_eq!(week_messages(&next_usage(&mut watcher, 8).await), 3);
    let read = copier.request::<ReadUsage>(&()).await.unwrap();
    assert_eq!(week_messages(&read), 3);
    host.stop(HostStopReason::Stop).await;
}
