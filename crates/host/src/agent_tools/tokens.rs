//! The tokens a listener has minted, and which session holds each.

use subtle::ConstantTimeEq;

use super::{Caller, GrantId};
use crate::agent::{fill_random, hex};
use crate::session::SessionId;

/// Bytes of randomness in a token. Written as hex, so a token is twice as
/// many characters.
const TOKEN_BYTES: usize = 32;

/// Every live token. A new listener starts with none, so a token from before
/// a restart is nobody's.
#[derive(Default)]
pub(super) struct Tokens {
    held: Vec<Held>,
    next_grant: u64,
}

struct Held {
    token: String,
    grant: GrantId,
    session: Option<SessionId>,
}

impl Tokens {
    /// A new token, of 32 bytes from the OS.
    pub(super) fn mint(&mut self) -> (GrantId, String) {
        let mut bytes = [0u8; TOKEN_BYTES];
        fill_random(&mut bytes);
        let token = hex(&bytes);
        let grant = GrantId(self.next_grant);
        self.next_grant += 1;
        self.held.push(Held {
            token: token.clone(),
            grant,
            session: None,
        });
        (grant, token)
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

    /// Who an `Authorization` header's value is, when it is exactly
    /// `Bearer <a live token>`.
    ///
    /// Every live token is compared, in constant time and without stopping at
    /// a match, so how long the answer takes says nothing about how much of a
    /// guess was right or which token it was.
    pub(super) fn resolve(&self, authorization: &[u8]) -> Option<Caller> {
        let offered = bearer(authorization)?;
        let mut found = None;
        for held in &self.held {
            if bool::from(held.token.as_bytes().ct_eq(offered)) {
                found = Some(Caller {
                    grant: held.grant,
                    session: held.session,
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
