//! Role files read, listed and seeded: what a file may say, what makes it
//! bad, that every call reads the folder afresh, and what the first start
//! writes.

use std::path::Path;

use floti_protocol::BackendId;
use floti_protocol::channels::common::PermissionMode;
use floti_protocol::channels::sessions::EffortLevel;

use super::folder::{FolderRoles, roles_folder};
use super::parse::parse_role;
use super::seed::{SHIPPED_ROLES, seed_roles};
use super::*;
use crate::agent::PlainCommandBackend;
use crate::testkit::TestDirs;

fn good(name: &str, source: &str) -> Role {
    parse_role(name, source).unwrap_or_else(|problem| panic!("{name} is bad: {problem}"))
}

fn bad(name: &str, source: &str) -> String {
    parse_role(name, source).expect_err("the file is bad")
}

fn write(dir: &Path, file: &str, content: &str) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join(file), content).unwrap();
}

fn ids(role: &Role) -> Vec<&str> {
    role.backends.iter().map(BackendId::as_str).collect()
}

// ---------------------------------------------------------------------------
// A file read
// ---------------------------------------------------------------------------

#[test]
fn a_file_with_every_field_reads_as_that_role_and_its_body_is_the_instructions() {
    let role = good(
        "reviewer",
        "---\n\
         description: Read-only review.\n\
         profile: Acme\n\
         backend: claude-code, other-agent\n\
         model:\n  claude-code: opus\n  other-agent: small\n\
         effort:\n  claude-code: high\n\
         permission: plan\n\
         class: heavy\n\
         worktree: yes\n\
         can_start: true\n\
         allowed_tools: Read, Bash(git log --format=a,b:*)\n\
         disallowed_tools:\n  - Edit\n  - Write\n\
         command: acme\n\
         submit: enter\n\
         stop: ctrl-c\n\
         ---\n\
         \n\
         Read the code first.\n\n\
         Then report.\n",
    );
    assert_eq!(role.name, "reviewer");
    assert_eq!(role.description, "Read-only review.");
    assert_eq!(role.profile.as_deref(), Some("Acme"));
    assert_eq!(ids(&role), ["claude-code", "other-agent"]);
    assert_eq!(role.model_for(&BackendId::claude_code()), Some("opus"));
    assert_eq!(
        role.model_for(&BackendId::new("other-agent")),
        Some("small")
    );
    assert_eq!(
        role.effort_for(&BackendId::claude_code()),
        Some(EffortLevel::High)
    );
    assert_eq!(role.effort_for(&BackendId::new("other-agent")), None);
    assert_eq!(role.permission, Some(PermissionMode::Plan));
    assert_eq!(role.class, RoleClass::Heavy);
    assert!(role.worktree && role.can_start);
    // A comma inside parentheses belongs to the rule.
    assert_eq!(role.allowed_tools, ["Read", "Bash(git log --format=a,b:*)"]);
    assert_eq!(role.disallowed_tools, ["Edit", "Write"]);
    // Accepted and kept, doing nothing here.
    assert_eq!(role.command.as_deref(), Some("acme"));
    assert_eq!(role.submit.as_deref(), Some("enter"));
    assert_eq!(role.stop.as_deref(), Some("ctrl-c"));
    assert_eq!(role.instructions, "Read the code first.\n\nThen report.");
}

#[test]
fn a_file_with_no_fields_is_a_role_with_the_defaults() {
    let role = good("plain", "---\n---\nJust do it.\n");
    assert!(role.backends.is_empty(), "every installed agent backend");
    assert_eq!(role.class, RoleClass::Light);
    assert!(!role.worktree && !role.can_start);
    assert_eq!(role.permission, None);
    assert_eq!(role.instructions, "Just do it.");

    let empty = good("empty", "---\ndescription: Nothing else.\n---\n");
    assert_eq!(empty.instructions, "");
}

