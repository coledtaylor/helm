use std::fs;

use super::*;
use crate::testkit::TestDirs;

#[test]
fn a_folder_link_shows_the_target_and_unlinking_leaves_it() {
    let dirs = TestDirs::new();
    let target = dirs.folder("a repo/.claude/skills");
    fs::write(target.join("SKILL.md"), "skill").unwrap();
    let link = dirs.folder("overlay").join("skills");

    Native.link_folder(&target, &link).unwrap();
    assert!(is_link(&link));
    assert_eq!(fs::read_to_string(link.join("SKILL.md")).unwrap(), "skill");

    Native.unlink_folder(&link).unwrap();
    assert!(!link.exists());
    assert_eq!(
        fs::read_to_string(target.join("SKILL.md")).unwrap(),
        "skill"
    );
}

#[test]
fn removing_a_tree_unlinks_its_links_and_never_walks_into_them() {
    let dirs = TestDirs::new();
    let repo = dirs.folder("a repo");
    let skills = repo.join(".claude").join("skills");
    fs::create_dir_all(skills.join("think")).unwrap();
    fs::write(skills.join("think").join("SKILL.md"), "think").unwrap();

    let overlay = dirs.folder("launch/overlays/repo");
    fs::create_dir_all(overlay.join(".claude-plugin")).unwrap();
    fs::write(overlay.join(".claude-plugin").join("plugin.json"), "{}").unwrap();
    Native
        .link_folder(&skills, &overlay.join("skills"))
        .unwrap();
    // A link one level down, as a skills folder made of per-skill links is.
    let nested = overlay.join("agents");
    fs::create_dir_all(&nested).unwrap();
    Native
        .link_folder(&skills.join("think"), &nested.join("think"))
        .unwrap();

    remove_tree(&Native, &dirs.root().join("launch")).unwrap();

    assert!(!dirs.root().join("launch").exists());
    assert_eq!(
        fs::read_to_string(skills.join("think").join("SKILL.md")).unwrap(),
        "think",
        "nothing inside the repository is touched"
    );
}

#[test]
fn removing_a_tree_that_is_not_there_is_done() {
    let dirs = TestDirs::new();
    remove_tree(&Native, &dirs.root().join("never made")).unwrap();
}
