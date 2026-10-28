//! `[[wikilink]]` resolution, the way Obsidian resolves it.
//!
//! A link is written by name, not by path: `[[reference-session-history]]`
//! finds `notes/reference-session-history.md` from anywhere in the scope. The
//! index is keyed by scope-relative path (with and without its extension)
//! and by bare name, and a path spelling wins over a name collision. A link
//! that resolves to nothing is not an error: it marks a note worth writing.

use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedWikilink {
    /// Everything before the `#` or `|`, trimmed.
    pub target: String,
    /// What to show: the alias after `|`, else the target.
    pub label: String,
    /// The `#heading` part, without the hash.
    pub heading: Option<String>,
    /// `![[embed]]`, which is linked rather than inlined.
    pub embed: bool,
}

/// What a scope's files answer to.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WikiIndex {
    /// Lower-cased name (no extension) to every file that answers to it.
    by_name: HashMap<String, Vec<String>>,
    /// Lower-cased scope-relative path, with and without its extension.
    by_path: HashMap<String, String>,
    pub size: usize,
}

/// One file an index is built from.
#[derive(Debug, Clone, Copy)]
pub struct IndexedFile<'a> {
    /// The absolute path a link resolves to.
    pub path: &'a str,
    /// Relative to the scope, forward-slashed.
    pub rel_path: &'a str,
    /// The name without its extension.
    pub slug: &'a str,
}

impl WikiIndex {
    pub fn build<'a>(files: impl IntoIterator<Item = IndexedFile<'a>>) -> Self {
        let mut index = Self::default();
        for file in files {
            index
                .by_name
                .entry(file.slug.to_lowercase())
                .or_default()
                .push(file.path.to_owned());
            let rel = file.rel_path.to_lowercase();
            let without_ext = strip_extension(&rel).to_owned();
            index
                .by_path
                .entry(rel)
                .or_insert_with(|| file.path.to_owned());
            index
                .by_path
                .entry(without_ext)
                .or_insert_with(|| file.path.to_owned());
            index.size += 1;
        }
        index
    }

    /// The file a link names, or `None`. `self_path` is the file the link
    /// is written in: `[[#Heading]]` resolves to it, and of two files that
    /// answer to one name the one beside it wins.
    pub fn resolve(&self, link: &ParsedWikilink, self_path: Option<&str>) -> Option<String> {
        if link.target.is_empty() {
            return self_path.map(str::to_owned);
        }
        let lowered = link.target.to_lowercase().replace('\\', "/");
        let needle = lowered.strip_prefix("./").unwrap_or(&lowered);

        if let Some(path) = self
            .by_path
            .get(needle)
            .or_else(|| self.by_path.get(strip_extension(needle)))
        {
            return Some(path.clone());
        }

        let name = needle.rsplit('/').next().unwrap_or(needle);
        let candidates = self.by_name.get(name).filter(|found| !found.is_empty())?;
        if candidates.len() == 1 {
            return candidates.first().cloned();
        }
        if let Some(self_path) = self_path {
            let cut = self_path
                .rfind(['/', '\\'])
                .unwrap_or_else(|| self_path.len().saturating_sub(1));
            let dir = &self_path[..floor_char_boundary(self_path, cut)];
            if let Some(sibling) = candidates.iter().find(|path| path.starts_with(dir)) {
                return Some(sibling.clone());
            }
        }
        candidates.first().cloned()
    }
}

fn floor_char_boundary(text: &str, mut at: usize) -> usize {
    while at > 0 && !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}

/// `rel` without a final `.ext` that holds no `.` or `/`.
fn strip_extension(rel: &str) -> &str {
    match rel.rfind('.') {
        Some(dot) if dot + 1 < rel.len() && !rel[dot + 1..].contains('/') => &rel[..dot],
        _ => rel,
    }
}

