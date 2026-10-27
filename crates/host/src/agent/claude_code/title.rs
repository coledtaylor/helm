//! What to call a conversation, from the prompts it recorded: the first that
//! says something, failing that the first that is legible, failing that a
//! stand-in in Floti's own words. Pure: text in, text out.

/// The longest title, in characters, before it is cut on a word.
pub const TITLE_MAX: usize = 60;

/// A title, and whether anybody actually said it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionTitle {
    pub text: String,
    /// True when no prompt survived cleaning and `text` is Floti's own words.
    pub fallback: bool,
}

/// A whole conversation's prompts as a title.
pub fn session_title_from(prompts: &[String]) -> SessionTitle {
    let chosen = prompts
        .iter()
        .find(|text| title_rank(text) == 0)
        .or_else(|| prompts.iter().find(|text| title_rank(text) == 1))
        .or_else(|| prompts.first());
    derive_title(chosen.map_or("", String::as_str))
}

/// One prompt as a title: cleaned, cut, never empty.
fn derive_title(raw: &str) -> SessionTitle {
    let cleaned = clean_prompt(raw);
    if cleaned.is_empty() {
        let text = if raw.contains("[Image #") {
            "Image only"
        } else if raw.contains("[Pasted text") {
            "Pasted text only"
        } else {
            "No prompt recorded"
        };
        return SessionTitle {
            text: text.to_owned(),
            fallback: true,
        };
    }
    SessionTitle {
        text: truncate(&cleaned),
        fallback: false,
    }
}

/// How usable a prompt is as a title. 0 says something, 1 is legible but
/// says nothing on its own (`/usage`, `ok`), 2 has nothing left.
fn title_rank(text: &str) -> u8 {
    let cleaned = clean_prompt(text);
    if cleaned.is_empty() {
        return 2;
    }
    let Some(command_len) = command_length(&cleaned) else {
        return if says_something(&cleaned) { 0 } else { 1 };
    };
    let args = collapse(&remove_flags(&cleaned[command_len..]));
    if says_something(&args) { 0 } else { 1 }
}

/// The prompt without attachment placeholders (`[Image #1]`,
/// `[Pasted text #1 +142 lines]`), on one line.
fn clean_prompt(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('[') {
        out.push_str(&rest[..open]);
        let after = &rest[open..];
        match placeholder_length(after) {
            Some(len) => {
                out.push(' ');
                rest = &after[len..];
            }
            None => {
                out.push('[');
                rest = &after[1..];
            }
        }
    }
    out.push_str(rest);
    collapse(&out)
}

/// The length of a placeholder at the start of `text`, if one is there.
fn placeholder_length(text: &str) -> Option<usize> {
    let digits = |s: &str| s.bytes().take_while(u8::is_ascii_digit).count();
    let body = if let Some(rest) = text.strip_prefix("[Image #") {
        let n = digits(rest);
        (n > 0).then(|| &rest[n..])?
    } else if let Some(rest) = text.strip_prefix("[Pasted text #") {
        let n = digits(rest);
        let mut rest = (n > 0).then(|| &rest[n..])?;
        if let Some(lines) = rest.strip_prefix(" +") {
            let m = digits(lines);
            if m > 0
                && let Some(after) = lines[m..].strip_prefix(" line")
            {
                rest = after.strip_prefix('s').unwrap_or(after);
            }
        }
        rest
    } else {
        return None;
    };
    body.starts_with(']').then(|| text.len() - body.len() + 1)
}

/// The length of a leading slash command (`/usage`, `/spec:quick`).
fn command_length(text: &str) -> Option<usize> {
    let rest = text.strip_prefix('/')?;
    let first = rest.chars().next()?;
    if !first.is_ascii_alphanumeric() {
        return None;
    }
    let len = rest
        .chars()
        .take_while(|c| c.is_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'))
        .map(char::len_utf8)
        .sum::<usize>();
    Some(1 + len)
}

/// `--research` and `-n` taken out: switches, not a subject.
fn remove_flags(text: &str) -> String {
    text.split(' ')
        .filter(|word| {
            let bare = word.trim_start_matches('-');
            let dashes = word.len() - bare.len();
            !((1..=2).contains(&dashes)
                && bare.chars().next().is_some_and(|c| c.is_ascii_alphabetic()))
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Two or more words that each hold two letters running.
fn says_something(text: &str) -> bool {
    text.split(' ')
        .filter(|word| {
            word.as_bytes()
                .windows(2)
                .any(|pair| pair[0].is_ascii_alphabetic() && pair[1].is_ascii_alphabetic())
        })
        .count()
        >= 2
}

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Cut to [`TITLE_MAX`] on a word, with the ellipsis that says so, unless the
/// last space is too early to be worth honouring.
fn truncate(text: &str) -> String {
    if text.chars().count() <= TITLE_MAX {
        return text.to_owned();
    }
    let cut: String = text.chars().take(TITLE_MAX).collect();
    let kept = match cut.rfind(' ') {
        Some(space) if cut[..space].chars().count() >= TITLE_MAX / 2 => &cut[..space],
        _ => cut.as_str(),
    };
    let kept = kept.trim_end_matches(|c: char| c.is_whitespace() || ",.;:!?-".contains(c));
    format!("{kept}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn title(prompts: &[&str]) -> SessionTitle {
        session_title_from(&prompts.iter().map(|p| (*p).to_owned()).collect::<Vec<_>>())
    }

    #[test]
    fn the_first_prompt_that_says_something_names_it() {
        assert_eq!(
            title(&["/usage", "ok", "fix the login page redirect"]),
            SessionTitle {
                text: "fix the login page redirect".into(),
                fallback: false
            }
        );
        assert_eq!(
            title(&[
                "/spec:execute-phase 1",
                "/spec:quick when a user goes to admin"
            ])
            .text,
            "/spec:quick when a user goes to admin"
        );
    }

    #[test]
    fn a_legible_prompt_is_used_when_none_says_something() {
        assert_eq!(title(&["", "/usage"]).text, "/usage");
    }

    #[test]
    fn placeholders_are_removed_and_nothing_left_is_a_stand_in() {
        assert_eq!(
            title(&["What is causing this [Image #1]"]).text,
            "What is causing this"
        );
        assert_eq!(
            title(&["[Image #2]"]),
            SessionTitle {
                text: "Image only".into(),
                fallback: true
            }
        );
        assert_eq!(
            title(&["[Pasted text #1 +142 lines]"]).text,
            "Pasted text only"
        );
        assert_eq!(title(&[]).text, "No prompt recorded");
    }

    #[test]
    fn a_long_prompt_is_cut_on_a_word() {
        let long = "please look at the way the session list orders its rows when two sessions share a name";
        let cut = title(&[long]).text;
        assert!(cut.ends_with('…'), "{cut}");
        assert!(cut.chars().count() <= TITLE_MAX + 1, "{cut}");
        assert_eq!(
            cut,
            "please look at the way the session list orders its rows…"
        );
    }
}
