//! Syntax highlighting, with syntect on its pure-Rust regex engine: two-face's
//! grammars (bat's set, which holds syntect's own and adds TypeScript, TSX,
//! TOML, Dockerfile, INI, Kotlin, Swift, Vue, Svelte and more), syntect's
//! bundled themes, and grammars of Floti's own under `grammars/` for what
//! two-face carries only for Oniguruma (PowerShell).
//!
//! The languages are today's: [`ALIASES`] and [`PLAIN`] are the tables
//! `packages/core/src/content/highlight.ts` resolves a name with, and
//! `tests/highlighting.rs` reads that file and the app's language names and
//! checks each one highlights over a client connection. A language with its
//! own grammar in the set is highlighted with it; [`STAND_INS`] holds only the
//! few that have none, with the nearest grammar that runs.
//!
//! Every token carries both themes' colours as `--shiki-light` and
//! `--shiki-dark`, the custom properties today's shiki output writes, so a
//! client's one stylesheet rule picks a side and a theme toggle re-colours
//! without a re-highlight. A source is tokenised once and each token is
//! styled by both themes, so the two never split a line differently.
//!
//! A language with no grammar is not an error: the block is plain text,
//! `highlighted` is false, and the markdown renderer names the language.
//! The colours are syntect's themes, not shiki's; the structure is today's.

use std::sync::OnceLock;
use std::time::Instant;

use floti_protocol::channels::workspace::{EditorHighlight, Millis};
use syntect::highlighting::{Color, FontStyle, Highlighter, Style, Theme, ThemeSet};
use syntect::parsing::{
    ParseState, ScopeStack, SyntaxDefinition, SyntaxReference, SyntaxSet, SyntaxSetBuilder,
};

/// The ceiling on highlighting an editor's whole source. Past it the source
/// is marked too large and shows as plain text, rather than holding a
/// backtracking grammar over a generated bundle.
pub const HIGHLIGHT_MAX_BYTES: usize = 512 * 1024;

/// The themes, by syntect's names.
const LIGHT_THEME: &str = "InspiredGitHub";
const DARK_THEME: &str = "base16-ocean.dark";

/// How the themes are named in a block's class list.
const THEME_CLASSES: &str = "shiki shiki-themes inspired-github base16-ocean-dark";

/// A tab counts for this many columns of a line's indentation.
const TAB_COLUMNS: usize = 2;

/// What people type in a fence, as the language it means: highlight.ts's
/// `ALIASES`, entry for entry.
pub const ALIASES: &[(&str, &str)] = &[
    ("sh", "shellscript"),
    ("bash", "shellscript"),
    ("shell", "shellscript"),
    ("zsh", "shellscript"),
    ("console", "shellscript"),
    ("ps", "powershell"),
    ("ps1", "powershell"),
    ("pwsh", "powershell"),
    ("cmd", "bat"),
    ("batch", "bat"),
    ("js", "javascript"),
    ("mjs", "javascript"),
    ("cjs", "javascript"),
    ("ts", "typescript"),
    ("mts", "typescript"),
    ("cts", "typescript"),
    ("py", "python"),
    ("rb", "ruby"),
    ("rs", "rust"),
    ("yml", "yaml"),
    ("md", "markdown"),
    ("golang", "go"),
    ("c++", "cpp"),
    ("c#", "csharp"),
    ("cs", "csharp"),
    ("htm", "html"),
    ("dockerfile", "docker"),
    ("text", "plaintext"),
    ("txt", "plaintext"),
    ("plain", "plaintext"),
    ("", "plaintext"),
];

/// Languages whose own grammar the set files under another token: shiki's
/// name for it, and the token it is found by.
const TOKENS: &[(&str, &str)] = &[
    ("shellscript", "sh"),
    ("csharp", "cs"),
    ("docker", "dockerfile"),
];

/// Languages with no grammar of their own in the set, highlighted with the
/// nearest one that runs on the pure-Rust engine, by the token it is found
/// by. JSX is TypeScriptReact's: bat's JSX grammar (JavaScript (Babel)) is
/// Oniguruma-only, and TSX parses every JSX file.
const STAND_INS: &[(&str, &str)] = &[
    ("jsx", "tsx"),
    ("jsonc", "json"),
    ("json5", "json"),
    ("mdx", "md"),
    ("astro", "html"),
];

