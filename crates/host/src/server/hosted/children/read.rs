//! Reading: what `agents_read` and `floti agent read` do. The caller gets what
//! its child's off-screen terminal holds, as plain text: the screen and up to
//! [`MAX_ABOVE`] lines above it, with no escape sequence and no blank rows
//! under the last line.
//!
//! **Only the caller's own children.** A name is resolved among the caller's
//! children, and anything else is not found: a parent, the caller itself, a
//! sibling, another family's child and a session nobody started all answer the
//! same. A command child is its parent's alone to read.
//!
//! **A screen, never a transcript.** The text is the terminal as the program
//! drew it, interpreted by nobody. Nothing of an agent's conversation, and no
//! argv, is returned, and an agent that has ended has no screen to read.
//!
//! **A command child's output outlives its screen.** While it runs it is read
//! as any screen is; once it has exited, the last lines it printed (at most
//! 40) are what the host kept, and
//! they are the same lines its parent was told with its exit.

use super::{not_found, rows};
use crate::server::hosted::Hosted;
use crate::session::SessionId;

/// The most lines of scrollback a read returns above the screen.
pub(crate) const MAX_ABOVE: usize = 200;

/// What `agents_read` was asked: the child, and how many lines above the
/// screen at most (none for as many as there are, up to [`MAX_ABOVE`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReadChild {
    pub child: String,
    pub lines: Option<usize>,
}

/// What a read returned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChildRead {
    /// The child's name.
    pub name: String,
    /// Whether it is a command child.
    pub command: bool,
    /// Whether it has ended, so the lines are the last ones the host kept.
    pub ended: bool,
    pub lines: Vec<String>,
}

impl Hosted {
    /// The screen of the caller's child `request.child`, with up to
    /// `request.lines` lines above it, as plain text.
    ///
    /// # Errors
    ///
    /// A sentence when the name is not one of the caller's children, or the
    /// child is an agent that has ended and has no screen.
    pub(crate) fn read_child(
        &self,
        parent: SessionId,
        request: &ReadChild,
    ) -> Result<ChildRead, String> {
        let above = request.lines.unwrap_or(MAX_ABOVE).min(MAX_ABOVE);
        let (name, id, command, running) = {
            let store = self.ledger.store();
            let facts = rows::parent_facts(&store, parent).map_err(|err| err.to_string())?;
            let children = rows::children_of(&store, parent, facts.conversation_id.as_deref())
                .map_err(|err| err.to_string())?;
            let asked = request.child.trim();
            let Some(found) = children
                .iter()
                .rev()
                .find(|child| child.name.eq_ignore_ascii_case(asked))
            else {
                let running: Vec<&rows::ChildRow> = children
                    .iter()
                    .filter(|child| child.running && self.sessions.get(child.id).is_some())
                    .collect();
                return Err(not_found(&request.child, &running));
            };
            (
                found.name.clone(),
                found.id,
                found.is_command(),
                found.running,
            )
        };

        let screen = self
            .sessions
            .get(id)
            .filter(|_| running)
            .and_then(|session| session.screen_text(above));
        if let Some(lines) = screen {
            return Ok(ChildRead {
                name,
                command,
                ended: false,
                lines,
            });
        }
        if command {
            // Its screen went with it; its last lines were kept.
            return Ok(ChildRead {
                lines: self.ledger.last_lines_of(id),
                name,
                command,
                ended: true,
            });
        }
        Err(format!(
            "{name} has ended, so it has no screen to read. Resume it with agents_start resume to \
             give it another turn."
        ))
    }
}
