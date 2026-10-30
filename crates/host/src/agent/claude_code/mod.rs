//! Claude Code, the first agent backend, matching today's app for launch,
//! overlays, resume, status, agent tools, permissions, transcripts, usage,
//! config files and sign-in.
//!
//! Everything here reads Claude Code's own records and writes nothing into
//! its config folder: a launch's agent tool registration, settings file,
//! composed instructions and overlays go in the launch's own folder under
//! Floti's data folder. The credential files (`.credentials.json` and every
//! `sessions/<pid>.<hash>.key`) are named in [`AgentBackend::credential_paths`]
//! and never opened.

mod argv;
mod config;
mod history;
mod overlay;
mod prompts;
mod sign_in;
mod status;
mod time;
mod title;
mod usage;

#[cfg(test)]
mod tests;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, PoisonError, RwLock};

use floti_protocol::channels::common::PermissionMode;
use floti_protocol::channels::sessions::{SessionActivity, UsageSnapshot};
use floti_protocol::channels::workspace::ConfigFile;
use floti_protocol::{BackendId, HarnessPart, HarnessSupport, Knowable};

use super::{
    AgentBackend, AgentToolServer, AgentTools, Composition, ConfigSource, Conversation,
    ExecutableSetup, HistorySource, Launch, LaunchFolder, LaunchRequest, LaunchSpec, Permissions,
    PromptRecord, PromptTail, Registration, ResumeRequest, Resumer, SessionRef, SignIn,
    SignInCheck, StatusSource, TestedVersions, Transcript, UsageSource, Version, VersionCheck,
};
use crate::platform::folders::UserEnv;
use crate::platform::launcher::{self, Program, ProgramLauncher};
use crate::platform::process_tree::ProcessTree;
use crate::{Error, Result};

pub use argv::{sanitize_session_name, unique_session_name};
pub use overlay::{overlay_plugin_name, overlay_plugin_names};
pub(crate) use time::parse_instant;
pub use title::{SessionTitle, session_title_from};
pub use usage::{PRICE_TABLE_DATE, UsageBucket, UsageView, usage_view};

/// The versions this backend was tested against: from 2.1.277, the first to
/// read `AGENTS.md` through `instructionFiles`, up to but not including 2.2.0.
pub const TESTED_VERSIONS: TestedVersions = TestedVersions {
    min: Version(2, 1, 277),
    below: Version(2, 2, 0),
};

/// The settings every launch passes with `--settings`, so a harness and a
/// repository written in different shapes both reach the session: Claude Code
/// then loads `CLAUDE.md` and `AGENTS.md` together, each once.
pub const LAUNCH_SETTINGS: &str = r#"{"instructionFiles":"claude-md-and-agents-md"}"#;

/// Where Claude Code is and where it keeps its records.
#[derive(Debug, Clone)]
pub struct ClaudeCodeSettings {
    /// `claude`, by path or by name on `PATH`.
    pub program: OsString,
    /// Arguments before every launch's own, such as a script for a program
    /// that is an interpreter.
    pub leading_args: Vec<OsString>,
    /// Its config folder: `CLAUDE_CONFIG_DIR`, or `~/.claude`.
    pub config_dir: PathBuf,
    /// Pass `CLAUDE_CONFIG_DIR` to every session, for a config folder that is
    /// not the one the CLI would find on its own.
    pub pass_config_dir: bool,
    /// Whether `ANTHROPIC_API_KEY` is set for the host. Only whether: the
    /// value is never read.
    pub api_key_set: bool,
    /// Folders `program`, when it is a bare name, is looked for in before
    /// `PATH`: the user's program folders a host started at sign-in may not
    /// have on its `PATH`, where the native installer puts `claude`.
    pub search_first: Vec<PathBuf>,
}

