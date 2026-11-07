//! What an agent's terminal input is made of: the keys a parent presses to
//! give a child a turn.
//!
//! Each backend declares them ([`AgentBackend::input`]) and nothing outside
//! its adapter names an agent's keys: the bytes that open and close a
//! bracketed paste, the key that submits it, the key that stops a turn in
//! progress, and the pause between the end of a paste and the submit. An agent
//! that reads a paste and the key right after it as one input does not submit
//! on that key, so the host waits [`AgentInput::pause`] between them.
//!
//! A plain command line has no turns, so it declares none of this unless its
//! role names a submit word and a stop word ([`AgentInput::from_words`]).
//!
//! [`AgentBackend::input`]: super::AgentBackend::input

use std::time::Duration;

/// What a terminal sends before pasted text.
pub const PASTE_OPEN: &[u8] = b"\x1b[200~";

/// What a terminal sends after pasted text.
pub const PASTE_CLOSE: &[u8] = b"\x1b[201~";

/// How an agent takes a turn typed into its terminal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentInput {
    /// Sent before the text of a paste.
    pub paste_open: Vec<u8>,
    /// Sent after the text of a paste.
    pub paste_close: Vec<u8>,
    /// The key that submits what was pasted.
    pub submit: Vec<u8>,
    /// The key that stops a turn in progress, or none when the agent has no
    /// such key: a send that asks to interrupt is then refused, naming it.
    pub stop: Option<Vec<u8>>,
    /// How long to wait between the end of the paste and the submit key.
    pub pause: Duration,
}

impl AgentInput {
    /// An agent that takes the standard bracketed paste, submitted by `submit`
    /// after `pause`, and stopped by `stop`.
    pub fn bracketed(submit: &[u8], stop: Option<&[u8]>, pause: Duration) -> Self {
        Self {
            paste_open: PASTE_OPEN.to_vec(),
            paste_close: PASTE_CLOSE.to_vec(),
            submit: submit.to_vec(),
            stop: stop.map(<[u8]>::to_vec),
            pause,
        }
    }

    /// A plain command line's input from the words its role gives for submit
    /// and stop, or `None` when the role gives no submit word: a command line
    /// without one takes no turns. A role with a submit word and no stop word
    /// has no stop key.
    ///
    /// # Errors
    ///
    /// The sentence naming a word that is not a key.
    pub fn from_words(submit: Option<&str>, stop: Option<&str>) -> Result<Option<Self>, String> {
        let Some(submit) = submit.map(str::trim).filter(|word| !word.is_empty()) else {
            return Ok(None);
        };
        let submit = key_bytes(submit).map_err(|problem| format!("submit: {problem}"))?;
        let stop = match stop.map(str::trim).filter(|word| !word.is_empty()) {
            Some(word) => Some(key_bytes(word).map_err(|problem| format!("stop: {problem}"))?),
            None => None,
        };
        Ok(Some(Self {
            paste_open: PASTE_OPEN.to_vec(),
            paste_close: PASTE_CLOSE.to_vec(),
            submit,
            stop,
            pause: PLAIN_PAUSE,
        }))
    }

    /// `text` as one bracketed paste: the open marker, the text and the close
    /// marker. Newlines and tabs stay; a line ending is one `\n`; every other
    /// control character is dropped, because an escape in the text could end
    /// the paste early and make the rest of it keys.
    pub fn paste(&self, text: &str) -> Vec<u8> {
        let mut bytes =
            Vec::with_capacity(self.paste_open.len() + text.len() + self.paste_close.len());
        bytes.extend_from_slice(&self.paste_open);
        let mut chars = text.chars().peekable();
        let mut buffer = [0_u8; 4];
        while let Some(c) = chars.next() {
            let c = match c {
                '\r' => {
                    if chars.peek() == Some(&'\n') {
                        continue;
                    }
                    '\n'
                }
                '\n' | '\t' => c,
                other if other.is_control() => continue,
                other => other,
            };
            bytes.extend_from_slice(c.encode_utf8(&mut buffer).as_bytes());
        }
        bytes.extend_from_slice(&self.paste_close);
        bytes
    }
}

/// The pause a plain command line waits between a paste and its submit key:
/// a chosen default, as a role has no word for it.
pub const PLAIN_PAUSE: Duration = Duration::from_millis(100);