#[test]
fn backends_are_one_a_comma_list_or_a_yaml_list_and_an_id_that_is_not_installed_is_valid() {
    assert_eq!(
        ids(&good("a", "---\nbackend: claude-code\n---\n")),
        ["claude-code"]
    );
    assert_eq!(
        ids(&good("b", "---\nbackend: codex, claude-code\n---\n")),
        ["codex", "claude-code"]
    );
    assert_eq!(
        ids(&good(
            "c",
            "---\nbackend:\n  - Other-Agent\n  - codex\n---\n"
        )),
        ["other-agent", "codex"]
    );
}

#[test]
fn permission_is_written_with_hyphens_spaces_or_camel_case() {
    for (written, mode) in [
        ("plan", PermissionMode::Plan),
        ("dont-ask", PermissionMode::DontAsk),
        ("dontAsk", PermissionMode::DontAsk),
        ("manual", PermissionMode::Manual),
        ("accept-edits", PermissionMode::AcceptEdits),
        ("accept edits", PermissionMode::AcceptEdits),
        ("acceptEdits", PermissionMode::AcceptEdits),
        ("auto", PermissionMode::Auto),
        ("bypass-permissions", PermissionMode::BypassPermissions),
        ("bypassPermissions", PermissionMode::BypassPermissions),
    ] {
        let role = good("p", &format!("---\npermission: {written}\n---\n"));
        assert_eq!(role.permission, Some(mode), "{written}");
    }
}

#[test]
fn flags_are_yes_no_true_or_false() {
    for (written, expected) in [
        ("yes", true),
        ("no", false),
        ("true", true),
        ("false", false),
    ] {
        let role = good(
            "f",
            &format!("---\nworktree: {written}\ncan_start: {written}\n---\n"),
        );
        assert_eq!(
            (role.worktree, role.can_start),
            (expected, expected),
            "{written}"
        );
    }
}

#[test]
fn a_file_that_is_not_exactly_a_role_is_bad_and_says_what_is_wrong() {
    // No front matter at all.
    assert!(bad("a", "Just some text.\n").contains("no front matter"));
    // A front matter that never ends.
    assert!(bad("a", "---\ndescription: x\n").contains("front matter"));
    // A front matter that does not parse.
    assert!(bad("a", "---\ndescription: [unclosed\n---\n").contains("does not parse"));
    // A key no role has: a typo must never quietly drop a rule.
    let typo = bad("a", "---\ndisalowed_tools: Edit\n---\n");
    assert!(typo.contains("disalowed_tools"), "{typo}");
    assert!(
        typo.contains("disallowed_tools"),
        "the fields are listed: {typo}"
    );
    // A value outside its field's choices.
    let effort = bad("a", "---\neffort:\n  claude-code: loud\n---\n");
    assert!(effort.contains("effort for claude-code"), "{effort}");
    let permission = bad("a", "---\npermission: always\n---\n");
    assert!(permission.contains("permission must be"), "{permission}");
    assert!(bad("a", "---\nclass: medium\n---\n").contains("class must be light or heavy"));
    assert!(bad("a", "---\nworktree: maybe\n---\n").contains("worktree must be"));
    assert!(bad("a", "---\nmodel: opus\n---\n").contains("model is a map"));
    assert!(bad("a", "---\nbackend: \"\"\n---\n").contains("backend"));
    // Every problem is named, not only the first.
    let two = bad("a", "---\nclass: x\npermission: y\n---\n");
    assert!(two.contains("class") && two.contains("permission"), "{two}");
}

// ---------------------------------------------------------------------------
// The folder, read afresh
// ---------------------------------------------------------------------------

#[test]
fn the_roles_folder_is_roles_in_the_config_folder() {
    let dirs = TestDirs::new();
    assert_eq!(roles_folder(&dirs.folders()), dirs.config.join("roles"));
}

