//! History and the transcript archive, against today's app: the cases
//! core's tests check for the history index (`store/history.test.ts`), the
//! archive (`store/archive.test.ts`) and the service around them
//! (`main/history.test.ts`), with the same inputs and expectations, then the
//! same through a real host on its socket.
//!
//! Every folder is temporary: the data folder with `floti.db`, the home and
//! the agent's config folder in it. No agent runs; the transcripts are
//! written as Claude Code writes them.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use floti_host::Result;
use floti_host::agent::claude_code::{ClaudeCodeBackend, ClaudeCodeSettings};
use floti_host::agent::{AgentBackend, Conversation, HistorySource, Transcript};
use floti_host::history::archive::{self, ArchiveInput};
use floti_host::history::index::{HistoryIndex, IndexInput, PromptLine, TranscriptFile};
use floti_host::history::{index_history, read_indexed};
use floti_host::platform::process_tree::Native as NativeTree;
use floti_host::server::{Host, HostConfig};
use floti_host::store::Store;
use floti_host::testkit::{PATIENCE, TestClient, TestDirs};
use floti_protocol::channel::from_payload;
use floti_protocol::channels::sessions::{
    ArchiveChanged, ArchiveConversation, ArchiveMessage, ArchiveRole, ArchiveSessionState,
    ArchiveStats, HistoryChanged, HistoryPage, HistoryProjects, HistoryPrompts, HistoryQuery,
    HistoryRefresh, HistoryRename, HistorySearchScope, HistorySession, HistorySessionRef,
    HistorySessions, HistorySummary, ReadArchiveStats, ReadHistorySummary,
    RenameHistorySessionRequest,
};
use floti_protocol::{BackendId, EventChannel, Message, Payload};
use serde_json::json;

// ---------------------------------------------------------------------------
// The index on its own
// ---------------------------------------------------------------------------

/// The record the index tests feed, as a path on any OS.
const RECORD: &str = "history.jsonl";

/// A store in a temporary data folder.
struct Indexed {
    _dirs: TestDirs,
    store: Store,
    backend: BackendId,
    alpha: String,
    beta: String,
    clock: u64,
    transcripts_dir: PathBuf,
}

/// One prompt to index; `project` and `at` default as core's tests do.
struct Prompt<'a> {
    session: &'a str,
    text: &'a str,
    project: Option<&'a str>,
}

fn p<'a>(session: &'a str, text: &'a str) -> Prompt<'a> {
    Prompt {
        session,
        text,
        project: None,
    }
}

fn pin<'a>(session: &'a str, text: &'a str, project: &'a str) -> Prompt<'a> {
    Prompt {
        session,
        text,
        project: Some(project),
    }
}

#[derive(Default)]
struct Pass<'a> {
    transcripts: &'a [&'a str],
    missing: &'a [&'a str],
    bytes: Option<u64>,
    reset: bool,
    error: Option<&'a str>,
}

impl Indexed {
    fn new() -> Self {
        let dirs = TestDirs::new();
        let store = Store::open(&dirs.data).expect("open the store");
        Self {
            alpha: dirs.folder("repos/alpha").display().to_string(),
            beta: dirs.folder("repos/beta").display().to_string(),
            transcripts_dir: dirs.folder("transcripts"),
            store,
            backend: BackendId::claude_code(),
            clock: 1_700_000_000_000,
            _dirs: dirs,
        }
    }

    fn index(&self) -> HistoryIndex<'_> {
        HistoryIndex::new(self.store.connection(), &self.backend)
    }

    fn transcripts(&self, ids: &[&str]) -> BTreeMap<String, TranscriptFile> {
        ids.iter()
            .map(|id| {
                (
                    id.to_lowercase(),
                    TranscriptFile {
                        file: self
                            .transcripts_dir
                            .join(format!("{id}.jsonl"))
                            .display()
                            .to_string(),
                        bytes: 1234,
                    },
                )
            })
            .collect()
    }

    fn pass(&mut self, prompts: &[Prompt<'_>], pass: Pass<'_>) -> HistorySummary {
        let lines: Vec<PromptLine> = prompts
            .iter()
            .map(|prompt| {
                self.clock += 1000;
                PromptLine {
                    session_id: prompt.session.to_owned(),
                    project: prompt.project.unwrap_or(&self.alpha).to_owned(),
                    at: self.clock,
                    text: prompt.text.to_owned(),
                }
            })
            .collect();
        let missing: BTreeSet<String> = pass.missing.iter().map(|p| p.to_lowercase()).collect();
        let transcripts = self.transcripts(pass.transcripts);
        self.index()
            .index(&IndexInput {
                record: RECORD,
                bytes: pass.bytes.unwrap_or(100),
                reset: pass.reset,
                replaced: &BTreeSet::new(),
                lines: &lines,
                transcripts: &transcripts,
                directory_exists: &|folder| !missing.contains(&folder.to_lowercase()),
                error: pass.error.map(str::to_owned),
            })
            .expect("index a pass")
    }

    fn sessions(&self, query: HistoryQuery) -> HistoryPage {
        self.index().sessions(&query).expect("read sessions")
    }

    fn all(&self) -> HistoryPage {
        self.sessions(HistoryQuery::default())
    }

    fn session(&self, id: &str) -> Option<HistorySession> {
        self.index().session(id).expect("read a session")
    }

    fn search(&self, search: &str) -> HistoryPage {
        self.sessions(HistoryQuery {
            search: Some(search.to_owned()),
            ..HistoryQuery::default()
        })
    }

    fn sql_count(&self, sql: &str) -> i64 {
        self.store
            .connection()
            .query_row(sql, [], |row| row.get(0))
            .unwrap()
    }
}

fn ids(page: &HistoryPage) -> Vec<&str> {
    page.sessions
        .iter()
        .map(|session| session.session_id.as_str())
        .collect()
}

fn can_resume(session: &HistorySession) -> bool {
    session.transcript_file.is_some() && session.project_exists
}

#[test]
fn a_record_of_prompts_becomes_sessions_ordered_by_recency() {
    let mut world = Indexed::new();
    let beta = world.beta.clone();
    world.pass(
        &[
            p("a", "first thing"),
            p("a", "second thing"),
            pin("b", "another session", &beta),
        ],
        Pass::default(),
    );
    let page = world.all();
    assert_eq!(page.total, 2);
    assert_eq!(ids(&page), ["b", "a"]);
    let a = &page.sessions[1];
    assert_eq!(a.project, world.alpha);
    assert_eq!(a.project_name, "alpha");
    assert_eq!(a.prompt_count, 2);
    assert_eq!(a.first_prompt, "first thing");
    assert_eq!(a.backend, BackendId::claude_code());
}

#[test]
fn the_cursor_is_recorded_so_the_next_pass_can_resume_from_it() {
    let mut world = Indexed::new();
    world.pass(
        &[p("a", "x")],
        Pass {
            bytes: Some(4096),
            ..Pass::default()
        },
    );
    assert_eq!(world.index().cursor(RECORD).unwrap(), 4096);
    assert_eq!(world.index().cursor("somewhere else.jsonl").unwrap(), 0);
}

#[test]
fn an_appended_pass_merges_into_the_sessions_already_indexed() {
    let mut world = Indexed::new();
    world.pass(&[p("a", "first")], Pass::default());
    world.pass(
        &[p("a", "follow up"), p("c", "new session")],
        Pass::default(),
    );
    let page = world.all();
    assert_eq!(page.sessions.len(), 2);
    let a = page.sessions.iter().find(|s| s.session_id == "a").unwrap();
    assert_eq!(a.prompt_count, 2);
    // The opening prompt is the opening prompt, not the most recent one.
    assert_eq!(a.first_prompt, "first");
    assert!(a.last_at > a.first_at);
}

