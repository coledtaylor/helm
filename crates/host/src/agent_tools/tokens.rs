//! The tokens a listener has minted, which session holds each, and which
//! families each was granted.

use std::sync::Arc;

use subtle::ConstantTimeEq;

use super::{Caller, GrantId, KeptGrant};
use crate::agent::{fill_random, hex};
use crate::config_console::sha256_hex;
use crate::session::SessionId;

/// Bytes of randomness in a token. Written as hex, so a token is twice as
/// many characters.
const TOKEN_BYTES: usize = 32;

/// Every live token. A new listener starts with none, so a token from before
/// a restart is nobody's, except one whose session the host took back from
/// its keeper: that one is known again by its hash ([`Tokens::take_back`]).
#[derive(Default)]
pub(super) struct Tokens {
    held: Vec<Held>,
    next_grant: u64,
}

struct Held {
    token: Proof,
    grant: GrantId,
    session: Option<SessionId>,
    families: Arc<[String]>,
}

/// How a live token is checked.
enum Proof {
    /// Minted here: the token itself.
    Minted(String),
    /// Taken back after a restart: the SHA-256 of the token, as hex, which
    /// the host kept in the session's row. The token itself was never kept.
    Hashed(String),
}

/// Who a live token is, and the families its launch was given.
pub(super) struct Holder {
    pub caller: Caller,
    families: Arc<[String]>,
}

impl Holder {
    /// Whether its launch was given the family named `name`.
    pub fn holds(&self, name: &str) -> bool {
        self.families.iter().any(|family| family == name)
    }
}

impl Tokens {
    /// A new token, of 32 bytes from the OS, for a launch given `families`.
    pub(super) fn mint(&mut self, families: Vec<String>) -> (GrantId, String) {
        let mut bytes = [0u8; TOKEN_BYTES];
        fill_random(&mut bytes);
        let token = hex(&bytes);
        let grant = GrantId(self.next_grant);
        self.next_grant += 1;
        self.held.push(Held {
            token: Proof::Minted(token.clone()),
            grant,
            session: None,
            families: families.into(),
        });
        (grant, token)
    }

    /// Accepts again, for `session`, the token whose hash and families
    /// `kept` holds: a session that outlived the host that minted it.
    pub(super) fn take_back(&mut self, kept: &KeptGrant, session: SessionId) -> GrantId {
        let grant = GrantId(self.next_grant);
        self.next_grant += 1;
        self.held.push(Held {
            token: Proof::Hashed(kept.token_sha256.to_ascii_lowercase()),
            grant,
            session: Some(session),
            families: kept.families.clone().into(),
        });
        grant
    }

    /// What the host keeps of `grant` so that a host after it can accept its
    /// token again: the hash of the token and the families, never the token.
    pub(super) fn kept(&self, grant: GrantId, port: u16) -> Option<KeptGrant> {
        let held = self.held.iter().find(|held| held.grant == grant)?;
        let token_sha256 = match &held.token {
            Proof::Minted(token) => sha256_hex(token.as_bytes()),
            Proof::Hashed(hash) => hash.clone(),
        };
        Some(KeptGrant {
            port,
            token_sha256,
            families: held.families.to_vec(),
        })
    }

    pub(super) fn bind(&mut self, grant: GrantId, session: SessionId) {
        if let Some(held) = self.held.iter_mut().find(|held| held.grant == grant) {
            held.session = Some(session);
        }
    }

    pub(super) fn revoke(&mut self, grant: GrantId) {
        self.held.retain(|held| held.grant != grant);
    }

    pub(super) fn revoke_all(&mut self) {
        self.held.clear();
    }

    pub(super) fn is_empty(&self) -> bool {
        self.held.is_empty()
    }

    /// Who an `Authorization` header's value is, and what it was granted,
    /// when it is exactly `Bearer <a live token>`.
    ///
    /// Every live token is compared, in constant time and without stopping at
    /// a match, so how long the answer takes says nothing about how much of a
    /// guess was right or which token it was.
    pub(super) fn resolve(&self, authorization: &[u8]) -> Option<Holder> {
        let offered = bearer(authorization)?;
        // Hashed once, and only when a token taken back is held.
        let offered_hash = self
            .held
            .iter()
            .any(|held| matches!(held.token, Proof::Hashed(_)))
            .then(|| sha256_hex(offered));
        let mut found = None;
        for held in &self.held {
            let matched = match (&held.token, &offered_hash) {
                (Proof::Minted(token), _) => token.as_bytes().ct_eq(offered),
                (Proof::Hashed(hash), Some(offered)) => hash.as_bytes().ct_eq(offered.as_bytes()),
                (Proof::Hashed(_), None) => subtle::Choice::from(0),
            };
            if bool::from(matched) {
                found = Some(Holder {
                    caller: Caller {
                        grant: held.grant,
                        session: held.session,
                        shell: false,
                    },
                    families: Arc::clone(&held.families),
                });
            }
        }
        found
    }
}

/// The credential in `Bearer <credential>`, the scheme in any case.
fn bearer(authorization: &[u8]) -> Option<&[u8]> {
    let value = authorization.trim_ascii();
    let scheme = value.get(..6)?;
    if !scheme.eq_ignore_ascii_case(b"bearer") {
        return None;
    }
    let rest = &value[6..];
    let credential = rest.trim_ascii_start();
    // A space or tab must separate them: `Bearerabc` is not a bearer token.
    (credential.len() < rest.len() && !credential.is_empty()).then_some(credential)
}