#[test]
fn a_listing_has_the_good_roles_by_name_then_each_bad_file_with_its_problem() {
    let dirs = TestDirs::new();
    let dir = dirs.config.join("roles");
    write(&dir, "zeta.md", "---\ndescription: Last.\n---\nz\n");
    write(&dir, "alpha.md", "---\ndescription: First.\n---\na\n");
    write(
        &dir,
        "broken.md",
        "---\neffort:\n  claude-code: loud\n---\n",
    );
    write(&dir, "no-front.md", "nothing\n");
    // Not role files: other extensions, other names and folders.
    write(&dir, "notes.txt", "---\n---\n");
    write(&dir, "Upper Case.md", "---\n---\n");
    write(&dir, "Shouting.md", "---\n---\n");
    std::fs::create_dir_all(dir.join("folder.md")).unwrap();

    let listing = FolderRoles::new(&dir).listing();
    let names: Vec<&str> = listing
        .roles
        .iter()
        .map(|role| role.name.as_str())
        .collect();
    assert_eq!(names, ["alpha", "zeta"]);
    let files: Vec<&str> = listing.bad.iter().map(|bad| bad.file.as_str()).collect();
    assert_eq!(files, ["broken.md", "no-front.md"]);
    assert!(listing.bad[0].problem.contains("effort for claude-code"));
    assert!(listing.bad[1].problem.contains("no front matter"));
}

#[test]
fn no_folder_is_no_roles() {
    let dirs = TestDirs::new();
    let roles = FolderRoles::new(dirs.config.join("roles"));
    assert_eq!(roles.listing(), RoleListing::default());
    assert_eq!(roles.lookup("reviewer"), RoleLookup::Missing);
}

#[test]
fn every_call_reads_the_folder_afresh_so_an_edit_an_add_and_a_delete_show_at_once() {
    let dirs = TestDirs::new();
    let dir = dirs.config.join("roles");
    let roles = FolderRoles::new(&dir);

    write(&dir, "scout.md", "---\ndescription: One.\n---\nfirst\n");
    let RoleLookup::Found(first) = roles.lookup("scout") else {
        panic!("scout is a role");
    };
    assert_eq!(
        (first.description.as_str(), first.instructions.as_str()),
        ("One.", "first")
    );

    // Edited: the next call has the new text.
    write(
        &dir,
        "scout.md",
        "---\ndescription: Two.\nworktree: yes\n---\nsecond\n",
    );
    let RoleLookup::Found(second) = roles.lookup("scout") else {
        panic!("scout is still a role");
    };
    assert_eq!(second.description, "Two.");
    assert_eq!(second.instructions, "second");
    assert!(second.worktree);

    // Broken: the lookup says why, naming the file.
    write(&dir, "scout.md", "---\nclass: medium\n---\n");
    let RoleLookup::Bad(broken) = roles.lookup("scout") else {
        panic!("scout is bad now");
    };
    assert_eq!(broken.file, "scout.md");
    assert!(broken.problem.contains("class must be light or heavy"));
    assert!(roles.listing().roles.is_empty());

    // Added and deleted.
    write(&dir, "new-one.md", "---\n---\nbody\n");
    assert_eq!(roles.listing().roles.len(), 1);
    std::fs::remove_file(dir.join("scout.md")).unwrap();
    std::fs::remove_file(dir.join("new-one.md")).unwrap();
    assert_eq!(roles.lookup("scout"), RoleLookup::Missing);
    assert_eq!(roles.listing(), RoleListing::default());
}

#[test]
fn a_lookup_ignores_the_case_of_the_name_and_a_name_that_cannot_be_a_role_is_missing() {
    let dirs = TestDirs::new();
    let dir = dirs.config.join("roles");
    write(&dir, "reviewer.md", "---\n---\nx\n");
    let roles = FolderRoles::new(&dir);
    assert!(matches!(roles.lookup("Reviewer"), RoleLookup::Found(_)));
    assert_eq!(roles.lookup("../reviewer"), RoleLookup::Missing);
    assert_eq!(roles.lookup("re viewer"), RoleLookup::Missing);
    assert_eq!(roles.lookup(""), RoleLookup::Missing);
}

