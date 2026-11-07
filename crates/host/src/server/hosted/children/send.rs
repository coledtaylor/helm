//! Sending: what `agents_send` and `floti agent send` do. The caller is its
//! child's user for the one turn: the text arrives in the child's terminal as
//! one bracketed paste followed by the backend's submit key, as if it had been
//! typed there.
//!
//! **Only the caller's own children.** A name is resolved among the caller's
//! children, and anything else is not found. A child that has ended takes
//! nothing.
//!
//! **Refusals type nothing, and say which.** The child has ended (resume it
//! with `agents_start` `resume`); it waits on a permission prompt or any other
//! dialog, which only a person answers (its activity: its backend's records
//! first, then its program's OSC 7501 `blocked`); a person has typed into its
//! terminal since its last turn ended (marked where a client's bytes reach
//! the session, cleared where the child's turn ends); or it is not an agent,
//! which takes no turns.
//!
//! **The keys are the backend's.** What opens and closes a paste, what
//! submits it, what stops a turn and how long to wait between the end of the
//! paste and the submit key are declared by the child's adapter
//! ([`AgentInput`]); nothing here names an agent. A backend that declares no
//! input (a plain terminal or command) takes no turns.
//!
//! **The pause is a timer.** An agent that reads the paste and the key after it
//! together does not submit on that key, so the submit key is pressed only
//! after the adapter's pause. With `interrupt` the stop key is pressed first,
//! and the text follows after the same pause, so that the stop is read apart
//! from the paste's opening.
//!
//! **Typing is one turn at a time.** Two sends to one child are taken in turn,
//! so the paste and submit of one never come between the other's.
//!
//! **Text sent while the child works is accepted.** The host looks at
//! nothing on the child's screen: an agent that takes text typed during a turn
//! as its next turn does so itself.

use std::sync::Arc;

use tokio::time::sleep;

use super::{not_found, rows};
use crate::agent::AgentInput;
use crate::server::hosted::Hosted;
use crate::session::{ReportState, Session, SessionId};
use floti_protocol::channels::sessions::SessionActivity;

/// What `agents_send` was asked: the child, the text and whether to stop the
/// child's turn in progress first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SendChild {
    pub child: String,
    pub text: String,
    pub interrupt: bool,
}

/// What a send did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChildSent {
    /// The child's name.
    pub name: String,
    /// Whether the stop key was pressed first.
    pub interrupted: bool,
}

/// Where the bytes of a turn go: a child's terminal.
pub(super) trait Keys {
    /// Presses `bytes`.
    ///
    /// # Errors
    ///
    /// A sentence when the terminal takes no more.
    fn press(&self, bytes: &[u8]) -> Result<(), String>;
}

impl Keys for Session {
    fn press(&self, bytes: &[u8]) -> Result<(), String> {
        self.type_for_parent(bytes).map_err(|err| err.to_string())
    }
}

/// Types one turn: the stop key and its pause when `interrupt`, then `text` as
/// one paste, the pause, and the submit key.
///
/// # Errors
///
/// A sentence when `interrupt` is asked of an agent with no stop key (before
/// any key is pressed), or when the terminal takes no more.
pub(super) async fn type_turn(
    keys: &impl Keys,
    input: &AgentInput,
    text: &str,
    interrupt: bool,
) -> Result<(), String> {
    let stop = match (&input.stop, interrupt) {
        (Some(stop), true) => Some(stop),
        (None, true) => return Err("That agent has no key that stops a turn.".to_owned()),
        (_, false) => None,
    };
    if let Some(stop) = stop {
        keys.press(stop)?;
        sleep(input.pause).await;
    }
    keys.press(&input.paste(text))?;
    sleep(input.pause).await;
    keys.press(&input.submit)
}

/// A child that can be sent to: its terminal, its name and how its backend
/// takes a turn.
struct Target {
    session: Arc<Session>,
    name: String,
    input: AgentInput,
}

impl Hosted {
    /// Types `request.text` into the caller's child `request.child` as its
    /// next turn.
    ///
    /// # Errors
    ///
    /// A sentence when the name is not one of the caller's children, the
    /// child has ended, its backend takes no typed turns or has no stop key
    /// for an interrupt, or the text is empty.
    pub(crate) async fn send_to_child(
        self: &Arc<Self>,
        parent: SessionId,
        request: SendChild,
    ) -> Result<ChildSent, String> {
        if request.text.trim().is_empty() {
            return Err("Give the text to send: text is the child's next turn.".to_owned());
        }
        let target = {
            let hosted = Arc::clone(self);
            let child = request.child.clone();
            tokio::task::spawn_blocking(move || hosted.target_of(parent, &child))
                .await
                .unwrap_or_else(|_| Err("Floti could not finish that. Try again.".to_owned()))?
        };
        let turn = self.children.typing_lock(target.session.id());
        let _one_at_a_time = turn.lock().await;
        self.refuse_at_a_prompt_or_after_a_person(&target)?;
        type_turn(
            &*target.session,
            &target.input,
            &request.text,
            request.interrupt,
        )
        .await?;
        Ok(ChildSent {
            name: target.name,
            interrupted: request.interrupt,
        })
    }

