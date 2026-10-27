//! Agent backends: which agent CLI runs a session, and what Floti can show
//! for it.
//!
//! The protocol does not assume Claude Code. Every session names its backend,
//! and each backend declares the features it supports, the way a client
//! declares what it can draw. A feature a backend does not declare is
//! [`Support::Unknown`]: shown as Unknown, never left out and never guessed.
//! Claude Code is the backend `claude-code`, the first one and not a special
//! case. A backend id this client has never heard of still decodes; the client
//! shows only what that backend declares.

use std::fmt;

use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

/// Names an agent backend, such as `claude-code`.
///
/// Open-ended on purpose: a new backend on the host must not need a new
/// client to decode the sessions it runs.
#[derive(
    Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema, TS,
)]
#[serde(transparent)]
pub struct BackendId(String);

impl BackendId {
    /// Claude Code's id.
    pub const CLAUDE_CODE: &'static str = "claude-code";

    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    pub fn claude_code() -> Self {
        Self::new(Self::CLAUDE_CODE)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for BackendId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Something Floti can do or show for a backend's sessions.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema, TS,
)]
#[serde(rename_all = "camelCase")]
pub enum BackendFeature {
    /// Start a session.
    Run,
    /// Say whether a session is busy, idle or waiting, from the agent's own
    /// records.
    Status,
    /// Give a session Floti's agent tools for one launch.
    AgentTools,
    /// Reopen an earlier conversation.
    Resume,
    /// Read the agent's transcripts into history.
    History,
    /// Report usage, labelled with what it measures.
    Usage,
    /// Show and edit the agent's config files.
    Config,
    /// Say whether the agent is signed in, without opening a credential.
    SignInCheck,
}

impl BackendFeature {
    pub const ALL: [BackendFeature; 8] = [
        BackendFeature::Run,
        BackendFeature::Status,
        BackendFeature::AgentTools,
        BackendFeature::Resume,
        BackendFeature::History,
        BackendFeature::Usage,
        BackendFeature::Config,
        BackendFeature::SignInCheck,
    ];
}

/// One backend the host can run, and the features it declares.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct BackendDescriptor {
    pub id: BackendId,
    /// What to call it on screen, such as "Claude Code".
    pub name: String,
    /// What it supports. A feature a newer host names and this version does
    /// not know is dropped on decode, so it reads as Unknown here.
    #[serde(deserialize_with = "known_features")]
    #[schemars(with = "Vec<BackendFeature>")]
    pub features: Vec<BackendFeature>,
    /// How it takes a harness: which instruction files it reads, and which
    /// parts of a harness reach it and which it has no equivalent for.
    #[serde(default)]
    pub harness: HarnessSupport,
}

impl BackendDescriptor {
    /// A backend that takes the folder of a harness and nothing else in it.
    pub fn new(
        id: BackendId,
        name: impl Into<String>,
        features: impl IntoIterator<Item = BackendFeature>,
    ) -> Self {
        let mut features: Vec<BackendFeature> = features.into_iter().collect();
        features.sort();
        features.dedup();
        Self {
            id,
            name: name.into(),
            features,
            harness: HarnessSupport::default(),
        }
    }

    /// The same backend, taking a harness as `harness` says.
    pub fn with_harness(mut self, harness: HarnessSupport) -> Self {
        self.harness = harness;
        self
    }

    pub fn support(&self, feature: BackendFeature) -> Support {
        if self.features.contains(&feature) {
            Support::Declared
        } else {
            Support::Unknown
        }
    }

    /// `value()` when this backend declares `feature`, and Unknown when it
    /// does not, so a caller cannot show a value the backend never claimed.
    pub fn answer<T>(&self, feature: BackendFeature, value: impl FnOnce() -> T) -> Knowable<T> {
        match self.support(feature) {
            Support::Declared => Knowable::Known(value()),
            Support::Unknown => Knowable::Unknown,
        }
    }
}