#[test]
fn everything_is_discarded_when_the_record_has_been_replaced() {
    let mut world = Indexed::new();
    world.pass(&[p("a", "old world")], Pass::default());
    world.pass(
        &[p("z", "new world")],
        Pass {
            reset: true,
            ..Pass::default()
        },
    );
    assert_eq!(ids(&world.all()), ["z"]);
    assert!(world.index().prompts("a").unwrap().is_empty());
}

#[test]
fn a_session_is_resumable_only_when_its_transcript_and_its_folder_are_both_there() {
    let mut world = Indexed::new();
    let beta = world.beta.clone();
    world.pass(
        &[
            p("kept", "has a transcript"),
            p("reaped", "transcript is gone"),
            pin("homeless", "project is gone", &beta),
        ],
        Pass {
            transcripts: &["kept", "homeless"],
            missing: &[&beta],
            ..Pass::default()
        },
    );
    let kept = world.session("kept").unwrap();
    assert!(can_resume(&kept));
    assert_eq!(kept.transcript_bytes, Some(1234));
    // Reaped: history only, and its prompts still there to read.
    let reaped = world.session("reaped").unwrap();
    assert_eq!(reaped.transcript_file, None);
    assert!(!can_resume(&reaped));
    // The transcript survived and its folder did not, which a resume cannot
    // work around.
    let homeless = world.session("homeless").unwrap();
    assert!(homeless.transcript_file.is_some());
    assert!(!homeless.project_exists);
    assert!(!can_resume(&homeless));
}

#[test]
fn a_transcript_reaped_since_the_last_pass_is_noticed() {
    let mut world = Indexed::new();
    world.pass(
        &[p("a", "x")],
        Pass {
            transcripts: &["a"],
            ..Pass::default()
        },
    );
    assert!(world.session("a").unwrap().transcript_file.is_some());
    // Nothing new in the record; the transcript is simply gone.
    let summary = world.pass(&[], Pass::default());
    assert_eq!(world.session("a").unwrap().transcript_file, None);
    assert_eq!(summary.resumable, 0);
}

#[test]
fn a_transcript_matches_its_session_whatever_case_the_id_was_written_in() {
    let mut world = Indexed::new();
    world.pass(
        &[p("AbC", "x")],
        Pass {
            transcripts: &["aBc"],
            ..Pass::default()
        },
    );
    assert!(world.session("AbC").unwrap().transcript_file.is_some());
}

#[test]
fn a_folder_recorded_under_two_casings_is_one_project() {
    let mut world = Indexed::new();
    world.pass(
        &[
            pin("a", "x", "C:\\repos\\Alpha"),
            pin("b", "y", "C:\\repos\\alpha"),
        ],
        Pass::default(),
    );
    let projects = world.index().projects().unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!((projects[0].sessions, projects[0].prompts), (2, 2));
    assert!(!projects[0].name.is_empty());
}

#[test]
fn running_a_pass_again_changes_nothing() {
    let mut world = Indexed::new();
    let first = world.pass(
        &[p("a", "x")],
        Pass {
            transcripts: &["a"],
            ..Pass::default()
        },
    );
    let again = world.pass(
        &[],
        Pass {
            transcripts: &["a"],
            bytes: Some(first.indexed_bytes),
            ..Pass::default()
        },
    );
    assert_eq!(again, first);
}

#[test]
fn a_read_error_is_reported_without_losing_what_was_indexed() {
    let mut world = Indexed::new();
    world.pass(&[p("a", "x")], Pass::default());
    let summary = world.pass(
        &[],
        Pass {
            error: Some("EBUSY"),
            ..Pass::default()
        },
    );
    assert_eq!(summary.error.as_deref(), Some("EBUSY"));
    assert_eq!(summary.sessions, 1);
}

/// Core's fixture for reading sessions.
fn searchable() -> Indexed {
    let mut world = Indexed::new();
    let beta = world.beta.clone();
    world.pass(
        &[
            p("a", "add geofencing to the map"),
            p("a", "now write the tests"),
            pin("b", "fix the geofence radius", &beta),
            p("c", "unrelated work"),
            p("d", "50% of the rows are _wrong_"),
        ],
        Pass {
            transcripts: &["a"],
            ..Pass::default()
        },
    );
    world
}

#[test]
fn a_search_filters_by_a_substring_of_any_prompt_in_the_session() {
    let world = searchable();
    let page = world.search("geofenc");
    assert_eq!(page.total, 2);
    let mut found = ids(&page);
    found.sort_unstable();
    assert_eq!(found, ["a", "b"]);
}

#[test]
fn a_search_matches_case_insensitively_and_says_which_prompt_matched() {
    let world = searchable();
    let page = world.search("WRITE THE TESTS");
    assert_eq!(page.sessions.len(), 1);
    assert_eq!(
        page.sessions[0].matched.as_deref(),
        Some("now write the tests")
    );
    assert_eq!(page.sessions[0].first_prompt, "add geofencing to the map");
}

#[test]
fn nothing_searched_for_leaves_the_match_unset() {
    assert_eq!(searchable().all().sessions[0].matched, None);
}

#[test]
fn like_wildcards_in_the_search_box_are_literal_characters() {
    let world = searchable();
    assert_eq!(world.search("50%").total, 1);
    assert_eq!(world.search("_wrong_").total, 1);
    assert_eq!(world.search("%").total, 1);
    assert_eq!(world.search("r_ws").total, 0);
}

#[test]
fn a_project_filter_ignores_case() {
    let world = searchable();
    let by = |project: String| {
        world
            .sessions(HistoryQuery {
                project: Some(project),
                ..HistoryQuery::default()
            })
            .total
    };
    assert_eq!(by(world.beta.clone()), 1);
    assert_eq!(by(world.beta.to_uppercase()), 1);
}

#[test]
fn a_search_matches_the_project_path_as_well_as_the_prompts() {
    let world = searchable();
    // No prompt says "beta"; only the folder session b ran in does.
    let page = world.search("beta");
    assert_eq!(page.total, 1);
    assert_eq!(page.sessions[0].session_id, "b");
    assert_eq!(world.search("BETA").total, 1);
    // The tail of the path, separator and all, in another case.
    let tail = world.beta[world.beta.len() - "repos/beta".len()..].to_uppercase();
    assert_eq!(world.search(&tail).total, 1);
}

#[test]
fn a_session_matching_by_project_and_prompt_is_counted_once() {
    let world = searchable();
    assert_eq!(world.search("geofenc").total, 2);
    let page = world.search("e");
    assert_eq!(page.total as usize, page.sessions.len());
    let unique: BTreeSet<&str> = ids(&page).into_iter().collect();
    assert_eq!(unique.len(), page.sessions.len());
}

#[test]
fn resumable_only_lists_what_can_actually_be_resumed() {
    let page = searchable().sessions(HistoryQuery {
        resumable_only: Some(true),
        ..HistoryQuery::default()
    });
    assert_eq!(page.total, 1);
    assert_eq!(page.sessions[0].session_id, "a");
}

#[test]
fn the_match_count_is_reported_apart_from_the_page() {
    let page = searchable().sessions(HistoryQuery {
        limit: Some(2),
        ..HistoryQuery::default()
    });
    assert_eq!(page.sessions.len(), 2);
    assert_eq!(page.total, 4);
    assert!(page.took_ms >= 0.0);
}

#[test]
fn a_session_is_titled_from_the_first_prompt_that_says_something() {
    let mut world = Indexed::new();
    world.pass(
        &[
            p("a", "/usage"),
            p("a", "[Image #1]"),
            p("a", "why is the status bar blank on a fresh install"),
        ],
        Pass::default(),
    );
    let session = world.session("a").unwrap();
    assert_eq!(
        session.title,
        "why is the status bar blank on a fresh install"
    );
    assert!(!session.title_fallback);
    assert_eq!(session.first_prompt, "/usage");
}