impl ClaudeCodeSettings {
    /// `claude` in the user's program folders or on `PATH`, with the config
    /// folder the user's environment gives it. `None` without a home folder
    /// to find it in.
    pub fn from_env(env: &UserEnv) -> Option<Self> {
        let home = env.home.as_ref()?;
        let (config_dir, pass) = match env.absolute_var("CLAUDE_CONFIG_DIR") {
            Some(dir) => (dir, true),
            None => (home.join(".claude"), false),
        };
        Some(Self {
            program: "claude".into(),
            leading_args: Vec::new(),
            config_dir,
            pass_config_dir: pass,
            api_key_set: env
                .var("ANTHROPIC_API_KEY")
                .is_some_and(|value| !value.is_empty()),
            search_first: launcher::Native.user_bin_folders(home),
        })
    }
}

/// The Claude Code backend.
pub struct ClaudeCodeBackend {
    id: BackendId,
    settings: ClaudeCodeSettings,
    tree: Arc<dyn ProcessTree + Send + Sync>,
    /// The executable the user chose in setup, run in place of the one
    /// `settings` name, with no leading arguments.
    chosen: RwLock<Option<PathBuf>>,
    /// The version check of whichever executable launches now, asked once
    /// per executable.
    version: Mutex<Option<VersionCheck>>,
}

impl ClaudeCodeBackend {
    /// Claude Code as `settings` describe it, asking `tree` whether the
    /// processes its records name are still running.
    pub fn new(settings: ClaudeCodeSettings, tree: Arc<dyn ProcessTree + Send + Sync>) -> Self {
        Self {
            id: BackendId::claude_code(),
            settings,
            tree,
            chosen: RwLock::new(None),
            version: Mutex::new(None),
        }
    }

    pub fn settings(&self) -> &ClaudeCodeSettings {
        &self.settings
    }

    /// The installed version against [`TESTED_VERSIONS`], asked once for
    /// each executable launched.
    pub fn version_check(&self) -> VersionCheck {
        let mut cached = self.version.lock().unwrap_or_else(PoisonError::into_inner);
        cached
            .get_or_insert_with(|| {
                let (program, leading) = self.command();
                match self.version_output(&program, &leading) {
                    Some(output) => TESTED_VERSIONS.check(&output),
                    None => VersionCheck::Unknown,
                }
            })
            .clone()
    }

    /// What `program`, with `leading` before it, prints for `--version`, or
    /// `None` when it would not run.
    fn version_output(&self, program: &OsString, leading: &[OsString]) -> Option<String> {
        let args: Vec<OsString> = leading
            .iter()
            .cloned()
            .chain(["--version".into()])
            .collect();
        let program = launcher::Native.resolve(program, &args);
        let output = Command::new(&program.program)
            .args(&program.args)
            .envs(self.session_env())
            .envs(program.env)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
            .filter(|text| !text.is_empty())
    }

    /// The executable launched now and the arguments before every launch's
    /// own: the one the user chose, alone, or the one `settings` name.
    fn command(&self) -> (OsString, Vec<OsString>) {
        match &*self.chosen.read().unwrap_or_else(PoisonError::into_inner) {
            Some(chosen) => (chosen.clone().into_os_string(), Vec::new()),
            None => (
                self.settings.program.clone(),
                self.settings.leading_args.clone(),
            ),
        }
    }

    /// `claude` with `args` after its leading ones, as the OS has to start
    /// it: a batch-file install on Windows goes through `cmd.exe`.
    fn program(&self, args: Vec<OsString>) -> Program {
        let (program, leading) = self.command();
        let args: Vec<OsString> = leading.into_iter().chain(args).collect();
        launcher::Native.resolve(&program, &args)
    }

    fn session_env(&self) -> Vec<(OsString, OsString)> {
        if self.settings.pass_config_dir {
            vec![(
                "CLAUDE_CONFIG_DIR".into(),
                self.settings.config_dir.clone().into_os_string(),
            )]
        } else {
            Vec::new()
        }
    }

