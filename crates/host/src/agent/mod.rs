//! Agent backends: every agent CLI the host runs, behind one trait.
//!
//! A backend says how to launch its agent, and each thing Floti can show for
//! it beyond running is an optional part: resume, status, agent tools,
//! history, usage, config files and the sign-in check. What a backend
//! declares ([`AgentBackend::capabilities`]) is derived from which parts it
//! has, so a declaration and an answer cannot disagree, and asking a backend
//! for a part it lacks answers Unknown ([`BackendAnswers`]), never an empty
//! list or a zero.
//!
//! A backend composes a [`Launch`] and never spawns anything: the session
//! module runs its [`LaunchSpec`] in a pty, so every backend gets the same
//! environment, process-tree handling and screen. What a launch needs on disk
//! (agent tool registration, settings, composed instructions, overlays) goes
//! in a [`LaunchFolder`] under Floti's data folder, never into the agent's own
//! config, and is removed when the session ends.
//!
//! Every backend lists the credential paths it must never open
//! ([`AgentBackend::credential_paths`]); nothing in the host opens them.

pub mod claude_code;
pub mod harness;
pub mod launch_folder;
mod plain;

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use floti_protocol::channels::common::PermissionMode;
use floti_protocol::channels::sessions::{EffortLevel, SessionActivity, UsageSnapshot};
use floti_protocol::channels::workspace::ConfigFile;
use floti_protocol::{
    BackendDescriptor, BackendFeature, BackendId, HarnessPart, HarnessSupport, Knowable,
};

use crate::Result;

pub use claude_code::ClaudeCodeBackend;
pub use launch_folder::{LaunchFolder, sweep_launch_folders};
pub use plain::PlainCommandBackend;

/// One agent CLI the host can run.
pub trait AgentBackend: Send + Sync {
    /// The backend's id, such as `claude-code`.
    fn id(&self) -> &BackendId;

    /// What to call it on screen, such as "Claude Code".
    fn name(&self) -> &str;

    /// What to run for a new session. Files the launch needs go in `folder`.
    fn launch(&self, request: &LaunchRequest, folder: &LaunchFolder) -> Result<Launch>;

    /// Reopening an earlier conversation, in the folder history recorded.
    fn resumer(&self) -> Option<&dyn Resumer> {
        None
    }

    /// Whether a session is busy, idle or waiting, from the agent's own
    /// records.
    fn status(&self) -> Option<&dyn StatusSource> {
        None
    }

    /// Floti's agent tools, given for one launch.
    fn agent_tools(&self) -> Option<&dyn AgentTools> {
        None
    }

    /// How Floti's permission choice maps to the agent's own flags.
    fn permissions(&self) -> Option<&dyn Permissions> {
        None
    }

    /// The agent's transcripts, read only.
    fn history(&self) -> Option<&dyn HistorySource> {
        None
    }

    /// Usage, labelled with what it measures.
    fn usage(&self) -> Option<&dyn UsageSource> {
        None
    }

    /// The agent's config files, credential files never among them.
    fn config(&self) -> Option<&dyn ConfigSource> {
        None
    }

    /// Whether the agent is signed in, decided without opening a credential.
    fn sign_in(&self) -> Option<&dyn SignInCheck> {
        None
    }

    /// Every path holding one of the agent's credentials. Nothing in the host
    /// opens these; a backend's readers skip them by name.
    fn credential_paths(&self) -> Vec<PathBuf> {
        Vec::new()
    }

    /// The versions this backend was built against. Outside them a launch
    /// warns and still runs.
    fn tested_range(&self) -> Option<TestedVersions> {
        None
    }

    /// How it takes a harness. A plain tab's answer, the default, is the
    /// folder and nothing else.
    fn harness(&self) -> HarnessSupport {
        HarnessSupport::default()
    }

