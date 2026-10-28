//! How a file opens, decided by its name: rendered, framed, as source, as
//! text, or not at all. Every file has a kind; the kind decides which
//! surface opens it, never whether it is listed.

use floti_protocol::channels::workspace::ContentFileKind;

const MARKDOWN: &[&str] = &[".md", ".markdown", ".mdx"];
const HTML: &[&str] = &[".html", ".htm"];
const DATA: &[&str] = &[".yaml", ".yml", ".json", ".jsonc", ".toml"];
const TEXT: &[&str] = &[".txt", ".csv", ".log", ".text", ".rst", ".adoc"];

/// Extensions that open in the source view: generous on purpose, since a
/// file the agent wrote that the view will not admit to is the worse error.
const SOURCE: &[&str] = &[
    ".js",
    ".mjs",
    ".cjs",
    ".jsx",
    ".ts",
    ".mts",
    ".cts",
    ".tsx",
    ".py",
    ".pyi",
    ".rb",
    ".pl",
    ".php",
    ".lua",
    ".r",
    ".sh",
    ".bash",
    ".zsh",
    ".fish",
    ".ps1",
    ".psm1",
    ".psd1",
    ".bat",
    ".cmd",
    ".c",
    ".h",
    ".cc",
    ".cpp",
    ".hpp",
    ".cs",
    ".java",
    ".kt",
    ".kts",
    ".swift",
    ".go",
    ".rs",
    ".scala",
    ".clj",
    ".ex",
    ".exs",
    ".erl",
    ".hs",
    ".ml",
    ".vb",
    ".sql",
    ".graphql",
    ".gql",
    ".proto",
    ".css",
    ".scss",
    ".sass",
    ".less",
    ".vue",
    ".svelte",
    ".astro",
    ".ini",
    ".cfg",
    ".conf",
    ".properties",
    ".env",
    ".editorconfig",
    ".gitignore",
    ".gitattributes",
    ".dockerignore",
    ".npmrc",
    ".nvmrc",
    ".xml",
    ".svg",
    ".patch",
    ".diff",
    ".make",
    ".mk",
    ".cmake",
    ".gradle",
    ".tf",
    ".tfvars",
    ".nix",
    ".vim",
    ".el",
    ".applescript",
];

/// The part of a name that decides its kind, lower-cased with its dot. A
/// leading dot is the whole name (`.gitignore`), not an empty extension.
pub fn content_extension(name: &str) -> String {
    match name.rfind('.') {
        None => String::new(),
        Some(0) => name.to_lowercase(),
        Some(dot) => name[dot..].to_lowercase(),
    }
}

/// How the file called `name` opens. A name with no extension is text
/// (`LICENSE`, `Makefile`), a dotfile whose whole name is its extension is
/// source, and anything else unrecognised is binary, which is still listed.
pub fn content_file_kind(name: &str) -> ContentFileKind {
    let ext = content_extension(name);
    let ext = ext.as_str();
    if MARKDOWN.contains(&ext) {
        ContentFileKind::Markdown
    } else if HTML.contains(&ext) {
        ContentFileKind::Html
    } else if DATA.contains(&ext) {
        ContentFileKind::Data
    } else if TEXT.contains(&ext) {
        ContentFileKind::Text
    } else if SOURCE.contains(&ext) {
        ContentFileKind::Source
    } else if ext.is_empty() {
        ContentFileKind::Text
    } else if ext == name.to_lowercase() {
        ContentFileKind::Source
    } else {
        ContentFileKind::Binary
    }
}

/// Whether a file is evidence that the folder holding it is content.
pub fn counts_as_content(kind: ContentFileKind) -> bool {
    kind != ContentFileKind::Binary
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_name_has_a_kind() {
        assert_eq!(content_file_kind("a.MD"), ContentFileKind::Markdown);
        assert_eq!(content_file_kind("tool.py"), ContentFileKind::Source);
        assert_eq!(content_file_kind("LICENSE"), ContentFileKind::Text);
        assert_eq!(content_file_kind(".prettierrc"), ContentFileKind::Source);
        assert_eq!(content_file_kind("a.exe"), ContentFileKind::Binary);
        assert_eq!(content_extension(".gitignore"), ".gitignore");
    }
}