#[test]
fn a_title_falls_back_to_something_legible_when_no_prompt_says_anything() {
    let mut world = Indexed::new();
    world.pass(&[p("a", "/usage")], Pass::default());
    let a = world.session("a").unwrap();
    assert_eq!((a.title.as_str(), a.title_fallback), ("/usage", false));
    world.pass(&[p("b", "[Image #1]")], Pass::default());
    let b = world.session("b").unwrap();
    assert_eq!((b.title.as_str(), b.title_fallback), ("Image only", true));
}

#[test]
fn a_later_pass_with_a_better_prompt_retitles_the_session() {
    let mut world = Indexed::new();
    world.pass(&[p("a", "/usage")], Pass::default());
    assert_eq!(world.session("a").unwrap().title, "/usage");
    world.pass(&[p("a", "rename the profiles pane")], Pass::default());
    assert_eq!(
        world.session("a").unwrap().title,
        "rename the profiles pane"
    );
}

#[test]
fn prompts_an_older_build_left_unranked_are_ranked() {
    let mut world = Indexed::new();
    world.pass(
        &[p("a", "/usage"), p("a", "add geofencing to the map")],
        Pass::default(),
    );
    let conn = world.store.connection();
    conn.execute("UPDATE history_prompts SET title_rank = NULL", [])
        .unwrap();
    conn.execute("UPDATE history_sessions SET title_prompt = NULL", [])
        .unwrap();
    assert_eq!(world.session("a").unwrap().title, "/usage");
    // A pass with nothing new is enough.
    world.pass(&[], Pass::default());
    assert_eq!(
        world.session("a").unwrap().title,
        "add geofencing to the map"
    );
}

fn renamable() -> Indexed {
    let mut world = Indexed::new();
    let beta = world.beta.clone();
    world.pass(
        &[
            p("a", "/usage"),
            p("a", "add geofencing to the map"),
            pin("b", "unrelated work", &beta),
        ],
        Pass::default(),
    );
    world
}

#[test]
fn a_name_given_by_hand_is_what_the_list_shows() {
    let world = renamable();
    let renamed = world
        .index()
        .rename("a", Some("  Geofencing  "))
        .unwrap()
        .unwrap();
    assert_eq!(renamed.label.as_deref(), Some("Geofencing"));
    // The derived title is still there, which is what makes clearing it work.
    assert_eq!(renamed.title, "add geofencing to the map");
    let page = world.all();
    let label = |id: &str| {
        page.sessions
            .iter()
            .find(|s| s.session_id == id)
            .unwrap()
            .label
            .clone()
    };
    assert_eq!(label("a").as_deref(), Some("Geofencing"));
    assert_eq!(label("b"), None);
}

#[test]
fn a_name_survives_a_full_reindex() {
    let mut world = renamable();
    world.index().rename("a", Some("Geofencing")).unwrap();
    world.pass(
        &[p("a", "add geofencing to the map")],
        Pass {
            reset: true,
            ..Pass::default()
        },
    );
    assert_eq!(
        world.session("a").unwrap().label.as_deref(),
        Some("Geofencing")
    );
}

#[test]
fn clearing_a_name_returns_the_row_to_its_derived_title() {
    let world = renamable();
    world.index().rename("a", Some("Geofencing")).unwrap();
    let cleared = world.index().rename("a", Some("   ")).unwrap().unwrap();
    assert_eq!(cleared.label, None);
    assert_eq!(cleared.title, "add geofencing to the map");
    assert_eq!(world.sql_count("SELECT COUNT(*) FROM history_names"), 0);
}

#[test]
fn a_session_is_found_by_the_name_it_was_given() {
    let world = renamable();
    world
        .index()
        .rename("a", Some("Monarch budget spike"))
        .unwrap();
    let page = world.search("monarch");
    assert_eq!(page.total, 1);
    assert_eq!(page.sessions[0].session_id, "a");
}

#[test]
fn a_name_is_keyed_on_the_id_whatever_case_it_is_given_with() {
    let world = renamable();
    world.index().rename("A", Some("Geofencing")).unwrap();
    assert_eq!(
        world.session("a").unwrap().label.as_deref(),
        Some("Geofencing")
    );
}

#[test]
fn a_name_loses_the_characters_that_would_corrupt_its_row() {
    let world = renamable();
    let renamed = world
        .index()
        .rename("a", Some("alpha beta\u{200B}gamma"))
        .unwrap()
        .unwrap();
    assert_eq!(renamed.label.as_deref(), Some("alpha beta gamma"));
}

#[test]
fn renaming_a_session_the_index_does_not_have_answers_null() {
    let world = renamable();
    assert_eq!(
        world.index().rename("nope", Some("whatever")).unwrap(),
        None
    );
    assert_eq!(world.sql_count("SELECT COUNT(*) FROM history_names"), 0);
}

#[test]
fn a_sessions_prompts_come_in_submission_order() {
    let mut world = Indexed::new();
    world.pass(
        &[
            p("a", "one"),
            p("b", "other session"),
            p("a", "two"),
            p("a", "three"),
        ],
        Pass::default(),
    );
    let texts: Vec<String> = world
        .index()
        .prompts("a")
        .unwrap()
        .into_iter()
        .map(|prompt| prompt.text)
        .collect();
    assert_eq!(texts, ["one", "two", "three"]);
    assert!(world.index().prompts("nope").unwrap().is_empty());
}

#[test]
fn the_summary_counts_what_the_launcher_puts_on_screen() {
    let mut world = Indexed::new();
    let beta = world.beta.clone();
    world.pass(
        &[p("a", "x"), p("a", "y"), pin("b", "z", &beta)],
        Pass {
            transcripts: &["a"],
            bytes: Some(900),
            ..Pass::default()
        },
    );
    let summary = world.index().summary(RECORD).unwrap();
    assert_eq!(
        (
            summary.sessions,
            summary.prompts,
            summary.projects,
            summary.resumable
        ),
        (2, 3, 2, 1)
    );
    assert_eq!(summary.history_file, RECORD);
    assert_eq!(summary.indexed_bytes, 900);
}

#[test]
fn the_summary_is_empty_rather_than_broken_before_anything_is_indexed() {
    let world = Indexed::new();
    let summary = world.index().summary(RECORD).unwrap();
    assert_eq!(
        (
            summary.sessions,
            summary.prompts,
            summary.resumable,
            summary.latest_at,
            summary.indexed_bytes
        ),
        (0, 0, 0, None, 0)
    );
}

/// The bound a keystroke has to beat. What this catches is a search that
/// stopped using the index or started doing a query per row, not a busy
/// machine: each term's best of eight runs is held to the bound, so a test
/// run sharing the processor with every other test does not fail it.
#[test]
fn a_search_over_thousands_of_prompts_answers_within_a_keystroke() {
    let mut world = Indexed::new();
    let (alpha, beta) = (world.alpha.clone(), world.beta.clone());
    let subjects = [
        "geofencing",
        "the parser",
        "release notes",
        "a flaky test",
        "the schema",
    ];
    let texts: Vec<String> = (0..3200)
        .map(|n| format!("prompt {n} about {}", subjects[n % subjects.len()]))
        .collect();
    let sessions: Vec<String> = (0..800).map(|n| format!("s{n}")).collect();
    let prompts: Vec<Prompt<'_>> = texts
        .iter()
        .enumerate()
        .map(|(n, text)| {
            let project = if n % 2 == 0 { &alpha } else { &beta };
            pin(&sessions[n % sessions.len()], text, project)
        })
        .collect();
    let summary = world.pass(&prompts, Pass::default());
    assert_eq!((summary.sessions, summary.prompts), (800, 3200));
    for term in [
        "geofenc",
        "parser",
        "prompt 31",
        "nothing matches this",
        "beta",
    ] {
        let best = (0..8)
            .map(|_| world.search(term).took_ms)
            .fold(f64::INFINITY, f64::min);
        assert!(best < 100.0, "a search for {term:?} took {best} ms at best");
    }
}

