//! What a first start writes into the roles folder: the shipped `lead`,
//! `reviewer` and `worker`.
//!
//! The trigger is the folder being absent, as for the templates folder, and for
//! the same reason: the host keeps no record of what it wrote there, so it
//! cannot tell an edited file from an untouched one, and an improved shipped
//! role overwriting somebody's edited copy is the one failure this must not
//! have. So a better shipped role never reaches an existing folder, a file the
//! user deleted stays deleted, an empty folder stays empty, and deleting the
//! folder brings the originals back at the next start.

use std::io;
use std::path::Path;

use crate::workspace::templates::seed::write_new;

/// The shipped roles, by file name.
pub const SHIPPED_ROLES: &[(&str, &str)] = &[
    ("lead.md", include_str!("shipped/lead.md")),
    ("reviewer.md", include_str!("shipped/reviewer.md")),
    ("worker.md", include_str!("shipped/worker.md")),
];

/// What seeding did.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Seeded {
    /// False when the folder was already there, which is the ordinary case.
    pub seeded: bool,
    /// The files written.
    pub created: Vec<String>,
    /// Why seeding stopped part way, or `None`.
    pub problem: Option<String>,
}

/// Writes the shipped roles into `dir`, only when `dir` is absent. The folder
/// itself is made by a call that fails when it exists, and every file is
/// written create-new, so of two hosts starting at once only one seeds, and
/// nothing already there is ever written over.
pub fn seed_roles(dir: &Path) -> Seeded {
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
    let mut created = Vec::new();
    for (file, content) in SHIPPED_ROLES {
        if let Err(err) = write_new(&dir.join(file), content) {
            return failed(created, &err);
        }
        created.push((*file).to_owned());
    }
    Seeded {
        seeded: true,
        created,
        problem: None,
    }
}

fn failed(created: Vec<String>, err: &io::Error) -> Seeded {
    Seeded {
        seeded: !created.is_empty(),
        created,
        problem: Some(format!("the roles folder could not be seeded: {err}")),
    }
}
