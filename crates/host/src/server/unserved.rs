//! The protocol's host channels this host does not serve yet, each with the
//! feature that will serve it.
//!
//! Every channel the protocol declares is either served or listed here, and
//! [`drift`] says where that stops being true: a channel served but still
//! listed, a channel neither served nor listed, or an entry that names no
//! channel. The host's tests fail on any of them, so a feature that starts
//! serving a channel takes it off this list in the same change.
//!
//! A client that calls, subscribes to or opens a listed channel is answered
//! with an error naming it and the feature it comes with, and is served on as
//! before.

use std::collections::BTreeSet;
use std::fmt;

use floti_protocol::Catalogue;

/// Channels one feature will serve.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Later {
    /// The feature, by the surface it covers.
    pub feature: &'static str,
    /// Channel names, or families written `family:*`.
    pub channels: &'static [&'static str],
}

impl Later {
    /// Whether `channel` is one of these.
    pub fn covers(&self, channel: &str) -> bool {
        self.channels
            .iter()
            .any(|entry| entry_covers(entry, channel))
    }
}

fn entry_covers(entry: &str, channel: &str) -> bool {
    match entry.strip_suffix('*') {
        Some(family) => channel.starts_with(family),
        None => channel == entry,
    }
}

/// Every channel not served yet, by the feature that will serve it.
pub const NOT_YET_SERVED: &[Later] = &[
    Later {
        feature: "agent tools listener",
        channels: &["agentBrowser:*"],
    },
    Later {
        feature: "plugin pages",
        channels: &[
            "plugins:call",
            "plugins:cancel",
            "plugins:answer",
            "plugins:session",
            "plugins:ui",
            "plugins:deliver",
        ],
    },
    Later {
        feature: "plugin services",
        channels: &["plugins:log", "plugins:metrics"],
    },
    Later {
        feature: "plugin tool families",
        channels: &["plugins:setTools"],
    },
    Later {
        feature: "plugin secrets",
        channels: &["secrets:*"],
    },
];

/// The entry that lists `channel`, when it is not served yet.
pub fn later(channel: &str) -> Option<&'static Later> {
    NOT_YET_SERVED.iter().find(|later| later.covers(channel))
}

/// The sentence a client gets for a channel on the list.
pub fn refusal(channel: &str, later: &Later) -> String {
    format!(
        "This host does not serve `{channel}` yet: it comes with the {}.",
        later.feature
    )
}

/// Where the list and what the host serves disagree.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Drift {
    /// Served channels still on the list, with the feature they are listed
    /// under.
    pub served_but_listed: Vec<(&'static str, &'static str)>,
    /// Channels neither served nor listed.
    pub missing: Vec<&'static str>,
    /// Entries that cover no channel the protocol declares, with their
    /// feature.
    pub stale: Vec<(&'static str, &'static str)>,
}

impl Drift {
    pub fn is_empty(&self) -> bool {
        self.served_but_listed.is_empty() && self.missing.is_empty() && self.stale.is_empty()
    }
}

impl fmt::Display for Drift {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (channel, feature) in &self.served_but_listed {
            writeln!(
                f,
                "`{channel}` is served but still listed as not served yet ({feature})"
            )?;
        }
        for channel in &self.missing {
            writeln!(
                f,
                "`{channel}` is not served and not on the not-yet-served list"
            )?;
        }
        for (entry, feature) in &self.stale {
            writeln!(
                f,
                "`{entry}` ({feature}) names no channel the protocol declares"
            )?;
        }
        Ok(())
    }
}

/// How [`NOT_YET_SERVED`] and `served` disagree about `catalogue`.
pub fn drift(catalogue: &Catalogue, served: &BTreeSet<&'static str>) -> Drift {
    drift_against(catalogue, served, NOT_YET_SERVED)
}

/// How `list` and `served` disagree about `catalogue`.
pub fn drift_against(
    catalogue: &Catalogue,
    served: &BTreeSet<&'static str>,
    list: &[Later],
) -> Drift {
    let mut drift = Drift::default();
    for decl in catalogue.channels() {
        let channel = decl.name();
        let listed = list.iter().find(|later| later.covers(channel));
        match (served.contains(channel), listed) {
            (true, Some(later)) => drift.served_but_listed.push((channel, later.feature)),
            (false, None) => drift.missing.push(channel),
            _ => {}
        }
    }
    for later in list {
        for entry in later.channels {
            if !catalogue
                .channels()
                .any(|decl| entry_covers(entry, decl.name()))
            {
                drift.stale.push((entry, later.feature));
            }
        }
    }
    drift
}

#[cfg(test)]
mod tests {
    use super::*;

    fn served(channels: &[&'static str]) -> BTreeSet<&'static str> {
        channels.iter().copied().collect()
    }

    /// Every protocol channel the list does not cover, as if all were
    /// served.
    fn all_unlisted(catalogue: &Catalogue) -> BTreeSet<&'static str> {
        catalogue
            .channels()
            .map(|decl| decl.name())
            .filter(|name| later(name).is_none())
            .collect()
    }

    #[test]
    fn the_list_names_each_served_channel_left_on_it() {
        let catalogue = Catalogue::protocol();
        let mut served = all_unlisted(&catalogue);
        served.insert("agentBrowser:call");
        served.insert("secrets:list");
        let drift = drift(&catalogue, &served);
        assert_eq!(
            drift.served_but_listed,
            vec![
                ("agentBrowser:call", "agent tools listener"),
                ("secrets:list", "plugin secrets")
            ]
        );
        assert!(
            drift.missing.is_empty() && drift.stale.is_empty(),
            "{drift}"
        );
        let said = drift.to_string();
        assert!(said.contains("`agentBrowser:call` is served"), "{said}");
        assert!(said.contains("`secrets:list` is served"), "{said}");
    }

    #[test]
    fn the_list_names_each_unserved_channel_missing_from_it() {
        let catalogue = Catalogue::protocol();
        let mut served = all_unlisted(&catalogue);
        served.remove("session:list");
        served.remove("host:stop");
        let drift = drift(&catalogue, &served);
        assert_eq!(drift.missing, vec!["host:stop", "session:list"]);
        assert!(drift.served_but_listed.is_empty(), "{drift}");
        let said = drift.to_string();
        assert!(said.contains("`host:stop` is not served"), "{said}");
        assert!(said.contains("`session:list` is not served"), "{said}");
    }

    #[test]
    fn the_list_names_an_entry_that_covers_no_channel() {
        let catalogue = Catalogue::protocol();
        let list = [Later {
            feature: "plugin secrets",
            channels: &["secrets:*", "nothing:here"],
        }];
        let drift = drift_against(&catalogue, &served(&[]), &list);
        assert_eq!(drift.stale, vec![("nothing:here", "plugin secrets")]);
    }

    #[test]
    fn every_entry_is_labelled_with_the_feature_that_will_serve_it() {
        let features: BTreeSet<&str> = NOT_YET_SERVED.iter().map(|later| later.feature).collect();
        for permanent in [
            "agent tools listener",
            "plugin pages",
            "plugin services",
            "plugin tool families",
            "plugin secrets",
        ] {
            assert!(features.contains(permanent), "{permanent} is missing");
        }
        assert!(
            NOT_YET_SERVED
                .iter()
                .all(|later| !later.feature.is_empty() && !later.channels.is_empty())
        );
    }

    #[test]
    fn a_refusal_names_the_channel_and_its_feature() {
        let later = later("agentBrowser:call").unwrap();
        assert_eq!(
            refusal("agentBrowser:call", later),
            "This host does not serve `agentBrowser:call` yet: it comes with the agent tools listener."
        );
    }
}