/// A part of a harness: what a profile's harness can give a session besides
/// its folder.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema, TS,
)]
#[serde(rename_all = "camelCase")]
pub enum HarnessPart {
    /// Project instructions, such as `CLAUDE.md` or `AGENTS.md`.
    Instructions,
    /// `SKILL.md` folders, the same in every agent under the Agent Skills
    /// standard.
    Skills,
    /// Slash commands.
    Commands,
    /// Subagent definitions.
    Subagents,
    /// Workflow scripts.
    Workflows,
}

impl HarnessPart {
    pub const ALL: [HarnessPart; 5] = [
        HarnessPart::Instructions,
        HarnessPart::Skills,
        HarnessPart::Commands,
        HarnessPart::Subagents,
        HarnessPart::Workflows,
    ];
}

/// How a backend takes a harness, declared before a launch so a client can
/// say what an agent will and will not get.
///
/// The default is a plain tab's: the folder and nothing else, because Floti
/// cannot know where an unknown CLI reads. Every part in [`HarnessPart::ALL`]
/// is in exactly one of `takes` and `cannot_take`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct HarnessSupport {
    /// The instruction file names it reads, such as `CLAUDE.md` and
    /// `AGENTS.md`, in the order it reads them.
    pub instruction_files: Vec<String>,
    /// The parts that reach it.
    pub takes: Vec<HarnessPart>,
    /// The parts it has no equivalent for. A launch names each one of these a
    /// harness holds.
    pub cannot_take: Vec<HarnessPart>,
}

impl HarnessSupport {
    /// A backend that takes `takes`, reading `instruction_files`, and has no
    /// equivalent for any other part.
    pub fn taking(
        instruction_files: impl IntoIterator<Item = impl Into<String>>,
        takes: impl IntoIterator<Item = HarnessPart>,
    ) -> Self {
        let mut takes: Vec<HarnessPart> = takes.into_iter().collect();
        takes.sort();
        takes.dedup();
        let cannot_take = HarnessPart::ALL
            .into_iter()
            .filter(|part| !takes.contains(part))
            .collect();
        Self {
            instruction_files: instruction_files.into_iter().map(Into::into).collect(),
            takes,
            cannot_take,
        }
    }

    pub fn takes(&self, part: HarnessPart) -> bool {
        self.takes.contains(&part)
    }
}

impl Default for HarnessSupport {
    fn default() -> Self {
        Self::taking(Vec::<String>::new(), [])
    }
}

/// Whether a backend declares a feature.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum Support {
    Declared,
    /// Not declared, or declared by a backend this client does not know.
    /// Shown as Unknown.
    Unknown,
}

/// A value Floti either has or could not get.
///
/// "Could not look" and "nothing there" are never merged: `Known([])` is an
/// answer, `Unknown` is the absence of one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "state", content = "value", rename_all = "camelCase")]
pub enum Knowable<T> {
    Known(T),
    Unknown,
}

impl<T> Knowable<T> {
    pub fn is_known(&self) -> bool {
        matches!(self, Knowable::Known(_))
    }

    pub fn known(self) -> Option<T> {
        match self {
            Knowable::Known(value) => Some(value),
            Knowable::Unknown => None,
        }
    }
}

/// Every feature with its support for one backend, in [`BackendFeature::ALL`]
/// order. `None` is a backend the host did not describe: every feature is
/// Unknown.
pub fn feature_table(backend: Option<&BackendDescriptor>) -> [(BackendFeature, Support); 8] {
    BackendFeature::ALL.map(|feature| {
        (
            feature,
            backend.map_or(Support::Unknown, |descriptor| descriptor.support(feature)),
        )
    })
}

fn known_features<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<BackendFeature>, D::Error> {
    let names = Vec::<String>::deserialize(deserializer)?;
    Ok(names
        .into_iter()
        .filter_map(|name| {
            ciborium::Value::Text(name)
                .deserialized::<BackendFeature>()
                .ok()
        })
        .collect())
}