/// Splits `name#heading|alias`: the heading comes before the alias.
pub fn parse_wikilink(raw: &str, embed: bool) -> ParsedWikilink {
    let text = raw.trim();
    let (before_alias, alias) = match text.find('|') {
        Some(pipe) => (&text[..pipe], Some(text[pipe + 1..].trim())),
        None => (text, None),
    };
    let (target, heading) = match before_alias.find('#') {
        Some(hash) => {
            let heading = before_alias[hash + 1..].trim();
            (
                before_alias[..hash].trim(),
                (!heading.is_empty()).then(|| heading.to_owned()),
            )
        }
        None => (before_alias.trim(), None),
    };
    let label = match alias.filter(|alias| !alias.is_empty()) {
        Some(alias) => alias.to_owned(),
        None if target.is_empty() => heading.clone().unwrap_or_else(|| text.to_owned()),
        None => match &heading {
            Some(heading) => format!("{target} \u{a7} {heading}"),
            None => target.to_owned(),
        },
    };
    ParsedWikilink {
        target: target.to_owned(),
        label,
        heading,
        embed,
    }
}

/// A heading's anchor: lower-cased, punctuation dropped, spaces hyphenated.
/// Both the heading and a `#heading` link to it are slugged here.
pub fn heading_slug(text: &str) -> String {
    let kept: String = text
        .to_lowercase()
        .chars()
        .filter(|ch| !matches!(ch, '`' | '*' | '_' | '~'))
        .filter(|ch| ch.is_alphabetic() || ch.is_numeric() || ch.is_whitespace() || *ch == '-')
        .collect();
    kept.split_whitespace().collect::<Vec<_>>().join("-")
}

/// One `[[…]]` in a run of text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WikilinkMatch {
    /// Byte offset of the match, at its `!` for an embed.
    pub start: usize,
    /// Byte offset just past its `]]`.
    pub end: usize,
    pub embed: bool,
    /// Exactly what is between the brackets.
    pub inner: String,
}

/// Every `[[…]]` in `text` whose inside holds no bracket or newline, with
/// the `!` of an embed, left to right and never overlapping.
pub fn find_wikilinks(text: &str) -> Vec<WikilinkMatch> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut from = 0;
    let mut at = 0;
    while let Some(offset) = text[at..].find("[[") {
        let open = at + offset;
        let inner_start = open + 2;
        match closing(&bytes[inner_start..]) {
            Some(len) => {
                let embed = open > from && bytes[open - 1] == b'!';
                out.push(WikilinkMatch {
                    start: if embed { open - 1 } else { open },
                    end: inner_start + len + 2,
                    embed,
                    inner: text[inner_start..inner_start + len].to_owned(),
                });
                from = inner_start + len + 2;
                at = from;
            }
            None => at = open + 1,
        }
    }
    out
}

/// The length of a wikilink's inside, up to the `]]` that closes it, or
/// `None` when a bracket or newline comes first.
fn closing(rest: &[u8]) -> Option<usize> {
    for (i, byte) in rest.iter().enumerate() {
        match byte {
            b']' => return (rest.get(i + 1) == Some(&b']')).then_some(i),
            b'[' | b'\n' => return None,
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_links_and_embeds_and_skips_what_is_not_one() {
        let found = find_wikilinks("a [[one]] ![[two#h|x]] [[no\nlink]] [[[three]] [[open");
        let inner: Vec<(&str, bool)> = found.iter().map(|m| (m.inner.as_str(), m.embed)).collect();
        assert_eq!(inner, [("one", false), ("two#h|x", true), ("three", false)]);
        let text = "a [[one]]";
        assert_eq!(&text[found[0].start..found[0].end], "[[one]]");
    }

    #[test]
    fn a_link_to_a_heading_alone_is_labelled_by_the_heading() {
        let link = parse_wikilink("#Intro", false);
        assert_eq!(link.target, "");
        assert_eq!(link.heading.as_deref(), Some("Intro"));
        assert_eq!(link.label, "Intro");
        let index = WikiIndex::default();
        assert_eq!(
            index.resolve(&link, Some("/v/a.md")).as_deref(),
            Some("/v/a.md")
        );
    }

    #[test]
    fn of_two_notes_with_one_name_the_one_beside_the_link_wins() {
        let index = WikiIndex::build([
            IndexedFile {
                path: "/v/docs/index.md",
                rel_path: "docs/index.md",
                slug: "index",
            },
            IndexedFile {
                path: "/v/notes/index.md",
                rel_path: "notes/index.md",
                slug: "index",
            },
        ]);
        let link = parse_wikilink("index", false);
        assert_eq!(
            index.resolve(&link, Some("/v/notes/today.md")).as_deref(),
            Some("/v/notes/index.md")
        );
        assert_eq!(
            index.resolve(&link, None).as_deref(),
            Some("/v/docs/index.md")
        );
    }
}