// ---------------------------------------------------------------------------
// The archive on its own
// ---------------------------------------------------------------------------

struct Archive {
    _dirs: TestDirs,
    store: Store,
    next_uuid: u64,
}

impl Archive {
    fn new() -> Self {
        let dirs = TestDirs::new();
        Self {
            store: Store::open(&dirs.data).expect("open the store"),
            _dirs: dirs,
            next_uuid: 0,
        }
    }

    fn conn(&self) -> &rusqlite::Connection {
        self.store.connection()
    }

    fn message(&mut self, role: ArchiveRole, at: u64, text: &str) -> ArchiveMessage {
        self.next_uuid += 1;
        ArchiveMessage {
            uuid: format!("00000000-0000-4000-8000-{:012x}", self.next_uuid),
            role,
            at: 1_760_000_000_000 + at,
            text: text.to_owned(),
        }
    }

    fn user(&mut self, at: u64, text: &str) -> ArchiveMessage {
        self.message(ArchiveRole::User, at, text)
    }

    fn archive(
        &self,
        file: &str,
        session: &str,
        messages: &[ArchiveMessage],
    ) -> archive::ArchiveWrite {
        archive::archive_transcript(
            self.conn(),
            &ArchiveInput {
                file,
                session_id: session,
                bytes: messages.len() as u64 * 100,
                messages,
            },
        )
        .expect("archive a transcript")
    }

    fn texts(&self, session: &str) -> Vec<String> {
        archive::read_conversation(self.conn(), session)
            .unwrap()
            .unwrap()
            .messages
            .into_iter()
            .map(|message| message.text)
            .collect()
    }

    /// Four sessions, oldest first, each big enough to be worth evicting.
    fn fill(&mut self) {
        for (index, name) in ["oldest", "older", "newer", "newest"].iter().enumerate() {
            let text = format!("conversation {name} ").repeat(60);
            let message = self.user(index as u64 * 1000, &text);
            self.archive(&format!("{name}.jsonl"), name, &[message]);
        }
    }

    fn bytes(&self) -> u64 {
        archive::archived_bytes(self.conn()).unwrap()
    }

    fn state(&self, session: &str) -> Option<ArchiveSessionState> {
        archive::state_of(self.conn(), session).unwrap()
    }

    fn search(&self, search: &str) -> BTreeMap<String, String> {
        archive::search_archive(self.conn(), search, 2000).unwrap()
    }
}

#[test]
fn a_transcript_offered_again_adds_exactly_the_messages_it_grew_by() {
    let mut world = Archive::new();
    let first = vec![
        world.user(1, "hello"),
        world.message(ArchiveRole::Assistant, 2, "one"),
    ];
    assert_eq!(world.archive("grown.jsonl", "sess", &first).messages, 2);
    let mut grown = first.clone();
    grown.push(world.user(3, "two"));
    grown.push(world.message(ArchiveRole::Assistant, 4, "three"));
    assert_eq!(world.archive("grown.jsonl", "sess", &grown).messages, 2);
    assert_eq!(world.texts("sess"), ["hello", "one", "two", "three"]);
    assert_eq!(
        archive::cursor(world.conn(), "grown.jsonl").unwrap(),
        Some(400)
    );
}

#[test]
fn a_message_a_fork_put_in_a_second_transcript_is_counted_once() {
    let mut world = Archive::new();
    let shared = world.user(1, "hello");
    let parent = [shared.clone(), world.user(2, "parent")];
    world.archive("parent.jsonl", "sess", &parent);
    let fork = [shared, world.user(3, "fork")];
    assert_eq!(world.archive("fork.jsonl", "sess", &fork).messages, 1);
    let conversation = archive::read_conversation(world.conn(), "sess")
        .unwrap()
        .unwrap();
    assert_eq!(conversation.message_count, 3);
}

#[test]
fn a_cursor_for_a_transcript_that_has_gone_is_forgotten_and_its_conversation_kept() {
    let mut world = Archive::new();
    let messages = [world.user(1, "hello")];
    world.archive("reaped.jsonl", "sess", &messages);
    assert!(
        archive::indexed_files(world.conn())
            .unwrap()
            .contains_key("reaped.jsonl")
    );
    let gone = ["reaped.jsonl".to_owned()];
    assert_eq!(archive::forget_files(world.conn(), &gone).unwrap(), 1);
    assert!(
        !archive::indexed_files(world.conn())
            .unwrap()
            .contains_key("reaped.jsonl")
    );
    assert_eq!(world.texts("sess").len(), 1);
}

#[test]
fn a_short_body_is_stored_as_it_is_and_comes_back_byte_for_byte() {
    let mut world = Archive::new();
    let long = "the quick brown fox jumps over the lazy dog. ".repeat(40);
    let messages = [world.user(1, "short"), world.user(2, long.trim())];
    world.archive("sizes.jsonl", "sess", &messages);
    let rows: Vec<(bool, i64, i64)> = world
        .conn()
        .prepare("SELECT compressed, raw_bytes, stored_bytes FROM transcript_messages ORDER BY at")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert!(!rows[0].0);
    assert_eq!(rows[0].1, rows[0].2);
    assert_eq!(world.texts("sess")[1], long.trim());
}

#[test]
fn a_token_planted_in_the_middle_of_a_conversation_is_found() {
    let mut world = Archive::new();
    let messages = [
        world.user(1, "opening question"),
        world.message(ArchiveRole::Assistant, 2, "the answer is zorblatt"),
        world.user(3, "closing remark"),
    ];
    world.archive("search.jsonl", "sess", &messages);
    assert_eq!(
        world.search("zorblatt").into_keys().collect::<Vec<_>>(),
        ["sess"]
    );
    assert!(world.search("zorbl")["sess"].contains("zorblatt"));
    assert!(world.search("nothinglikethis").is_empty());
}

#[test]
fn a_message_search_finds_it_through_the_history_list_and_a_prompt_search_does_not() {
    let mut world = Archive::new();
    let backend = BackendId::claude_code();
    let index = HistoryIndex::new(world.store.connection(), &backend);
    let lines: Vec<PromptLine> = ["opening question", "closing remark"]
        .iter()
        .enumerate()
        .map(|(n, text)| PromptLine {
            session_id: "sess".to_owned(),
            project: "folder".to_owned(),
            at: 1_760_000_000_000 + n as u64,
            text: (*text).to_owned(),
        })
        .collect();
    index
        .index(&IndexInput {
            record: RECORD,
            bytes: 100,
            reset: false,
            replaced: &BTreeSet::new(),
            lines: &lines,
            transcripts: &BTreeMap::new(),
            directory_exists: &|_| true,
            error: None,
        })
        .unwrap();
    let messages = [
        world.user(1, "opening question"),
        world.message(ArchiveRole::Assistant, 2, "the answer is zorblatt"),
        world.user(3, "closing remark"),
    ];
    world.archive("scoped.jsonl", "sess", &messages);
    let index = HistoryIndex::new(world.store.connection(), &backend);
    let scoped = |scope| {
        index
            .sessions(&HistoryQuery {
                search: Some("zorblatt".to_owned()),
                scope: Some(scope),
                ..HistoryQuery::default()
            })
            .unwrap()
    };
    let found = scoped(HistorySearchScope::Messages);
    assert_eq!(
        found
            .sessions
            .iter()
            .map(|s| (s.session_id.as_str(), s.matched.as_deref()))
            .collect::<Vec<_>>(),
        [("sess", Some("the answer is zorblatt"))]
    );
    assert_eq!(scoped(HistorySearchScope::Prompts).total, 0);
}

