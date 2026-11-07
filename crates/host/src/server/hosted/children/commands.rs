//! Command children: `floti agent run`, a plain command the caller starts so
//! that the user sees it run.
//!
//! **A plain command on the user's shell.** It runs in the caller's folder
//! through the user's own shell ([`CommandShell`]: PowerShell on Windows, the
//! login shell on macOS and Linux) as a session on the plain backend, as if
//! typed there. Several words are one program and its arguments, quoted for
//! that shell; a single word is the command line itself, so a pipe or a `&&`
//! works.
//!
//! **A child like any other, and no agent.** Its row has the parent's links
//! and the command line, and no role. It gets no agent token and no tools,
//! opens no tab, and counts toward none of the agent limits
//! (`rows::ChildRow::is_command`). It is named as an agent child is, `--name`
//! or its program's file name, made unique among all the caller's children.
//! Only its parent waits on it, reads it, stops it, or hears of its exit, and
//! it ends with its parent, as every child does.
//!
//! **Its own limit.** A parent runs at most `agentCommandsPerParent` command
//! children at once (4 until changed), read afresh from the host's settings on
//! every run and counted from the parent's rows that have a command. No agent
//! limit counts them, and this limit counts no agent, so a parent with every
//! agent slot full can still run a command and a test run never takes a
//! reviewer's slot. A run over it is refused naming the limit and the command
//! children that hold it.
//!
//! **It ends when its command exits,** with the command's exit code and the
//! last lines it printed, which its parent is told with the exit
//! (`news.rs`, `Screen::last_lines`).

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;

use floti_protocol::BackendId;

use super::{CHILD_SIZE, lock, rows, settings, unique_child_name};
use crate::agent::{AgentBackend, Composition, PlainCommandBackend};
use crate::platform::command_shell::{CommandShell, Native};
use crate::platform::folders::UserEnv;
use crate::server::hosted::{Hosted, Plan};
use crate::session::{ParentLink, SessionId, SessionOrigin, TermSize, find_shell};

/// The plain backend's id: what a plain terminal and a command child record.
const PLAIN_BACKEND: &str = "shell";

/// What `floti agent run` asked.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct RunCommand {
    /// The command: a program and its arguments, or one word that is the
    /// whole command line.
    pub words: Vec<String>,
    /// What the child is called; the program's file name when none.
    pub name: Option<String>,
}

/// What a run answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CommandStarted {
    pub name: String,
    /// The command line the shell was given.
    pub command: String,
    pub folder: String,
}

impl Hosted {
    /// Starts `request.words` as a command child of `parent`, in `parent`'s
    /// folder, through the user's shell.
    ///
    /// # Errors
    ///
    /// A sentence naming what was refused. Nothing has started then.
    pub(crate) fn run_command_child(
        &self,
        parent: SessionId,
        request: RunCommand,
    ) -> Result<CommandStarted, String> {
        let line = command_line_of(&request.words, &Native)?;
        // One start at a time, as an agent's is: names are chosen and spent.
        let _starting = lock(&self.children.starting);
        if self.sessions.get(parent).is_none() {
            return Err("Your session has ended, so it runs no more commands.".to_owned());
        }
        let facts =
            rows::parent_facts(&self.ledger.store(), parent).map_err(|err| err.to_string())?;
        let name = {
            let store = self.ledger.store();
            let existing = rows::children_of(&store, parent, facts.conversation_id.as_deref())
                .map_err(|err| err.to_string())?;
            let limit = settings::read(store.connection())
                .map_err(|err| err.to_string())?
                .agent_commands_per_parent;
            let running: Vec<&rows::ChildRow> = existing
                .iter()
                .filter(|child| child.is_command())
                .filter(|child| child.running && self.sessions.get(child.id).is_some())
                .collect();
            command_limit_refusal(limit, &running)?;
            let wanted = request
                .name
                .as_deref()
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map_or_else(|| program_name(&request.words), str::to_owned);
            unique_child_name(&wanted, existing.iter().map(|child| child.name.as_str()))
        };

        let folder = PathBuf::from(&facts.cwd);
        let backend = self.shell_running(&line);
        let launched = self.run(
            Plan {
                backend,
                folder: folder.clone(),
                name: name.clone(),
                prompt: None,
                composition: Composition::default(),
                resume: None,
                origin: SessionOrigin {
                    project_path: self.known_project(&folder.display().to_string()),
                    profile_id: None,
                    permission_mode: None,
                    branch: None,
                    // A shell has no Remote Control to name.
                    remote_control_name: None,
                    parent: Some(ParentLink {
                        session: parent,
                        conversation_id: facts.conversation_id.clone(),
                        name: name.clone(),
                        role: None,
                        command: Some(line.clone()),
                        outlive: false,
                        can_start: false,
                        heavy: false,
                        worktree: false,
                    }),
                },
            },
            TermSize::new(CHILD_SIZE.0, CHILD_SIZE.1),
            None,
        );
        let launched = match launched {
            Ok(launched) => launched,
            Err(reason) => {
                self.launch_failed(
                    &rows::Link {
                        name: name.clone(),
                        parent,
                        conversation: facts.conversation_id.clone(),
                    },
                    &reason,
                );
                return Err(reason);
            }
        };
        self.end_with_gone_parent(parent, false, launched.session.id)
            .map_err(|_| {
                "Your session ended while the command was starting, so the command ended with it."
                    .to_owned()
            })?;
        Ok(CommandStarted {
            name,
            command: line,
            folder: launched.session.cwd,
        })
    }

