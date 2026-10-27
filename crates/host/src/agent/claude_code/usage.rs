//! Claude Code's usage: its own cached copy of the plan limits, and an
//! estimate of spend from the token counts in its transcripts.
//!
//! The CLI caches the server's answer about plan limits in `.claude.json`
//! under `cachedUsageUtilization`. That is undocumented internal state, so
//! everything here answers "can a number be stood behind" rather than "can
//! one be found", and a question it cannot settle is answered with a problem
//! and no number, never a zero.
//!
//! Dollars are always an estimate: on a subscription plan nothing is billed
//! per token, so they are Floti's arithmetic over the transcripts against
//! [`PRICES`], dated [`PRICE_TABLE_DATE`]. Reads only.

use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::time::Instant;

use floti_protocol::BackendId;
use floti_protocol::channels::sessions::{
    UsageGroup, UsageLimit, UsageProblem, UsageProblemKind, UsageSeverity, UsageSnapshot,
    UsageSpend, UsageTokens, UsageWindowCost,
};
use serde::Serialize;
use serde_json::Value;

use super::time::parse_instant;

/// The day the price table was last checked against Anthropic's published
/// pricing. Change it only when the rates have been re-read.
pub const PRICE_TABLE_DATE: &str = "2026-08-10";

/// How old a reading may be before its percentages become lower bounds.
pub const USAGE_STALE_AFTER_MS: u64 = 30 * 60_000;

/// A reading dated further in the future than this is a clock disagreeing
/// with itself.
const FUTURE_TOLERANCE_MS: u64 = 60_000;

/// `.claude.json` also holds per-project prompt history and grows with use;
/// past this it is reported, not parsed.
const MAX_BYTES: u64 = 64 * 1024 * 1024;

/// A subagent writes to `projects/<project>/<session>/subagents/`, three
/// below the root, and its tokens count against the same plan.
const TRANSCRIPT_DEPTH: usize = 4;

const HOUR_MS: u64 = 3_600_000;
const SESSION_WINDOW_MS: u64 = 5 * HOUR_MS;
const WEEK_MS: u64 = 7 * 24 * HOUR_MS;

/// US dollars per million tokens.
#[derive(Debug, Clone, Copy, PartialEq)]
struct TokenPrice {
    input: f64,
    output: f64,
    cache_write_5m: f64,
    cache_write_1h: f64,
    cache_read: f64,
}

const fn price(input: f64, output: f64) -> TokenPrice {
    TokenPrice {
        input,
        output,
        cache_write_5m: input * 1.25,
        cache_write_1h: input * 2.0,
        cache_read: input * 0.1,
    }
}

