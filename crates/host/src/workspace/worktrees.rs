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

use floti_protocol::channels::workspace::{
    AgentWorktree, AgentWorktrees, WorktreeChild, WorktreeRemoval,
};
use rusqlite::Connection;

use super::discovery::git::{GIT_TIMEOUT, run_git};
use super::files::paths::resolves_inside;
use super::roots::key;
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
        Self::from_listing(&listed, folder)
    }

    /// The repository `folder` is in, or `None` when it is in none.
    ///
    /// # Errors
    ///
    /// A sentence when git could not be run or the repository has no working
    /// tree.
    pub(crate) fn find(folder: &Path) -> Result<Option<Self>, String> {
        match run_git(folder, &["worktree", "list", "--porcelain"], GIT_TIMEOUT) {
            Ok(listed) => Self::from_listing(&listed, folder).map(Some),
            Err(problem) if git_did_not_run(&problem) => Err(problem),
            Err(_) => Ok(None),
        }
    }

    /// The repository `git worktree list --porcelain` printed `listed` in.
    fn from_listing(listed: &str, folder: &Path) -> Result<Self, String> {
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

/// Whether `problem` (from [`run_git`]) says git could not be run or did not
/// answer, rather than what git itself said about a folder.
fn git_did_not_run(problem: &str) -> bool {
    problem.starts_with("Floti could not run git") || problem.starts_with("git did not answer")
}

/// The sentence for a folder git says is no repository, or git that did not
/// answer.
fn not_a_repository(folder: &Path, problem: &str) -> String {
    if git_did_not_run(problem) {
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

/// One agent worktree as git lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Listed {
    /// Its root.
    folder: PathBuf,
    /// The branch checked out there; `None` for a detached checkout.
    branch: Option<String>,
}

impl Repository {
    /// The worktrees under `.floti/worktrees`, from `git worktree list`: the
    /// repository's own working tree, its other worktrees and a worktree
    /// whose folder is gone (git marks it prunable) are left out.
    ///
    /// # Errors
    ///
    /// A sentence when git could not be asked.
    fn agent_worktrees(&self) -> Result<Vec<Listed>, String> {
        let listed = run_git(
            &self.main,
            &["worktree", "list", "--porcelain"],
            GIT_TIMEOUT,
        )?;
        let holder = key(&self.worktrees_folder());
        Ok(parse_listing(&listed)
            .into_iter()
            .filter(|entry| {
                entry
                    .folder
                    .parent()
                    .is_some_and(|parent| key(parent) == holder)
            })
            .collect())
    }
}

/// The worktrees in the text of `git worktree list --porcelain`, whose
/// entries are blocks of lines separated by an empty one.
fn parse_listing(text: &str) -> Vec<Listed> {
    let mut found = Vec::new();
    for block in text.replace("\r\n", "\n").split("\n\n") {
        let mut folder: Option<PathBuf> = None;
        let mut branch: Option<String> = None;
        let mut prunable = false;
        for line in block.lines() {
            if let Some(path) = line.strip_prefix("worktree ") {
                folder = Some(normalize(Path::new(path.trim())));
            } else if let Some(name) = line.strip_prefix("branch ") {
                branch = Some(name.trim().trim_start_matches("refs/heads/").to_owned());
            } else if line == "prunable" || line.starts_with("prunable ") {
                prunable = true;
            }
        }
        if let (Some(folder), false) = (folder, prunable) {
            found.push(Listed { folder, branch });
        }
    }
    found
}

/// A session that worked in, or works in, a folder under `.floti/worktrees`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Worker {
    /// The folder it runs in.
    cwd: String,
    /// Its child name, else its label, else its name.
    name: String,
    /// The name of the session that started it.
    parent: Option<String>,
    running: bool,
}

/// Every running session, and every session that ran under a
/// `.floti/worktrees` folder, oldest first.
fn workers(conn: &Connection) -> Result<Vec<Worker>, String> {
    let mut select = conn
        .prepare(
            "SELECT cwd, \
                    coalesce(nullif(child_name, ''), nullif(label, ''), name), \
                    (SELECT coalesce(nullif(parent.label, ''), parent.name) FROM sessions AS parent \
                     WHERE parent.id = sessions.parent_session_id), \
                    status = 'running' \
             FROM sessions \
             WHERE status = 'running' \
                OR lower(replace(cwd, char(92), '/')) LIKE '%/.floti/worktrees/%' \
             ORDER BY id",
        )
        .map_err(sql)?;
    let rows = select
        .query_map([], |row| {
            Ok(Worker {
                cwd: row.get(0)?,
                name: row.get(1)?,
                parent: row.get(2)?,
                running: row.get(3)?,
            })
        })
        .map_err(sql)?;
    rows.collect::<Result<_, _>>().map_err(sql)
}

fn sql(err: rusqlite::Error) -> String {
    format!("Floti could not read its record of sessions: {err}")
}

/// The worker that works in `worktree` now, else the one that did last.
fn worker_in<'a>(workers: &'a [Worker], worktree: &Path) -> Option<&'a Worker> {
    let inside = |worker: &&Worker| resolves_inside(worktree, Path::new(&worker.cwd));
    workers
        .iter()
        .rev()
        .filter(inside)
        .find(|worker| worker.running)
        .or_else(|| workers.iter().rev().find(inside))
}