    /// The backend's id, name and declared features, derived from the parts
    /// it has.
    fn capabilities(&self) -> BackendDescriptor {
        let parts = [
            (BackendFeature::Run, true),
            (BackendFeature::Resume, self.resumer().is_some()),
            (BackendFeature::Status, self.status().is_some()),
            (BackendFeature::AgentTools, self.agent_tools().is_some()),
            (BackendFeature::History, self.history().is_some()),
            (BackendFeature::Usage, self.usage().is_some()),
            (BackendFeature::Config, self.config().is_some()),
            (BackendFeature::SignInCheck, self.sign_in().is_some()),
        ];
        BackendDescriptor::new(
            self.id().clone(),
            self.name(),
            parts
                .into_iter()
                .filter_map(|(feature, has)| has.then_some(feature)),
        )
        .with_harness(self.harness())
    }
}

/// Reopens a conversation.
pub trait Resumer: Send + Sync {
    /// What to run to reopen `request.conversation_id`. It runs in the folder
    /// history recorded for it, whatever folder the client is looking at.
    fn resume(&self, request: &ResumeRequest, folder: &LaunchFolder) -> Result<Launch>;
}

/// Reads what a running session is doing from the agent's own records.
pub trait StatusSource: Send + Sync {
    /// `Known(Some(..))` when a live record says; `Known(None)` when there is
    /// no live record for the session, which shows as a plain tab; Unknown
    /// when a record is there and cannot be interpreted.
    fn status(&self, session: &SessionRef) -> Knowable<Option<SessionActivity>>;
}

/// Gives a launch Floti's agent tools without touching the agent's config.
pub trait AgentTools: Send + Sync {
    /// The arguments and variables that register `servers` for one launch,
    /// writing any file it needs into `folder`. No servers, nothing at all.
    fn register(&self, servers: &[AgentToolServer], folder: &LaunchFolder) -> Result<Registration>;
}

/// Maps Floti's permission choice to the agent's flags.
pub trait Permissions: Send + Sync {
    /// The arguments for `mode`.
    fn arguments(&self, mode: PermissionMode) -> Vec<OsString>;
}

/// The agent's transcripts.
pub trait HistorySource: Send + Sync {
    /// Every conversation on disk, most recent first.
    fn conversations(&self) -> Result<Vec<Conversation>>;

    /// One conversation's messages, or `None` when it is not on disk.
    fn transcript(&self, conversation_id: &str) -> Result<Option<Transcript>>;
}

/// The agent's usage figures.
pub trait UsageSource: Send + Sync {
    /// The latest reading. `today_start_ms` is local midnight, from the
    /// caller's clock and timezone, for the "today" estimate.
    fn usage(&self, now_ms: u64, today_start_ms: u64) -> UsageSnapshot;
}

/// The agent's config files.
pub trait ConfigSource: Send + Sync {
    /// The user's files, and `project`'s when one is given. Never a
    /// credential file.
    fn config_files(&self, project: Option<&Path>) -> Result<Vec<ConfigFile>>;
}

/// Whether the agent is signed in.
pub trait SignInCheck: Send + Sync {
    fn signed_in(&self) -> SignIn;
}

/// A new session.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LaunchRequest {
    /// The folder the session runs in.
    pub folder: PathBuf,
    /// The session's name, before it is made safe for the agent.
    pub name: String,
    /// The opening prompt, when there is one.
    pub prompt: Option<String>,
    /// What every launch of this composition gets, new or resumed.
    pub composition: Composition,
}

/// A conversation to reopen.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ResumeRequest {
    /// The agent's own id for the conversation.
    pub conversation_id: String,
    /// The folder history recorded for it.
    pub folder: PathBuf,
    /// The composition it is reopened with: a conversation reopened without
    /// its overlays is a session missing the skills it was having.
    pub composition: Composition,
}

/// What a launch is given, whether it starts a conversation or reopens one.
/// An empty choice passes nothing.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Composition {
    /// Harness projects composed in as overlays.
    pub overlays: Vec<PathBuf>,
    /// Further folders the session may work in.
    pub extra_folders: Vec<PathBuf>,
    pub model: Option<String>,
    pub effort: Option<EffortLevel>,
    pub permission_mode: Option<PermissionMode>,
    /// A named agent definition to run as.
    pub agent: Option<String>,
    /// Floti's agent tool families switched on, for this session alone.
    pub agent_tools: Vec<AgentToolServer>,
}

