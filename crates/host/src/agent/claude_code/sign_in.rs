//! Whether Claude Code is signed in, judged only from artefacts existing.
//!
//! Three signals, in order: `ANTHROPIC_API_KEY` is set (whether, never its
//! value); `.credentials.json` exists and is not empty, judged from its
//! metadata and never opened; `.claude.json` records a completed onboarding
//! with a user id, which a login kept in a keychain still leaves behind.
//! A config folder that cannot be read is Unknown, never "no".

use std::path::Path;

use floti_protocol::Knowable;
use serde_json::Value;

use super::usage::claude_config_file;
use crate::agent::SignIn;

/// The sentence for "no": what to run to sign in.
pub const NOT_SIGNED_IN: &str =
    "Claude Code is not signed in. Run claude in a terminal and sign in.";

pub(super) fn signed_in(config_dir: &Path, api_key_set: bool) -> SignIn {
    let yes = |signal: &str| SignIn {
        signed_in: Knowable::Known(true),
        signal: signal.to_owned(),
    };
    let no = || SignIn {
        signed_in: Knowable::Known(false),
        signal: NOT_SIGNED_IN.to_owned(),
    };
    if api_key_set {
        return yes("ANTHROPIC_API_KEY is set");
    }
    match std::fs::read_dir(config_dir) {
        Ok(_) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return no(),
        Err(err) => {
            return SignIn {
                signed_in: Knowable::Unknown,
                signal: format!("{} could not be read: {err}", config_dir.display()),
            };
        }
    }
    let credentials = config_dir.join(".credentials.json");
    if std::fs::metadata(&credentials).is_ok_and(|meta| meta.is_file() && meta.len() > 0) {
        return yes(".credentials.json is present");
    }
    if onboarding_recorded(&claude_config_file(config_dir)) {
        return yes(".claude.json records a completed sign-in");
    }
    no()
}

fn onboarding_recorded(file: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(file) else {
        return false;
    };
    let Ok(root) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    root.get("hasCompletedOnboarding").and_then(Value::as_bool) == Some(true)
        && root.get("userID").is_some_and(Value::is_string)
}
