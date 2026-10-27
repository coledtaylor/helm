//! Usage, against today's app: the cases core's tests check for reading
//! Claude Code's cached plan limits and shaping them (`usage/usage.test.ts`)
//! and main's usage service (`main/usage.test.ts`), with the same inputs and
//! expectations, then the same through a real host on its socket.
//!
//! Every folder is temporary: a home with the agent's config folder in it,
//! and the host's data folder. No agent runs; `.claude.json` is written as
//! Claude Code writes it.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use floti_host::agent::claude_code::{ClaudeCodeBackend, ClaudeCodeSettings, usage_view};
use floti_host::agent::{AgentBackend, BackendAnswers};
use floti_host::platform::process_tree::Native as NativeTree;
use floti_host::server::{Host, HostConfig, shell_backend};
use floti_host::testkit::{PATIENCE, TestClient, TestDirs};
use floti_host::usage::{LocalDay, UsageReader, ZonedDay, same_readings};
use floti_protocol::channel::from_payload;
use floti_protocol::channels::sessions::{
    ReadUsage, UsageChanged, UsageGroup, UsageProblemKind, UsageSeverity, UsageSnapshot,
};
use floti_protocol::{BackendId, EventChannel, Message};
use jiff::tz::TimeZone;
use serde_json::{Value, json};

/// How old a reading gets before its figures are floors (core's
/// `USAGE_STALE_AFTER_MS`).
const STALE_AFTER_MS: u64 = 30 * 60_000;

/// 2026-08-10T09:00:00Z, core's `NOW`.
const NOW: u64 = 1_786_352_400_000;
/// 2026-08-10T08:55:00Z, core's `FETCHED`.
const FETCHED: u64 = NOW - 5 * 60_000;

/// A home with Claude Code's config folder in it.
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

    /// Where the CLI keeps `.claude.json` for the default config folder:
    /// beside it.
    fn beside(&self) -> PathBuf {
        self.dirs.home.join(".claude.json")
    }

    fn write(&self, root: &Value) -> PathBuf {
        let file = self.beside();
        std::fs::write(&file, root.to_string()).unwrap();
        file
    }

    fn read(&self, root: &Value) -> UsageSnapshot {
        self.write(root);
        self.reading()
    }

    fn reading(&self) -> UsageSnapshot {
        self.backend()
            .read_usage(NOW, NOW - 9 * 3_600_000)
            .known()
            .expect("Claude Code declares usage")
    }

    fn config(&self) -> HostConfig {
        HostConfig {
            folders: self.dirs.folders(),
            endpoint: self.dirs.endpoint(),
            backends: vec![Arc::new(self.backend()) as Arc<dyn AgentBackend>],
            inherited_env: Vec::new(),
        }
    }
}

/// The three limits a 2.1.225 reading carries.
fn limits() -> Value {
    json!([
        { "kind": "session", "group": "session", "percent": 51, "severity": "normal",
          "resets_at": "2026-08-10T13:10:00.721285+00:00", "scope": null, "is_active": true },
        { "kind": "weekly_all", "group": "weekly", "percent": 38, "severity": "warning",
          "resets_at": "2026-08-11T19:00:00.721310+00:00", "scope": null, "is_active": false },
        { "kind": "weekly_scoped", "group": "weekly", "percent": 21, "severity": "normal",
          "resets_at": "2026-08-11T18:59:59.721602+00:00",
          "scope": { "model": { "id": null, "display_name": "Fable" }, "surface": null },
          "is_active": false },
    ])
}

