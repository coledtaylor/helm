//! The git worktrees Floti makes for agents.
//!
//! A child that asks for one (or whose role does) works in
//! `<repo>/.floti/worktrees/<name>` on a new branch `agent/<name>`, cut from
//! the commit its parent's folder has checked out. The repository is the main
//! working tree, found through git itself, so a parent that is already in an
//! agent worktree still makes the next one under the main repository. `/.floti/`
//! is added to the repository's `info/exclude` once, so `git status` shows
//! nothing under it. A worktree is never removed here when its child ends: its
//! branch holds the work.

use std::path::{Path, PathBuf};
use std::time::Duration;

use super::discovery::git::{GIT_TIMEOUT, run_git};
use super::files::paths::resolves_inside;
use crate::config_console::normalize;

/// Floti's folder in a repository.
const FLOTI_FOLDER: &str = ".floti";

/// The folder in it that holds the worktrees.
const WORKTREES_FOLDER: &str = "worktrees";

/// The branch of every agent worktree starts with this.
const BRANCH_PREFIX: &str = "agent/";

/// The line `info/exclude` gets.
const EXCLUDE_LINE: &str = "/.floti/";

/// The longest a worktree's name is.
const NAME_LENGTH: usize = 40;

/// What a name is when nothing usable is left of the one asked for.
const FALLBACK_NAME: &str = "agent";

/// How long making a checkout may take: a large repository writes many files.
const CHECKOUT_TIMEOUT: Duration = Duration::from_secs(300);

/// The repository a folder is in, as its main working tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Repository {
    main: PathBuf,
}

/// A worktree that was made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Made {
    repository: Repository,
    /// Its one-word name: the folder's name, and the branch's after
    /// `agent/`.
    pub name: String,
    /// Its root, where the child runs.
    pub folder: PathBuf,
    /// Its branch.
    pub branch: String,
}

impl Repository {
    /// The repository `folder` is in: its main working tree, which is the
    /// same for the repository's own folders and for the worktrees of it.
    ///
    /// # Errors
    ///
    /// A sentence when `folder` is not in a git repository, or the repository
    /// has no working tree.
    pub(crate) fn of(folder: &Path) -> Result<Self, String> {
        let listed = run_git(folder, &["worktree", "list", "--porcelain"], GIT_TIMEOUT)
            .map_err(|problem| not_a_repository(folder, &problem))?;
        let main = listed
            .lines()
            .next()
            .and_then(|line| line.strip_prefix("worktree "))
            .map(|path| normalize(Path::new(path.trim())))
            .filter(|_| !listed.lines().any(|line| line == "bare"))
            .ok_or_else(|| {
                format!(
                    "{} is in a git repository that has no working tree, so no worktree can be made there and no agent was started.",
                    folder.display()
                )
            })?;
        Ok(Self { main })
    }

    /// The main working tree.
    pub(crate) fn main(&self) -> &Path {
        &self.main
    }

    /// The folder that holds the agent worktrees.
    pub(crate) fn worktrees_folder(&self) -> PathBuf {
        self.main.join(FLOTI_FOLDER).join(WORKTREES_FOLDER)
    }

    /// The agent worktree that holds `folder`, when one does: its root.
    pub(crate) fn worktree_holding(&self, folder: &Path) -> Option<PathBuf> {
        std::fs::read_dir(self.worktrees_folder())
            .ok()?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .find(|root| resolves_inside(root, folder))
    }

    /// Makes a worktree called `wanted` (made unique among the folders there
    /// and the `agent/*` branches) from the commit `from` has checked out.
    ///
    /// # Errors
    ///
    /// A sentence when `from` has no commit checked out or git refuses. Nothing
    /// is left behind then.
    pub(crate) fn make(&self, from: &Path, wanted: &str) -> Result<Made, String> {
        let commit = run_git(from, &["rev-parse", "--verify", "HEAD^{commit}"], GIT_TIMEOUT)
            .map_err(|_| {
                format!(
                    "{} has no commit checked out, so no worktree can be made from it and no agent was started.",
                    from.display()
                )
            })?
            .trim()
            .to_owned();
        let name = choose_name(wanted, self.taken_names()?.iter().map(String::as_str));
        let branch = format!("{BRANCH_PREFIX}{name}");
        let folder = self.worktrees_folder().join(&name);
        self.exclude_floti_folder()?;
        let path = folder.display().to_string();
        run_git(
            &self.main,
            &["worktree", "add", "-b", &branch, &path, &commit],
            CHECKOUT_TIMEOUT,
        )
        .map_err(|problem| {
            format!("Floti could not make the worktree {name}: {problem} No agent was started.")
        })?;
        Ok(Made {
            repository: self.clone(),
            name,
            folder,
            branch,
        })
    }