    fn sessions_dir(&self) -> PathBuf {
        self.settings.config_dir.join("sessions")
    }

    /// Composes one launch, new or resumed.
    fn compose(&self, launch: Composed<'_>, folder: &LaunchFolder) -> Result<Launch> {
        let Composed {
            cwd,
            name,
            prompt,
            resume,
            composition,
        } = launch;
        let mut warnings = Vec::new();
        if let VersionCheck::Untested { warning, .. } = self.version_check() {
            warnings.push(warning);
        }

        let overlays: Vec<PathBuf> = existing(&composition.overlays, |path| {
            warnings.push(format!(
                "Overlay skipped - {} is not there any more.",
                path.display()
            ));
        });
        let built = overlay::build_overlays(&overlays, folder, &mut warnings)?;

        let instructions = overlay::compose_instructions(&built, cwd);
        let instructions_file = match &instructions {
            Some(text) => Some(folder.write("instructions.md", text)?),
            None => {
                let none_had_any = built
                    .iter()
                    .all(|overlay| overlay.project.instruction_files().next().is_none());
                if !built.is_empty() && none_had_any {
                    warnings.push(
                        "No overlay had a CLAUDE.md or AGENTS.md, so no project instructions were composed."
                            .to_owned(),
                    );
                }
                None
            }
        };
        let settings_file = folder.write("settings.json", LAUNCH_SETTINGS)?;

        let extra_folders = existing(&composition.extra_folders, |path| {
            warnings.push(format!(
                "Access directory skipped - {} is not there any more.",
                path.display()
            ));
        });

        let registration = self.register(&composition.agent_tools, folder)?;
        let session_id = match resume {
            Some(id) => id.to_owned(),
            None => super::new_conversation_id(),
        };
        let plugin_dirs: Vec<PathBuf> = built.iter().map(|overlay| overlay.dir.clone()).collect();
        let args = argv::build(&argv::Argv {
            extra_folders: &extra_folders,
            resume,
            name,
            plugin_dirs: &plugin_dirs,
            instructions_file: instructions_file.as_deref(),
            settings_file: Some(&settings_file),
            session_id: Some(&session_id),
            tool_args: &registration.args,
            model: composition.model.as_deref(),
            effort: composition.effort,
            permission_mode: composition.permission_mode,
            agent: composition.agent.as_deref(),
            prompt,
        });

        let program = self.program(args);
        let mut env = self.session_env();
        env.extend(registration.env);
        env.extend(program.env);
        Ok(Launch {
            spec: LaunchSpec {
                program: program.program,
                args: program.args,
                cwd: cwd.to_path_buf(),
                env,
                conversation_id: Some(session_id),
                launch_folder: Some(folder.path().to_path_buf()),
            },
            overlays: built.into_iter().map(|overlay| overlay.name).collect(),
            composed_instructions: instructions.is_some(),
            warnings,
            not_taken: super::parts_not_taken(&self.harness(), &overlays),
        })
    }
}

/// One launch's inputs, new or resumed.
struct Composed<'a> {
    cwd: &'a Path,
    name: &'a str,
    prompt: Option<&'a str>,
    resume: Option<&'a str>,
    composition: &'a Composition,
}

/// The paths that are still there, calling `gone` for each that is not.
fn existing(paths: &[PathBuf], mut gone: impl FnMut(&Path)) -> Vec<PathBuf> {
    paths
        .iter()
        .filter(|path| {
            let there = path.exists();
            if !there {
                gone(path);
            }
            there
        })
        .cloned()
        .collect()
}

impl AgentBackend for ClaudeCodeBackend {
    fn id(&self) -> &BackendId {
        &self.id
    }

    fn name(&self) -> &str {
        "Claude Code"
    }