#[test]
fn input_fts5_would_refuse_matches_nothing_rather_than_failing() {
    let mut world = Archive::new();
    let messages = [world.user(1, "ordinary words")];
    world.archive("odd.jsonl", "sess", &messages);
    for term in ["\"", "(", "NEAR(", "a AND", "*", "^"] {
        archive::search_archive(world.conn(), term, 2000).expect("no failure");
    }
}

#[test]
fn a_conversation_the_ceiling_dropped_is_no_longer_found() {
    let mut world = Archive::new();
    let messages = [world.user(1, &"the word is zorblatt ".repeat(20))];
    world.archive("gone.jsonl", "sess", &messages);
    assert_eq!(world.search("zorblatt").len(), 1);
    archive::evict_to_ceiling(world.conn(), 0).unwrap();
    assert!(world.search("zorblatt").is_empty());
}

#[test]
fn the_ceiling_drops_the_oldest_session_whole_and_only_as_far_as_it_has_to() {
    let mut world = Archive::new();
    world.fill();
    let each = world.bytes() as f64 / 4.0;
    let ceiling = (each * 3.5).round() as u64;
    let eviction = archive::evict_to_ceiling(world.conn(), ceiling).unwrap();
    assert_eq!(eviction.sessions, ["oldest"]);
    assert!(world.bytes() <= ceiling);
    assert_eq!(world.state("older"), Some(ArchiveSessionState::Archived));
    assert_eq!(world.state("newest"), Some(ArchiveSessionState::Archived));
}

#[test]
fn the_ceiling_never_leaves_half_a_conversation_behind() {
    let mut world = Archive::new();
    let messages: Vec<ArchiveMessage> = (0..12)
        .map(|n| world.user(n, &format!("part {n} ").repeat(40)))
        .collect();
    world.archive("many.jsonl", "wide", &messages);
    let total = world.bytes();
    archive::evict_to_ceiling(world.conn(), total / 2).unwrap();
    let kept: i64 = world
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM transcript_messages WHERE session_id = 'wide'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(kept, 0);
    assert_eq!(world.state("wide"), Some(ArchiveSessionState::Evicted));
}

#[test]
fn a_session_the_ceiling_dropped_is_told_from_one_it_never_had() {
    let mut world = Archive::new();
    world.fill();
    let ceiling = (world.bytes() as f64 * 0.6).round() as u64;
    archive::evict_to_ceiling(world.conn(), ceiling).unwrap();
    assert_eq!(world.state("oldest"), Some(ArchiveSessionState::Evicted));
    assert_eq!(world.state("never-seen"), None);
    let dropped = archive::read_conversation(world.conn(), "oldest")
        .unwrap()
        .unwrap();
    assert_eq!(dropped.state, ArchiveSessionState::Evicted);
    assert!(dropped.messages.is_empty());
    assert!(dropped.message_count > 0);
    assert!(dropped.evicted_at.is_some());
    assert_eq!(dropped.stored_bytes, 0);
    assert_eq!(
        archive::read_conversation(world.conn(), "never-seen").unwrap(),
        None
    );
}

#[test]
fn what_the_ceiling_just_dropped_is_not_archived_again() {
    let mut world = Archive::new();
    let messages = [world.user(1, &"body ".repeat(80))];
    world.archive("again.jsonl", "sess", &messages);
    archive::evict_to_ceiling(world.conn(), 0).unwrap();
    // The transcript replaced, which offers every row it ever had again.
    world
        .conn()
        .execute(
            "DELETE FROM transcript_index WHERE file = 'again.jsonl'",
            [],
        )
        .unwrap();
    let again = world.archive("again.jsonl", "sess", &messages);
    assert_eq!(again.messages, 0);
    assert!(again.skipped_evicted);
    assert_eq!(world.state("sess"), Some(ArchiveSessionState::Evicted));
}

#[test]
fn the_ceiling_stops_when_nothing_is_left_to_drop() {
    let mut world = Archive::new();
    world.fill();
    let eviction = archive::evict_to_ceiling(world.conn(), 0).unwrap();
    assert_eq!(eviction.sessions.len(), 4);
    assert_eq!(eviction.stored_bytes, 0);
}

#[test]
fn the_stats_count_what_the_archive_has_and_what_it_dropped_apart() {
    let mut world = Archive::new();
    world.fill();
    let total = world.bytes();
    archive::evict_to_ceiling(world.conn(), total / 2).unwrap();
    let stats = archive::read_stats(world.conn(), 1024 * 1024 * 1024).unwrap();
    assert_eq!(stats.sessions + stats.evicted_sessions, 4);
    assert!(stats.evicted_sessions > 0);
    assert_eq!(stats.stored_bytes, world.bytes());
    assert!(stats.raw_bytes >= stats.stored_bytes);
    assert_eq!(stats.max_bytes, 1024 * 1024 * 1024);
}

// ---------------------------------------------------------------------------
// A pass over Claude Code's own history
// ---------------------------------------------------------------------------

/// A home with Claude Code's config folder in it, and a data folder.
struct Claude {
    dirs: TestDirs,
    config: PathBuf,
}

impl Claude {
    fn new() -> Self {
        let dirs = TestDirs::new();
        let config = dirs.home.join(".claude");
        std::fs::create_dir_all(config.join("projects")).unwrap();
        Self { dirs, config }
    }

    fn backend(&self) -> ClaudeCodeBackend {
        ClaudeCodeBackend::new(
            ClaudeCodeSettings {
                program: "claude".into(),
                leading_args: Vec::new(),
                config_dir: self.config.clone(),
                pass_config_dir: true,
                api_key_set: false,
            },
            Arc::new(NativeTree),
        )
    }

    fn project(&self, name: &str) -> PathBuf {
        self.dirs.folder(name)
    }

    /// Writes a transcript under `projects/<folder>/`, rows as the CLI writes
    /// them, all from `cwd`.
    fn transcript(
        &self,
        folder: &str,
        id: &str,
        cwd: &Path,
        rows: &[(&str, &str, u64, &str)],
    ) -> PathBuf {
        let dir = self.config.join("projects").join(folder);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(format!("{id}.jsonl"));
        let text: String = rows
            .iter()
            .map(|(kind, uuid, at, text)| transcript_row(kind, uuid, cwd, *at, text))
            .collect();
        std::fs::write(&file, text).unwrap();
        file
    }

    fn config(&self) -> HostConfig {
        HostConfig {
            folders: self.dirs.folders(),
            endpoint: self.dirs.endpoint(),
            backends: vec![Arc::new(self.backend()) as Arc<dyn AgentBackend>],
            inherited_env: Vec::new(),
        }
    }

    fn open_store(&self) -> Store {
        Store::open(&self.dirs.data).expect("open the store")
    }
}

const ONE: &str = "11111111-1111-4111-8111-111111111111";
const TWO: &str = "22222222-2222-4222-8222-222222222222";

fn uuid(n: u64) -> String {
    format!("00000000-0000-4000-8000-{n:012x}")
}

fn transcript_row(kind: &str, uuid: &str, cwd: &Path, at_ms: u64, text: &str) -> String {
    let content = if kind == "assistant" {
        json!([{ "type": "text", "text": text }])
    } else {
        json!(text)
    };
    let row = json!({
        "type": kind,
        "uuid": uuid,
        "sessionId": "ignored-for-the-file-name",
        "cwd": cwd.display().to_string(),
        "timestamp": iso(at_ms),
        "message": { "role": kind, "content": content },
    });
    format!("{row}\n")
}