    /// Nothing is typed while the child waits on a prompt or any other dialog
    /// (Floti answers none), or when a person has typed into its terminal
    /// since its last turn ended (their keys come first).
    fn refuse_at_a_prompt_or_after_a_person(&self, target: &Target) -> Result<(), String> {
        let name = &target.name;
        let blocked = matches!(
            target.session.reported_status(),
            Some(status) if status.report.state == ReportState::Blocked
        );
        if blocked
            || self.children.news.activity_of(target.session.id()) == Some(SessionActivity::Waiting)
        {
            return Err(format!(
                "{name} is waiting on a prompt a person must answer, so nothing was typed. \
                 Floti answers no prompt; send again once it is working again."
            ));
        }
        if target.session.person_typed() {
            return Err(format!(
                "A person has typed in {name}'s terminal since its last turn, so nothing was typed. \
                 Send again once its next turn has ended."
            ));
        }
        Ok(())
    }

    /// The running child of `parent` called `name`, with its backend's input.
    fn target_of(&self, parent: SessionId, name: &str) -> Result<Target, String> {
        let (child, session) = {
            let store = self.ledger.store();
            let facts = rows::parent_facts(&store, parent).map_err(|err| err.to_string())?;
            let children = rows::children_of(&store, parent, facts.conversation_id.as_deref())
                .map_err(|err| err.to_string())?;
            let asked = name.trim();
            let Some(found) = children
                .iter()
                .rev()
                .find(|child| child.name.eq_ignore_ascii_case(asked))
            else {
                let running: Vec<&rows::ChildRow> = children
                    .iter()
                    .filter(|child| child.running && self.sessions.get(child.id).is_some())
                    .collect();
                return Err(not_found(name, &running));
            };
            let session = self.sessions.get(found.id).filter(|_| found.running);
            (
                (found.name.clone(), found.backend.clone()),
                session.ok_or_else(|| {
                    format!(
                        "{} has ended, so it takes nothing more. Resume it with agents_start \
                         resume to give it another turn.",
                        found.name
                    )
                })?,
            )
        };
        let (name, backend) = child;
        let input = self
            .find_backend(&floti_protocol::BackendId::new(backend))
            .and_then(|backend| backend.input())
            .ok_or_else(|| format!("{name} takes no typed turns: it is not an agent."))?;
        Ok(Target {
            session,
            name,
            input,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::time::Duration;

    use tokio::time::Instant;

    use super::*;

    /// Keys pressed, each with the instant of the clock it was pressed at.
    #[derive(Default)]
    struct Pressed(Mutex<Vec<(Instant, Vec<u8>)>>);

    impl Keys for Pressed {
        fn press(&self, bytes: &[u8]) -> Result<(), String> {
            self.0
                .lock()
                .unwrap()
                .push((Instant::now(), bytes.to_vec()));
            Ok(())
        }
    }

    const PAUSE: Duration = Duration::from_millis(250);

    fn input() -> AgentInput {
        AgentInput::bracketed(b"\r", Some(b"\x1b"), PAUSE)
    }

    #[tokio::test(start_paused = true)]
    async fn the_text_is_one_paste_and_the_submit_key_comes_only_after_the_pause() {
        let keys = Pressed::default();
        let started = Instant::now();
        let input = input();
        let turn = type_turn(&keys, &input, "one\ntwo", false);
        tokio::pin!(turn);

        // Nothing but the paste has been pressed while the pause runs.
        tokio::select! {
            biased;
            result = &mut turn => panic!("finished before the pause: {result:?}"),
            () = tokio::time::sleep(PAUSE - Duration::from_millis(1)) => {}
        }
        {
            let pressed = keys.0.lock().unwrap();
            assert_eq!(pressed.len(), 1);
            assert_eq!(pressed[0].1, b"\x1b[200~one\ntwo\x1b[201~".to_vec());
            assert_eq!(pressed[0].0, started);
        }

        turn.await.unwrap();
        let pressed = keys.0.lock().unwrap();
        assert_eq!(pressed.len(), 2);
        assert_eq!(pressed[1].1, b"\r".to_vec());
        assert_eq!(pressed[1].0 - pressed[0].0, PAUSE);
    }

    #[tokio::test(start_paused = true)]
    async fn an_interrupt_presses_the_stop_key_first_then_pastes_and_submits_each_after_the_pause()
    {
        let keys = Pressed::default();
        type_turn(&keys, &input(), "instead", true).await.unwrap();
        let pressed = keys.0.lock().unwrap();
        let sent: Vec<&[u8]> = pressed.iter().map(|(_, bytes)| bytes.as_slice()).collect();
        assert_eq!(sent, [&b"\x1b"[..], b"\x1b[200~instead\x1b[201~", b"\r"]);
        assert_eq!(pressed[1].0 - pressed[0].0, PAUSE);
        assert_eq!(pressed[2].0 - pressed[1].0, PAUSE);
    }

    #[tokio::test(start_paused = true)]
    async fn an_interrupt_of_an_agent_with_no_stop_key_is_refused_before_any_key_is_pressed() {
        let keys = Pressed::default();
        let mut input = input();
        input.stop = None;
        let refused = type_turn(&keys, &input, "instead", true).await.unwrap_err();
        assert!(refused.contains("no key that stops a turn"), "{refused}");
        assert!(keys.0.lock().unwrap().is_empty());
        // The same agent takes the text without an interrupt.
        type_turn(&keys, &input, "instead", false).await.unwrap();
        assert_eq!(keys.0.lock().unwrap().len(), 2);
    }
}
