//! The discovery cache, `projects`: what the last scan found, so a client
//! paints before a fresh scan finishes and a project that has gone missing
//! shows as stale rather than vanishing. A scan overwrites the rows it saw
//! and leaves the rest; [`forget_projects`] is the only way a row leaves.
//!
//! The same rows and JSON as `packages/core/src/store/projects.ts`.

use floti_protocol::channels::workspace::{
    CachedProject, ClaudeInventory, GitState, Harness, Project, ProjectKind,
};
use rusqlite::{Connection, params};

use super::sql_error;
use crate::Result;

/// What a row with no readable inventory counts as: nothing.
pub const EMPTY_INVENTORY: ClaudeInventory = ClaudeInventory {
    skills: 0,
    commands: 0,
    agents: 0,
    hooks: false,
    settings: false,
    claude_md: false,
    mcp: false,
};

/// Writes the rows a scan found, as of `seen_at` (ISO 8601).
///
/// `harnesses` is required because the one thing a row carries that a
/// [`Project`] does not is its harness's `template:`: a caller passing the
/// projects alone would write null over it.
pub fn cache_projects(
    conn: &mut Connection,
    found: &[Project],
    harnesses: &[Harness],
    seen_at: &str,
) -> Result<()> {
    let template_of = |project: &Project| -> Option<String> {
        if project.kind != ProjectKind::Harness {
            return None;
        }
        let key = project.path.to_lowercase();
        harnesses
            .iter()
            .find(|harness| harness.path.to_lowercase() == key)
            .and_then(|harness| harness.template.clone())
    };
    let write = conn
        .transaction()
        .map_err(sql_error("cache the projects a scan found"))?;
    {
        let mut upsert = write
            .prepare(
                "INSERT INTO projects \
                 (path, name, kind, harness_path, template, has_claude_dir, inventory, git, last_seen_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) \
                 ON CONFLICT(path) DO UPDATE SET \
                 name = excluded.name, kind = excluded.kind, harness_path = excluded.harness_path, \
                 template = excluded.template, has_claude_dir = excluded.has_claude_dir, \
                 inventory = excluded.inventory, git = excluded.git, last_seen_at = excluded.last_seen_at",
            )
            .map_err(sql_error("cache the projects a scan found"))?;
        for project in found {
            let git = project
                .git
                .as_ref()
                .map(|git| serde_json::to_string(git).expect("git state is JSON"));
            upsert
                .execute(params![
                    project.path,
                    project.name,
                    kind_name(project.kind),
                    project.harness_path,
                    template_of(project),
                    project.has_claude_dir,
                    serde_json::to_string(&project.inventory).expect("an inventory is JSON"),
                    git,
                    seen_at,
                ])
                .map_err(sql_error("cache the projects a scan found"))?;
        }
    }
    write
        .commit()
        .map_err(sql_error("cache the projects a scan found"))
}

/// Drops the rows whose paths are among `paths`, compared ignoring case: a
/// row written from one spelling of a Windows folder is the same folder in
/// another. Answers how many went.
pub fn forget_projects(conn: &mut Connection, paths: &[String]) -> Result<usize> {
    if paths.is_empty() {
        return Ok(0);
    }
    let wanted: std::collections::HashSet<String> =
        paths.iter().map(|path| path.to_lowercase()).collect();
    let doomed: Vec<String> = all_paths(conn)?
        .into_iter()
        .filter(|path| wanted.contains(&path.to_lowercase()))
        .collect();
    if doomed.is_empty() {
        return Ok(0);
    }
    let remove = conn
        .transaction()
        .map_err(sql_error("forget cached projects"))?;
    for path in &doomed {
        remove
            .execute("DELETE FROM projects WHERE path = ?1", [path])
            .map_err(sql_error("forget cached projects"))?;
    }
    remove
        .commit()
        .map_err(sql_error("forget cached projects"))?;
    Ok(doomed.len())
}

