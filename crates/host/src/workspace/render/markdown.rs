//! Markdown, as a vault writes it, to sanitised HTML.
//!
//! The order is the design:
//!
//! 1. The frontmatter is taken off the source before parsing, so it can only
//!    ever be a chip row and never text.
//! 2. comrak parses GitHub-flavoured markdown, raw HTML included.
//! 3. ammonia sanitises the whole result: no script, event handler or
//!    address it does not allow survives. It is the only step that sees what
//!    the note wrote, and it sees all of it.
//! 4. The host's own transforms run on what survived: callouts, heading
//!    anchors, wikilinks, tags, table scrollers and code highlighting.
//!
//! The transforms come after the sanitiser so the schema stays GitHub's,
//! widened only by `checked` on a task box: nothing the host generates
//! depends on the sanitiser letting it through, and a note cannot borrow the
//! host's markup.

use std::collections::{BTreeSet, HashMap};
use std::time::Instant;

use floti_protocol::channels::workspace::{
    ContentCounts, ContentHeading, ContentWikilink, Millis, RenderedFrontmatter, RenderedMarkdown,
};

use super::frontmatter::parse_note_frontmatter;
use super::highlight::highlight_code;
use super::html::{self, Element, Node, text_of};
use super::wikilinks::{WikiIndex, find_wikilinks, heading_slug, parse_wikilink};

/// Subtrees whose text is not prose and is never rewritten.
const OPAQUE: &[&str] = &["code", "pre", "a", "script", "style", "kbd", "samp"];

/// The inline elements a wikilink's own text may be split across.
const INLINE: &[&str] = &[
    "a", "abbr", "b", "br", "code", "del", "em", "i", "img", "ins", "kbd", "mark", "q", "s",
    "samp", "small", "span", "strong", "sub", "sup", "u", "var",
];

/// `source` rendered: `index` resolves wikilinks (without one every link is
/// broken), and `path` is the file being rendered, so `[[#heading]]` and a
/// tie between two same-named notes resolve.
pub fn render_markdown(
    source: &str,
    index: Option<&WikiIndex>,
    path: Option<&str>,
) -> RenderedMarkdown {
    let started = Instant::now();
    let front = parse_note_frontmatter(source);
    let mut counts = ContentCounts {
        tables: 0,
        task_items: 0,
        task_items_checked: 0,
        code_blocks: 0,
        highlighted_blocks: 0,
        callouts: 0,
        wikilinks: 0,
        broken_wikilinks: 0,
        tags: 0,
        headings: 0,
    };
    let mut headings = Vec::new();
    let mut links = Vec::new();
    let mut tags = BTreeSet::new();
    let mut unknown = BTreeSet::new();

    let mut tree = html::parse(&sanitise(&parse_markdown(&front.body)));

    apply_callouts(&mut tree, &mut counts);
    apply_headings(&mut tree, &mut headings, &mut HashMap::new());
    let linker = Linker {
        index,
        path,
        links: &mut links,
    };
    linker.apply(&mut tree);
    apply_tags(&mut tree, &mut tags);
    count_structures(&tree, &mut counts);
    wrap_tables(&mut tree);
    apply_highlighting(&mut tree, &mut counts, &mut unknown);

    counts.wikilinks = len_u32(links.len());
    counts.broken_wikilinks = len_u32(links.iter().filter(|link| link.resolved.is_none()).count());
    counts.headings = len_u32(headings.len());
    counts.tags = len_u32(tags.len());

    RenderedMarkdown {
        html: html::serialize(&tree),
        frontmatter: RenderedFrontmatter {
            present: front.present,
            fields: front.fields,
            raw: front.raw,
            error: front.error,
            end_line: front.end_line,
        },
        headings,
        links,
        tags: tags.into_iter().collect(),
        words: count_words(&front.body),
        counts,
        unknown_languages: unknown.into_iter().collect(),
        took_ms: Millis(started.elapsed().as_secs_f64() * 1_000.0),
    }
}