#[test]
fn an_agent_md_is_the_default_role() {
    let dirs = TestDirs::new();
    let dir = dirs.config.join("roles");
    write(
        &dir,
        "agent.md",
        "---\npermission: plan\n---\nBe careful.\n",
    );
    let RoleLookup::Found(role) = FolderRoles::new(&dir).lookup(DEFAULT_ROLE) else {
        panic!("agent.md is a role");
    };
    assert_eq!(role.name, "agent");
    assert_eq!(role.permission, Some(PermissionMode::Plan));
}

// ---------------------------------------------------------------------------
// What a role asks of the host
// ---------------------------------------------------------------------------

fn plain_command() -> std::sync::Arc<dyn AgentBackend> {
    std::sync::Arc::new(PlainCommandBackend::new(
        BackendId::new("my-cli"),
        "My CLI",
        "my-cli",
        Vec::<&str>::new(),
    ))
}

#[test]
fn a_plain_command_line_runs_no_role_and_a_role_that_lists_no_backend_never_picks_one() {
    let host = vec![plain_command()];
    assert!(Role::new("any", []).backends_on(&host).is_empty());
    assert!(default_role(&host).backends.is_empty());
    // Even when it is named, a plain command line takes no task.
    let named = Role::new("named", [BackendId::new("my-cli")]);
    assert_eq!(named.backends_on(&host).len(), 1);
    let refusal = named.refusal_on(host[0].as_ref(), None).expect("a refusal");
    assert!(
        refusal.contains("my-cli") && refusal.contains("plain command line"),
        "{refusal}"
    );
}

#[test]
fn a_role_that_names_a_backend_the_host_does_not_have_runs_on_none() {
    let host = vec![plain_command()];
    let codex = Role::new("codex-only", [BackendId::new("codex")]);
    assert!(codex.backends_on(&host).is_empty());
}

// ---------------------------------------------------------------------------
// What the first start writes
// ---------------------------------------------------------------------------

#[test]
fn an_absent_folder_gets_the_three_shipped_roles_and_each_reads_as_a_good_role() {
    let dirs = TestDirs::new();
    let dir = dirs.config.join("roles");
    let seeded = seed_roles(&dir);
    assert!(seeded.seeded && seeded.problem.is_none(), "{seeded:?}");
    assert_eq!(seeded.created, ["lead.md", "reviewer.md", "worker.md"]);

    let listing = FolderRoles::new(&dir).listing();
    assert!(listing.bad.is_empty(), "{:?}", listing.bad);
    let names: Vec<&str> = listing
        .roles
        .iter()
        .map(|role| role.name.as_str())
        .collect();
    assert_eq!(names, ["lead", "reviewer", "worker"]);
}

#[test]
fn a_folder_that_is_there_is_never_written_to_whatever_it_holds() {
    let dirs = TestDirs::new();

    // Empty stays empty.
    let empty = dirs.config.join("empty roles");
    std::fs::create_dir_all(&empty).unwrap();
    let seeded = seed_roles(&empty);
    assert!(!seeded.seeded && seeded.created.is_empty());
    assert_eq!(std::fs::read_dir(&empty).unwrap().count(), 0);

    // An edited file is not rewritten, and one the user deleted stays deleted.
    let dir = dirs.config.join("roles");
    seed_roles(&dir);
    let edited = "---\ndescription: Mine.\n---\nMy own words.\n";
    std::fs::write(dir.join("worker.md"), edited).unwrap();
    std::fs::remove_file(dir.join("lead.md")).unwrap();
    let again = seed_roles(&dir);
    assert!(!again.seeded && again.created.is_empty());
    assert_eq!(
        std::fs::read_to_string(dir.join("worker.md")).unwrap(),
        edited
    );
    assert!(!dir.join("lead.md").exists());
    assert!(dir.join("reviewer.md").exists());

    // Deleting the folder brings the originals back at the next start.
    std::fs::remove_dir_all(&dir).unwrap();
    assert!(seed_roles(&dir).seeded);
    assert!(dir.join("lead.md").exists());
}