fn iso(ms: u64) -> String {
    let (secs, millis) = (ms / 1000, ms % 1000);
    let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

const T0: u64 = 1_760_000_000_000;

/// A history that counts how often a transcript is read.
struct Counting<'a> {
    inner: &'a ClaudeCodeBackend,
    reads: AtomicUsize,
}

impl HistorySource for Counting<'_> {
    fn conversations(&self) -> Result<Vec<Conversation>> {
        self.inner.history().unwrap().conversations()
    }

    fn transcript(&self, id: &str) -> Result<Option<Transcript>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.inner.history().unwrap().transcript(id)
    }
}

fn pass(store: &Mutex<Store>, source: &dyn HistorySource) -> floti_host::history::Indexed {
    index_history(
        || store.lock().unwrap(),
        source,
        &BackendId::claude_code(),
        &|| true,
    )
    .expect("a pass")
}

/// Every file under `root` with its size and modification time.
fn tree_state(root: &Path) -> BTreeMap<PathBuf, (u64, Option<SystemTime>)> {
    let mut found = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            let meta = entry.metadata().unwrap();
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                found.insert(entry.path(), (meta.len(), meta.modified().ok()));
            }
        }
    }
    found
}

#[test]
fn a_pass_indexes_each_conversation_with_its_prompts_and_archives_its_messages() {
    let world = Claude::new();
    let alpha = world.project("repos/alpha");
    world.transcript(
        "-repos-alpha",
        ONE,
        &alpha,
        &[
            ("user", &uuid(1), T0, "add geofencing to the map"),
            ("assistant", &uuid(2), T0 + 1, "done"),
            ("user", &uuid(3), T0 + 2, "now write the tests"),
        ],
    );
    let store = Mutex::new(world.open_store());
    let backend = world.backend();
    let indexed = pass(&store, &backend);
    assert_eq!(
        (
            indexed.summary.sessions,
            indexed.summary.prompts,
            indexed.summary.resumable
        ),
        (1, 2, 1)
    );
    assert_eq!(
        indexed.summary.history_file,
        world.config.join("projects").display().to_string()
    );
    assert_eq!((indexed.stats.sessions, indexed.stats.messages), (1, 3));
    let guard = store.lock().unwrap();
    let id = BackendId::claude_code();
    let index = HistoryIndex::new(guard.connection(), &id);
    let session = index.session(ONE).unwrap().unwrap();
    assert_eq!(session.project, alpha.display().to_string());
    assert_eq!(session.title, "add geofencing to the map");
    assert_eq!(session.archive, Some(ArchiveSessionState::Archived));
    assert_eq!(session.archived_messages, Some(3));
}

#[test]
fn a_transcript_that_has_not_changed_is_not_read_again() {
    let world = Claude::new();
    let alpha = world.project("alpha");
    let file = world.transcript(
        "a",
        ONE,
        &alpha,
        &[("user", &uuid(1), T0, "hello there friend")],
    );
    let store = Mutex::new(world.open_store());
    let backend = world.backend();
    let counting = Counting {
        inner: &backend,
        reads: AtomicUsize::new(0),
    };
    pass(&store, &counting);
    pass(&store, &counting);
    assert_eq!(counting.reads.load(Ordering::SeqCst), 1);

    // It grew: read again, and only what it grew by is added.
    let mut text = std::fs::read_to_string(&file).unwrap();
    text.push_str(&transcript_row(
        "user",
        &uuid(2),
        &alpha,
        T0 + 5,
        "and one more thing",
    ));
    std::fs::write(&file, text).unwrap();
    let indexed = pass(&store, &counting);
    assert_eq!(counting.reads.load(Ordering::SeqCst), 2);
    assert_eq!(indexed.stats.messages, 2);
    assert_eq!(indexed.summary.prompts, 2);
}

#[test]
fn a_transcript_that_was_replaced_is_read_again_and_keeps_what_was_archived() {
    let world = Claude::new();
    let alpha = world.project("alpha");
    world.transcript(
        "a",
        ONE,
        &alpha,
        &[
            ("user", &uuid(1), T0, "one"),
            ("user", &uuid(2), T0 + 1, "two"),
            ("user", &uuid(3), T0 + 2, "three"),
        ],
    );
    let store = Mutex::new(world.open_store());
    let backend = world.backend();
    pass(&store, &backend);
    world.transcript("a", ONE, &alpha, &[("user", &uuid(4), T0 + 3, "four")]);
    let indexed = pass(&store, &backend);
    // The archive keeps every message it had; the index lists what the
    // transcript says now.
    assert_eq!(indexed.stats.messages, 4);
    assert_eq!(indexed.summary.prompts, 1);
}

#[test]
fn the_agents_folder_is_left_byte_for_byte_as_it_was_on_a_full_pass_from_cleared_cursors() {
    let world = Claude::new();
    let alpha = world.project("alpha");
    world.transcript(
        "a",
        ONE,
        &alpha,
        &[("user", &uuid(1), T0, "hello there friend")],
    );
    world.transcript(
        "b",
        TWO,
        &alpha,
        &[("user", &uuid(2), T0 + 1, "second conversation here")],
    );
    std::fs::write(world.config.join("history.jsonl"), "{}\n").unwrap();
    let before = tree_state(&world.config);
    let store = Mutex::new(world.open_store());
    let backend = world.backend();
    pass(&store, &backend);
    store
        .lock()
        .unwrap()
        .connection()
        .execute("DELETE FROM transcript_index", [])
        .unwrap();
    pass(&store, &backend);
    assert_eq!(tree_state(&world.config), before);
}

#[test]
fn a_ceiling_written_in_the_settings_is_honoured_on_the_next_pass() {
    let world = Claude::new();
    let alpha = world.project("alpha");
    for (n, id) in [ONE, TWO].iter().enumerate() {
        let text = format!("conversation number {n} ").repeat(200);
        world.transcript(
            &format!("p{n}"),
            id,
            &alpha,
            &[("user", &uuid(n as u64 + 1), T0 + n as u64, &text)],
        );
    }
    let store = Mutex::new(world.open_store());
    let backend = world.backend();
    let first = pass(&store, &backend);
    assert_eq!(first.stats.sessions, 2);
    assert_eq!(first.stats.max_bytes, archive::DEFAULT_CEILING);

    let ceiling = first.stats.stored_bytes - 1;
    store
        .lock()
        .unwrap()
        .connection()
        .execute(
            "INSERT INTO app_settings (key, value) VALUES (?, ?)",
            rusqlite::params![archive::CEILING_SETTING, ceiling.to_string()],
        )
        .unwrap();
    let next = pass(&store, &backend);
    assert_eq!(next.stats.max_bytes, ceiling);
    assert_eq!((next.stats.sessions, next.stats.evicted_sessions), (1, 1));
    assert!(next.stats.stored_bytes <= ceiling);
    // The older one went.
    let guard = store.lock().unwrap();
    assert_eq!(
        archive::state_of(guard.connection(), ONE).unwrap(),
        Some(ArchiveSessionState::Evicted)
    );
}