    fn launch(&self, request: &LaunchRequest, folder: &LaunchFolder) -> Result<Launch> {
        self.compose(
            Composed {
                cwd: &request.folder,
                name: &request.name,
                prompt: request.prompt.as_deref(),
                resume: None,
                composition: &request.composition,
            },
            folder,
        )
    }

    fn resumer(&self) -> Option<&dyn Resumer> {
        Some(self)
    }

    fn status(&self) -> Option<&dyn StatusSource> {
        Some(self)
    }

    fn agent_tools(&self) -> Option<&dyn AgentTools> {
        Some(self)
    }

    fn permissions(&self) -> Option<&dyn Permissions> {
        Some(self)
    }

    fn history(&self) -> Option<&dyn HistorySource> {
        Some(self)
    }

    fn usage(&self) -> Option<&dyn UsageSource> {
        Some(self)
    }

    fn config(&self) -> Option<&dyn ConfigSource> {
        Some(self)
    }

    fn sign_in(&self) -> Option<&dyn SignInCheck> {
        Some(self)
    }

    fn executable(&self) -> Option<&dyn ExecutableSetup> {
        Some(self)
    }

    /// `.credentials.json`, and every `<pid>.<hash>.key` beside the session
    /// records, found by name from a listing that opens none of them.
    fn credential_paths(&self) -> Vec<PathBuf> {
        let mut paths = vec![self.settings.config_dir.join(".credentials.json")];
        if let Ok(entries) = std::fs::read_dir(self.sessions_dir()) {
            let mut keys: Vec<PathBuf> = entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| status::is_session_key(path))
                .collect();
            keys.sort();
            paths.extend(keys);
        }
        paths
    }

    fn tested_range(&self) -> Option<TestedVersions> {
        Some(TESTED_VERSIONS)
    }

    /// Instructions from `CLAUDE.md` and `AGENTS.md`; skills, commands,
    /// subagents and workflows through the overlay. Nothing it cannot take.
    fn harness(&self) -> HarnessSupport {
        HarnessSupport::taking(["CLAUDE.md", "AGENTS.md"], HarnessPart::ALL)
    }
}

impl Resumer for ClaudeCodeBackend {
    /// `--resume <id>` in the folder history recorded, with this launch's
    /// overlays, agent tools and settings file, and never `-n`,
    /// `--session-id` or a prompt.
    fn resume(&self, request: &ResumeRequest, folder: &LaunchFolder) -> Result<Launch> {
        if request.conversation_id.trim().is_empty() {
            return Err(Error::backend(&self.id, "resume a conversation with no id"));
        }
        self.compose(
            Composed {
                cwd: &request.folder,
                name: "",
                prompt: None,
                resume: Some(&request.conversation_id),
                composition: &request.composition,
            },
            folder,
        )
    }
}

impl StatusSource for ClaudeCodeBackend {
    fn status(&self, session: &SessionRef) -> Knowable<Option<SessionActivity>> {
        status::status(&self.sessions_dir(), self.tree.as_ref(), session)
    }

    fn registry(&self) -> Knowable<Vec<super::LiveRecord>> {
        status::registry(&self.sessions_dir(), self.tree.as_ref())
    }
}

impl AgentTools for ClaudeCodeBackend {
    /// One `--mcp-config` file in the launch folder naming each family with
    /// the session's bearer token, then `--allowedTools` naming each tool a
    /// family lists as read-only. No families, no file and no flag. Both
    /// flags are variadic, so they come in that order before the next flag
    /// (see `argv`), and no rule is passed for a server the file does not
    /// name.
    fn register(&self, servers: &[AgentToolServer], folder: &LaunchFolder) -> Result<Registration> {
        if servers.is_empty() {
            return Ok(Registration::default());
        }
        let mut document = serde_json::Map::new();
        for server in servers {
            document.insert(
                server.name.clone(),
                serde_json::json!({
                    "type": "http",
                    "url": server.url,
                    "headers": { "Authorization": format!("Bearer {}", server.token) },
                }),
            );
        }
        let json = serde_json::json!({ "mcpServers": document });
        let file = folder.write("mcp.json", serde_json::to_vec_pretty(&json).expect("json"))?;
        let mut args: Vec<OsString> = vec!["--mcp-config".into(), file.into_os_string()];
        let allowed: Vec<OsString> = servers
            .iter()
            .flat_map(|server| server.allowed_tool_rules())
            .map(OsString::from)
            .collect();
        if !allowed.is_empty() {
            args.push("--allowedTools".into());
            args.extend(allowed);
        }
        Ok(Registration {
            args,
            env: Vec::new(),
        })
    }
}

