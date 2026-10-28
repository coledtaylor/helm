//! Markdown and source rendered to sanitised, highlighted HTML, the way
//! today's app renders them in `packages/core/src/content`.
//!
//! - [`markdown`]: a note to HTML. comrak parses GitHub-flavoured markdown,
//!   ammonia sanitises everything the note wrote, and only then are the
//!   frontmatter chips, heading anchors, wikilinks, tags, callouts and code
//!   highlighting applied, so nothing the host generates depends on the
//!   sanitiser letting it through.
//! - [`highlight`]: syntect, with each token carrying `--shiki-light` and
//!   `--shiki-dark` as today's shiki output does, so a client's stylesheet
//!   picks a side without re-highlighting.
//! - [`frontmatter`]: the YAML block at the top of a note.
//! - [`wikilinks`]: `[[wikilink]]` parsing and resolution.
//!
//! [`render_config`] is `config:render` and [`highlight::editor_highlight`]
//! is `editor:highlight`: the config console and the editors share this one
//! renderer.

pub mod frontmatter;
pub mod highlight;
mod html;
pub mod markdown;
pub mod wikilinks;

use floti_protocol::channels::workspace::{ConfigRendered, RenderedCode};

pub use highlight::{HIGHLIGHT_MAX_BYTES, editor_highlight};
pub use markdown::render_markdown;

/// A config file rendered as what it is: markdown for `.md` and
/// `.markdown`, highlighted source for anything else.
///
/// No wikilink index is passed: a config folder is not a vault, so `[[a]]`
/// in a `SKILL.md` renders unresolved.
pub fn render_config(path: &str, source: &str) -> ConfigRendered {
    let extension = config_extension(path);
    if extension == "md" || extension == "markdown" {
        return ConfigRendered {
            markdown: Some(render_markdown(source, None, Some(path))),
            code: None,
        };
    }
    let code = highlight::highlight_code(source, &extension);
    ConfigRendered {
        markdown: None,
        code: Some(RenderedCode {
            html: code.html,
            language: code.language,
            highlighted: code.highlighted,
        }),
    }
}

/// The extension of the file's own name, lower-cased and without its dot;
/// empty for none.
fn config_extension(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    match name.rfind('.') {
        Some(dot) if dot + 1 < name.len() => name[dot + 1..].to_lowercase(),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_config_note_renders_as_markdown_and_a_hook_as_highlighted_source() {
        let note = render_config("C:/p/.claude/skills/x/SKILL.md", "# Skill\n\nSee [[a]].\n");
        let markdown = note.markdown.expect("markdown");
        assert!(note.code.is_none());
        assert!(markdown.html.contains("<h1"), "{}", markdown.html);
        assert_eq!(markdown.counts.broken_wikilinks, 1);

        let hook = render_config("/p/.claude/hooks/check.py", "print('ok')\n");
        assert!(hook.markdown.is_none());
        let code = hook.code.expect("code");
        assert!(code.highlighted);
        assert_eq!(code.language, "python");
        assert!(code.html.contains("--shiki-dark"), "{}", code.html);
    }

    #[test]
    fn a_config_file_with_no_grammar_is_plain_source_not_nothing() {
        let rendered = render_config("/p/.claude/settings.unknownext", "a = 1\n");
        let code = rendered.code.expect("code");
        assert!(!code.highlighted);
        assert_eq!(code.language, "plaintext");
        assert!(code.html.contains("a = 1"), "{}", code.html);
    }
}