/// A model's rate, and an introductory rate with the last day it applies.
struct ModelPrice {
    model: &'static str,
    price: TokenPrice,
    intro: Option<(&'static str, TokenPrice)>,
}

/// Keyed by the `model` a transcript row records. A model not here is
/// counted, left unpriced and named.
const PRICES: &[ModelPrice] = &[
    ModelPrice {
        model: "claude-fable-5",
        price: price(10.0, 50.0),
        intro: None,
    },
    ModelPrice {
        model: "claude-mythos-5",
        price: price(10.0, 50.0),
        intro: None,
    },
    ModelPrice {
        model: "claude-opus-5",
        price: price(5.0, 25.0),
        intro: None,
    },
    ModelPrice {
        model: "claude-opus-4-8",
        price: price(5.0, 25.0),
        intro: None,
    },
    ModelPrice {
        model: "claude-opus-4-7",
        price: price(5.0, 25.0),
        intro: None,
    },
    ModelPrice {
        model: "claude-opus-4-6",
        price: price(5.0, 25.0),
        intro: None,
    },
    ModelPrice {
        model: "claude-opus-4-5",
        price: price(5.0, 25.0),
        intro: None,
    },
    ModelPrice {
        model: "claude-sonnet-5",
        price: price(3.0, 15.0),
        intro: Some(("2026-08-31", price(2.0, 10.0))),
    },
    ModelPrice {
        model: "claude-sonnet-4-6",
        price: price(3.0, 15.0),
        intro: None,
    },
    ModelPrice {
        model: "claude-sonnet-4-5",
        price: price(3.0, 15.0),
        intro: None,
    },
    ModelPrice {
        model: "claude-haiku-4-5",
        price: price(1.0, 5.0),
        intro: None,
    },
];

/// The rate for `model` at `at_ms`, or `None` when there is none. A dated
/// snapshot id (`claude-haiku-4-5-20251001`) falls back to its family.
fn price_for(model: &str, at_ms: u64) -> Option<TokenPrice> {
    let family = match model.rsplit_once('-') {
        Some((family, date)) if date.len() == 8 && date.bytes().all(|b| b.is_ascii_digit()) => {
            family
        }
        _ => model,
    };
    let entry = PRICES
        .iter()
        .find(|entry| entry.model == model)
        .or_else(|| PRICES.iter().find(|entry| entry.model == family))?;
    if let Some((until, intro)) = entry.intro
        && let Some(end) = parse_instant(&format!("{until}T23:59:59.999Z"))
        && at_ms <= end
    {
        return Some(intro);
    }
    Some(entry.price)
}

/// The file the cached figures live in: `.claude.json` inside the config
/// folder when it is there, otherwise beside it, where the CLI keeps it for
/// the default `~/.claude`.
pub(super) fn claude_config_file(config_dir: &Path) -> PathBuf {
    let inside = config_dir.join(".claude.json");
    if inside.exists() {
        return inside;
    }
    match config_dir.parent() {
        Some(parent) => parent.join(".claude.json"),
        None => inside,
    }
}

/// One reading of Claude Code's usage, labelled with `backend`.
pub(super) fn read(
    backend: &BackendId,
    config_dir: &Path,
    now_ms: u64,
    today_start_ms: u64,
) -> UsageSnapshot {
    let file = claude_config_file(config_dir);
    let mut snapshot = read_limits(&file);
    snapshot.backend = backend.clone();
    let session_reset = snapshot
        .limits
        .iter()
        .filter(|limit| limit.group == UsageGroup::Session)
        .filter_map(|limit| limit.resets_at_ms)
        .filter(|&reset| reset > now_ms)
        .min();
    snapshot.spend = spend(
        &config_dir.join("projects"),
        Windows::new(now_ms, today_start_ms, session_reset),
    );
    snapshot
}

fn problem(file: &Path, kind: UsageProblemKind, detail: impl Into<String>) -> UsageSnapshot {
    UsageSnapshot {
        backend: BackendId::claude_code(),
        file: file.display().to_string(),
        fetched_at_ms: None,
        limits: Vec::new(),
        problem: Some(UsageProblem {
            kind,
            detail: detail.into(),
        }),
        spend: None,
    }
}

/// The cached plan limits out of `file`.
fn read_limits(file: &Path) -> UsageSnapshot {
    let shown = file.display();
    let size = match std::fs::metadata(file) {
        Ok(meta) => meta.len(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return problem(
                file,
                UsageProblemKind::NoFile,
                format!("{shown} is not there, so Claude Code has no figures yet."),
            );
        }
        Err(err) => return problem(file, UsageProblemKind::Unreadable, err.to_string()),
    };
    if size > MAX_BYTES {
        return problem(
            file,
            UsageProblemKind::Unreadable,
            format!(
                "{shown} is {} MB, which is too large to parse for one figure.",
                size / 1024 / 1024
            ),
        );
    }
    let text = match std::fs::read_to_string(file) {
        Ok(text) => text,
        Err(err) => return problem(file, UsageProblemKind::Unreadable, err.to_string()),
    };
    match serde_json::from_str::<Value>(&text) {
        // A read that lands mid-write sees half the file; the next one sees it
        // whole.
        Err(err) => problem(
            file,
            UsageProblemKind::NotJson,
            format!("{shown} did not parse: {err}"),
        ),
        Ok(root) => parse_usage(&root, file),
    }
}

/// `cachedUsageUtilization` out of a parsed `.claude.json`.
fn parse_usage(root: &Value, file: &Path) -> UsageSnapshot {
    let unrecognised = |detail: &str| problem(file, UsageProblemKind::Unrecognised, detail);
    let Some(root) = root.as_object() else {
        return problem(
            file,
            UsageProblemKind::NotJson,
            format!("{} did not parse as a JSON object.", file.display()),
        );
    };
    let cached = match root.get("cachedUsageUtilization") {
        None | Some(Value::Null) => {
            return problem(
                file,
                UsageProblemKind::MissingKey,
                "Claude Code has not cached any usage figures yet. Run a session and they appear.",
            );
        }
        Some(cached) => cached,
    };
    let Some(cached) = cached.as_object() else {
        return unrecognised("cachedUsageUtilization is not an object.");
    };
    let Some(fetched_at_ms) = cached
        .get("fetchedAtMs")
        .and_then(Value::as_f64)
        .filter(|ms| ms.is_finite() && *ms > 0.0)
    else {
        return unrecognised(
            "cachedUsageUtilization has no usable fetchedAtMs, so its age cannot be judged.",
        );
    };
    let Some(utilization) = cached.get("utilization").and_then(Value::as_object) else {
        return unrecognised("cachedUsageUtilization.utilization is not an object.");
    };
    let Some(raw) = utilization.get("limits").and_then(Value::as_array) else {
        return unrecognised("utilization.limits is not an array.");
    };
    let limits: Vec<UsageLimit> = raw.iter().filter_map(parse_limit).collect();
    if limits.is_empty() {
        let entries = if raw.len() == 1 { "entry" } else { "entries" };
        return unrecognised(&format!(
            "utilization.limits held {} {entries} and none had the shape Floti reads.",
            raw.len()
        ));
    }
    UsageSnapshot {
        backend: BackendId::claude_code(),
        file: file.display().to_string(),
        fetched_at_ms: Some(fetched_at_ms as u64),
        limits,
        problem: None,
        spend: None,
    }
}

/// One limit, or `None` when it is not one. `kind` stays a free string so a
/// new kind joins the group it declares; `group` is closed.
fn parse_limit(value: &Value) -> Option<UsageLimit> {
    let value = value.as_object()?;
    let group = match value.get("group")?.as_str()? {
        "session" => UsageGroup::Session,
        "weekly" => UsageGroup::Weekly,
        _ => return None,
    };
    // Above 100 is possible with extra usage on; past 1000 the field has been
    // repurposed and must not be painted as a percentage.
    let percent = value
        .get("percent")?
        .as_f64()
        .filter(|p| p.is_finite() && (0.0..=1000.0).contains(p))?;
    let kind = value
        .get("kind")?
        .as_str()
        .filter(|kind| !kind.is_empty())?;
    let severity = match value.get("severity").and_then(Value::as_str) {
        Some("warning") => UsageSeverity::Warning,
        Some("critical") => UsageSeverity::Critical,
        _ => UsageSeverity::Normal,
    };
    let scope = value
        .get("scope")
        .and_then(|scope| scope.get("model"))
        .and_then(|model| model.get("display_name"))
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .map(str::to_owned);
    Some(UsageLimit {
        kind: kind.to_owned(),
        group,
        percent,
        severity,
        resets_at_ms: value
            .get("resets_at")
            .and_then(Value::as_str)
            .and_then(parse_instant),
        scope,
        is_active: value.get("is_active").and_then(Value::as_bool) == Some(true),
    })
}

// ---------------------------------------------------------------------------
// What may be painted
// ---------------------------------------------------------------------------

/// One number a client may paint.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBucket {
    pub group: UsageGroup,
    /// `Session` or `Week`.
    pub label: &'static str,
    /// The model a scoped weekly limit applies to.
    pub scope: Option<String>,
    pub percent: f64,
    pub severity: UsageSeverity,
    pub resets_at_ms: Option<u64>,
    pub kind: String,
}