#[test]
fn a_conversation_whose_transcript_was_deleted_is_kept_across_a_restart_identical_and_searchable() {
    let world = Claude::new();
    let alpha = world.project("alpha");
    let file = world.transcript(
        "a",
        ONE,
        &alpha,
        &[
            ("user", &uuid(1), T0, "where is the zorblatt configured"),
            ("assistant", &uuid(2), T0 + 1, "in the settings pane"),
        ],
    );
    let backend = world.backend();
    let before = {
        let store = Mutex::new(world.open_store());
        pass(&store, &backend);
        let guard = store.lock().unwrap();
        archive::read_conversation(guard.connection(), ONE)
            .unwrap()
            .unwrap()
    };
    std::fs::remove_file(&file).unwrap();

    let store = Mutex::new(world.open_store());
    let indexed = pass(&store, &backend);
    assert_eq!(indexed.summary.resumable, 0);
    let guard = store.lock().unwrap();
    let after = archive::read_conversation(guard.connection(), ONE)
        .unwrap()
        .unwrap();
    assert_eq!(after, before);
    assert!(
        archive::search_archive(guard.connection(), "zorblatt", 10)
            .unwrap()
            .contains_key(ONE)
    );
    let id = BackendId::claude_code();
    let session = HistoryIndex::new(guard.connection(), &id)
        .session(ONE)
        .unwrap()
        .unwrap();
    assert_eq!(session.transcript_file, None);
    assert_eq!(session.prompt_count, 1);
}

#[test]
fn a_pass_told_to_stop_writes_nothing_more_and_the_next_carries_on_from_there() {
    let world = Claude::new();
    let alpha = world.project("alpha");
    world.transcript(
        "a",
        ONE,
        &alpha,
        &[("user", &uuid(1), T0, "first conversation here")],
    );
    world.transcript(
        "b",
        TWO,
        &alpha,
        &[("user", &uuid(2), T0 + 1, "second conversation here")],
    );
    let store = Mutex::new(world.open_store());
    let backend = world.backend();
    let source = backend.history().unwrap();
    let id = BackendId::claude_code();

    let stopped = index_history(|| store.lock().unwrap(), source, &id, &|| false).unwrap();
    assert_eq!((stopped.summary.sessions, stopped.stats.messages), (0, 0));

    // Stopped between the two transcripts' messages: one is archived.
    let asked = AtomicUsize::new(0);
    let partway = index_history(|| store.lock().unwrap(), source, &id, &|| {
        asked.fetch_add(1, Ordering::SeqCst) < 3
    })
    .unwrap();
    assert_eq!(partway.summary.sessions, 2);
    assert_eq!(partway.stats.messages, 1);

    let finished = pass(&store, &backend);
    assert_eq!((finished.summary.sessions, finished.stats.sessions), (2, 2));
    assert_eq!(finished.stats.messages, 2);
}

#[test]
fn the_tree_the_config_folder_names_is_read_and_not_the_one_in_the_home() {
    let world = Claude::new();
    let alpha = world.project("alpha");
    // A tree in the default place that the backend was not pointed at.
    let elsewhere = world.dirs.folder("elsewhere/.claude");
    let dir = elsewhere.join("projects").join("x");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join(format!("{TWO}.jsonl")),
        transcript_row("user", &uuid(9), &alpha, T0, "not this one please"),
    )
    .unwrap();
    world.transcript(
        "a",
        ONE,
        &alpha,
        &[("user", &uuid(1), T0, "this one is right")],
    );
    let store = Mutex::new(world.open_store());
    let indexed = pass(&store, &world.backend());
    assert_eq!(indexed.summary.sessions, 1);
    let guard = store.lock().unwrap();
    let id = BackendId::claude_code();
    assert!(
        HistoryIndex::new(guard.connection(), &id)
            .session(TWO)
            .unwrap()
            .is_none()
    );
}

#[test]
fn what_is_indexed_reads_without_a_pass() {
    let world = Claude::new();
    let store = world.open_store();
    let indexed = read_indexed(store.connection(), &BackendId::claude_code()).unwrap();
    assert_eq!(indexed.summary.sessions, 0);
    assert_eq!(
        indexed.stats,
        ArchiveStats {
            sessions: 0,
            evicted_sessions: 0,
            messages: 0,
            raw_bytes: 0,
            stored_bytes: 0,
            max_bytes: archive::DEFAULT_CEILING,
            oldest_at: None,
            newest_at: None,
        }
    );
}

// ---------------------------------------------------------------------------
// Through the host
// ---------------------------------------------------------------------------

/// The next event on `subscription`, within the test's patience.
async fn event_on(client: &mut TestClient, subscription: u64) -> Payload {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        match client.next(left).await {
            Some(Message::Event(event)) if event.subscription == subscription => {
                return event.payload;
            }
            Some(_) => {}
            None => panic!("no event on subscription {subscription} within {PATIENCE:?}"),
        }
    }
}

/// Waits for an event on `subscription` that `ready` accepts.
async fn event_until<T: serde::de::DeserializeOwned>(
    client: &mut TestClient,
    subscription: u64,
    ready: impl Fn(&T) -> bool,
) -> T {
    loop {
        let state: T = from_payload(&event_on(client, subscription).await).unwrap();
        if ready(&state) {
            return state;
        }
    }
}