/// The bytes a key word names, in the one place words become bytes.
///
/// The words are `enter` (or `return`), `escape` (or `esc`), `tab`, `space`,
/// `backspace` and `ctrl-<letter>`, in any case.
///
/// # Errors
///
/// The sentence naming a word that is none of them.
pub fn key_bytes(word: &str) -> Result<Vec<u8>, String> {
    let lower = word.trim().to_ascii_lowercase();
    match lower.as_str() {
        "enter" | "return" => return Ok(b"\r".to_vec()),
        "escape" | "esc" => return Ok(b"\x1b".to_vec()),
        "tab" => return Ok(b"\t".to_vec()),
        "space" => return Ok(b" ".to_vec()),
        "backspace" => return Ok(b"\x7f".to_vec()),
        _ => {}
    }
    if let Some(letter) = lower.strip_prefix("ctrl-")
        && let [letter @ b'a'..=b'z'] = letter.as_bytes()
    {
        return Ok(vec![letter - b'a' + 1]);
    }
    Err(format!(
        "{word} is not a key (the keys are enter, escape, tab, space, backspace and ctrl-<letter>)"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_paste_is_the_open_marker_the_text_untouched_and_the_close_marker() {
        let input = AgentInput::bracketed(b"\r", Some(b"\x1b"), Duration::from_millis(250));
        assert_eq!(
            input.paste("one\ntwo\n"),
            b"\x1b[200~one\ntwo\n\x1b[201~".to_vec()
        );
        assert_eq!(input.paste(""), b"\x1b[200~\x1b[201~".to_vec());
        assert_eq!(
            input.paste("tab\there é"),
            "\x1b[200~tab\there é\x1b[201~".as_bytes().to_vec()
        );
    }

    #[test]
    fn a_paste_cannot_end_itself_early_or_carry_a_key() {
        let input = AgentInput::bracketed(b"\r", Some(b"\x1b"), Duration::from_millis(250));
        // Line endings become one newline each; an escape, a bell and a
        // delete are dropped, so the close marker in the text is not one.
        assert_eq!(
            input.paste("a\r\nb\rc\x1b[201~d\x07\x7fe"),
            b"\x1b[200~a\nb\nc[201~de\x1b[201~".to_vec()
        );
    }

    #[test]
    fn the_words_are_turned_into_bytes_in_any_case() {
        for (word, bytes) in [
            ("enter", &b"\r"[..]),
            ("Return", b"\r"),
            ("ESC", b"\x1b"),
            ("escape", b"\x1b"),
            ("tab", b"\t"),
            ("space", b" "),
            ("backspace", b"\x7f"),
            ("ctrl-c", b"\x03"),
            ("Ctrl-D", b"\x04"),
            ("ctrl-x", b"\x18"),
            ("ctrl-z", b"\x1a"),
            (" ctrl-a ", b"\x01"),
        ] {
            assert_eq!(key_bytes(word).unwrap(), bytes, "{word}");
        }
    }

    #[test]
    fn a_word_that_is_not_a_key_is_refused_naming_it() {
        for word in [
            "",
            "f5",
            "ctrl-",
            "ctrl-1",
            "ctrl-cc",
            "alt-x",
            "shift-enter",
        ] {
            let refused = key_bytes(word).expect_err(word);
            assert!(refused.contains("is not a key"), "{word}: {refused}");
            assert!(refused.contains(word.trim()), "{word}: {refused}");
        }
    }

    #[test]
    fn a_role_with_a_submit_word_and_a_stop_word_declares_input() {
        let input = AgentInput::from_words(Some("enter"), Some("ctrl-c"))
            .unwrap()
            .expect("it takes turns");
        assert_eq!(input.submit, b"\r");
        assert_eq!(input.stop.as_deref(), Some(&b"\x03"[..]));
        assert_eq!(input.paste_open, PASTE_OPEN);
        assert_eq!(input.paste_close, PASTE_CLOSE);
        assert_eq!(input.pause, PLAIN_PAUSE);
    }

    #[test]
    fn a_role_without_a_submit_word_declares_no_input_and_one_without_a_stop_word_no_stop_key() {
        for (submit, stop) in [(None, None), (None, Some("ctrl-c")), (Some("  "), None)] {
            assert_eq!(AgentInput::from_words(submit, stop), Ok(None), "{submit:?}");
        }
        let input = AgentInput::from_words(Some("enter"), None)
            .unwrap()
            .expect("it takes turns");
        assert_eq!(input.stop, None);
    }

    #[test]
    fn a_role_word_that_is_not_a_key_is_refused_naming_its_field() {
        assert!(
            AgentInput::from_words(Some("hit it"), None)
                .unwrap_err()
                .starts_with("submit: hit it is not a key")
        );
        assert!(
            AgentInput::from_words(Some("enter"), Some("kill"))
                .unwrap_err()
                .starts_with("stop: kill is not a key")
        );
    }
}