impl Permissions for ClaudeCodeBackend {
    fn arguments(&self, mode: PermissionMode) -> Vec<OsString> {
        vec![
            "--permission-mode".into(),
            argv::permission_mode_name(mode).into(),
        ]
    }
}

impl HistorySource for ClaudeCodeBackend {
    fn conversations(&self) -> Result<Vec<Conversation>> {
        history::conversations(&self.settings.config_dir)
    }

    fn transcript(&self, conversation_id: &str) -> Result<Option<Transcript>> {
        history::transcript(&self.settings.config_dir, conversation_id)
    }

    fn prompt_record(&self) -> Option<&dyn PromptRecord> {
        Some(self)
    }
}

/// `history.jsonl`, the prompt record the history list is built from.
impl PromptRecord for ClaudeCodeBackend {
    fn prompt_file(&self) -> PathBuf {
        prompts::history_file(&self.settings.config_dir)
    }

    fn prompts_since(&self, offset: u64) -> PromptTail {
        prompts::read_since(&self.prompt_file(), offset)
    }
}

impl UsageSource for ClaudeCodeBackend {
    fn usage(&self, now_ms: u64, today_start_ms: u64) -> UsageSnapshot {
        usage::read(&self.id, &self.settings.config_dir, now_ms, today_start_ms)
    }
}

impl ConfigSource for ClaudeCodeBackend {
    fn config_files(&self, project: Option<&Path>) -> Result<Vec<ConfigFile>> {
        config::config_files(&self.settings.config_dir, project, &self.credential_paths())
    }

    fn console(&self) -> Option<crate::config_console::AgentConfig> {
        Some(self.console_agent())
    }
}

impl SignInCheck for ClaudeCodeBackend {
    fn signed_in(&self) -> SignIn {
        sign_in::signed_in(&self.settings.config_dir, self.settings.api_key_set)
    }
}

/// `claude` as setup finds it: a bare name in the user's program folders
/// first, then on `PATH`; a path where it names one.
impl ExecutableSetup for ClaudeCodeBackend {
    fn discovered(&self) -> Option<PathBuf> {
        let program = &self.settings.program;
        let bare =
            Path::new(program).components().count() == 1 && !Path::new(program).is_absolute();
        if bare
            && let Some(found) = self
                .settings
                .search_first
                .iter()
                .find_map(|folder| launcher::Native.find(folder.join(program).as_os_str()))
        {
            return Some(found);
        }
        launcher::Native.find(program)
    }

    fn version(&self, chosen: Option<&Path>) -> Option<String> {
        match chosen {
            Some(chosen) => self.version_output(&chosen.as_os_str().to_owned(), &[]),
            None => self.version_output(&self.settings.program, &self.settings.leading_args),
        }
    }

    fn version_command(&self) -> &str {
        "claude --version"
    }

    fn use_executable(&self, chosen: Option<PathBuf>) {
        let mut current = self.chosen.write().unwrap_or_else(PoisonError::into_inner);
        if *current != chosen {
            *current = chosen;
            // A different binary answers for itself.
            *self.version.lock().unwrap_or_else(PoisonError::into_inner) = None;
        }
    }

    fn config_dir(&self) -> Option<PathBuf> {
        Some(self.settings.config_dir.clone())
    }
}