/// One family of Floti's agent tools: a loopback address and the session's
/// bearer token for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentToolServer {
    /// Its name as the agent lists it, such as `floti-browser`.
    pub name: String,
    pub url: String,
    pub token: String,
}

/// What registering agent tools adds to a launch.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Registration {
    pub args: Vec<OsString>,
    pub env: Vec<(OsString, OsString)>,
}

/// A composed launch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub spec: LaunchSpec,
    /// The overlays it was given, by the name the agent shows them under.
    pub overlays: Vec<String>,
    /// Whether composed project instructions were passed.
    pub composed_instructions: bool,
    /// Problems that did not stop it.
    pub warnings: Vec<String>,
    /// Parts of the harness the backend has no equivalent for, which the
    /// overlays held and the session did not get.
    pub not_taken: Vec<HarnessPart>,
}

impl Launch {
    /// A launch of `spec` with nothing composed.
    pub fn plain(spec: LaunchSpec) -> Self {
        Self {
            spec,
            overlays: Vec::new(),
            composed_instructions: false,
            warnings: Vec::new(),
            not_taken: Vec::new(),
        }
    }
}

/// A program for the session module to run in a pty.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    /// The program, by path or by a name resolved on `PATH`.
    pub program: OsString,
    /// Its arguments, each passed as one argument with no shell between.
    pub args: Vec<OsString>,
    /// The folder it starts in.
    pub cwd: PathBuf,
    /// Variables the backend adds for this launch, on top of the environment
    /// every session gets.
    pub env: Vec<(OsString, OsString)>,
    /// The agent's own id for the conversation this runs: chosen at launch
    /// where the backend lets the host pick it (Claude Code's
    /// `--session-id`), the resumed one for a resume, and `None` where the
    /// backend cannot say. A session without one cannot be restored.
    pub conversation_id: Option<String>,
    /// The launch's own folder, removed when the session ends.
    pub launch_folder: Option<PathBuf>,
}

/// A running session, as a status source finds it in the agent's records.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRef {
    /// The pid of the program the pty runs.
    pub pid: u32,
    /// The conversation it was launched or resumed with, when known.
    pub conversation_id: Option<String>,
}

/// One conversation in an agent's history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conversation {
    pub id: String,
    /// The folder it ran in, as its transcript recorded it.
    pub folder: Option<String>,
    /// What to call it, from its prompts. Never empty.
    pub title: String,
    /// True when `title` is Floti's stand-in for a record with no usable
    /// prompt.
    pub title_fallback: bool,
    /// Epoch ms of its first and last message, when it has any.
    pub first_at_ms: Option<u64>,
    pub last_at_ms: Option<u64>,
    /// The transcript it was read from.
    pub file: PathBuf,
}

/// One conversation's messages.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transcript {
    pub conversation: Conversation,
    pub messages: Vec<floti_protocol::channels::sessions::ArchiveMessage>,
}

/// A sign-in answer: whether, and which signal decided it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignIn {
    pub signed_in: Knowable<bool>,
    /// The signal, or for "no" one sentence naming the agent's own command.
    pub signal: String,
}

/// The versions a backend was built against: from `min`, up to but not
/// including `below`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TestedVersions {
    pub min: Version,
    pub below: Version,
}

impl TestedVersions {
    /// Whether `version` is inside the range, and a warning naming the range
    /// when it is not. An unreadable version is Unknown, and still launches.
    pub fn check(&self, version_output: &str) -> VersionCheck {
        let Some(version) = Version::find_in(version_output) else {
            return VersionCheck::Unknown;
        };
        if version >= self.min && version < self.below {
            VersionCheck::Tested(version)
        } else {
            VersionCheck::Untested {
                version,
                warning: format!(
                    "Version {version} has not been tested with Floti, which was tested from {} up to but not including {}. It will still launch.",
                    self.min, self.below
                ),
            }
        }
    }
}

/// What a version check found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VersionCheck {
    Tested(Version),
    Untested { version: Version, warning: String },
    Unknown,
}

/// A `major.minor.patch` version.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version(pub u32, pub u32, pub u32);

