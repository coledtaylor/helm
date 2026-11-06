//! The roles folder: `roles` in the host's config folder, one `<name>.md` per
//! role. Read on every call and cached nowhere, so a file the user adds, edits
//! or deletes is seen by the next start or listing with no restart.
//!
//! A file is a role when its stem is a role name (lowercase letters, digits
//! and hyphens) and its extension is `md`. Everything else in the folder is
//! ignored: other extensions, other names and folders.

use std::io;
use std::path::{Path, PathBuf};

use super::parse::parse_role;
use super::{BadRole, RoleListing, RoleLookup, RoleSource, is_role_name};
use crate::platform::folders::Folders;

/// Where the user's roles live: `roles` in the host's config folder.
pub fn roles_folder(folders: &Folders) -> PathBuf {
    folders.config.join("roles")
}

/// The roles in a folder, read fresh on every call.
#[derive(Debug, Clone)]
pub struct FolderRoles {
    dir: PathBuf,
}

impl FolderRoles {
    /// The roles in `dir`. The folder need not exist.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// The folder.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The role file `name.md`, read and parsed.
    fn read(&self, name: &str) -> RoleLookup {
        let file = format!("{name}.md");
        let path = self.dir.join(&file);
        match std::fs::metadata(&path) {
            Ok(meta) if meta.is_file() => {}
            Ok(_) => return RoleLookup::Missing,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return RoleLookup::Missing,
            Err(err) => return RoleLookup::Bad(unreadable(file, &err)),
        }
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(err) => return RoleLookup::Bad(unreadable(file, &err)),
        };
        let Ok(source) = String::from_utf8(bytes) else {
            return RoleLookup::Bad(BadRole {
                file,
                problem: "it is not UTF-8 text".to_owned(),
            });
        };
        match parse_role(name, &source) {
            Ok(role) => RoleLookup::Found(Box::new(role)),
            Err(problem) => RoleLookup::Bad(BadRole { file, problem }),
        }
    }
}

fn unreadable(file: String, err: &io::Error) -> BadRole {
    BadRole {
        file,
        problem: format!("it could not be read: {err}"),
    }
}

impl RoleSource for FolderRoles {
    fn listing(&self) -> RoleListing {
        let mut names: Vec<String> = match std::fs::read_dir(&self.dir) {
            Ok(entries) => entries
                .filter_map(|entry| {
                    let path = entry.ok()?.path();
                    if path.extension()? != "md" {
                        return None;
                    }
                    let stem = path.file_stem()?.to_str()?;
                    (is_role_name(stem) && path.is_file()).then(|| stem.to_owned())
                })
                .collect(),
            // No folder is no roles; one that cannot be read is said in the
            // host's log and is no roles either.
            Err(err) if err.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(err) => {
                log_line!(
                    "floti host: the roles folder {} could not be read: {err}",
                    self.dir.display()
                );
                Vec::new()
            }
        };
        names.sort();
        let mut listing = RoleListing::default();
        for name in names {
            match self.read(&name) {
                RoleLookup::Found(role) => listing.roles.push(*role),
                RoleLookup::Bad(bad) => listing.bad.push(bad),
                RoleLookup::Missing => {}
            }
        }
        listing
    }

    fn lookup(&self, name: &str) -> RoleLookup {
        let name = name.trim().to_ascii_lowercase();
        if is_role_name(&name) {
            self.read(&name)
        } else {
            RoleLookup::Missing
        }
    }
}