/// What may be painted from a reading at `now_ms`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageView {
    /// Empty means paint no number.
    pub buckets: Vec<UsageBucket>,
    /// Why `buckets` is empty.
    pub problem: Option<UsageProblem>,
    pub age_ms: Option<i64>,
    /// The percentages are lower bounds: the reading is older than
    /// [`USAGE_STALE_AFTER_MS`], and a running window's usage only grows.
    pub at_least: bool,
}

impl UsageView {
    fn empty(problem: Option<UsageProblem>, age_ms: Option<i64>) -> Self {
        Self {
            buckets: Vec::new(),
            problem,
            age_ms,
            at_least: false,
        }
    }
}

fn view_problem(kind: UsageProblemKind, detail: &str) -> Option<UsageProblem> {
    Some(UsageProblem {
        kind,
        detail: detail.to_owned(),
    })
}

/// What may be painted right now from `snapshot`. A rolled-over window is
/// judged before age: a reading of a window that has ended bounds nothing.
pub fn usage_view(snapshot: &UsageSnapshot, now_ms: u64) -> UsageView {
    if snapshot.problem.is_some() {
        return UsageView::empty(snapshot.problem.clone(), None);
    }
    let Some(fetched) = snapshot.fetched_at_ms else {
        return UsageView::empty(
            view_problem(
                UsageProblemKind::Unrecognised,
                "The reading carries no timestamp, so its age is unknown.",
            ),
            None,
        );
    };
    let age_ms = now_ms as i64 - fetched as i64;
    if age_ms < -(FUTURE_TOLERANCE_MS as i64) {
        return UsageView::empty(
            view_problem(
                UsageProblemKind::Unrecognised,
                "Claude Code dated its usage figures in the future; this machine and the server disagree about the time.",
            ),
            Some(age_ms),
        );
    }
    let live: Vec<&UsageLimit> = snapshot
        .limits
        .iter()
        .filter(|limit| limit.resets_at_ms.is_none_or(|reset| reset > now_ms))
        .collect();
    if live.is_empty() {
        return UsageView::empty(
            view_problem(
                UsageProblemKind::RolledOver,
                "Every usage window in this reading has already reset. The figures are from the window before it.",
            ),
            Some(age_ms),
        );
    }
    let buckets: Vec<UsageBucket> = [UsageGroup::Session, UsageGroup::Weekly]
        .into_iter()
        .filter_map(|group| binding(&live, group))
        .map(|limit| UsageBucket {
            group: limit.group,
            label: match limit.group {
                UsageGroup::Session => "Session",
                UsageGroup::Weekly => "Week",
            },
            scope: limit.scope.clone(),
            percent: limit.percent,
            severity: limit.severity,
            resets_at_ms: limit.resets_at_ms,
            kind: limit.kind.clone(),
        })
        .collect();
    if buckets.is_empty() {
        return UsageView::empty(
            view_problem(
                UsageProblemKind::Unrecognised,
                "No limit in this reading belongs to a window Floti shows.",
            ),
            Some(age_ms),
        );
    }
    UsageView {
        buckets,
        problem: None,
        age_ms: Some(age_ms),
        at_least: age_ms > USAGE_STALE_AFTER_MS as i64,
    }
}

