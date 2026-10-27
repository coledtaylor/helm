//! What a client can draw.
//!
//! A client declares its capabilities in `hello`, and the host sends it only
//! what they cover: a TUI has no browser and no plugin pages and is never sent
//! them. A name the host does not know is ignored rather than refused, so a
//! newer client still connects to an older host; the `welcome` lists only the
//! names the host accepted.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema, TS,
)]
#[serde(rename_all = "camelCase")]
pub enum Capability {
    /// Draws terminals: session and plain-terminal byte streams.
    Terminal,
    /// Draws the Files view.
    Files,
    /// Draws plugin pages.
    PluginPages,
    /// Has a browser pane, so agent browser tools can reach it.
    Browser,
}

impl Capability {
    pub const ALL: [Capability; 4] = [
        Capability::Terminal,
        Capability::Files,
        Capability::PluginPages,
        Capability::Browser,
    ];

    /// The wire name, as a client writes it in `hello`.
    pub const fn name(self) -> &'static str {
        match self {
            Capability::Terminal => "terminal",
            Capability::Files => "files",
            Capability::PluginPages => "pluginPages",
            Capability::Browser => "browser",
        }
    }

    /// The capability a wire name stands for, or `None` for a name this
    /// version does not know.
    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|capability| capability.name() == name)
    }

    const fn bit(self) -> u8 {
        1 << self as u8
    }
}

/// The capabilities one client declared.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CapabilitySet(u8);

impl CapabilitySet {
    pub const fn empty() -> Self {
        Self(0)
    }

    /// The known capabilities among `names`; unknown names are dropped.
    pub fn from_names<'a>(names: impl IntoIterator<Item = &'a str>) -> Self {
        names.into_iter().filter_map(Capability::parse).collect()
    }

    pub fn insert(&mut self, capability: Capability) {
        self.0 |= capability.bit();
    }

    pub const fn contains(&self, capability: Capability) -> bool {
        self.0 & capability.bit() != 0
    }

    /// Whether this set covers something that needs `required`, where `None`
    /// means it needs nothing.
    pub const fn covers(&self, required: Option<Capability>) -> bool {
        match required {
            Some(capability) => self.contains(capability),
            None => true,
        }
    }

    /// The capabilities in the set, in declaration order.
    pub fn to_vec(&self) -> Vec<Capability> {
        Capability::ALL
            .into_iter()
            .filter(|capability| self.contains(*capability))
            .collect()
    }
}

impl FromIterator<Capability> for CapabilitySet {
    fn from_iter<I: IntoIterator<Item = Capability>>(iter: I) -> Self {
        let mut set = Self::empty();
        for capability in iter {
            set.insert(capability);
        }
        set
    }
}