/// Names that are plain text, not a language without a grammar:
/// highlight.ts's initial `loaded` set.
pub const PLAIN: &[&str] = &["plaintext", "text", "txt", "ansi"];

/// Floti's own grammars, as sublime-syntax sources, for languages two-face
/// carries only for Oniguruma.
const OWN_GRAMMARS: &[&str] = &[include_str!("grammars/PowerShell.sublime-syntax")];

struct Grammars {
    /// two-face's set.
    syntaxes: SyntaxSet,
    /// Floti's own, looked in first.
    own: SyntaxSet,
    light: Theme,
    dark: Theme,
}

fn grammars() -> &'static Grammars {
    static GRAMMARS: OnceLock<Grammars> = OnceLock::new();
    GRAMMARS.get_or_init(|| {
        let mut themes = ThemeSet::load_defaults().themes;
        Grammars {
            syntaxes: two_face::syntax::extra_newlines(),
            own: own_grammars(),
            light: themes.remove(LIGHT_THEME).unwrap_or_default(),
            dark: themes.remove(DARK_THEME).unwrap_or_default(),
        }
    })
}

/// The set of Floti's own grammars. One that does not load is left out, so
/// its language is plain text; a unit test loads each one.
fn own_grammars() -> SyntaxSet {
    let mut builder = SyntaxSetBuilder::new();
    for source in OWN_GRAMMARS {
        if let Ok(definition) = SyntaxDefinition::load_from_str(source, true, None) {
            builder.add(definition);
        }
    }
    builder.build()
}

/// A grammar and the set it belongs to, which parsing it needs.
#[derive(Clone, Copy)]
struct Grammar {
    syntax: &'static SyntaxReference,
    set: &'static SyntaxSet,
}

/// The grammar a set files under `token`, Floti's own first.
fn find_grammar(token: &str) -> Option<Grammar> {
    let grammars = grammars();
    [&grammars.own, &grammars.syntaxes]
        .into_iter()
        .find_map(|set| {
            set.find_syntax_by_token(token)
                .map(|syntax| Grammar { syntax, set })
        })
        .filter(|grammar| grammar.syntax.name != "Plain Text")
}

/// `raw` as the language name it means, lower-cased.
pub fn normalise_language(raw: &str) -> String {
    let lower = raw.trim().to_lowercase();
    ALIASES
        .iter()
        .find(|(alias, _)| *alias == lower)
        .map_or(lower, |(_, name)| (*name).to_owned())
}

/// A name safe to look a grammar up by.
fn safe_language(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
        && chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || "+._-".contains(ch))
}

/// The language `raw` names and its grammar, or `plaintext` and none.
fn grammar_for(raw: &str) -> (String, Option<Grammar>) {
    let name = normalise_language(raw);
    if PLAIN.contains(&name.as_str()) || !safe_language(&name) {
        return ("plaintext".to_owned(), None);
    }
    let token = TOKENS
        .iter()
        .chain(STAND_INS)
        .find(|(language, _)| *language == name)
        .map_or(name.as_str(), |(_, token)| token);
    match find_grammar(token) {
        Some(grammar) => (name, Some(grammar)),
        None => ("plaintext".to_owned(), None),
    }
}

/// One code block as HTML, in both themes at once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HighlightedCode {
    pub html: String,
    pub language: String,
    pub highlighted: bool,
}

/// Each line's inner HTML, for an editor's underlay.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HighlightedLines {
    pub lines: Vec<String>,
    pub language: String,
    pub highlighted: bool,
}

/// One run of text and both themes' styles for it.
struct Token<'a> {
    text: &'a str,
    light: Style,
    dark: Style,
}

/// `code`'s lines, split on `\n` with a trailing `\r` dropped: a trailing
/// newline is a final empty line, as it is in a textarea.
fn source_lines(code: &str) -> Vec<&str> {
    code.split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect()
}