/// The 2.1.225 shape of `.claude.json`, with the fields that vary made
/// arguments.
fn claude_json(fetched_at_ms: Value, limits: Value) -> Value {
    json!({
        "numStartups": 42,
        "projects": {},
        "cachedUsageUtilization": {
            "fetchedAtMs": fetched_at_ms,
            "accountUuid": "a5438327-5c7d-4ecd-97cd-47307ff36d81",
            "utilization": {
                "five_hour": { "utilization": 51, "resets_at": "2026-08-10T13:10:00.721285+00:00" },
                "seven_day": { "utilization": 38, "resets_at": "2026-08-11T19:00:00.721310+00:00" },
                "tangelo": null,
                "nimbus_quill": { "utilization": 0, "resets_at": null },
                "limits": limits,
                "spend": { "used": { "amount_minor": 0, "currency": "USD" }, "enabled": false, "percent": 0 },
                "extra_usage": { "is_enabled": false, "daily": null, "weekly": null },
            },
        },
    })
}

fn usual() -> Value {
    claude_json(json!(FETCHED), limits())
}

fn with_cached(cached: Value) -> Value {
    json!({ "numStartups": 42, "projects": {}, "cachedUsageUtilization": cached })
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

fn problem(snapshot: &UsageSnapshot) -> Option<UsageProblemKind> {
    snapshot.problem.as_ref().map(|problem| problem.kind)
}

// ---------------------------------------------------------------------------
// Reading the cached limits
// ---------------------------------------------------------------------------

#[test]
fn the_limits_a_current_reading_carries_are_read() {
    let world = Claude::new();
    let snapshot = world.read(&usual());
    assert_eq!(snapshot.problem, None);
    assert_eq!(snapshot.backend, BackendId::claude_code());
    assert_eq!(snapshot.fetched_at_ms, Some(FETCHED));
    assert_eq!(
        snapshot
            .limits
            .iter()
            .map(|limit| (limit.kind.as_str(), limit.percent))
            .collect::<Vec<_>>(),
        [
            ("session", 51.0),
            ("weekly_all", 38.0),
            ("weekly_scoped", 21.0)
        ]
    );
    assert_eq!(snapshot.limits[2].scope.as_deref(), Some("Fable"));
    assert_eq!(snapshot.limits[1].severity, UsageSeverity::Warning);
    assert!(snapshot.limits[0].is_active);
}

#[test]
fn the_six_digit_offset_timestamps_the_cli_writes_are_parsed() {
    let world = Claude::new();
    let snapshot = world.read(&usual());
    // 2026-08-10T13:10:00.721Z
    assert_eq!(
        snapshot.limits[0].resets_at_ms,
        Some(NOW + 4 * 3_600_000 + 600_721)
    );
}

#[test]
fn a_missing_key_is_reported_rather_than_a_zero_invented() {
    let world = Claude::new();
    let snapshot = world.read(&json!({ "numStartups": 42, "projects": {} }));
    assert_eq!(problem(&snapshot), Some(UsageProblemKind::MissingKey));
    assert!(snapshot.limits.is_empty());
}

#[test]
fn an_unusable_fetched_at_is_reported_because_an_age_cannot_be_judged_without_one() {
    let world = Claude::new();
    for value in [json!(null), json!("yesterday"), json!(0)] {
        let snapshot = world.read(&claude_json(value.clone(), limits()));
        assert_eq!(
            problem(&snapshot),
            Some(UsageProblemKind::Unrecognised),
            "fetchedAtMs {value}"
        );
        assert!(snapshot.limits.is_empty());
    }
}

#[test]
fn a_reshaped_limits_array_is_reported_rather_than_what_was_recognised_shown() {
    let world = Claude::new();
    let snapshot = world.read(&claude_json(
        json!(FETCHED),
        json!([
            { "kind": "session", "group": "session", "utilizationPercent": 51 },
            { "kind": "weekly_all", "bucket": "weekly", "percent": 38 },
        ]),
    ));
    assert_eq!(problem(&snapshot), Some(UsageProblemKind::Unrecognised));
    assert!(snapshot.limits.is_empty());
}

#[test]
fn the_limits_recognised_are_kept_when_a_new_kind_appears_beside_them() {
    let world = Claude::new();
    let snapshot = world.read(&claude_json(
        json!(FETCHED),
        json!([
            { "kind": "session", "group": "session", "percent": 12, "resets_at": null },
            { "kind": "weekly_cowork", "group": "weekly", "percent": 4, "resets_at": null },
            { "kind": "something_new", "group": "monthly", "percent": 90 },
        ]),
    ));
    // The unknown kind declares a group that is shown; the unknown group has
    // nowhere honest to go.
    assert_eq!(
        snapshot
            .limits
            .iter()
            .map(|limit| limit.kind.as_str())
            .collect::<Vec<_>>(),
        ["session", "weekly_cowork"]
    );
}

#[test]
fn a_percent_that_is_not_one_is_refused() {
    let world = Claude::new();
    let snapshot = world.read(&claude_json(
        json!(FETCHED),
        json!([{ "kind": "session", "group": "session", "percent": "51%", "resets_at": null }]),
    ));
    assert_eq!(problem(&snapshot), Some(UsageProblemKind::Unrecognised));
}

#[test]
fn a_null_cached_reading_is_missing_and_a_string_one_is_reshaped() {
    let world = Claude::new();
    assert_eq!(
        problem(&world.read(&with_cached(json!(null)))),
        Some(UsageProblemKind::MissingKey)
    );
    assert_eq!(
        problem(&world.read(&with_cached(json!("nope")))),
        Some(UsageProblemKind::Unrecognised)
    );
}

#[test]
fn the_file_beside_the_config_folder_is_read() {
    let world = Claude::new();
    let file = world.write(&usual());
    let snapshot = world.reading();
    assert_eq!(snapshot.file, file.display().to_string());
    assert_eq!(snapshot.limits.len(), 3);
}

#[test]
fn one_inside_the_config_folder_is_preferred_when_that_is_where_it_is() {
    let world = Claude::new();
    world.write(&json!({ "numStartups": 1 }));
    let inside = world.config.join(".claude.json");
    std::fs::write(&inside, usual().to_string()).unwrap();
    let snapshot = world.reading();
    assert_eq!(snapshot.file, inside.display().to_string());
    assert_eq!(snapshot.problem, None);
}

#[test]
fn a_file_that_is_not_there_is_reported() {
    let world = Claude::new();
    let snapshot = world.reading();
    assert_eq!(problem(&snapshot), Some(UsageProblemKind::NoFile));
    assert!(snapshot.limits.is_empty());
    assert_eq!(snapshot.fetched_at_ms, None);
}

#[test]
fn a_half_written_file_is_reported_rather_than_failing() {
    let world = Claude::new();
    std::fs::write(world.beside(), "{\"cachedUsageUtilization\": {\"fetched").unwrap();
    assert_eq!(problem(&world.reading()), Some(UsageProblemKind::NotJson));
}

// ---------------------------------------------------------------------------
// What a reading may paint
// ---------------------------------------------------------------------------

fn labels(snapshot: &UsageSnapshot, now: u64) -> Vec<(&'static str, f64, Option<String>)> {
    usage_view(snapshot, now)
        .buckets
        .into_iter()
        .map(|bucket| (bucket.label, bucket.percent, bucket.scope))
        .collect()
}

#[test]
fn the_session_limit_and_the_binding_weekly_one_are_shown() {
    let world = Claude::new();
    let snapshot = world.read(&usual());
    let view = usage_view(&snapshot, NOW);
    assert_eq!(view.problem, None);
    assert_eq!(
        labels(&snapshot, NOW),
        [("Session", 51.0, None), ("Week", 38.0, None)]
    );
}

#[test]
fn the_per_model_weekly_limit_is_shown_when_it_is_the_binding_one() {
    let world = Claude::new();
    let snapshot = world.read(&claude_json(
        json!(FETCHED),
        json!([
            { "kind": "session", "group": "session", "percent": 10, "resets_at": "2026-08-10T13:10:00Z" },
            { "kind": "weekly_all", "group": "weekly", "percent": 38, "resets_at": "2026-08-11T19:00:00Z" },
            { "kind": "weekly_scoped", "group": "weekly", "percent": 77, "resets_at": "2026-08-11T19:00:00Z",
              "scope": { "model": { "display_name": "Fable" } } },
        ]),
    ));
    let view = usage_view(&snapshot, NOW);
    assert_eq!(view.buckets[1].percent, 77.0);
    assert_eq!(view.buckets[1].scope.as_deref(), Some("Fable"));
    assert_eq!(view.buckets[1].kind, "weekly_scoped");
}

#[test]
fn the_binding_limit_is_not_chosen_by_is_active_which_was_seen_on_the_lower_one() {
    let world = Claude::new();
    let snapshot = world.read(&claude_json(
        json!(FETCHED),
        json!([
            { "kind": "weekly_all", "group": "weekly", "percent": 38,
              "resets_at": "2026-08-11T19:00:00Z", "is_active": false },
            { "kind": "weekly_scoped", "group": "weekly", "percent": 90,
              "resets_at": "2026-08-11T19:00:00Z", "is_active": true,
              "scope": { "model": { "display_name": "Fable" } } },
        ]),
    ));
    assert_eq!(
        usage_view(&snapshot, NOW)
            .buckets
            .iter()
            .map(|bucket| bucket.percent)
            .collect::<Vec<_>>(),
        [90.0]
    );
}

#[test]
fn past_the_staleness_horizon_the_figures_are_lower_bounds() {
    let world = Claude::new();
    let snapshot = world.read(&usual());
    let inside = usage_view(&snapshot, FETCHED + STALE_AFTER_MS - 1000);
    let outside = usage_view(&snapshot, FETCHED + STALE_AFTER_MS + 1000);
    assert_eq!(inside.buckets.len(), 2);
    assert!(!inside.at_least);
    // The same numbers, now floors rather than withheld.
    assert_eq!(
        outside
            .buckets
            .iter()
            .map(|b| b.percent)
            .collect::<Vec<_>>(),
        inside.buckets.iter().map(|b| b.percent).collect::<Vec<_>>()
    );
    assert!(outside.at_least);
    assert_eq!(outside.problem, None);
    assert_eq!(outside.age_ms, Some((STALE_AFTER_MS + 1000) as i64));
}

#[test]
fn a_stale_reading_that_has_also_rolled_over_shows_nothing() {
    let world = Claude::new();
    let snapshot = world.read(&claude_json(
        json!(NOW - 6 * 3_600_000),
        json!([{ "kind": "session", "group": "session", "percent": 59,
                 "resets_at": iso(NOW - 3_600_000) }]),
    ));
    let view = usage_view(&snapshot, NOW);
    assert!(view.buckets.is_empty());
    assert!(!view.at_least);
    assert_eq!(
        view.problem.map(|problem| problem.kind),
        Some(UsageProblemKind::RolledOver)
    );
}

#[test]
fn a_window_that_has_reset_is_dropped_and_one_that_has_not_is_kept() {
    let world = Claude::new();
    let snapshot = world.read(&claude_json(
        json!(NOW - 60_000),
        json!([
            { "kind": "session", "group": "session", "percent": 51, "resets_at": iso(NOW - 4 * 60_000) },
            { "kind": "weekly_all", "group": "weekly", "percent": 38, "resets_at": "2026-08-11T19:00:00Z" },
        ]),
    ));
    assert_eq!(
        labels(&snapshot, NOW)
            .into_iter()
            .map(|(label, _, _)| label)
            .collect::<Vec<_>>(),
        ["Week"]
    );
}

#[test]
fn nothing_is_shown_when_every_window_in_the_reading_has_reset() {
    let world = Claude::new();
    let snapshot = world.read(&claude_json(
        json!(NOW - 60_000),
        json!([
            { "kind": "session", "group": "session", "percent": 51, "resets_at": iso(NOW - 1000) },
            { "kind": "weekly_all", "group": "weekly", "percent": 38, "resets_at": iso(NOW - 1000) },
        ]),
    ));
    assert_eq!(
        usage_view(&snapshot, NOW)
            .problem
            .map(|problem| problem.kind),
        Some(UsageProblemKind::RolledOver)
    );
}

#[test]
fn a_limit_the_server_sent_no_reset_time_for_is_kept() {
    let world = Claude::new();
    let snapshot = world.read(&claude_json(
        json!(NOW),
        json!([{ "kind": "session", "group": "session", "percent": 7, "resets_at": null }]),
    ));
    assert_eq!(
        usage_view(&snapshot, NOW)
            .buckets
            .iter()
            .map(|bucket| (bucket.percent, bucket.resets_at_ms))
            .collect::<Vec<_>>(),
        [(7.0, None)]
    );
}

#[test]
fn a_reading_dated_in_the_future_shows_nothing() {
    let world = Claude::new();
    let snapshot = world.read(&claude_json(json!(NOW + 10 * 60_000), limits()));
    let view = usage_view(&snapshot, NOW);
    assert!(view.buckets.is_empty());
    assert_eq!(
        view.problem.map(|problem| problem.kind),
        Some(UsageProblemKind::Unrecognised)
    );
}

#[test]
fn a_read_problem_is_passed_straight_through() {
    let world = Claude::new();
    let snapshot = world.read(&json!({ "numStartups": 42 }));
    let view = usage_view(&snapshot, NOW);
    assert!(view.buckets.is_empty());
    assert_eq!(
        view.problem.map(|problem| problem.kind),
        Some(UsageProblemKind::MissingKey)
    );
}

// ---------------------------------------------------------------------------
// The host's readings
// ---------------------------------------------------------------------------

/// A local day that starts at a fixed instant.
struct FixedDay(u64);

impl LocalDay for FixedDay {
    fn today_start_ms(&self, _now_ms: u64) -> Option<u64> {
        Some(self.0)
    }
}

fn backends(world: &Claude) -> Vec<Arc<dyn AgentBackend>> {
    vec![
        Arc::new(world.backend()) as Arc<dyn AgentBackend>,
        Arc::new(shell_backend(&world.dirs.user_env())),
    ]
}

#[test]
fn a_reading_is_taken_only_from_the_backends_that_declare_usage() {
    let world = Claude::new();
    world.write(&usual());
    let reader = UsageReader::new(&backends(&world), Box::new(FixedDay(0)));
    assert!(
        reader.latest().is_empty(),
        "nothing is read before a reading"
    );
    let (readings, changed) = reader.read();
    assert!(changed);
    assert_eq!(readings.len(), 1);
    assert_eq!(readings[0].backend, BackendId::claude_code());
    assert_eq!(readings[0].limits.len(), 3);
    assert_eq!(reader.latest(), readings);
}

#[test]
fn a_reading_that_says_the_same_again_is_no_change() {
    let world = Claude::new();
    world.write(&usual());
    let reader = UsageReader::new(&backends(&world), Box::new(FixedDay(0)));
    reader.read();
    assert!(!reader.read().1);
    world.write(&claude_json(json!(FETCHED + 1), limits()));
    assert!(reader.read().1);
}

/// A local day nobody can tell.
struct NoDay;

impl LocalDay for NoDay {
    fn today_start_ms(&self, _now_ms: u64) -> Option<u64> {
        None
    }
}

#[test]
fn the_estimate_is_left_out_where_local_midnight_cannot_be_told() {
    let world = Claude::new();
    world.write(&usual());
    let unknown = UsageReader::new(&backends(&world), Box::new(NoDay));
    let (readings, _) = unknown.read();
    assert_eq!(readings[0].spend, None);
    assert_eq!(readings[0].limits.len(), 3);

    let known = UsageReader::new(&backends(&world), Box::new(FixedDay(0)));
    assert!(known.read().0[0].spend.is_some());
}

// ---------------------------------------------------------------------------
// Local midnight
// ---------------------------------------------------------------------------

/// US Eastern as a POSIX rule, which needs no time zone database on any OS:
/// summer time from 02:00 on the second Sunday of March to 02:00 on the
/// first Sunday of November.
const EASTERN: &str = "EST5EDT,M3.2.0,M11.1.0";

const HOUR: u64 = 3_600_000;

fn eastern() -> ZonedDay {
    ZonedDay::new(TimeZone::posix(EASTERN).expect("a valid POSIX rule"))
}

#[test]
fn today_starts_at_local_midnight_in_the_zone() {
    // 2026-07-15T14:30 EDT; that day's midnight is 04:00Z.
    let now = 1_784_140_200_000;
    let midnight = 1_784_088_000_000;
    assert_eq!(eastern().today_start_ms(now), Some(midnight));
    // Midnight is the first instant of its own day, and the instant before
    // it is the day before's.
    assert_eq!(eastern().today_start_ms(midnight), Some(midnight));
    assert_eq!(
        eastern().today_start_ms(midnight - 1),
        Some(midnight - 24 * HOUR)
    );
}

#[test]
fn today_starts_at_local_midnight_on_a_day_of_23_hours() {
    // 2026-03-08, when the clocks go forward: 20:00 EDT is 19 hours after
    // that day's midnight (05:00Z), not 20 and not 24.
    let now = 1_773_014_400_000;
    let midnight = 1_772_946_000_000;
    let start = eastern().today_start_ms(now);
    assert_eq!(start, Some(midnight));
    assert_eq!(now - midnight, 19 * HOUR);
    assert_ne!(start, Some(now - 24 * HOUR));
}

#[test]
fn today_starts_at_local_midnight_on_a_day_of_25_hours() {
    // 2026-11-01, when the clocks go back: 22:00 EST is 23 hours after that
    // day's midnight (04:00Z), not 22 and not 24.
    let now = 1_793_588_400_000;
    let midnight = 1_793_505_600_000;
    let start = eastern().today_start_ms(now);
    assert_eq!(start, Some(midnight));
    assert_eq!(now - midnight, 23 * HOUR);
    assert_ne!(start, Some(now - 24 * HOUR));
}

#[test]
fn a_zone_nobody_can_tell_has_no_local_midnight() {
    let unknown = ZonedDay::new(TimeZone::unknown());
    assert_eq!(unknown.today_start_ms(1_784_140_200_000), None);

    // And a reading taken by it leaves the spend out, keeping the limits.
    let world = Claude::new();
    world.write(&usual());
    let reader = UsageReader::new(&backends(&world), Box::new(unknown));
    let (readings, _) = reader.read();
    assert_eq!(readings[0].spend, None);
    assert_eq!(readings[0].limits.len(), 3);
}

#[test]
fn how_long_the_estimate_took_to_sum_is_not_a_change() {
    let world = Claude::new();
    world.write(&usual());
    let reader = UsageReader::new(&backends(&world), Box::new(FixedDay(0)));
    let (first, _) = reader.read();
    let mut slower = first.clone();
    if let Some(spend) = &mut slower[0].spend {
        spend.index_ms += 12.5;
    }
    assert!(same_readings(&first, &slower));
    slower[0].limits[0].percent += 1.0;
    assert!(!same_readings(&first, &slower));
}

#[test]
fn a_host_with_no_backend_that_declares_usage_reads_none() {
    let world = Claude::new();
    let shell: Vec<Arc<dyn AgentBackend>> = vec![Arc::new(shell_backend(&world.dirs.user_env()))];
    let reader = UsageReader::new(&shell, Box::new(FixedDay(0)));
    assert_eq!(reader.read(), (Vec::new(), false));
}

// ---------------------------------------------------------------------------
// Through the host
// ---------------------------------------------------------------------------

fn snapshot_state(message: Message) -> Vec<UsageSnapshot> {
    match message {
        Message::Snapshot(snapshot) => from_payload(&snapshot.state).unwrap(),
        other => panic!("expected a snapshot, got {other:?}"),
    }
}

/// The next `usage:changed` event on `subscription`.
async fn next_readings(client: &mut TestClient, subscription: u64) -> Vec<UsageSnapshot> {
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

fn file_in(path: &Path) -> String {
    path.display().to_string()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_gets_the_latest_raw_reading_and_each_new_one_as_it_lands() {
    let world = Claude::new();
    let fetched = 1_786_000_000_000_u64;
    world.write(&claude_json(json!(fetched), limits()));
    let config = world.config();
    let endpoint = config.endpoint.clone();
    let host = Host::start(config).expect("start the host");
    let mut client = TestClient::connect(&endpoint, &[]).await;

    let read = client.request::<ReadUsage>(&()).await.unwrap();
    assert_eq!(read.len(), 1);
    assert_eq!(read[0].backend, BackendId::claude_code());
    assert_eq!(read[0].file, file_in(&world.beside()));
    assert_eq!(read[0].fetched_at_ms, Some(fetched));
    // Raw: every limit as the agent cached it, reset or not, for the client
    // to judge.
    assert_eq!(read[0].limits.len(), 3);
    assert_eq!(read[0].limits[0].group, UsageGroup::Session);
    assert_eq!(read[0].problem, None);

    let watched = snapshot_state(client.subscribe_on(4, UsageChanged::NAME).await);
    // How long the estimate took to sum differs on every reading.
    assert!(same_readings(&watched, &read), "{watched:?} != {read:?}");

    // The agent rewrites its cached figures: the reading arrives unasked.
    world.write(&claude_json(
        json!(fetched + 60_000),
        json!([{ "kind": "session", "group": "session", "percent": 64, "resets_at": null }]),
    ));
    let next = next_readings(&mut client, 4).await;
    assert_eq!(next[0].fetched_at_ms, Some(fetched + 60_000));
    assert_eq!(next[0].limits.len(), 1);
    assert_eq!(next[0].limits[0].percent, 64.0);
    let again = client.request::<ReadUsage>(&()).await.unwrap();
    assert!(same_readings(&again, &next), "{again:?} != {next:?}");
    drop(host);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_reading_the_host_could_not_take_is_unknown_and_never_a_number() {
    let world = Claude::new();
    let config = world.config();
    let endpoint = config.endpoint.clone();
    let host = Host::start(config).expect("start the host");
    let mut client = TestClient::connect(&endpoint, &[]).await;

    let read = client.request::<ReadUsage>(&()).await.unwrap();
    assert_eq!(read.len(), 1);
    assert_eq!(problem(&read[0]), Some(UsageProblemKind::NoFile));
    assert!(read[0].limits.is_empty());
    assert_eq!(read[0].fetched_at_ms, None);
    assert!(usage_view(&read[0], NOW).buckets.is_empty());

    // Half a file is no better.
    let watched = snapshot_state(client.subscribe_on(5, UsageChanged::NAME).await);
    // How long the estimate took to sum differs on every reading.
    assert!(same_readings(&watched, &read), "{watched:?} != {read:?}");
    std::fs::write(world.beside(), "{\"cachedUsageUtilization\": {\"fetched").unwrap();
    let next = next_readings(&mut client, 5).await;
    assert_eq!(problem(&next[0]), Some(UsageProblemKind::NotJson));
    assert!(next[0].limits.is_empty());
    drop(host);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_host_whose_backends_declare_no_usage_answers_with_no_readings() {
    let dirs = TestDirs::new();
    let endpoint = dirs.endpoint();
    let host = Host::start(HostConfig {
        folders: dirs.folders(),
        endpoint: endpoint.clone(),
        backends: vec![Arc::new(shell_backend(&dirs.user_env())) as Arc<dyn AgentBackend>],
        inherited_env: Vec::new(),
    })
    .expect("start the host");
    let mut client = TestClient::connect(&endpoint, &[]).await;
    assert!(client.request::<ReadUsage>(&()).await.unwrap().is_empty());
    let watched = snapshot_state(client.subscribe_on(6, UsageChanged::NAME).await);
    assert!(watched.is_empty());
    drop(host);
}