/// The agent worktrees of the repository `project` is in, with the session
/// that last worked in each and whether git sees changes there. A folder in no
/// repository has none.
///
/// # Errors
///
/// A sentence when git could not be asked or the record of sessions read.
pub(crate) fn list(project: &Path, conn: &Connection) -> Result<AgentWorktrees, String> {
    let none = || AgentWorktrees {
        worktrees: Vec::new(),
    };
    if !project.is_dir() {
        return Ok(none());
    }
    let Some(repository) = Repository::find(project)? else {
        return Ok(none());
    };
    let listed = repository.agent_worktrees()?;
    if listed.is_empty() {
        return Ok(none());
    }
    let workers = workers(conn)?;
    let mut worktrees: Vec<AgentWorktree> = listed
        .into_iter()
        .map(|entry| AgentWorktree {
            name: folder_name(&entry.folder),
            child: worker_in(&workers, &entry.folder).map(|worker| WorktreeChild {
                name: worker.name.clone(),
                parent: worker.parent.clone(),
                running: worker.running,
            }),
            uncommitted: has_changes(&entry.folder),
            folder: entry.folder.display().to_string(),
            branch: entry.branch,
        })
        .collect();
    worktrees.sort_by_key(|worktree| worktree.name.to_lowercase());
    Ok(AgentWorktrees { worktrees })
}

fn folder_name(folder: &Path) -> String {
    folder
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Whether git sees a modified or untracked file in `folder`; `None` when it
/// could not be asked.
fn has_changes(folder: &Path) -> Option<bool> {
    run_git(folder, &["status", "--porcelain"], GIT_TIMEOUT)
        .ok()
        .map(|printed| !printed.trim().is_empty())
}

/// Removes the agent worktree at `folder` of the repository `project` is in,
/// with `git worktree remove` and never `--force`, so git itself also refuses
/// a checkout with changes, and never a recursive delete, which can walk a
/// junction. The `agent/<name>` branch stays, with the work on it.
///
/// A worktree that cannot be removed is a refusal in the answer, and is left
/// as it is: a folder that is not one of the repository's agent worktrees, one
/// a running session works in (named), and one with uncommitted changes.
///
/// # Errors
///
/// A sentence when git could not be asked or the record of sessions read.
pub(crate) fn remove(
    project: &Path,
    folder: &Path,
    conn: &Connection,
) -> Result<WorktreeRemoval, String> {
    let refused = |sentence: String| {
        Ok(WorktreeRemoval {
            removed: false,
            refusal: Some(sentence),
        })
    };
    let Some(repository) = Repository::find(project)? else {
        return refused(format!(
            "{} is not in a git repository, so it has no agent worktrees.",
            project.display()
        ));
    };
    let Some(entry) = repository.agent_worktrees()?.into_iter().find(|entry| {
        resolves_inside(&entry.folder, folder) && resolves_inside(folder, &entry.folder)
    }) else {
        return refused(format!(
            "{} is not one of the agent worktrees of {}, so it was left alone.",
            folder.display(),
            repository.main().display()
        ));
    };
    let name = folder_name(&entry.folder);
    if let Some(worker) = workers(conn)?
        .iter()
        .rev()
        .find(|worker| worker.running && resolves_inside(&entry.folder, Path::new(&worker.cwd)))
    {
        return refused(format!(
            "The worktree {name} was not removed: {} is running in it. Stop it first.",
            worker.name
        ));
    }
    match has_changes(&entry.folder) {
        Some(false) => {}
        Some(true) => {
            return refused(format!(
                "The worktree {name} has uncommitted changes, so it was not removed. Commit or discard them first."
            ));
        }
        None => {
            return refused(format!(
                "Floti could not tell whether the worktree {name} has uncommitted changes, so it was not removed."
            ));
        }
    }
    let path = entry.folder.display().to_string();
    match run_git(
        repository.main(),
        &["worktree", "remove", &path],
        CHECKOUT_TIMEOUT,
    ) {
        Ok(_) => Ok(WorktreeRemoval {
            removed: true,
            refusal: None,
        }),
        Err(problem) => refused(format!("The worktree {name} was not removed: {problem}")),
    }
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
    fn the_listing_keeps_the_folders_git_prints_with_their_branch_and_drops_a_prunable_one() {
        let text = "worktree /work/a repo\nHEAD 1111\nbranch refs/heads/main\n\n\
                    worktree /work/a repo/.floti/worktrees/ledger\nHEAD 2222\nbranch refs/heads/agent/ledger\n\n\
                    worktree /work/a repo/.floti/worktrees/loose\nHEAD 3333\ndetached\n\n\
                    worktree /work/a repo/.floti/worktrees/gone\nHEAD 4444\nbranch refs/heads/agent/gone\nprunable gitdir file points to non-existent location\n";
        let listed = parse_listing(text);
        assert_eq!(
            listed
                .iter()
                .map(|entry| (folder_name(&entry.folder), entry.branch.as_deref()))
                .collect::<Vec<_>>(),
            [
                ("a repo".to_owned(), Some("main")),
                ("ledger".to_owned(), Some("agent/ledger")),
                ("loose".to_owned(), None),
            ]
        );
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
