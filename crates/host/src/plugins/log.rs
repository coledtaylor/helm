//! Each plugin's log, as Settings shows it (`plugins:log`): what its service
//! printed, what its background script wrote with `console`, and what the
//! host noted about it, oldest first, the last [`LOG_LINES`] kept.
//!
//! Kept in memory for the run, by plugin id. Nothing here is ever written
//! to a file or the host's own log, and a service's token never reaches it:
//! a service's output is cleaned of it before it is pushed
//! ([`services::supervisor`](super::services::supervisor)).

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, MutexGuard, PoisonError};

use floti_protocol::channels::plugins::{PluginLogLine, PluginLogStream};

/// How many log lines are kept for each plugin.
pub const LOG_LINES: usize = 1000;

/// Every plugin's log lines.
#[derive(Default)]
pub struct PluginLogs {
    lines: Mutex<HashMap<String, VecDeque<PluginLogLine>>>,
}

impl PluginLogs {
    fn lines(&self) -> MutexGuard<'_, HashMap<String, VecDeque<PluginLogLine>>> {
        self.lines.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Adds one line to `plugin`'s log, dropping its oldest past
    /// [`LOG_LINES`].
    pub fn push(&self, plugin: &str, stream: PluginLogStream, text: String) {
        let mut lines = self.lines();
        let kept = lines.entry(plugin.to_owned()).or_default();
        if kept.len() == LOG_LINES {
            kept.pop_front();
        }
        kept.push_back(PluginLogLine {
            at: crate::config_console::time::now_iso(),
            stream,
            text,
        });
    }

    /// `plugin`'s log, oldest first.
    pub fn of(&self, plugin: &str) -> Vec<PluginLogLine> {
        self.lines()
            .get(plugin)
            .map(|kept| kept.iter().cloned().collect())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plugins_log_keeps_its_last_lines_oldest_first_and_apart_from_the_others() {
        let logs = PluginLogs::default();
        for n in 0..=LOG_LINES {
            logs.push("busy", PluginLogStream::Out, format!("line {n}"));
        }
        logs.push("quiet", PluginLogStream::Host, "started".into());
        let busy = logs.of("busy");
        assert_eq!(busy.len(), LOG_LINES);
        assert_eq!(busy[0].text, "line 1");
        assert_eq!(busy[LOG_LINES - 1].text, format!("line {LOG_LINES}"));
        let quiet = logs.of("quiet");
        assert_eq!(quiet.len(), 1);
        assert_eq!(
            (quiet[0].stream, quiet[0].text.as_str()),
            (PluginLogStream::Host, "started")
        );
        assert!(logs.of("nobody").is_empty());
    }
}