fn snapshot<T: serde::de::DeserializeOwned>(message: Message) -> T {
    match message {
        Message::Snapshot(snapshot) => from_payload(&snapshot.state).unwrap(),
        other => panic!("expected a snapshot, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_start_up_pass_indexes_and_archives_what_happened_while_the_host_was_closed() {
    let world = Claude::new();
    let alpha = world.project("alpha");
    world.transcript(
        "a",
        ONE,
        &alpha,
        &[
            ("user", &uuid(1), T0, "fix the launcher grid"),
            ("assistant", &uuid(2), T0 + 1, "fixed it"),
        ],
    );
    let config = world.config();
    let endpoint = config.endpoint.clone();
    let host = Host::start(config).expect("start the host");
    let mut client = TestClient::connect(&endpoint, &[]).await;

    // The start-up pass may have landed before the subscription: the
    // snapshot is the state then, and an event follows if it had not.
    let history: HistorySummary = snapshot(client.subscribe_on(1, HistoryChanged::NAME).await);
    if history.sessions == 0 {
        event_until::<HistorySummary>(&mut client, 1, |summary| summary.sessions == 1).await;
    }
    let stats: ArchiveStats = snapshot(client.subscribe_on(2, ArchiveChanged::NAME).await);
    if stats.sessions == 0 {
        event_until::<ArchiveStats>(&mut client, 2, |stats| stats.sessions == 1).await;
    }
    let summary = client.request::<ReadHistorySummary>(&()).await.unwrap();
    assert_eq!((summary.sessions, summary.prompts), (1, 1));
    let conversation = client
        .request::<ArchiveConversation>(&HistorySessionRef {
            session_id: ONE.to_owned(),
        })
        .await
        .unwrap()
        .expect("archived on the start-up pass");
    assert_eq!(conversation.message_count, 2);
    drop(host);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_gets_the_history_index_through_the_host_and_every_subscriber_each_change() {
    let world = Claude::new();
    let alpha = world.project("repos/alpha");
    let beta = world.project("repos/beta");
    world.transcript(
        "a",
        ONE,
        &alpha,
        &[
            ("user", &uuid(1), T0, "add geofencing to the map"),
            ("user", &uuid(2), T0 + 1, "now write the tests"),
        ],
    );
    let config = world.config();
    let endpoint = config.endpoint.clone();
    let host = Host::start(config).expect("start the host");
    let mut client = TestClient::connect(&endpoint, &[]).await;
    let mut watcher = TestClient::connect(&endpoint, &[]).await;
    let first = client.request::<HistoryRefresh>(&()).await.unwrap();
    assert_eq!(first.sessions, 1);
    let start: HistorySummary = snapshot(watcher.subscribe_on(7, HistoryChanged::NAME).await);
    assert_eq!(start, first);

    // A second conversation appears; a refresh indexes it and the watcher
    // is told.
    world.transcript(
        "b",
        TWO,
        &beta,
        &[("user", &uuid(3), T0 + 10, "fix the geofence radius")],
    );
    let refreshed = client.request::<HistoryRefresh>(&()).await.unwrap();
    assert_eq!(
        (refreshed.sessions, refreshed.prompts, refreshed.projects),
        (2, 3, 2)
    );
    let told: HistorySummary = from_payload(&event_on(&mut watcher, 7).await).unwrap();
    assert_eq!(told, refreshed);

    // Paged, searched, prompts, projects.
    let page = client
        .request::<HistorySessions>(&HistoryQuery {
            limit: Some(1),
            ..HistoryQuery::default()
        })
        .await
        .unwrap();
    assert_eq!((page.sessions.len(), page.total), (1, 2));
    assert_eq!(page.sessions[0].session_id, TWO);
    let found = client
        .request::<HistorySessions>(&HistoryQuery {
            search: Some("WRITE THE".to_owned()),
            ..HistoryQuery::default()
        })
        .await
        .unwrap();
    assert_eq!(ids(&found), [ONE]);
    assert_eq!(
        found.sessions[0].matched.as_deref(),
        Some("now write the tests")
    );
    let prompts = client
        .request::<HistoryPrompts>(&HistorySessionRef {
            session_id: ONE.to_owned(),
        })
        .await
        .unwrap();
    assert_eq!(
        prompts.iter().map(|p| p.text.as_str()).collect::<Vec<_>>(),
        ["add geofencing to the map", "now write the tests"]
    );
    let projects = client.request::<HistoryProjects>(&()).await.unwrap();
    assert_eq!(
        projects.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
        ["beta", "alpha"]
    );

    // A rename is answered, told to the watcher, and kept across a refresh.
    let renamed = client
        .request::<HistoryRename>(&RenameHistorySessionRequest {
            session_id: ONE.to_owned(),
            name: Some("Geofencing".to_owned()),
        })
        .await
        .unwrap()
        .unwrap();
    assert_eq!(renamed.label.as_deref(), Some("Geofencing"));
    event_on(&mut watcher, 7).await;
    client.request::<HistoryRefresh>(&()).await.unwrap();
    let after = client
        .request::<HistorySessions>(&HistoryQuery::default())
        .await
        .unwrap();
    let one = after.sessions.iter().find(|s| s.session_id == ONE).unwrap();
    assert_eq!(one.label.as_deref(), Some("Geofencing"));
    assert_eq!(
        client
            .request::<HistoryRename>(&RenameHistorySessionRequest {
                session_id: "not-a-session".to_owned(),
                name: Some("x".to_owned()),
            })
            .await
            .unwrap(),
        None
    );
    drop(host);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_archive_answers_after_the_transcript_is_gone_and_null_for_one_never_archived() {
    let world = Claude::new();
    let alpha = world.project("alpha");
    let file = world.transcript(
        "a",
        ONE,
        &alpha,
        &[
            ("user", &uuid(1), T0, "what does the archive keep"),
            ("assistant", &uuid(2), T0 + 1, "everything it read"),
        ],
    );
    let before = tree_state(&world.config);
    let config = world.config();
    let endpoint = config.endpoint.clone();
    let host = Host::start(config).expect("start the host");
    let mut client = TestClient::connect(&endpoint, &[]).await;
    client.request::<HistoryRefresh>(&()).await.unwrap();
    assert_eq!(
        tree_state(&world.config),
        before,
        "nothing is written in the agent's folder"
    );

    std::fs::remove_file(&file).unwrap();
    let summary = client.request::<HistoryRefresh>(&()).await.unwrap();
    assert_eq!(summary.resumable, 0);
    let kept = client
        .request::<ArchiveConversation>(&HistorySessionRef {
            session_id: ONE.to_owned(),
        })
        .await
        .unwrap()
        .expect("kept after its transcript went");
    assert_eq!(kept.state, ArchiveSessionState::Archived);
    assert_eq!(
        kept.messages
            .iter()
            .map(|m| m.text.as_str())
            .collect::<Vec<_>>(),
        ["what does the archive keep", "everything it read"]
    );
    assert_eq!(kept.source_file, file.display().to_string());
    let never = client
        .request::<ArchiveConversation>(&HistorySessionRef {
            session_id: TWO.to_owned(),
        })
        .await
        .unwrap();
    assert_eq!(never, None);

    let stats = client.request::<ReadArchiveStats>(&()).await.unwrap();
    assert_eq!((stats.sessions, stats.messages), (1, 2));
    assert_eq!(stats.max_bytes, archive::DEFAULT_CEILING);
    assert_eq!(stats.stored_bytes, kept.stored_bytes);
    drop(host);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_oldest_conversations_are_evicted_to_stay_under_the_ceiling_and_subscribers_are_told() {
    let world = Claude::new();
    let alpha = world.project("alpha");
    for (n, id) in [ONE, TWO].iter().enumerate() {
        let text = format!("conversation number {n} ").repeat(200);
        world.transcript(
            &format!("p{n}"),
            id,
            &alpha,
            &[("user", &uuid(n as u64 + 1), T0 + n as u64, &text)],
        );
    }
    let config = world.config();
    let endpoint = config.endpoint.clone();
    let host = Host::start(config).expect("start the host");
    let mut client = TestClient::connect(&endpoint, &[]).await;
    client.request::<HistoryRefresh>(&()).await.unwrap();
    let full = client.request::<ReadArchiveStats>(&()).await.unwrap();
    assert_eq!(full.sessions, 2);
    let mut watcher = TestClient::connect(&endpoint, &[]).await;
    let start: ArchiveStats = snapshot(watcher.subscribe_on(3, ArchiveChanged::NAME).await);
    assert_eq!(start, full);

    // The ceiling is an ordinary setting, written beside the host.
    let ceiling = full.stored_bytes - 1;
    let db = rusqlite::Connection::open(world.dirs.data.join("floti.db")).unwrap();
    db.execute(
        "INSERT INTO app_settings (key, value) VALUES (?, ?)",
        rusqlite::params![archive::CEILING_SETTING, ceiling.to_string()],
    )
    .unwrap();
    drop(db);
    client.request::<HistoryRefresh>(&()).await.unwrap();
    let told: ArchiveStats = from_payload(&event_on(&mut watcher, 3).await).unwrap();
    assert_eq!(
        (told.sessions, told.evicted_sessions, told.max_bytes),
        (1, 1, ceiling)
    );
    assert!(told.stored_bytes <= ceiling);
    let dropped = client
        .request::<ArchiveConversation>(&HistorySessionRef {
            session_id: ONE.to_owned(),
        })
        .await
        .unwrap()
        .unwrap();
    assert_eq!(dropped.state, ArchiveSessionState::Evicted);
    assert!(dropped.messages.is_empty());
    drop(host);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_host_with_no_backend_that_keeps_history_answers_with_an_empty_index() {
    let dirs = TestDirs::new();
    let shell = floti_host::server::shell_backend(&dirs.user_env());
    let endpoint = dirs.endpoint();
    let host = Host::start(HostConfig {
        folders: dirs.folders(),
        endpoint: endpoint.clone(),
        backends: vec![Arc::new(shell) as Arc<dyn AgentBackend>],
        inherited_env: Vec::new(),
    })
    .expect("start the host");
    let mut client = TestClient::connect(&endpoint, &[]).await;
    let summary = client.request::<HistoryRefresh>(&()).await.unwrap();
    assert_eq!(
        (summary.sessions, summary.prompts, summary.error),
        (0, 0, None)
    );
    let page = client
        .request::<HistorySessions>(&HistoryQuery::default())
        .await
        .unwrap();
    assert!(page.sessions.is_empty());
    tokio::time::sleep(Duration::from_millis(10)).await;
    drop(host);
}
