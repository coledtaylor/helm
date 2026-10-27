//! Reading a harness project, in either shape a harness is written in.
//!
//! Claude's shape is `CLAUDE.md` and `.claude/` (`skills`, `commands`,
//! `agents`, `workflows`); the shared one is `AGENTS.md` and
//! `.agents/skills`. Floti reads both, and each backend lays out what it
//! found the way its agent reads it. Skills are the same `SKILL.md` folders in
//! every agent under the Agent Skills standard; where one name is a skill in
//! both shapes, the one in `.claude/skills` is used and the launch says so.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use floti_protocol::HarnessPart;

/// What one harness project holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarnessProject {
    pub path: PathBuf,
    pub claude_md: Option<PathBuf>,
    pub agents_md: Option<PathBuf>,
    pub skills: Skills,
    /// `.claude/commands`.
    pub commands: Option<PathBuf>,
    /// `.claude/agents`.
    pub subagents: Option<PathBuf>,
    /// `.claude/workflows`.
    pub workflows: Option<PathBuf>,
    /// Skill names in both `.claude/skills` and `.agents/skills`; the one in
    /// `.claude/skills` is used.
    pub shadowed_skills: Vec<String>,
}

/// Where a project's skills come from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Skills {
    None,
    /// One skills folder, linked as it is.
    Folder(PathBuf),
    /// Skills from both shapes, each skill folder by its name.
    Each(BTreeMap<String, PathBuf>),
}

impl HarnessProject {
    /// Reads the project at `path`. A part that is not there is `None`.
    pub fn read(path: &Path) -> Self {
        let path = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
        let file = |name: &str| Some(path.join(name)).filter(|file| file.is_file());
        let dir = |parts: &[&str]| {
            let dir = parts.iter().fold(path.clone(), |dir, part| dir.join(part));
            dir.is_dir().then_some(dir)
        };
        let claude_skills = dir(&[".claude", "skills"]);
        let shared_skills = dir(&[".agents", "skills"]);
        let (skills, shadowed_skills) = match (claude_skills, shared_skills) {
            (None, None) => (Skills::None, Vec::new()),
            (Some(only), None) | (None, Some(only)) => (Skills::Folder(only), Vec::new()),
            (Some(claude), Some(shared)) => {
                let mut each = skill_folders(&shared);
                let mut shadowed = Vec::new();
                for (name, folder) in skill_folders(&claude) {
                    if each.insert(name.clone(), folder).is_some() {
                        shadowed.push(name);
                    }
                }
                (Skills::Each(each), shadowed)
            }
        };
        Self {
            claude_md: file("CLAUDE.md"),
            agents_md: file("AGENTS.md"),
            skills,
            commands: dir(&[".claude", "commands"]),
            subagents: dir(&[".claude", "agents"]),
            workflows: dir(&[".claude", "workflows"]),
            shadowed_skills,
            path,
        }
    }

    /// The parts this project holds.
    pub fn parts(&self) -> Vec<HarnessPart> {
        [
            (
                HarnessPart::Instructions,
                self.claude_md.is_some() || self.agents_md.is_some(),
            ),
            (HarnessPart::Skills, self.skills != Skills::None),
            (HarnessPart::Commands, self.commands.is_some()),
            (HarnessPart::Subagents, self.subagents.is_some()),
            (HarnessPart::Workflows, self.workflows.is_some()),
        ]
        .into_iter()
        .filter_map(|(part, held)| held.then_some(part))
        .collect()
    }

    /// Its instruction files, `CLAUDE.md` first.
    pub fn instruction_files(&self) -> impl Iterator<Item = &PathBuf> {
        self.claude_md.iter().chain(&self.agents_md)
    }
}

/// Each skill folder directly in `skills`, by name.
fn skill_folders(skills: &Path) -> BTreeMap<String, PathBuf> {
    let Ok(entries) = std::fs::read_dir(skills) else {
        return BTreeMap::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| Some((entry.file_name().into_string().ok()?, entry.path())))
        .collect()
}

/// Whether `dir` is `path` or a folder above it: whether an agent started in
/// `path` walks through `dir` looking for instruction files. By whole
/// components, so `repos/acme` is no ancestor of `repos/acme-ui`.
pub fn is_same_or_ancestor(dir: &Path, path: &Path) -> bool {
    let normal = |path: &Path| {
        std::fs::canonicalize(path)
            .or_else(|_| std::path::absolute(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };
    normal(path).starts_with(normal(dir))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::testkit::TestDirs;

    fn skill(root: &Path, shape: &str, name: &str, text: &str) {
        let folder = root.join(shape).join("skills").join(name);
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("SKILL.md"), text).unwrap();
    }

    #[test]
    fn reads_a_harness_in_claudes_shape() {
        let dirs = TestDirs::new();
        let root = dirs.folder("harness");
        fs::write(root.join("CLAUDE.md"), "claude").unwrap();
        skill(&root, ".claude", "think", "think");
        for part in ["commands", "agents", "workflows"] {
            fs::create_dir_all(root.join(".claude").join(part)).unwrap();
        }

        let project = HarnessProject::read(&root);
        assert_eq!(project.claude_md, Some(root.join("CLAUDE.md")));
        assert_eq!(project.agents_md, None);
        assert_eq!(
            project.skills,
            Skills::Folder(root.join(".claude").join("skills"))
        );
        assert_eq!(project.parts(), HarnessPart::ALL.to_vec());
    }

    #[test]
    fn reads_a_harness_in_the_shared_shape() {
        let dirs = TestDirs::new();
        let root = dirs.folder("harness");
        fs::write(root.join("AGENTS.md"), "agents").unwrap();
        skill(&root, ".agents", "plan", "plan");

        let project = HarnessProject::read(&root);
        assert_eq!(project.agents_md, Some(root.join("AGENTS.md")));
        assert_eq!(
            project.skills,
            Skills::Folder(root.join(".agents").join("skills"))
        );
        assert_eq!(
            project.parts(),
            vec![HarnessPart::Instructions, HarnessPart::Skills]
        );
    }

    #[test]
    fn with_both_shapes_each_skill_is_taken_once_and_claudes_wins() {
        let dirs = TestDirs::new();
        let root = dirs.folder("harness");
        skill(&root, ".claude", "think", "claude's think");
        skill(&root, ".agents", "think", "shared think");
        skill(&root, ".agents", "plan", "plan");

        let project = HarnessProject::read(&root);
        let Skills::Each(each) = &project.skills else {
            panic!("expected each skill by name: {:?}", project.skills);
        };
        assert_eq!(
            each.get("think"),
            Some(&root.join(".claude").join("skills").join("think"))
        );
        assert_eq!(
            each.get("plan"),
            Some(&root.join(".agents").join("skills").join("plan"))
        );
        assert_eq!(project.shadowed_skills, vec!["think".to_owned()]);
    }

    #[test]
    fn an_ancestor_is_judged_by_whole_folders() {
        let dirs = TestDirs::new();
        let acme = dirs.folder("repos/acme");
        let inside = dirs.folder("repos/acme/sub dir");
        let sibling = dirs.folder("repos/acme-ui");
        assert!(is_same_or_ancestor(&acme, &acme));
        assert!(is_same_or_ancestor(&acme, &inside));
        assert!(!is_same_or_ancestor(&acme, &sibling));
        assert!(!is_same_or_ancestor(&inside, &acme));
    }
}
