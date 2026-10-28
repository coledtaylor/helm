//! A small HTML tree: the sanitiser's output is parsed into it so the
//! renderer's own transforms run on what survived sanitising, and it is
//! written back out as the HTML a client injects.
//!
//! A [`Node::Raw`] is markup the host generated itself (a highlighted code
//! block) and is written as it is; everything else is escaped on the way
//! out.

use std::cell::{Cell, RefCell};

use html5ever::tendril::StrTendril;
use html5ever::tokenizer::{
    BufferQueue, TagKind, Token, TokenSink, TokenSinkResult, Tokenizer, TokenizerOpts,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Node {
    Element(Element),
    Text(String),
    /// Generated markup, written verbatim.
    Raw(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Element {
    pub tag: String,
    pub attrs: Vec<(String, String)>,
    pub children: Vec<Node>,
}

impl Element {
    pub fn new(tag: &str, attrs: Vec<(&str, String)>, children: Vec<Node>) -> Self {
        Self {
            tag: tag.to_owned(),
            attrs: attrs
                .into_iter()
                .map(|(name, value)| (name.to_owned(), value))
                .collect(),
            children,
        }
    }

    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    /// Sets `name`, replacing a value it already has.
    pub fn set_attr(&mut self, name: &str, value: String) {
        match self.attrs.iter_mut().find(|(key, _)| key == name) {
            Some((_, existing)) => *existing = value,
            None => self.attrs.push((name.to_owned(), value)),
        }
    }

    /// The text inside, every descendant's joined.
    pub fn text(&self) -> String {
        let mut out = String::new();
        for child in &self.children {
            push_text(child, &mut out);
        }
        out
    }
}

impl Node {
    pub fn text(value: impl Into<String>) -> Self {
        Self::Text(value.into())
    }

    pub fn as_element(&self) -> Option<&Element> {
        match self {
            Self::Element(element) => Some(element),
            _ => None,
        }
    }
}

/// The text inside `node`, every descendant's joined.
pub(crate) fn text_of(node: &Node) -> String {
    let mut out = String::new();
    push_text(node, &mut out);
    out
}

fn push_text(node: &Node, out: &mut String) {
    match node {
        Node::Text(value) => out.push_str(value),
        Node::Element(element) => {
            for child in &element.children {
                push_text(child, out);
            }
        }
        Node::Raw(_) => {}
    }
}

/// The sanitiser's output as nodes. It is a serialised tree, so its tags
/// nest; it is read with html5ever's tokenizer, which decodes entities and
/// attributes the way a browser does, and the tree is rebuilt from the
/// tags. An end tag with no open element of its name is ignored, and
/// anything still open at the end is closed. Comments and doctypes are
/// dropped.
pub(crate) fn parse(html: &str) -> Vec<Node> {
    let queue = BufferQueue::default();
    queue.push_back(StrTendril::from(html));
    let tokenizer = Tokenizer::new(TreeSink::default(), TokenizerOpts::default());
    let _ = tokenizer.feed(&queue);
    tokenizer.end();
    tokenizer.sink.finish()
}

/// Builds the tree from the tokens: `open` holds the elements not closed
/// yet, the fragment's root first.
struct TreeSink {
    open: RefCell<Vec<Element>>,
    /// The last token opened a `<pre>`, whose first newline a parser drops.
    after_pre: Cell<bool>,
}

impl Default for TreeSink {
    fn default() -> Self {
        Self {
            open: RefCell::new(vec![Element::new("#root", vec![], vec![])]),
            after_pre: Cell::new(false),
        }
    }
}

impl TreeSink {
    fn push(open: &mut [Element], node: Node) {
        let top = open.last_mut().expect("the root is never closed");
        match (top.children.last_mut(), node) {
            (Some(Node::Text(previous)), Node::Text(more)) => previous.push_str(&more),
            (_, node) => top.children.push(node),
        }
    }

    fn close(open: &mut Vec<Element>) {
        if open.len() > 1 {
            let element = open.pop().expect("more than the root is open");
            Self::push(open, Node::Element(element));
        }
    }

    fn finish(self) -> Vec<Node> {
        let mut open = self.open.into_inner();
        while open.len() > 1 {
            Self::close(&mut open);
        }
        open.pop().map(|root| root.children).unwrap_or_default()
    }
}

impl TokenSink for TreeSink {
    type Handle = ();

    fn process_token(&self, token: Token, _line_number: u64) -> TokenSinkResult<()> {
        let after_pre = self.after_pre.replace(false);
        let mut open = self.open.borrow_mut();
        match token {
            Token::TagToken(tag) => {
                let name = tag.name.to_string();
                match tag.kind {
                    TagKind::StartTag => {
                        let element = Element {
                            tag: name.clone(),
                            attrs: tag
                                .attrs
                                .iter()
                                .map(|attr| (attr.name.local.to_string(), attr.value.to_string()))
                                .collect(),
                            children: Vec::new(),
                        };
                        if VOID.contains(&name.as_str()) || tag.self_closing {
                            Self::push(&mut open, Node::Element(element));
                        } else {
                            open.push(element);
                            self.after_pre
                                .set(matches!(name.as_str(), "pre" | "textarea" | "listing"));
                        }
                    }
                    TagKind::EndTag => {
                        if let Some(depth) = open.iter().skip(1).rposition(|el| el.tag == name) {
                            while open.len() > depth + 1 {
                                Self::close(&mut open);
                            }
                        }
                    }
                }
            }
            Token::CharacterTokens(text) => {
                let text: &str = &text;
                let text = if after_pre {
                    text.strip_prefix('\n').unwrap_or(text)
                } else {
                    text
                };
                if !text.is_empty() {
                    Self::push(&mut open, Node::text(text));
                }
            }
            _ => {}
        }
        TokenSinkResult::Continue
    }
}

/// Elements that have no closing tag and hold nothing.
const VOID: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track",
    "wbr",
];

/// The nodes as HTML.
pub(crate) fn serialize(nodes: &[Node]) -> String {
    let mut out = String::new();
    for node in nodes {
        write_node(node, &mut out);
    }
    out
}

fn write_node(node: &Node, out: &mut String) {
    match node {
        Node::Text(value) => escape_text(value, out),
        Node::Raw(markup) => out.push_str(markup),
        Node::Element(element) => {
            out.push('<');
            out.push_str(&element.tag);
            for (name, value) in &element.attrs {
                out.push(' ');
                out.push_str(name);
                out.push_str("=\"");
                escape_attr(value, out);
                out.push('"');
            }
            out.push('>');
            if VOID.contains(&element.tag.as_str()) {
                return;
            }
            // A parser drops one newline straight after `<pre>`, so one that
            // belongs to the text is written twice.
            if matches!(element.tag.as_str(), "pre" | "textarea" | "listing")
                && matches!(element.children.first(), Some(Node::Text(text)) if text.starts_with('\n'))
            {
                out.push('\n');
            }
            for child in &element.children {
                write_node(child, out);
            }
            out.push_str("</");
            out.push_str(&element.tag);
            out.push('>');
        }
    }
}

fn escape_text(value: &str, out: &mut String) {
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\u{a0}' => out.push_str("&nbsp;"),
            other => out.push(other),
        }
    }
}

fn escape_attr(value: &str, out: &mut String) {
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '\u{a0}' => out.push_str("&nbsp;"),
            other => out.push(other),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fragment_round_trips_with_its_text_escaped() {
        let html = "<p class=\"a\">one &amp; <em>two</em> &lt;3</p><pre><code>\nx</code></pre><input type=\"checkbox\" checked=\"\">";
        let nodes = parse(html);
        assert_eq!(serialize(&nodes), html);
        assert_eq!(text_of(&nodes[0]), "one & two <3");
    }

    #[test]
    fn an_attribute_value_keeps_its_quotes_escaped() {
        let element = Element::new("a", vec![("title", "say \"hi\" & go".to_owned())], vec![]);
        assert_eq!(
            serialize(&[Node::Element(element)]),
            "<a title=\"say &quot;hi&quot; &amp; go\"></a>"
        );
    }
}
