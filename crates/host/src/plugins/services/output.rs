//! What a service prints, as lines for its plugin's log, as today's
//! supervisor splits them (`desktop/main/plugins/service.ts`).
//!
//! A service may print its environment, which holds its run's token, so
//! every occurrence of the token is replaced before a line goes anywhere. A
//! token is hex with no line break in it, so it is always whole within one
//! line; a line too long to hold ([`LINE_MAX`]) is never split, which could
//! cut a token in two, but left out, with a line saying so.

use floti_protocol::channels::plugins::PluginLogStream;
use tokio::io::{AsyncRead, AsyncReadExt};

/// The longest line kept, in bytes.
pub const LINE_MAX: usize = 16 * 1024;

/// What a token is shown as in a log line.
pub const TOKEN_SHOWN_AS: &str = "[service token]";

/// Where each line goes.
pub type LineSink = Box<dyn Fn(PluginLogStream, String) + Send + Sync>;

/// Reads `output` to its end, telling `sink` each line on `stream`, with
/// `token` replaced and line endings taken off.
pub async fn pump(
    mut output: impl AsyncRead + Unpin,
    stream: PluginLogStream,
    token: String,
    sink: LineSink,
) {
    let tell = |line: &[u8]| {
        let text = String::from_utf8_lossy(line.strip_suffix(b"\r").unwrap_or(line));
        sink(stream, text.replace(token.as_str(), TOKEN_SHOWN_AS));
    };
    let too_long = || {
        sink(
            PluginLogStream::Host,
            format!("a line over {} KB was left out", LINE_MAX / 1024),
        );
    };
    let mut pending: Vec<u8> = Vec::new();
    let mut skipping = false;
    let mut buf = vec![0u8; 8192];
    loop {
        let n = match output.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        pending.extend_from_slice(&buf[..n]);
        while let Some(at) = pending.iter().position(|byte| *byte == b'\n') {
            if skipping || at > LINE_MAX {
                skipping = false;
                too_long();
            } else {
                tell(&pending[..at]);
            }
            pending.drain(..=at);
        }
        if pending.len() > LINE_MAX {
            skipping = true;
            pending.clear();
        }
    }
    if skipping || pending.len() > LINE_MAX {
        too_long();
    } else if !pending.is_empty() {
        tell(&pending);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";

    async fn lines(output: &[u8], stream: PluginLogStream) -> Vec<(PluginLogStream, String)> {
        let told: Arc<Mutex<Vec<(PluginLogStream, String)>>> = Arc::default();
        let into = Arc::clone(&told);
        pump(
            output,
            stream,
            TOKEN.to_owned(),
            Box::new(move |stream, text| into.lock().unwrap().push((stream, text))),
        )
        .await;
        Arc::try_unwrap(told).unwrap().into_inner().unwrap()
    }

    #[tokio::test]
    async fn a_services_output_is_its_lines_with_its_token_replaced() {
        let printed = format!(
            "listening\r\nHELM_SERVICE_TOKEN={TOKEN}\n\ntoken {TOKEN} twice {TOKEN}\nno newline"
        );
        let told = lines(printed.as_bytes(), PluginLogStream::Err).await;
        let texts: Vec<&str> = told.iter().map(|(_, text)| text.as_str()).collect();
        assert_eq!(
            texts,
            [
                "listening",
                "HELM_SERVICE_TOKEN=[service token]",
                "",
                "token [service token] twice [service token]",
                "no newline",
            ]
        );
        assert!(
            told.iter()
                .all(|(stream, _)| *stream == PluginLogStream::Err)
        );
        assert!(told.iter().all(|(_, text)| !text.contains(TOKEN)));
    }

    #[tokio::test]
    async fn a_line_too_long_to_keep_is_left_out_whole_and_said_so() {
        let long = format!("{}{TOKEN}", "x".repeat(LINE_MAX));
        let printed = format!("before\n{long}\nafter\n{long}");
        let told = lines(printed.as_bytes(), PluginLogStream::Out).await;
        let said = format!("a line over {} KB was left out", LINE_MAX / 1024);
        assert_eq!(
            told,
            [
                (PluginLogStream::Out, "before".to_owned()),
                (PluginLogStream::Host, said.clone()),
                (PluginLogStream::Out, "after".to_owned()),
                (PluginLogStream::Host, said),
            ]
        );
    }
}
