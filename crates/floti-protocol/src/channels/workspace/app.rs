//! The host's identity, its settings, and setup: `app:info`, `settings:*` and
//! `setup:*`.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::present;
use crate::backend::{BackendId, Knowable};

request_channel!(
    /// The host's identity, read once at connect.
    ReadAppInfo = "app:info", () => AppInfo
);
request_channel!(ReadSettings = "settings:read", () => HostSettings);
request_channel!(
    /// Changes the fields the patch carries and answers the settings after.
    WriteSettings = "settings:write", HostSettingsPatch => HostSettings
);
event_channel!(
    /// The settings after any change, whoever made it.
    SettingsChanged = "settings:changed", state HostSettings
);
request_channel!(
    /// First run. Setup is a state, not a wizard the host remembers having
    /// shown: a client shows it whenever there is nothing to scan and no
    /// completion stamp.
    ReadSetupStatus = "setup:status", () => SetupStatus
);
request_channel!(
    /// Uses the executable the client's file picker chose for a backend. The
    /// host runs it for its version before saving it, so a mis-click is a
    /// sentence in `error` rather than a session that opens and closes.
    LocateBackend = "setup:locateBackend", LocateBackendRequest => BackendStatus
);
request_channel!(
    /// Stamps `firstRunCompletedAt`.
    CompleteSetup = "setup:complete", () => HostSettings
);

/// How the host was started, which decides where its data lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "kebab-case")]
pub enum AppMode {
    Dev,
    /// A development build on the installed app's own data.
    DevLive,
    Portable,
    Installed,
}

/// The host's identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub mode: AppMode,
    pub data_dir: String,
    pub db_file: String,
    /// Migration tags this build applied or found already applied.
    pub migrations: Vec<String>,
    /// The Windows build number of the host's machine, for a terminal
    /// renderer's ConPTY quirks; null on any other OS.
    pub windows_build: Option<u32>,
    /// The host's home directory, so a long path can be shown from `~`.
    /// For showing only; every path the host acts on stays absolute.
    pub home: String,
    /// The releases page, opened by the client and never fetched.
    pub releases_url: String,
}

/// The host's settings.
///
/// One set for every client. What belongs to one client's window (theme,
/// layout, the terminal's look, the browser pane) is that client's own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostSettings {
    /// Folders discovery scans. Empty means "not set up yet".
    pub scan_roots: Vec<String>,
    /// Projects lifted out of their harness group into Pinned, by path.
    pub pinned_projects: Vec<String>,
    /// When setup was finished, ISO 8601, or null while it has not been.
    pub first_run_completed_at: Option<String>,
    /// An executable the user chose for a backend, for a machine where it is
    /// not where the host looks. A backend absent here is found by the host.
    pub backend_paths: BTreeMap<BackendId, String>,
    /// The program plain terminals open with, or null to detect one.
    pub terminal_shell: Option<String>,
    /// How many bytes of the database the transcript archive may hold.
    #[ts(type = "number")]
    pub transcript_archive_max_bytes: u64,
    /// Whether the host serves its browser tools to the sessions it hosts.
    pub browser_mcp: bool,
    /// Whether those tools are confined to this machine.
    pub browser_mcp_local_only: bool,
    /// Whether the host tells a session what other sessions are doing.
    pub session_mcp: bool,
    /// Reopen the sessions a crash took without asking first.
    pub restore_without_asking: bool,
}

/// A change to some settings. A field left out is unchanged; a nullable
/// field sent as null is cleared.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub scan_roots: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pinned_projects: Option<Vec<String>>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Option<String>")]
    #[ts(optional)]
    pub first_run_completed_at: Option<Option<String>>,
    /// Replaces the whole map.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub backend_paths: Option<BTreeMap<BackendId, String>>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Option<String>")]
    #[ts(optional)]
    pub terminal_shell: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub transcript_archive_max_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub browser_mcp: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub browser_mcp_local_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_mcp: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub restore_without_asking: Option<bool>,
}

/// What setup found for each agent backend the host can run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SetupStatus {
    pub backends: BTreeMap<BackendId, BackendStatus>,
}

/// Where a backend's executable came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum ExecutableSource {
    /// The user chose it.
    Setting,
    /// The host found it.
    Discovered,
}

/// The versions of a backend this host was tested against, inclusive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TestedRange {
    pub min: String,
    pub max: String,
}

/// What the host found out about one backend's executable.
///
/// Carries no credential. Whether the backend is signed in is decided from a
/// sign-in artefact existing, never from opening one, and the remedy for "no"
/// is a sentence naming the backend's own command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct BackendStatus {
    /// Whether an executable was found and ran.
    pub installed: bool,
    /// The executable, or null when there is not one.
    pub path: Option<String>,
    pub source: Option<ExecutableSource>,
    /// The executable's own version output.
    pub version: Option<String>,
    /// The `x.y.z` parsed out of it, or null when it carried none.
    pub semver: Option<String>,
    /// Whether that version is inside `testedRange`.
    pub tested: bool,
    pub tested_range: TestedRange,
    /// The backend's config folder, or null for a backend that has none.
    pub config_dir: Option<String>,
    pub config_dir_exists: bool,
    /// Signed in, not signed in, or Unknown: a backend that cannot be asked
    /// without opening a credential store, or that declares no sign-in check.
    pub signed_in: Knowable<bool>,
    /// Which signal decided `signedIn`, so a client can say why.
    pub sign_in_signal: String,
    /// What went wrong locating or running the executable, if anything.
    pub error: Option<String>,
}

/// An executable for a backend, as the client's file picker produced it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct LocateBackendRequest {
    pub backend: BackendId,
    pub path: String,
}