/// Every line's tokens, or `None` when the grammar fails on the source.
fn tokenise<'a>(lines: &[&'a str], grammar: Grammar) -> Option<Vec<Vec<Token<'a>>>> {
    let grammars = grammars();
    let light = Highlighter::new(&grammars.light);
    let dark = Highlighter::new(&grammars.dark);
    let mut state = ParseState::new(grammar.syntax);
    let mut stack = ScopeStack::new();
    let mut out = Vec::with_capacity(lines.len());
    for line in lines {
        let fed = format!("{line}\n");
        let ops = state.parse_line(&fed, grammar.set).ok()?;
        // Runs of the line as (start, end, light, dark), next to each other.
        let mut runs: Vec<(usize, usize, Style, Style)> = Vec::new();
        let mut last = 0;
        let mut push = |stack: &ScopeStack, from: usize, to: usize| {
            // The newline fed to the grammar is not the line's.
            let to = to.min(line.len());
            if from >= to {
                return;
            }
            let scopes = stack.as_slice();
            let (light, dark) = (light.style_for_stack(scopes), dark.style_for_stack(scopes));
            match runs.last_mut() {
                Some(previous)
                    if previous.1 == from
                        && same_look(previous.2, light)
                        && same_look(previous.3, dark) =>
                {
                    previous.1 = to;
                }
                _ => runs.push((from, to, light, dark)),
            }
        };
        for (at, op) in ops {
            push(&stack, last, at);
            stack.apply(&op).ok()?;
            last = at.max(last);
        }
        push(&stack, last, fed.len());
        out.push(
            runs.into_iter()
                .map(|(from, to, light, dark)| Token {
                    text: &line[from..to],
                    light,
                    dark,
                })
                .collect(),
        );
    }
    Some(out)
}

fn same_look(a: Style, b: Style) -> bool {
    a.foreground == b.foreground && a.font_style == b.font_style
}

fn hex(color: Color) -> String {
    if color.a == 0xff {
        format!("#{:02X}{:02X}{:02X}", color.r, color.g, color.b)
    } else {
        format!(
            "#{:02X}{:02X}{:02X}{:02X}",
            color.r, color.g, color.b, color.a
        )
    }
}

/// The `style` attribute for a token, which holds only theme colours.
fn token_style(light: Style, dark: Style) -> String {
    let mut parts = vec![
        format!("--shiki-light:{}", hex(light.foreground)),
        format!("--shiki-dark:{}", hex(dark.foreground)),
    ];
    for (side, style) in [("light", light), ("dark", dark)] {
        if style.font_style.contains(FontStyle::ITALIC) {
            parts.push(format!("--shiki-{side}-font-style:italic"));
        }
        if style.font_style.contains(FontStyle::BOLD) {
            parts.push(format!("--shiki-{side}-font-weight:bold"));
        }
        if style.font_style.contains(FontStyle::UNDERLINE) {
            parts.push(format!("--shiki-{side}-text-decoration:underline"));
        }
    }
    format!(" style=\"{}\"", parts.join(";"))
}

/// Text going into an HTML text node.
fn escape_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            other => out.push(other),
        }
    }
    out
}