/// The cached project whose folder is `cwd`, compared ignoring case as the
/// desktop's `knownProject` does, spelled as the scan found it; `None` for a
/// folder no scan has found. A session started there is that project's.
pub fn known_project(conn: &Connection, cwd: &str) -> Result<Option<String>> {
    let wanted = cwd.to_lowercase();
    Ok(all_paths(conn)?
        .into_iter()
        .find(|path| path.to_lowercase() == wanted))
}

fn all_paths(conn: &Connection) -> Result<Vec<String>> {
    let mut select = conn
        .prepare("SELECT path FROM projects")
        .map_err(sql_error("read the cached projects"))?;
    let rows = select
        .query_map([], |row| row.get(0))
        .map_err(sql_error("read the cached projects"))?;
    rows.collect::<rusqlite::Result<Vec<String>>>()
        .map_err(sql_error("read the cached projects"))
}

/// Every cached row, ordered by path ignoring case. A row whose inventory
/// cannot be read counts as [`EMPTY_INVENTORY`]; one whose git state cannot
/// be read has none, never a guessed one. A row of a kind this host does not
/// know is left out.
pub fn read_cached_projects(conn: &Connection) -> Result<Vec<CachedProject>> {
    let mut select = conn
        .prepare(
            "SELECT path, name, kind, harness_path, template, has_claude_dir, inventory, git, last_seen_at \
             FROM projects ORDER BY path COLLATE NOCASE",
        )
        .map_err(sql_error("read the cached projects"))?;
    let rows = select
        .query_map([], |row| {
            let kind: String = row.get(2)?;
            let Some(kind) = parse_kind(&kind) else {
                return Ok(None);
            };
            let inventory: Option<String> = row.get(6)?;
            let git: Option<String> = row.get(7)?;
            Ok(Some(CachedProject {
                path: row.get(0)?,
                name: row.get(1)?,
                kind,
                harness_path: row.get(3)?,
                template: row.get(4)?,
                has_claude_dir: row.get(5)?,
                inventory: inventory
                    .and_then(|text| serde_json::from_str(&text).ok())
                    .unwrap_or(EMPTY_INVENTORY),
                git: git.and_then(|text| {
                    serde_json::from_str::<Option<GitState>>(&text)
                        .ok()
                        .flatten()
                }),
                last_seen_at: row.get(8)?,
            }))
        })
        .map_err(sql_error("read the cached projects"))?;
    let mut out = Vec::new();
    for row in rows {
        if let Some(project) = row.map_err(sql_error("read the cached projects"))? {
            out.push(project);
        }
    }
    Ok(out)
}

fn kind_name(kind: ProjectKind) -> &'static str {
    match kind {
        ProjectKind::Harness => "harness",
        ProjectKind::Repo => "repo",
        ProjectKind::Folder => "folder",
    }
}