/// The limit of `group` closest to its cap: the one that binds.
fn binding<'a>(limits: &[&'a UsageLimit], group: UsageGroup) -> Option<&'a UsageLimit> {
    limits
        .iter()
        .copied()
        .filter(|limit| limit.group == group)
        .fold(None, |best: Option<&UsageLimit>, limit| match best {
            Some(best) if best.percent >= limit.percent => Some(best),
            _ => Some(limit),
        })
}

// ---------------------------------------------------------------------------
// Estimated spend
// ---------------------------------------------------------------------------

/// The three windows spend is summed over, as `[from, now]` in epoch ms.
#[derive(Debug, Clone, Copy)]
struct Windows {
    now: u64,
    session_from: u64,
    today_from: u64,
    week_from: u64,
}

impl Windows {
    /// The session window ends at the session limit's reset when there is
    /// one, so it lines up with the limit; otherwise it is the last 5 hours.
    fn new(now: u64, today_from: u64, session_reset: Option<u64>) -> Self {
        let session_from = match session_reset {
            Some(reset) => reset.saturating_sub(SESSION_WINDOW_MS),
            None => now.saturating_sub(SESSION_WINDOW_MS),
        };
        Self {
            now,
            session_from,
            today_from,
            week_from: now.saturating_sub(WEEK_MS),
        }
    }