fn tokens_html(tokens: &[Token<'_>]) -> String {
    tokens
        .iter()
        .map(|token| {
            format!(
                "<span{}>{}</span>",
                token_style(token.light, token.dark),
                escape_text(token.text)
            )
        })
        .collect()
}

/// A line with no grammar: one token in each theme's own text colour.
fn plain_line(line: &str) -> String {
    if line.is_empty() {
        return String::new();
    }
    let grammars = grammars();
    let light = Highlighter::new(&grammars.light).get_default();
    let dark = Highlighter::new(&grammars.dark).get_default();
    tokens_html(&[Token {
        text: line,
        light,
        dark,
    }])
}

/// A line's leading indentation in columns.
fn indent_columns(line: &str) -> usize {
    line.chars()
        .map_while(|ch| match ch {
            ' ' => Some(1),
            '\t' => Some(TAB_COLUMNS),
            _ => None,
        })
        .sum()
}

/// One block as a `<pre>` in both themes, each line a `<span class="line">`
/// carrying its indentation as `--line-indent`.
pub fn highlight_code(code: &str, language: &str) -> HighlightedCode {
    let (name, syntax) = grammar_for(language);
    let lines = source_lines(code);
    let rendered: Option<Vec<String>> = syntax.and_then(|syntax| {
        tokenise(&lines, syntax).map(|tokens| tokens.iter().map(|line| tokens_html(line)).collect())
    });
    let highlighted = rendered.is_some();
    let inner = rendered.unwrap_or_else(|| lines.iter().map(|line| plain_line(line)).collect());

    let (light, dark) = (&grammars().light.settings, &grammars().dark.settings);
    let mut html = format!(
        "<pre class=\"{THEME_CLASSES}\" style=\"--shiki-light:{};--shiki-dark:{};--shiki-light-bg:{};--shiki-dark-bg:{}\" tabindex=\"0\"><code>",
        hex(light.foreground.unwrap_or(Color::BLACK)),
        hex(dark.foreground.unwrap_or(Color::WHITE)),
        hex(light.background.unwrap_or(Color::WHITE)),
        hex(dark.background.unwrap_or(Color::BLACK)),
    );
    let body: Vec<String> = lines
        .iter()
        .zip(inner)
        .map(|(line, tokens)| match indent_columns(line) {
            0 => format!("<span class=\"line\">{tokens}</span>"),
            columns => {
                format!("<span class=\"line\" style=\"--line-indent:{columns}ch\">{tokens}</span>")
            }
        })
        .collect();
    html.push_str(&body.join("\n"));
    html.push_str("</code></pre>");
    HighlightedCode {
        html,
        language: if highlighted {
            name
        } else {
            "plaintext".to_owned()
        },
        highlighted,
    }
}

/// The same tokenising, handed over per line: one string of markup per
/// line, in source order.
pub fn highlight_lines(code: &str, language: &str) -> HighlightedLines {
    let lines = source_lines(code);
    let plain = || HighlightedLines {
        lines: lines.iter().map(|line| escape_text(line)).collect(),
        language: "plaintext".to_owned(),
        highlighted: false,
    };
    let (name, Some(syntax)) = grammar_for(language) else {
        return plain();
    };
    match tokenise(&lines, syntax) {
        Some(tokens) => HighlightedLines {
            lines: tokens.iter().map(|line| tokens_html(line)).collect(),
            language: name,
            highlighted: true,
        },
        None => plain(),
    }
}

/// The extension an editor's file is highlighted by: what follows the last
/// `.`, `/` or `\`, lower-cased.
pub fn editor_extension(path: &str) -> String {
    let start = path.rfind(['.', '/', '\\']).map_or(0, |at| at + 1);
    path[start..].to_lowercase()
}

/// A draft being typed, tokenised for an editor's underlay; marked too
/// large past [`HIGHLIGHT_MAX_BYTES`], measured in UTF-8 bytes.
pub fn editor_highlight(path: &str, source: &str) -> EditorHighlight {
    let started = Instant::now();
    if source.len() > HIGHLIGHT_MAX_BYTES {
        return EditorHighlight {
            lines: Vec::new(),
            language: "plaintext".to_owned(),
            highlighted: false,
            too_large: true,
            took_ms: Millis(0.0),
        };
    }
    let out = highlight_lines(source, &editor_extension(path));
    EditorHighlight {
        lines: out.lines,
        language: out.language,
        highlighted: out.highlighted,
        too_large: false,
        took_ms: Millis(started.elapsed().as_secs_f64() * 1_000.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The grammar `raw` is highlighted with, by its name in the set.
    fn grammar_name(raw: &str) -> Option<&'static str> {
        grammar_for(raw)
            .1
            .map(|grammar| grammar.syntax.name.as_str())
    }

    #[test]
    fn typescript_and_tsx_are_highlighted_by_their_own_grammars() {
        for name in ["typescript", "ts", "mts", "cts"] {
            assert_eq!(grammar_name(name), Some("TypeScript"), "{name}");
        }
        assert_eq!(grammar_name("tsx"), Some("TypeScriptReact"));
        assert_eq!(grammar_name("javascript"), Some("JavaScript"));
    }

    #[test]
    fn powershell_toml_dockerfile_and_ini_are_highlighted_by_their_own_grammars() {
        for name in ["powershell", "ps", "ps1", "pwsh"] {
            assert_eq!(grammar_name(name), Some("PowerShell"), "{name}");
        }
        assert_eq!(grammar_name("toml"), Some("TOML"));
        assert_eq!(grammar_name("docker"), Some("Dockerfile"));
        assert_eq!(grammar_name("dockerfile"), Some("Dockerfile"));
        assert_eq!(grammar_name("ini"), Some("INI"));
    }

    #[test]
    fn every_own_grammar_loads() {
        for source in OWN_GRAMMARS {
            let loaded = SyntaxDefinition::load_from_str(source, true, None);
            assert!(loaded.is_ok(), "{:?}", loaded.err());
        }
        assert_eq!(grammars().own.syntaxes().len(), OWN_GRAMMARS.len());
    }

    #[test]
    fn a_powershell_script_is_coloured_by_what_each_part_is() {
        let out = highlight_lines(
            "# note\n$name = \"hi $env:USER\"\nGet-Item -Path $name -ErrorAction Stop\nif ($n -gt 42) { return }",
            "ps1",
        );
        assert!(out.highlighted);
        assert_eq!(out.language, "powershell");
        let colours: std::collections::BTreeSet<&str> = out
            .lines
            .iter()
            .flat_map(|line| line.split("--shiki-light:").skip(1))
            .filter_map(|rest| rest.get(..7))
            .collect();
        assert!(colours.len() >= 4, "{colours:?} in {:?}", out.lines);
    }

    #[test]
    fn a_stand_in_is_kept_only_for_a_language_with_no_grammar_of_its_own() {
        for (language, token) in STAND_INS {
            assert!(
                find_grammar(language).is_none(),
                "{language} has a grammar of its own"
            );
            assert!(
                find_grammar(token).is_some(),
                "{language}'s stand-in {token}"
            );
        }
        for (language, token) in TOKENS {
            assert!(
                find_grammar(language).is_none(),
                "{language} is found by itself"
            );
            assert!(
                find_grammar(token).is_some(),
                "{language}'s grammar {token}"
            );
        }
    }

    #[test]
    fn a_fence_is_highlighted_in_both_themes_with_its_indentation_carried() {
        let out = highlight_code("fn main() {\n    let x = 1;\n}", "rs");
        assert!(out.highlighted);
        assert_eq!(out.language, "rust");
        assert!(out.html.contains("--shiki-light:#"), "{}", out.html);
        assert!(out.html.contains("--shiki-dark:#"), "{}", out.html);
        assert!(out.html.contains("--line-indent:4ch"), "{}", out.html);
        assert_eq!(out.html.matches("<span class=\"line\"").count(), 3);
    }

    #[test]
    fn a_language_with_no_grammar_is_plain_text_and_escaped() {
        let out = highlight_code("a < b", "notalanguage");
        assert!(!out.highlighted);
        assert_eq!(out.language, "plaintext");
        assert!(out.html.contains("a &lt; b"), "{}", out.html);
        assert!(!highlight_code("x", "../../etc").highlighted);
    }

    #[test]
    fn an_editors_lines_keep_a_final_empty_line_and_their_text() {
        let out = highlight_lines("const value = 1\n", "ts");
        assert!(out.highlighted);
        assert_eq!(out.language, "typescript");
        assert_eq!(out.lines.len(), 2);
        assert_eq!(out.lines[1], "");
        let text: String = out.lines[0]
            .split('>')
            .filter_map(|part| part.split('<').next())
            .collect();
        assert_eq!(text, "const value = 1");
    }

    #[test]
    fn an_editor_source_past_the_ceiling_is_marked_too_large() {
        let big = "x".repeat(HIGHLIGHT_MAX_BYTES + 1);
        let out = editor_highlight("C:\\notes\\big.ts", &big);
        assert!(out.too_large);
        assert!(out.lines.is_empty());
        assert!(!out.highlighted);
        assert_eq!(editor_extension("C:\\notes\\big.TS"), "ts");
        assert_eq!(editor_extension("/repo/Makefile"), "makefile");
    }
}