    /// The names the worktrees already take: the folders under
    /// `.floti/worktrees` and the first word after `agent/` of each branch
    /// there, so a name that is free as a folder but held by a branch is not
    /// reused.
    fn taken_names(&self) -> Result<Vec<String>, String> {
        let mut taken: Vec<String> = std::fs::read_dir(self.worktrees_folder())
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        let branches = run_git(
            &self.main,
            &[
                "for-each-ref",
                "--format=%(refname:short)",
                "refs/heads/agent/",
            ],
            GIT_TIMEOUT,
        )?;
        taken.extend(
            branches
                .lines()
                .filter_map(|branch| branch.trim().strip_prefix(BRANCH_PREFIX))
                .filter_map(|rest| rest.split('/').next())
                .map(str::to_owned),
        );
        Ok(taken)
    }

    /// Adds `/.floti/` to the repository's `info/exclude` when no line says
    /// it, keeping every other line.
    fn exclude_floti_folder(&self) -> Result<(), String> {
        let named = run_git(
            &self.main,
            &["rev-parse", "--git-path", "info/exclude"],
            GIT_TIMEOUT,
        )?;
        let file = self.main.join(named.trim());
        let existing = match std::fs::read_to_string(&file) {
            Ok(text) => text,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(err) => {
                return Err(format!(
                    "Floti could not read {}: {err} No agent was started.",
                    file.display()
                ));
            }
        };
        let Some(text) = with_exclude_line(&existing) else {
            return Ok(());
        };
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent).map_err(|err| {
                format!(
                    "Floti could not make {}: {err} No agent was started.",
                    parent.display()
                )
            })?;
        }
        std::fs::write(&file, text).map_err(|err| {
            format!(
                "Floti could not write {}: {err} No agent was started.",
                file.display()
            )
        })
    }
}

impl Made {
    /// Takes a worktree that was just made and holds no work back out, with
    /// its branch: a launch that failed after it was made.
    ///
    /// # Errors
    ///
    /// A sentence when git could not remove it.
    pub(crate) fn discard(&self) -> Result<(), String> {
        let path = self.folder.display().to_string();
        run_git(
            self.repository.main(),
            &["worktree", "remove", "--force", &path],
            GIT_TIMEOUT,
        )?;
        run_git(
            self.repository.main(),
            &["branch", "-D", &self.branch],
            GIT_TIMEOUT,
        )
        .map(|_| ())
    }
}

/// The sentence for a folder git says is no repository, or git that did not
/// answer.
fn not_a_repository(folder: &Path, problem: &str) -> String {
    if problem.starts_with("Floti could not run git") || problem.starts_with("git did not answer") {
        return format!("{problem} No worktree was made and no agent was started.");
    }
    format!(
        "{} is not in a git repository, so no worktree can be made there and no agent was started.",
        folder.display()
    )
}

/// `existing` (the text of an `info/exclude` file) with the line that keeps
/// `.floti/` out of `git status` added, or `None` when a line says it already.
/// Every other line stays as it is.
pub(crate) fn with_exclude_line(existing: &str) -> Option<String> {
    if existing.lines().any(|line| line.trim() == EXCLUDE_LINE) {
        return None;
    }
    let mut text = existing.to_owned();
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(EXCLUDE_LINE);
    text.push('\n');
    Some(text)
}

/// `wanted` as a worktree's name: one word of letters, digits, `-` and `_`
/// that is safe as a folder and as the rest of a branch name.
fn word_of(wanted: &str) -> String {
    let mapped: String = wanted
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let mut word = String::new();
    for c in mapped.chars() {
        if c == '-' && word.ends_with('-') {
            continue;
        }
        word.push(c);
    }
    let word: String = word.trim_matches('-').chars().take(NAME_LENGTH).collect();
    let word = word.trim_matches('-');
    if word.is_empty() {
        FALLBACK_NAME.to_owned()
    } else {
        word.to_owned()
    }
}