fn parse_kind(name: &str) -> Option<ProjectKind> {
    match name {
        "harness" => Some(ProjectKind::Harness),
        "repo" => Some(ProjectKind::Repo),
        "folder" => Some(ProjectKind::Folder),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use crate::testkit::TestDirs;

    fn project(path: &str, kind: ProjectKind) -> Project {
        Project {
            path: path.to_owned(),
            name: path.rsplit('/').next().unwrap().to_owned(),
            kind,
            harness_path: None,
            has_claude_dir: true,
            inventory: ClaudeInventory {
                skills: 2,
                ..EMPTY_INVENTORY
            },
            git: Some(GitState {
                branch: Some("main".into()),
                detached: false,
                dirty: 1,
                ahead: 0,
                behind: 2,
                error: None,
            }),
        }
    }

    #[test]
    fn a_scan_is_cached_with_its_harness_template_and_read_back_in_path_order() {
        let dirs = TestDirs::new();
        let mut store = Store::open(&dirs.data).unwrap();
        let harness = project("/work/Harness", ProjectKind::Harness);
        let mut repo = project("/work/Harness/repos/alpha", ProjectKind::Repo);
        repo.harness_path = Some(harness.path.clone());
        repo.git = None;
        let harnesses = [Harness {
            path: "/work/harness".into(),
            name: "Harness".into(),
            template: Some("starter".into()),
            version: None,
            repo_paths: vec![repo.path.clone()],
        }];
        cache_projects(
            store.connection_mut(),
            &[repo.clone(), harness.clone()],
            &harnesses,
            "2026-10-28T10:00:00.000Z",
        )
        .unwrap();

        let cached = read_cached_projects(store.connection()).unwrap();
        assert_eq!(
            cached
                .iter()
                .map(|row| row.path.as_str())
                .collect::<Vec<_>>(),
            ["/work/Harness", "/work/Harness/repos/alpha"]
        );
        assert_eq!(cached[0].template.as_deref(), Some("starter"));
        assert_eq!(cached[0].git, harness.git);
        assert_eq!(cached[0].inventory, harness.inventory);
        assert_eq!(
            cached[1].template, None,
            "only a harness row has a template"
        );
        assert_eq!(cached[1].git, None, "not a repository is null, not a guess");
        assert_eq!(cached[1].harness_path.as_deref(), Some("/work/Harness"));
        assert_eq!(cached[1].last_seen_at, "2026-10-28T10:00:00.000Z");
    }

    #[test]
    fn a_rescan_overwrites_what_it_saw_and_forgetting_matches_paths_ignoring_case() {
        let dirs = TestDirs::new();
        let mut store = Store::open(&dirs.data).unwrap();
        let alpha = project("/work/Alpha", ProjectKind::Folder);
        let beta = project("/work/beta", ProjectKind::Folder);
        cache_projects(store.connection_mut(), &[alpha.clone(), beta], &[], "t1").unwrap();
        let mut renamed = alpha.clone();
        renamed.name = "alpha renamed".into();
        cache_projects(store.connection_mut(), &[renamed], &[], "t2").unwrap();

        let cached = read_cached_projects(store.connection()).unwrap();
        assert_eq!(cached[0].name, "alpha renamed");
        assert_eq!(cached[0].last_seen_at, "t2");
        assert_eq!(
            cached[1].last_seen_at, "t1",
            "a row the scan did not see stays"
        );

        assert_eq!(
            forget_projects(store.connection_mut(), &["/WORK/ALPHA".into()]).unwrap(),
            1
        );
        assert_eq!(forget_projects(store.connection_mut(), &[]).unwrap(), 0);
        let left = read_cached_projects(store.connection()).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].path, "/work/beta");
    }

    #[test]
    fn a_folder_a_scan_found_is_known_as_its_project_in_any_case_and_another_is_not() {
        let dirs = TestDirs::new();
        let mut store = Store::open(&dirs.data).unwrap();
        let alpha = project("/work/My Projects/Alpha", ProjectKind::Repo);
        cache_projects(store.connection_mut(), &[alpha], &[], "t1").unwrap();

        assert_eq!(
            known_project(store.connection(), "/work/my projects/alpha").unwrap(),
            Some("/work/My Projects/Alpha".to_owned())
        );
        assert_eq!(
            known_project(store.connection(), "/work/My Projects/Alpha/src").unwrap(),
            None,
            "a folder inside a project is not that project"
        );
        assert_eq!(
            known_project(store.connection(), "/elsewhere").unwrap(),
            None
        );
    }

    #[test]
    fn a_row_with_an_unreadable_inventory_counts_as_empty() {
        let dirs = TestDirs::new();
        let store = Store::open(&dirs.data).unwrap();
        store
            .connection()
            .execute(
                "INSERT INTO projects (path, name, kind, inventory, git) VALUES ('/p', 'p', 'folder', 'nope', 'null')",
                [],
            )
            .unwrap();
        let cached = read_cached_projects(store.connection()).unwrap();
        assert_eq!(cached[0].inventory, EMPTY_INVENTORY);
        assert_eq!(cached[0].git, None);
        assert!(!cached[0].has_claude_dir);
    }
}