    fn earliest(&self) -> u64 {
        self.session_from.min(self.today_from).min(self.week_from)
    }
}

/// One assistant message's tokens.
#[derive(Debug, Clone, PartialEq)]
struct UsageRow {
    uuid: String,
    at: u64,
    model: String,
    input: u64,
    output: u64,
    cache_write_5m: u64,
    cache_write_1h: u64,
    cache_read: u64,
}

#[derive(Default)]
struct Sum {
    tokens: [u64; 4],
    dollars: f64,
    messages: u32,
}

impl Sum {
    fn add(&mut self, row: &UsageRow, rate: Option<TokenPrice>) {
        self.tokens[0] += row.input;
        self.tokens[1] += row.output;
        self.tokens[2] += row.cache_write_5m + row.cache_write_1h;
        self.tokens[3] += row.cache_read;
        self.messages += 1;
        if let Some(rate) = rate {
            self.dollars += (row.input as f64 * rate.input
                + row.output as f64 * rate.output
                + row.cache_write_5m as f64 * rate.cache_write_5m
                + row.cache_write_1h as f64 * rate.cache_write_1h
                + row.cache_read as f64 * rate.cache_read)
                / 1_000_000.0;
        }
    }

    fn cost(self) -> UsageWindowCost {
        let [input, output, cache_write, cache_read] = self.tokens;
        UsageWindowCost {
            tokens: UsageTokens {
                input,
                output,
                cache_write,
                cache_read,
            },
            dollars: self.dollars,
            messages: self.messages,
        }
    }
}

/// Spend over the three windows, or `None` when a transcript that could hold
/// part of it cannot be read: a partial sum would read as a smaller spend.
fn spend(projects: &Path, windows: Windows) -> Option<UsageSpend> {
    let started = Instant::now();
    let mut files = Vec::new();
    match std::fs::read_dir(projects) {
        Ok(_) => collect_transcripts(projects, 0, windows.earliest(), &mut files).ok()?,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return None,
    }

    let (mut session, mut today, mut week) = (Sum::default(), Sum::default(), Sum::default());
    let mut seen = HashSet::new();
    let mut unpriced = BTreeSet::new();
    for file in files {
        let text = std::fs::read_to_string(&file).ok()?;
        for line in text.lines() {
            // Most lines are not assistant messages; skip the parse for them.
            if !line.contains("\"assistant\"") {
                continue;
            }
            let Some(row) = parse_usage_line(line) else {
                continue;
            };
            if row.at > windows.now || row.at < windows.earliest() {
                continue;
            }
            if !seen.insert(row.uuid.clone()) {
                continue;
            }
            let rate = price_for(&row.model, row.at);
            if rate.is_none() {
                unpriced.insert(row.model.clone());
            }
            if row.at >= windows.session_from {
                session.add(&row, rate);
            }
            if row.at >= windows.today_from {
                today.add(&row, rate);
            }
            if row.at >= windows.week_from {
                week.add(&row, rate);
            }
        }
    }
    Some(UsageSpend {
        session: session.cost(),
        today: today.cost(),
        week: week.cost(),
        priced_at: PRICE_TABLE_DATE.to_owned(),
        unpriced_models: unpriced.into_iter().collect(),
        index_ms: started.elapsed().as_secs_f64() * 1_000.0,
    })
}