    /// The plain backend running `line` through the user's shell.
    fn shell_running(&self, line: &str) -> Arc<dyn AgentBackend> {
        let env = UserEnv::from_process();
        let vars: Vec<(OsString, OsString)> = std::env::vars_os().collect();
        let shell = Native.run_line(&env, &|file| find_shell(&vars, file), line);
        Arc::new(PlainCommandBackend::new(
            BackendId::new(PLAIN_BACKEND),
            "Shell",
            shell.program,
            shell.args,
        ))
    }
}

/// Whether `running` command children are as many as a parent may run; the
/// sentence naming the limit and what holds it when they are.
fn command_limit_refusal(limit: u32, running: &[&rows::ChildRow]) -> Result<(), String> {
    if running.len() < limit as usize {
        return Ok(());
    }
    let holders: Vec<String> = running
        .iter()
        .map(|child| {
            format!(
                "{} ({})",
                child.name,
                child.command.as_deref().unwrap_or_default()
            )
        })
        .collect();
    Err(format!(
        "The command-children limit of {limit} per parent holds: you have {} running ({}). \
         Wait for news and run again.",
        running.len(),
        holders.join(", ")
    ))
}

/// The one line the shell runs for `words`: several words quoted for it as a
/// program and its arguments, one word as it is.
///
/// # Errors
///
/// A sentence when there is no command.
fn command_line_of(words: &[String], shell: &impl CommandShell) -> Result<String, String> {
    let line = match words {
        [] => String::new(),
        [only] => only.trim().to_owned(),
        several => shell.command_line(several),
    };
    if line.trim().is_empty() {
        return Err(
            "Give the command to run after --, such as floti agent run --name tests -- pnpm test."
                .to_owned(),
        );
    }
    Ok(line)
}

/// A command's name when none is given: its program's file name, without the
/// folder it is in and the extension it carries (`pnpm` for `C:\x\pnpm.cmd`).
/// The program is the first of several words, or the first word of a single
/// command line.
fn program_name(words: &[String]) -> String {
    let program = match words {
        [only] => only.split_whitespace().next().unwrap_or_default(),
        [first, ..] => first.as_str(),
        [] => "",
    }
    .trim_matches(['\'', '"']);
    let file = program.rsplit(['/', '\\']).next().unwrap_or(program);
    match file.rfind('.') {
        Some(at) if at > 0 => file[..at].to_owned(),
        _ => file.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::command_shell::{linux, windows};

    fn words(list: &[&str]) -> Vec<String> {
        list.iter().map(|word| (*word).to_owned()).collect()
    }

    #[test]
    fn several_words_are_quoted_for_the_shell_and_one_word_is_the_line_itself() {
        assert_eq!(
            command_line_of(&words(&["pnpm", "test"]), &linux::Native).unwrap(),
            "pnpm test"
        );
        assert_eq!(
            command_line_of(&words(&["my script.sh", "a b"]), &linux::Native).unwrap(),
            "'my script.sh' 'a b'"
        );
        assert_eq!(
            command_line_of(&words(&["my script.sh", "a b"]), &windows::Native).unwrap(),
            "& 'my script.sh' 'a b'"
        );
        assert_eq!(
            command_line_of(&words(&["pnpm test && echo done "]), &linux::Native).unwrap(),
            "pnpm test && echo done"
        );
    }

    #[test]
    fn no_command_is_refused_saying_what_to_give() {
        for none in [words(&[]), words(&["   "])] {
            let refused = command_line_of(&none, &linux::Native).unwrap_err();
            assert!(refused.contains("after --"), "{refused}");
        }
    }

    #[test]
    fn a_command_is_named_after_its_programs_file() {
        assert_eq!(program_name(&words(&["pnpm", "test"])), "pnpm");
        assert_eq!(program_name(&words(&["pnpm test"])), "pnpm");
        assert_eq!(program_name(&words(&["pnpm.cmd", "test"])), "pnpm");
        assert_eq!(
            program_name(&words(&["./scripts/build.sh --fast"])),
            "build"
        );
        assert_eq!(
            program_name(&words(&["C:\\tools\\node.exe", "a.js"])),
            "node"
        );
        assert_eq!(
            program_name(&words(&["C:\\Program Files\\x\\tool.exe", "a b"])),
            "tool"
        );
        assert_eq!(program_name(&words(&[".hidden", "run"])), ".hidden");
        assert_eq!(program_name(&words(&["cargo"])), "cargo");
        assert_eq!(program_name(&words(&[])), "");
    }
}