#[test]
fn a_folder_that_cannot_be_made_is_a_problem_to_log_and_not_a_panic() {
    let dirs = TestDirs::new();
    // A file where the config folder's parent should be.
    let blocker = dirs.config.join("blocker");
    std::fs::write(&blocker, "a file").unwrap();
    let seeded = seed_roles(&blocker.join("roles"));
    assert!(!seeded.seeded);
    assert!(
        seeded
            .problem
            .as_deref()
            .is_some_and(|problem| problem.contains("roles folder")),
        "{seeded:?}"
    );
}

// ---------------------------------------------------------------------------
// What the shipped roles are
// ---------------------------------------------------------------------------

fn shipped(name: &str) -> Role {
    let (_, source) = SHIPPED_ROLES
        .iter()
        .find(|(file, _)| *file == format!("{name}.md"))
        .expect("a shipped role");
    good(name, source)
}

#[test]
fn the_reviewer_reads_and_reports_without_editing() {
    let role = shipped("reviewer");
    assert_eq!(role.permission, Some(PermissionMode::Plan));
    assert!(!role.can_start && !role.worktree);
    assert_eq!(role.class, RoleClass::Light);
    assert_eq!(role.disallowed_tools, ["Edit", "Write", "NotebookEdit"]);
    assert_eq!(role.model_for(&BackendId::claude_code()), Some("opus"));
    assert_eq!(
        role.effort_for(&BackendId::claude_code()),
        Some(EffortLevel::High)
    );
    assert!(!role.instructions.is_empty());
}

#[test]
fn the_worker_edits_in_a_worktree_of_its_own_and_cannot_start_agents_or_create_items() {
    let role = shipped("worker");
    assert_eq!(role.permission, Some(PermissionMode::AcceptEdits));
    assert!(role.worktree && !role.can_start);
    assert_eq!(role.class, RoleClass::Light);
    assert_eq!(role.disallowed_tools, ["mcp__helm-plugin-trackr__create"]);
    for rule in [
        "Touch only your own item",
        "Also fixed:",
        "Found:",
        "Blocked",
    ] {
        assert!(role.instructions.contains(rule), "{rule}");
    }
}

#[test]
fn the_lead_starts_agents_does_not_edit_and_keeps_trackr_in_a_voice() {
    let role = shipped("lead");
    assert!(role.can_start && !role.worktree);
    assert_eq!(role.class, RoleClass::Light);
    assert_eq!(role.permission, None);
    assert_eq!(role.disallowed_tools, ["Edit", "Write", "NotebookEdit"]);
    for section in ["## Keeping Trackr", "## Voice"] {
        assert!(role.instructions.contains(section), "{section}");
    }
    assert!(role.instructions.contains("robotic and then right"));
}

#[test]
fn the_shipped_roles_name_no_product_no_path_no_handle_and_only_made_up_item_ids() {
    for (file, source) in SHIPPED_ROLES {
        // Nothing that ties them to one machine, person or product: no
        // product of this repository, no agent but the one they run on, no
        // path, address or handle.
        for word in [
            "Helm", "Floti", "codex", "C:\\", "/Users/", "/home/", "http:", "https:", "@",
        ] {
            assert!(!source.contains(word), "{file} names {word}");
        }
        // An item id looks like ABC-12, and every one here is made up.
        for token in source.split(|c: char| !(c.is_ascii_alphanumeric() || c == '-')) {
            let looks_like_an_id = token.split_once('-').is_some_and(|(letters, digits)| {
                letters.len() >= 2
                    && letters.chars().all(|c| c.is_ascii_uppercase())
                    && !digits.is_empty()
                    && digits.chars().all(|c| c.is_ascii_digit())
            });
            assert!(
                !looks_like_an_id || token.starts_with("ABC-"),
                "{file}: {token}"
            );
        }
    }
}
