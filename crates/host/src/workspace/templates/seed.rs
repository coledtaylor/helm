//! What a first start writes into the templates folder: a README that says
//! how to write a template, and one example that shows every part of the
//! format.
//!
//! The trigger is the folder being absent, not a stamp or a hash. The host
//! keeps no record of what it wrote there, so it cannot tell an edited file
//! from an untouched one, and an improved example overwriting somebody's
//! edited copy is the one failure this must not have. So a better shipped
//! example never reaches an existing folder, and deleting the folder brings
//! the originals back at the next start.

use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// The shipped files, by path relative to the templates folder.
pub const SHIPPED_TEMPLATES: &[(&str, &str)] = &[
    ("README.md", README),
    (
        "example/template.yaml",
        "label: \"Example\"\ndescription: \"A CLAUDE.md naming the harness, an empty repos/ and an empty .claude/skills/.\"\norder: 10\n",
    ),
    (
        "example/CLAUDE.md.tpl",
        "# {{NAME}}\n\nCreated {{CREATED_AT}} from the {{TEMPLATE}} template.\n\nReplace this file with whatever the agents working here need to know.\n",
    ),
    ("example/dot-claude/skills/.gitkeep", ""),
    ("example/repos/.gitkeep", ""),
];

const README: &str = r#"# Harness templates

A template is a folder in this directory. Creating a harness from it copies the
folder's contents into the new harness, and that is the whole mechanism.

    templates/
      README.md          <- this file
      example/           <- one template, named by its folder
        template.yaml    <- what the picker shows
        ...              <- everything else is copied as-is

## template.yaml

    label: "Example"
    description: "One sentence, shown under the label in the picker."
    order: 10

All three are optional. Without a label the folder name is used; `order` sorts
the picker, and a template without one sorts after every template with one. A
`template.yaml` that cannot be parsed skips that one template and leaves the
rest of the picker working.

## The rest of the folder

Copied verbatim into the new harness, with five rules:

- **`.tpl` files are filled in and the extension is dropped.**
  `CLAUDE.md.tpl` is written as `CLAUDE.md` with `{{NAME}}`,
  `{{CREATED_AT}}`, `{{TEMPLATE}}` and `{{PATH}}` substituted. There
  are no other placeholders, and no conditionals or loops.
- **`{{PATH}}` is the new harness's folder, with forward slashes** -
  `C:/Users/you/.harness/work`. Use it wherever a file has to name something
  inside the harness: a hook command in `settings.json.tpl`, an MCP server in
  `.mcp.json.tpl`. Forward slashes keep it valid JSON, and every tool that
  reads those files accepts them.
- **Every other file is copied byte for byte.** A workflow file full of
  `${{ ... }}` arrives exactly as you wrote it. That is why substitution is
  opt-in rather than applied everywhere.
- **`dot-claude/` is written as `.claude/`.** A literal `.claude/` works
  too; the alias exists because some tools drop dot directories when a template
  is packaged or copied.
- **An empty folder needs a `.gitkeep`.** Folders are created as the parents
  of files, so an empty one would otherwise never arrive. The `.gitkeep`
  itself is not copied.

## What is refused

Absolute paths, anything that climbs out of the harness with `..`, and
junctions or symlinks. `harness.yaml` too - Floti writes that one, because
`template:` in it records which template a harness came from.

## Minimal

The first row of the picker is built in and is not a folder here. It writes a
manifest, an empty `repos/` and an empty `.claude/`, and nothing you put in
this directory can change or break it.

## Editing

These files are written once, when this directory does not exist. Nothing here
is ever overwritten, so anything you change stays changed - and deleting the
whole directory puts the originals back at the next start.
"#;

/// What seeding did.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Seeded {
    /// False when the folder was already there, which is the ordinary case.
    pub seeded: bool,
    /// Written, relative to the folder.
    pub created: Vec<String>,
    /// Why seeding stopped part way, or `None`.
    pub problem: Option<String>,
}

/// Writes the shipped README and example into `dir`, only when `dir` is
/// absent. The folder itself is made by a call that fails when it exists,
/// and every file is written create-new, so of two hosts starting at once
/// only one seeds, and nothing already there is ever written over.
pub fn seed_templates(dir: &Path) -> Seeded {
    if std::fs::symlink_metadata(dir).is_ok() {
        return Seeded::default();
    }
    if let Some(parent) = dir.parent()
        && let Err(err) = std::fs::create_dir_all(parent)
    {
        return failed(Vec::new(), &err);
    }
    match std::fs::create_dir(dir) {
        Ok(()) => {}
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => return Seeded::default(),
        Err(err) => return failed(Vec::new(), &err),
    }

    let mut shipped: Vec<&(&str, &str)> = SHIPPED_TEMPLATES.iter().collect();
    shipped.sort_by_key(|(path, _)| *path);
    let mut created = Vec::new();
    for (relative, content) in shipped {
        let destination: PathBuf = dir.join(relative.split('/').collect::<PathBuf>());
        if let Err(err) = write_new(&destination, content) {
            return failed(created, &err);
        }
        created.push((*relative).to_owned());
    }
    Seeded {
        seeded: true,
        created,
        problem: None,
    }
}

fn write_new(path: &Path, content: &str) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?
        .write_all(content.as_bytes())
}

fn failed(created: Vec<String>, err: &io::Error) -> Seeded {
    Seeded {
        seeded: !created.is_empty(),
        created,
        problem: Some(format!("the templates folder could not be seeded: {err}")),
    }
}