/// A worktree's name: `wanted` made into one word, and made unique among the
/// names `taken` by a number after it (`ledger`, `ledger-2`), as child names
/// are. Case is ignored in comparing, because a Windows or macOS disk reads
/// two spellings as one folder.
pub(crate) fn choose_name<'a>(wanted: &str, taken: impl IntoIterator<Item = &'a str>) -> String {
    let taken: Vec<String> = taken.into_iter().map(str::to_lowercase).collect();
    let base = word_of(wanted);
    if !taken.contains(&base.to_lowercase()) {
        return base;
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|candidate| !taken.contains(&candidate.to_lowercase()))
        .unwrap_or(base)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{GitRepo, TestDirs};

    fn repository(dirs: &TestDirs) -> GitRepo {
        let repo = GitRepo::init(dirs.folder("a repo"));
        repo.write("file.txt", "one\n");
        repo.commit_all("first");
        repo
    }

    #[test]
    fn a_worktree_is_made_under_the_main_repository_even_from_inside_another_and_discarded_with_its_branch()
     {
        let dirs = TestDirs::new();
        let repo = repository(&dirs);
        let first = Repository::of(&repo.path().join("."))
            .expect("a repository")
            .make(repo.path(), "ledger store")
            .expect("a worktree");
        assert_eq!(first.name, "ledger-store");
        assert_eq!(first.branch, "agent/ledger-store");
        assert!(first.folder.join("file.txt").is_file());

        // From inside the first, the repository is the same, and the next
        // worktree goes beside it.
        let inside = Repository::of(&first.folder).expect("a repository");
        assert_eq!(
            inside.worktrees_folder(),
            Repository::of(repo.path()).unwrap().worktrees_folder()
        );
        assert_eq!(
            inside.worktree_holding(&first.folder.join("nowhere")),
            Some(first.folder.clone())
        );
        let second = inside.make(&first.folder, "ledger store").expect("another");
        assert_eq!(second.name, "ledger-store-2");
        assert_eq!(second.folder.parent(), first.folder.parent());

        second.discard().expect("a fresh worktree is discarded");
        assert!(!second.folder.exists());
        let branches = repo.git(&["branch", "--list", "agent/*", "--format=%(refname:short)"]);
        assert_eq!(branches.trim(), "agent/ledger-store");
    }

    #[test]
    fn a_name_held_by_a_branch_with_no_folder_is_not_reused() {
        let dirs = TestDirs::new();
        let repo = repository(&dirs);
        repo.git(&["branch", "agent/kept/deeper"]);
        let made = Repository::of(repo.path())
            .expect("a repository")
            .make(repo.path(), "kept")
            .expect("a worktree");
        assert_eq!(made.name, "kept-2");
    }

    #[test]
    fn a_folder_outside_a_repository_is_refused_in_a_sentence() {
        let dirs = TestDirs::new();
        let refused = Repository::of(&dirs.folder("plain")).expect_err("no repository");
        assert!(refused.contains("not in a git repository"), "{refused}");
    }

    #[test]
    fn the_exclude_line_is_added_once_and_the_other_lines_stay() {
        let added = with_exclude_line("# comment\n*.log").expect("the line is missing");
        assert_eq!(added, "# comment\n*.log\n/.floti/\n");
        assert_eq!(with_exclude_line(&added), None);
        assert_eq!(with_exclude_line("a\n  /.floti/  \nb\n"), None);
        assert_eq!(with_exclude_line("").as_deref(), Some("/.floti/\n"));
        // A different line is not the same line.
        assert!(with_exclude_line(".floti/\n").is_some());
    }

    #[test]
    fn a_name_is_one_safe_word_made_unique_by_a_number() {
        assert_eq!(choose_name("ledger store", []), "ledger-store");
        assert_eq!(choose_name("  a/b..c  ", []), "a-b-c");
        assert_eq!(choose_name("--", []), "agent");
        assert_eq!(choose_name("ledger", ["Ledger"]), "ledger-2");
        assert_eq!(
            choose_name("ledger", ["ledger", "ledger-2", "LEDGER-3"]),
            "ledger-4"
        );
        assert_eq!(choose_name(&"x".repeat(100), []).len(), NAME_LENGTH);
    }
}