fn len_u32(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// GitHub-flavoured markdown to HTML, raw HTML passed through for the
/// sanitiser to judge.
fn parse_markdown(body: &str) -> String {
    let mut options = comrak::Options::default();
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.autolink = true;
    options.extension.tasklist = true;
    options.extension.footnotes = true;
    options.render.r#unsafe = true;
    comrak::markdown_to_html(body, &options)
}

/// ammonia's defaults, which are GitHub's set in spirit, plus a task list's
/// checkbox (`type="checkbox"`, `disabled`, `checked`) and a code block's
/// `language-*` class. Links get no `rel`: the client opens them itself.
fn sanitise(html: &str) -> String {
    let mut builder = ammonia::Builder::default();
    builder
        .add_tags(["input"])
        .add_tag_attributes("input", ["type", "disabled", "checked"])
        .add_tag_attributes("code", ["class"])
        .link_rel(None)
        .attribute_filter(|element, attribute, value| match (element, attribute) {
            ("input", "type") => value
                .eq_ignore_ascii_case("checkbox")
                .then(|| "checkbox".into()),
            ("code", "class") => {
                let kept: Vec<&str> = value
                    .split_ascii_whitespace()
                    .filter(|class| {
                        class.len() > "language-".len() && class.starts_with("language-")
                    })
                    .collect();
                (!kept.is_empty()).then(|| kept.join(" ").into())
            }
            _ => Some(value.into()),
        });
    builder.clean(html).to_string()
}

fn element_children_mut(nodes: &mut [Node]) -> impl Iterator<Item = &mut Element> {
    nodes.iter_mut().filter_map(|node| match node {
        Node::Element(element) => Some(element),
        _ => None,
    })
}

// --- Callouts --------------------------------------------------------------

/// A callout's marker: `[!kind]`, its fold, and the rest of the text after
/// any whitespace.
fn callout_marker(text: &str) -> Option<(String, String, &str)> {
    let rest = text.strip_prefix("[!")?;
    let mut chars = rest.char_indices();
    let (_, first) = chars.next()?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    let end = rest
        .char_indices()
        .find(|(_, ch)| !(ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '-'))
        .map_or(rest.len(), |(at, _)| at);
    let kind = &rest[..end];
    let rest = rest[end..].strip_prefix(']')?;
    let (fold, rest) = match rest.chars().next() {
        Some(sign @ ('+' | '-')) => (sign.to_string(), &rest[1..]),
        _ => (String::new(), rest),
    };
    Some((kind.to_lowercase(), fold, rest.trim_start()))
}

/// Obsidian's callout, a blockquote whose first line is `> [!note] Title`,
/// as an admonition rather than a quotation.
fn apply_callouts(nodes: &mut [Node], counts: &mut ContentCounts) {
    for element in element_children_mut(nodes) {
        if element.tag == "blockquote" {
            make_callout(element, counts);
        }
        apply_callouts(&mut element.children, counts);
    }
}

fn make_callout(quote: &mut Element, counts: &mut ContentCounts) {
    let Some(first_index) = quote
        .children
        .iter()
        .position(|child| child.as_element().is_some_and(|el| el.tag == "p"))
    else {
        return;
    };
    let Node::Element(first) = &mut quote.children[first_index] else {
        return;
    };
    let Some(Node::Text(lead)) = first.children.first() else {
        return;
    };
    let Some((kind, fold, rest)) = callout_marker(lead) else {
        return;
    };
    let mut parts = rest.split('\n');
    let title = parts.next().unwrap_or_default().trim().to_owned();
    let body = parts.collect::<Vec<_>>().join("\n");
    let body = body.trim_start_matches('\n').to_owned();
    if body.is_empty() {
        first.children.remove(0);
    } else {
        first.children[0] = Node::Text(body);
    }
    if first.children.is_empty() {
        quote.children.remove(first_index);
    }

    let mut attrs = vec![
        ("class", format!("callout callout-{kind}")),
        ("data-callout", kind.clone()),
    ];
    if !fold.is_empty() {
        attrs.push(("data-callout-fold", fold));
    }
    let heading = Element::new(
        "p",
        vec![
            ("class", "callout-title".to_owned()),
            ("data-callout-title", kind.clone()),
        ],
        vec![Node::Element(Element::new(
            "span",
            vec![("class", "callout-kind".to_owned())],
            vec![Node::text(if title.is_empty() {
                kind.clone()
            } else {
                title
            })],
        ))],
    );
    let mut children = vec![Node::Element(heading)];
    children.append(&mut quote.children);
    *quote = Element::new("div", attrs, children);
    counts.callouts += 1;
}

// --- Headings --------------------------------------------------------------

/// An anchor on every heading, unique within the note, so `[[note#heading]]`
/// and `[text](#heading)` have somewhere to land.
fn apply_headings(
    nodes: &mut [Node],
    headings: &mut Vec<ContentHeading>,
    used: &mut HashMap<String, u32>,
) {
    for element in element_children_mut(nodes) {
        let depth = match element.tag.as_bytes() {
            [b'h', level @ b'1'..=b'6'] => Some(u32::from(level - b'0')),
            _ => None,
        };
        if let Some(depth) = depth {
            let label = element.text().trim().to_owned();
            let base = Some(heading_slug(&label))
                .filter(|slug| !slug.is_empty())
                .unwrap_or_else(|| "section".to_owned());
            let seen = used.entry(base.clone()).or_insert(0);
            let slug = if *seen == 0 {
                base
            } else {
                format!("{base}-{seen}")
            };
            *seen += 1;
            element.set_attr("data-heading", slug.clone());
            headings.push(ContentHeading {
                depth,
                text: label,
                slug,
            });
        }
        apply_headings(&mut element.children, headings, used);
    }
}

// --- Wikilinks -------------------------------------------------------------

struct Linker<'a, 'b> {
    index: Option<&'a WikiIndex>,
    path: Option<&'a str>,
    links: &'b mut Vec<ContentWikilink>,
}

/// A `[[` that ran off the end of its text node, completed across its
/// siblings: the link's raw inside, the sibling holding its `]]`, and what
/// followed the `]]` there. Gives up wherever the shape is ambiguous.
fn span_wikilink(children: &[Node], from: usize, head: &str) -> Option<(String, usize, String)> {
    if head.contains('\n') {
        return None;
    }
    let mut raw = head.to_owned();
    for (i, sibling) in children.iter().enumerate().skip(from + 1) {
        match sibling {
            Node::Text(value) => {
                if let Some(close) = value.find("]]") {
                    let inner = format!("{raw}{}", &value[..close]);
                    if inner.contains('\n') {
                        return None;
                    }
                    return Some((inner, i, value[close + 2..].to_owned()));
                }
                // A second `[[` before this one closed means the first was
                // never a link.
                if value.contains("[[") || value.contains('\n') {
                    return None;
                }
                raw.push_str(value);
            }
            Node::Element(element) if INLINE.contains(&element.tag.as_str()) => {
                let flat = text_of(sibling);
                if flat.contains("]]") || flat.contains("[[") {
                    return None;
                }
                raw.push_str(&flat);
            }
            _ => return None,
        }
    }
    None
}

impl Linker<'_, '_> {
    fn apply(mut self, nodes: &mut Vec<Node>) {
        self.walk(nodes);
    }

    /// A link that resolves carries the path it resolved to; one that does
    /// not is marked broken. Nothing is dropped.
    fn anchor(&mut self, raw: &str, embed: bool) -> Node {
        let link = parse_wikilink(raw, embed);
        let resolved = self.index.and_then(|index| index.resolve(&link, self.path));
        self.links.push(ContentWikilink {
            target: link.target.clone(),
            label: link.label.clone(),
            heading: link.heading.clone(),
            resolved: resolved.clone(),
        });
        let mut attrs = vec![
            (
                "class",
                if resolved.is_none() {
                    "wikilink wikilink-broken"
                } else {
                    "wikilink"
                }
                .to_owned(),
            ),
            ("href", "#".to_owned()),
            ("data-wikilink", link.target.clone()),
        ];
        match &resolved {
            None => attrs.push(("data-wikilink-broken", "true".to_owned())),
            Some(path) => attrs.push(("data-wikilink-path", path.clone())),
        }
        if let Some(heading) = &link.heading {
            attrs.push(("data-wikilink-heading", heading_slug(heading)));
        }
        attrs.push((
            "title",
            match &resolved {
                None => format!(
                    "No note called \u{201c}{}\u{201d} in this scope yet",
                    link.target
                ),
                Some(path) => path.clone(),
            },
        ));
        Node::Element(Element::new("a", attrs, vec![Node::text(link.label)]))
    }

    /// Walks children rather than single text nodes, because a link may span
    /// several of them. Each child is moved out as it is reached; a spanned
    /// link reads only the siblings after it, which are still in place, and
    /// the ones it consumes are dropped.
    fn walk(&mut self, children: &mut Vec<Node>) {
        let mut taken = std::mem::take(children);
        let out = children;
        let mut i = 0;
        while i < taken.len() {
            let value = match std::mem::replace(&mut taken[i], Node::Raw(String::new())) {
                Node::Element(mut element) => {
                    if !OPAQUE.contains(&element.tag.as_str()) {
                        self.walk(&mut element.children);
                    }
                    out.push(Node::Element(element));
                    i += 1;
                    continue;
                }
                Node::Text(value) if value.contains("[[") => value,
                other => {
                    out.push(other);
                    i += 1;
                    continue;
                }
            };
            let mut cursor = i;
            let mut value = value;
            loop {
                let mut at = 0;
                for found in find_wikilinks(&value) {
                    if found.start > at {
                        out.push(Node::text(&value[at..found.start]));
                    }
                    at = found.end;
                    out.push(self.anchor(&found.inner, found.embed));
                }
                // Then whatever is left, which may be a `[[` still looking
                // for its `]]` in the siblings after it.
                let rest = &value[at..];
                let spanned = rest.rfind("[[").and_then(|open| {
                    span_wikilink(&taken, cursor, &rest[open + 2..]).map(|s| (open, s))
                });
                let Some((open, (raw, through, tail))) = spanned else {
                    if !rest.is_empty() {
                        out.push(Node::text(rest));
                    }
                    break;
                };
                let embed = rest[..open].ends_with('!');
                let before = &rest[..if embed { open - 1 } else { open }];
                if !before.is_empty() {
                    out.push(Node::text(before));
                }
                out.push(self.anchor(&raw, embed));
                cursor = through;
                value = tail;
            }
            i = cursor + 1;
        }
    }
}

// --- Tags ------------------------------------------------------------------

/// Every `#tag` in `value` as (start of the `#`, end, name): after the start
/// or whitespace or `(`, starting with a letter, so `C#`, `#1` and a URL's
/// `#frag` are not tags.
fn find_tags(value: &str) -> Vec<(usize, usize, String)> {
    let mut out = Vec::new();
    let mut previous: Option<char> = None;
    let mut chars = value.char_indices().peekable();
    while let Some((at, ch)) = chars.next() {
        let boundary = previous.is_none_or(|p| p.is_whitespace() || p == '(');
        if ch == '#' && boundary && chars.peek().is_some_and(|(_, next)| next.is_alphabetic()) {
            let mut end = at + 1;
            let mut last = ch;
            while let Some(&(next_at, next)) = chars.peek() {
                if next.is_alphanumeric() || matches!(next, '_' | '/' | '-') {
                    end = next_at + next.len_utf8();
                    last = next;
                    chars.next();
                } else {
                    break;
                }
            }
            out.push((at, end, value[at + 1..end].to_owned()));
            previous = Some(last);
            continue;
        }
        previous = Some(ch);
    }
    out
}

/// `#tag`, shown as a chip inline.
fn apply_tags(nodes: &mut Vec<Node>, tags: &mut BTreeSet<String>) {
    for node in std::mem::take(nodes) {
        match node {
            Node::Text(value) if value.contains('#') => {
                let mut at = 0;
                for (start, end, name) in find_tags(&value) {
                    if start > at {
                        nodes.push(Node::text(&value[at..start]));
                    }
                    at = end;
                    nodes.push(Node::Element(Element::new(
                        "span",
                        vec![("class", "md-tag".to_owned()), ("data-tag", name.clone())],
                        vec![Node::text(format!("#{name}"))],
                    )));
                    tags.insert(name);
                }
                if at < value.len() {
                    nodes.push(Node::text(&value[at..]));
                }
            }
            Node::Element(mut element) => {
                if !OPAQUE.contains(&element.tag.as_str()) {
                    apply_tags(&mut element.children, tags);
                }
                nodes.push(Node::Element(element));
            }
            other => nodes.push(other),
        }
    }
}

// --- Structure -------------------------------------------------------------

fn count_structures(nodes: &[Node], counts: &mut ContentCounts) {
    for node in nodes {
        let Node::Element(element) = node else {
            continue;
        };
        if element.tag == "table" {
            counts.tables += 1;
        }
        if element.tag == "input" && element.attr("type") == Some("checkbox") {
            counts.task_items += 1;
            if element.attr("checked").is_some() {
                counts.task_items_checked += 1;
            }
        }
        count_structures(&element.children, counts);
    }
}

/// Every table in its own horizontal scroller, so a wide one scrolls rather
/// than moving the prose out from under the reader.
fn wrap_tables(nodes: &mut [Node]) {
    for node in nodes.iter_mut() {
        let Node::Element(element) = node else {
            continue;
        };
        wrap_tables(&mut element.children);
        if element.tag == "table" {
            let scroller =
                Element::new("div", vec![("class", "md-table-scroll".to_owned())], vec![]);
            let table = std::mem::replace(element, scroller);
            element.children.push(Node::Element(table));
        }
    }
}

// --- Code ------------------------------------------------------------------

/// Every `<pre><code>` replaced by its highlighted block, labelled with its
/// language; a fence whose language has no grammar is named in `unknown`.
fn apply_highlighting(
    nodes: &mut [Node],
    counts: &mut ContentCounts,
    unknown: &mut BTreeSet<String>,
) {
    for node in nodes.iter_mut() {
        let Node::Element(element) = node else {
            continue;
        };
        if element.tag != "pre" {
            apply_highlighting(&mut element.children, counts, unknown);
            continue;
        }
        let Some(code) = element
            .children
            .iter()
            .find_map(|child| child.as_element().filter(|el| el.tag == "code"))
        else {
            continue;
        };
        let language = code
            .attr("class")
            .and_then(|classes| {
                classes
                    .split_ascii_whitespace()
                    .find_map(|class| class.strip_prefix("language-"))
            })
            .unwrap_or_default()
            .to_owned();
        let text = code.text();
        let text = text.strip_suffix('\n').unwrap_or(&text);
        counts.code_blocks += 1;
        let result = highlight_code(text, &language);
        if !language.is_empty() && !result.highlighted {
            unknown.insert(language);
        }
        if result.html.is_empty() {
            continue;
        }
        if result.highlighted {
            counts.highlighted_blocks += 1;
        }
        let label = if result.highlighted {
            result.language.as_str()
        } else {
            "text"
        };
        let labelled = match result.html.strip_prefix("<pre ") {
            Some(rest) => format!("<pre data-language=\"{label}\" {rest}"),
            None => result.html.clone(),
        };
        *node = Node::Raw(labelled);
    }
}

/// Words in the body: runs that start with a letter or digit.
fn count_words(body: &str) -> u32 {
    let mut words = 0u32;
    let mut inside = false;
    for ch in body.chars() {
        if inside {
            inside = ch.is_alphanumeric() || matches!(ch, '\'' | '\u{2019}' | '_' | '-');
        } else if ch.is_alphanumeric() {
            inside = true;
            words = words.saturating_add(1);
        }
    }
    words
}
