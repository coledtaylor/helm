//! The agent's own health check (`claude doctor`), shown rather than
//! interpreted: the raw text is kept whole, and only `Label: value` lines at
//! the left margin are laid out as rows.

use std::time::{Duration, Instant};

use floti_protocol::channels::workspace::{DoctorReport, DoctorRow, Millis};

use super::command::{AgentCommand, run};
use super::time::now_iso;

const LIMIT: Duration = Duration::from_secs(120);

/// A label of 2 to 41 letters, digits, spaces, `/` or `-`, starting with a
/// letter, then a colon and a value.
fn row(line: &str) -> Option<DoctorRow> {
    let (label, value) = line.split_once(':')?;
    let starts_with_letter = label
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic());
    let label_ok = (2..=41).contains(&label.chars().count())
        && starts_with_letter
        && label
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '/' | '-'));
    let (label, value) = (label.trim(), value.trim());
    (label_ok && !label.is_empty() && !value.is_empty()).then(|| DoctorRow {
        label: label.to_owned(),
        value: value.to_owned(),
    })
}

/// The rows of a report. An indented line belongs to the one above it.
pub fn parse_rows(output: &str) -> Vec<DoctorRow> {
    output
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .filter(|line| *line == line.trim_start())
        .filter_map(|line| row(line.trim()))
        .collect()
}

/// Runs the doctor. A non-zero exit is a finding, not a failure to run:
/// the error is set only when there is nothing to show.
pub fn run_doctor(command: &AgentCommand) -> DoctorReport {
    let ran_at = now_iso();
    let started = Instant::now();
    let outcome = run(command, &["doctor"], None, LIMIT);
    let error = match &outcome.failure {
        Some(failure) if outcome.output.is_empty() => Some(failure.clone()),
        None if outcome.output.is_empty() && outcome.exit_code != Some(0) => {
            Some("The doctor command failed and printed nothing.".to_owned())
        }
        _ => None,
    };
    DoctorReport {
        rows: parse_rows(&outcome.output),
        output: outcome.output,
        exit_code: outcome.exit_code,
        ran_at,
        duration_ms: Millis(started.elapsed().as_secs_f64() * 1_000.0),
        error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_value_lines_at_the_margin_are_rows_and_nothing_else_is() {
        let output = "Diagnostics\n \u{2514} Currently running: native (2.1.999)\nAuto-update channel: latest\r\nInstall path: C:\\Tools\\claude.exe\nSomething the parse has no row for\n  Indented detail: belongs to the line above\n9 lives: not a label";
        assert_eq!(
            parse_rows(output),
            vec![
                DoctorRow {
                    label: "Auto-update channel".into(),
                    value: "latest".into()
                },
                DoctorRow {
                    label: "Install path".into(),
                    value: "C:\\Tools\\claude.exe".into()
                },
            ]
        );
    }
}