impl Version {
    /// The first `x.y.z` in `text`, such as `2.1.277` in
    /// `2.1.277 (Claude Code)`.
    pub fn find_in(text: &str) -> Option<Self> {
        let bytes = text.as_bytes();
        let mut start = 0;
        while start < bytes.len() {
            if bytes[start].is_ascii_digit() && (start == 0 || !bytes[start - 1].is_ascii_digit()) {
                let rest = &text[start..];
                let mut parts = rest.splitn(3, '.');
                let number = |part: Option<&str>| -> Option<(u32, usize)> {
                    let part = part?;
                    let digits = part.bytes().take_while(u8::is_ascii_digit).count();
                    (digits > 0)
                        .then(|| part[..digits].parse().ok().map(|n| (n, digits)))
                        .flatten()
                };
                if let (Some((major, a)), Some((minor, b)), Some((patch, _))) = (
                    number(parts.next()),
                    number(parts.next()),
                    number(parts.next()),
                ) && rest.as_bytes().get(a) == Some(&b'.')
                    && rest.as_bytes().get(a + 1 + b) == Some(&b'.')
                {
                    return Some(Self(major, minor, patch));
                }
            }
            start += 1;
        }
        None
    }
}

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.0, self.1, self.2)
    }
}

/// Asks a backend for each part, answering Unknown for a part it does not
/// have: never an empty list or a zero.
pub trait BackendAnswers {
    fn read_status(&self, session: &SessionRef) -> Knowable<Option<SessionActivity>>;
    fn read_conversations(&self) -> Knowable<Vec<Conversation>>;
    fn read_usage(&self, now_ms: u64, today_start_ms: u64) -> Knowable<UsageSnapshot>;
    fn read_config_files(&self, project: Option<&Path>) -> Knowable<Vec<ConfigFile>>;
    fn read_sign_in(&self) -> Knowable<SignIn>;
}

impl<B: AgentBackend + ?Sized> BackendAnswers for B {
    fn read_status(&self, session: &SessionRef) -> Knowable<Option<SessionActivity>> {
        self.status()
            .map_or(Knowable::Unknown, |source| source.status(session))
    }

    fn read_conversations(&self) -> Knowable<Vec<Conversation>> {
        self.history()
            .and_then(|source| source.conversations().ok())
            .map_or(Knowable::Unknown, Knowable::Known)
    }

    fn read_usage(&self, now_ms: u64, today_start_ms: u64) -> Knowable<UsageSnapshot> {
        self.usage().map_or(Knowable::Unknown, |source| {
            Knowable::Known(source.usage(now_ms, today_start_ms))
        })
    }

    fn read_config_files(&self, project: Option<&Path>) -> Knowable<Vec<ConfigFile>> {
        self.config()
            .and_then(|source| source.config_files(project).ok())
            .map_or(Knowable::Unknown, Knowable::Known)
    }

    fn read_sign_in(&self) -> Knowable<SignIn> {
        self.sign_in().map_or(Knowable::Unknown, |check| {
            Knowable::Known(check.signed_in())
        })
    }
}

/// The parts of a harness the `overlays` hold that a backend taking a harness
/// as `support` says has no equivalent for, each named once, for the launch
/// answer.
pub fn parts_not_taken(support: &HarnessSupport, overlays: &[PathBuf]) -> Vec<HarnessPart> {
    let mut not_taken: Vec<HarnessPart> = overlays
        .iter()
        .flat_map(|overlay| harness::HarnessProject::read(overlay).parts())
        .filter(|part| !support.takes(*part))
        .collect();
    not_taken.sort();
    not_taken.dedup();
    not_taken
}

/// A fresh random id in the UUID v4 form an agent's `--session-id` takes.
pub fn new_conversation_id() -> String {
    let mut bytes = [0u8; 16];
    fill_random(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = hex(&bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Random bytes from the OS. A failure here means the OS cannot give
/// randomness at all, which nothing in the host can work around.
pub(crate) fn fill_random(bytes: &mut [u8]) {
    getrandom::fill(bytes).expect("the OS gives random bytes");
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests;