/// Every `.jsonl` under `dir` written since `since_ms`, subagents' included.
/// Linked folders are not followed.
fn collect_transcripts(
    dir: &Path,
    depth: usize,
    since_ms: u64,
    found: &mut Vec<PathBuf>,
) -> std::io::Result<()> {
    if depth > TRANSCRIPT_DEPTH {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let path = entry.path();
        if kind.is_dir() {
            collect_transcripts(&path, depth + 1, since_ms, found)?;
            continue;
        }
        if !kind.is_file() || path.extension().is_none_or(|ext| ext != "jsonl") {
            continue;
        }
        let modified = entry
            .metadata()?
            .modified()
            .ok()
            .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|at| at.as_millis() as u64);
        // A transcript last written before every window opened holds nothing
        // any window sums.
        if modified.is_none_or(|at| at >= since_ms) {
            found.push(path);
        }
    }
    Ok(())
}

fn count(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_u64).unwrap_or(0)
}

/// One transcript line, when it is an assistant message carrying usage.
fn parse_usage_line(line: &str) -> Option<UsageRow> {
    let value: Value = serde_json::from_str(line).ok()?;
    if value.get("type")?.as_str()? != "assistant" {
        return None;
    }
    let uuid = value
        .get("uuid")?
        .as_str()
        .filter(|uuid| !uuid.is_empty())?;
    let message = value.get("message")?.as_object()?;
    let usage = message.get("usage")?.as_object()?;
    let at = parse_instant(value.get("timestamp")?.as_str()?)?;
    let model = message
        .get("model")?
        .as_str()
        .filter(|model| !model.is_empty())?;

    // Without the split the whole write total is a five-minute write, the
    // default TTL and the cheaper reading; the total wins where they disagree.
    let total = count(usage.get("cache_creation_input_tokens"));
    let (mut write_5m, mut write_1h) = (total, 0);
    if let Some(split) = usage.get("cache_creation").and_then(Value::as_object) {
        write_1h = count(split.get("ephemeral_1h_input_tokens"));
        write_5m = count(split.get("ephemeral_5m_input_tokens"));
        let parts = write_1h + write_5m;
        if parts == 0 {
            write_5m = total;
        } else if total > parts {
            write_5m += total - parts;
        }
    }
    Some(UsageRow {
        uuid: uuid.to_owned(),
        at,
        model: model.to_owned(),
        input: count(usage.get("input_tokens")),
        output: count(usage.get("output_tokens")),
        cache_write_5m: write_5m,
        cache_write_1h: write_1h,
        cache_read: count(usage.get("cache_read_input_tokens")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dated_snapshot_is_priced_as_its_family_and_an_intro_rate_ends_on_its_day() {
        let at = parse_instant("2026-08-10T00:00:00Z").unwrap();
        assert_eq!(
            price_for("claude-haiku-4-5-20251001", at),
            Some(price(1.0, 5.0))
        );
        assert_eq!(price_for("claude-sonnet-5", at), Some(price(2.0, 10.0)));
        let later = parse_instant("2026-09-01T00:00:00Z").unwrap();
        assert_eq!(price_for("claude-sonnet-5", later), Some(price(3.0, 15.0)));
        assert_eq!(price_for("<synthetic>", at), None);
    }

    #[test]
    fn a_cache_write_without_its_split_is_a_five_minute_write() {
        let row = parse_usage_line(
            r#"{"type":"assistant","uuid":"u1","timestamp":"2026-08-10T00:00:00Z","message":{"model":"claude-opus-5","usage":{"input_tokens":10,"output_tokens":20,"cache_creation_input_tokens":30,"cache_read_input_tokens":40}}}"#,
        )
        .unwrap();
        assert_eq!(
            (row.cache_write_5m, row.cache_write_1h, row.cache_read),
            (30, 0, 40)
        );
        let split = parse_usage_line(
            r#"{"type":"assistant","uuid":"u2","timestamp":"2026-08-10T00:00:00Z","message":{"model":"claude-opus-5","usage":{"cache_creation_input_tokens":30,"cache_creation":{"ephemeral_1h_input_tokens":10,"ephemeral_5m_input_tokens":5}}}}"#,
        )
        .unwrap();
        assert_eq!((split.cache_write_5m, split.cache_write_1h), (20, 10));
        assert_eq!(parse_usage_line(r#"{"type":"user","uuid":"u3"}"#), None);
    }
}
