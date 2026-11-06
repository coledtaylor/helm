//! A second fake agent, shaped unlike Claude Code, and the backend that runs
//! it: the stand-in for any agent the host must not assume is Claude Code.
//!
//! The fake CLI is `test/fake-agents/other-agent.mjs`, run under Node. Its
//! opening prompt is a positional argument, its agent tools come from its own
//! config flag, it reopens a conversation with `--continue`, and it has no flag
//! that disallows a tool. Its backend, `other-agent`, has MCP tools, moves no
//! long call to the background and supports no MCP tasks, and it enforces what
//! its flags can: a role's allowed tools and the permission modes it has a
//! name for. A rule it cannot enforce, such as a disallowed tool, is refused.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use floti_protocol::BackendId;
use floti_protocol::channels::common::PermissionMode;
use serde::Deserialize;

use super::{TestDirs, unique_name};
use crate::agent::{
    AgentBackend, AgentToolServer, AgentTools, Composition, Launch, LaunchFolder, LaunchRequest,
    LaunchSpec, Permissions, Registration, ResumeRequest, Resumer, ToolRule, parts_not_taken,
};
use crate::{Error, Result};

/// The variable naming the folder the fake keeps its conversations and run
/// logs in.
pub const OTHER_AGENT_HOME_VAR: &str = "OTHER_AGENT_HOME";

/// One server the fake loaded from its tools config.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct OtherAgentServer {
    pub url: String,
    pub bearer: String,
}

/// One command a fake ran for a typed `/shell`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ShellRun {
    pub command: String,
    pub stdout: String,
    pub stderr: String,
    /// `None` while it runs.
    pub code: Option<i32>,
}

/// What one run of the fake recorded.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OtherAgentRecord {
    pub pid: u32,
    /// Its arguments, without the program.
    pub argv: Vec<String>,
    /// The folder it ran in.
    pub cwd: String,
    pub conversation: String,
    /// Whether it reopened a conversation.
    pub resumed: bool,
    pub title: Option<String>,
    pub model: Option<String>,
    /// What its `--instructions-file` held, when it was given one.
    #[serde(default)]
    pub instructions: Option<String>,
    /// Its `--mode`, as the CLI names it.
    pub mode: Option<String>,
    /// Each `--allow-tool`, in order.
    pub allowed_tools: Vec<String>,
    /// Each `--allow-shell`, in order.
    pub allowed_shell: Vec<String>,
    /// The servers its tools config named, by name.
    pub mcp_servers: BTreeMap<String, OtherAgentServer>,
    /// The prompt it started with.
    pub opening_prompt: Option<String>,
    /// Every line typed at its prompt, in order.
    pub received: Vec<String>,
    /// Every command a typed `/shell` ran, in order.
    #[serde(default)]
    pub shell: Vec<ShellRun>,
    /// `None` while it runs.
    pub exit_code: Option<i32>,
}

/// The other fake agent CLI, keeping its state in a folder of a test's tree.
#[derive(Debug, Clone)]
pub struct OtherAgent {
    script: PathBuf,
    home: PathBuf,
}

impl OtherAgent {
    /// The fake, with a home folder of its own in `dirs`. It exits once the
    /// test process that owns `dirs` is gone.
    pub fn new(dirs: &TestDirs) -> Self {
        Self {
            script: script_path(),
            home: dirs.folder("other agent home"),
        }
    }

    /// The folder it keeps its conversations and run logs in.
    pub fn home(&self) -> &Path {
        &self.home
    }

    /// A backend that runs this agent.
    pub fn backend(&self) -> OtherAgentBackend {
        OtherAgentBackend {
            id: BackendId::new(OtherAgentBackend::ID),
            agent: self.clone(),
        }
    }

    /// Every run recorded so far, in pid order.
    pub fn records(&self) -> Vec<OtherAgentRecord> {
        let Ok(entries) = std::fs::read_dir(self.home.join("fake-agent")) else {
            return Vec::new();
        };
        let mut records: Vec<OtherAgentRecord> = entries
            .filter_map(|entry| {
                let path = entry.ok()?.path();
                if path.extension()? != "json" {
                    return None;
                }
                serde_json::from_slice(&std::fs::read(path).ok()?).ok()
            })
            .collect();
        records.sort_by_key(|record| record.pid);
        records
    }

    /// The record of run `pid`, if it has written one.
    pub fn record(&self, pid: u32) -> Option<OtherAgentRecord> {
        let path = self.home.join("fake-agent").join(format!("{pid}.json"));
        serde_json::from_slice(&std::fs::read(path).ok()?).ok()
    }

    /// Waits up to `timeout` for a record of run `pid` that `done` accepts,
    /// and panics naming the last one seen when none does.
    pub fn wait_for_record(
        &self,
        pid: u32,
        timeout: Duration,
        done: impl Fn(&OtherAgentRecord) -> bool,
    ) -> OtherAgentRecord {
        let deadline = Instant::now() + timeout;
        loop {
            let record = self.record(pid);
            if let Some(record) = &record
                && done(record)
            {
                return record.clone();
            }
            assert!(
                Instant::now() < deadline,
                "the other fake agent's run {pid} did not record what was expected within {timeout:?}; last record: {record:?}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

/// The fake script, with links resolved and without the `\\?\` form Node's
/// own folder reporting does not use.
fn script_path() -> PathBuf {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("test")
        .join("fake-agents")
        .join("other-agent.mjs");
    let canonical = std::fs::canonicalize(&path).unwrap_or(path);
    match canonical.to_string_lossy().strip_prefix(r"\\?\") {
        Some(plain) => PathBuf::from(plain),
        None => canonical,
    }
}

/// A backend that runs the other fake agent.
#[derive(Debug, Clone)]
pub struct OtherAgentBackend {
    id: BackendId,
    agent: OtherAgent,
}

impl OtherAgentBackend {
    pub const ID: &'static str = "other-agent";

    /// The program a launch runs and what comes before the agent's own
    /// arguments.
    fn command(&self) -> (OsString, Vec<OsString>) {
        (
            "node".into(),
            vec![self.agent.script.clone().into_os_string()],
        )
    }

    fn spec(
        &self,
        cwd: &Path,
        conversation_args: Vec<OsString>,
        conversation_id: String,
        composition: &Composition,
        prompt: Option<&str>,
        folder: &LaunchFolder,
    ) -> Result<Launch> {
        // The one thing it can never do is start with a role's rule dropped.
        self.check_rules(&composition.tool_lists())?;
        let (program, mut args) = self.command();
        args.extend(conversation_args);
        if let Some(model) = composition
            .model
            .as_deref()
            .filter(|model| !model.trim().is_empty())
        {
            args.extend(["--model".into(), model.into()]);
        }
        // A role's body goes in a file of the launch's own, passed with the
        // flag it has for that; it is never typed to the session. It has no
        // effort setting, so a composition's effort is not passed.
        if let Some(role) = &composition.instructions {
            let file = folder.write(
                "instructions.md",
                format!("# Role: {}\n\n{}\n", role.role, role.body.trim()),
            )?;
            args.extend(["--instructions-file".into(), file.into_os_string()]);
        }
        if let Some(mode) = composition.permission_mode {
            args.extend(self.arguments(mode));
        }
        let tools = self.register(&composition.agent_tools, folder)?;
        args.extend(tools.args);
        for rule in &composition.allowed_tools {
            args.extend(self.allow_arguments(rule)?);
        }
        if let Some(prompt) = prompt.map(str::trim).filter(|prompt| !prompt.is_empty()) {
            // A prompt that starts with a dash would be read as an option.
            if prompt.starts_with('-') {
                args.push("--".into());
            }
            args.push(prompt.into());
        }
        let mut env: Vec<(OsString, OsString)> = vec![(
            OTHER_AGENT_HOME_VAR.into(),
            self.agent.home.clone().into_os_string(),
        )];
        env.extend(tools.env);
        let mut launch = Launch::plain(LaunchSpec {
            program,
            args,
            cwd: cwd.to_path_buf(),
            env,
            conversation_id: Some(conversation_id),
            launch_folder: Some(folder.path().to_path_buf()),
        });
        launch.not_taken = parts_not_taken(&self.harness(), &composition.overlays);
        Ok(launch)
    }

    /// The flags that let one tool or command run without asking, for the
    /// role's `rule` as Claude Code spells it.
    fn allow_arguments(&self, rule: &str) -> Result<Vec<OsString>> {
        match allow_of(rule) {
            Some(Allow::Tool(tool)) => Ok(vec!["--allow-tool".into(), tool.into()]),
            Some(Allow::Shell(command)) => Ok(vec!["--allow-shell".into(), command.into()]),
            None => Err(Error::backend(
                &self.id,
                format!("enforce the {}", ToolRule::AllowedTool(rule.to_owned())),
            )),
        }
    }
}

/// What an allow rule lets the agent do.
enum Allow {
    /// One of its tools, by its own name or `<server>.<tool>`.
    Tool(String),
    /// A shell command and any arguments after it.
    Shell(String),
}

/// The agent's own allowance for `rule`, written as Claude Code spells it:
/// `mcp__<server>__<tool>` is `<server>.<tool>`, `Bash(<command>:*)` is a
/// shell command, and its six built-in tools have names of their own. Any
/// other rule has no equivalent.
fn allow_of(rule: &str) -> Option<Allow> {
    if let Some(rest) = rule.strip_prefix("mcp__") {
        let (server, tool) = rest.split_once("__")?;
        return (!server.is_empty() && !tool.is_empty())
            .then(|| Allow::Tool(format!("{server}.{tool}")));
    }
    if let Some(command) = rule
        .strip_prefix("Bash(")
        .and_then(|rest| rest.strip_suffix(":*)"))
    {
        return (!command.trim().is_empty()).then(|| Allow::Shell(command.to_owned()));
    }
    let tool = match rule {
        "Read" => "read",
        "Write" => "write",
        "Edit" => "edit",
        "Glob" => "find",
        "Grep" => "search",
        "Bash" => "shell",
        _ => return None,
    };
    Some(Allow::Tool(tool.to_owned()))
}

/// Its `--mode` for `mode`, or `None` for a mode it has no name for.
fn mode_of(mode: PermissionMode) -> Option<&'static str> {
    match mode {
        PermissionMode::Plan => Some("plan"),
        PermissionMode::Manual => Some("ask"),
        PermissionMode::AcceptEdits => Some("edit"),
        PermissionMode::BypassPermissions => Some("yolo"),
        PermissionMode::Auto | PermissionMode::DontAsk => None,
    }
}

impl AgentTools for OtherAgentBackend {
    /// One tools config in the launch's own folder, a list of servers each
    /// with its bearer token, passed with `--tools-config`; then one
    /// `--allow-tool` for each tool a family allows and one `--allow-shell`
    /// for each command. No families, nothing at all.
    fn register(&self, servers: &[AgentToolServer], folder: &LaunchFolder) -> Result<Registration> {
        if servers.is_empty() {
            return Ok(Registration::default());
        }
        let document = serde_json::json!({
            "servers": servers
                .iter()
                .map(|server| serde_json::json!({
                    "name": server.name,
                    "url": server.url,
                    "bearer": server.token,
                }))
                .collect::<Vec<_>>(),
        });
        let file = folder.write(
            "tools.json",
            serde_json::to_vec_pretty(&document).expect("json"),
        )?;
        let mut args: Vec<OsString> = vec!["--tools-config".into(), file.into_os_string()];
        for server in servers {
            for tool in &server.allowed_tools {
                args.extend([
                    "--allow-tool".into(),
                    self.tool_rule(&server.name, tool).into(),
                ]);
            }
            for command in &server.allowed_commands {
                args.extend(["--allow-shell".into(), self.command_rule(command).into()]);
            }
        }
        Ok(Registration {
            args,
            env: Vec::new(),
        })
    }

    fn tool_rule(&self, server: &str, tool: &str) -> String {
        format!("{server}.{tool}")
    }

    fn command_rule(&self, command: &str) -> String {
        command.to_owned()
    }
}

impl Permissions for OtherAgentBackend {
    fn arguments(&self, mode: PermissionMode) -> Vec<OsString> {
        mode_of(mode)
            .map(|name| vec!["--mode".into(), name.into()])
            .unwrap_or_default()
    }

    /// A mode it has a name for and an allowed tool it has an equivalent
    /// for. It has no way to disallow a tool.
    fn can_enforce(&self, rule: &ToolRule) -> bool {
        match rule {
            ToolRule::PermissionMode(mode) => mode_of(*mode).is_some(),
            ToolRule::AllowedTool(rule) => allow_of(rule).is_some(),
            ToolRule::DisallowedTool(_) => false,
        }
    }
}

impl AgentBackend for OtherAgentBackend {
    fn id(&self) -> &BackendId {
        &self.id
    }

    fn name(&self) -> &str {
        "Other agent"
    }

    /// A new conversation is given an id of its own, as `--conversation`
    /// takes one, so its session can be restored.
    fn launch(&self, request: &LaunchRequest, folder: &LaunchFolder) -> Result<Launch> {
        let conversation = format!("other-conversation-{}", unique_name());
        let mut conversation_args: Vec<OsString> =
            vec!["--conversation".into(), conversation.clone().into()];
        let title = request.name.trim();
        if !title.is_empty() {
            conversation_args.extend(["--title".into(), title.into()]);
        }
        self.spec(
            &request.folder,
            conversation_args,
            conversation,
            &request.composition,
            request.prompt.as_deref(),
            folder,
        )
    }

    fn resumer(&self) -> Option<&dyn Resumer> {
        Some(self)
    }

    fn agent_tools(&self) -> Option<&dyn AgentTools> {
        Some(self)
    }

    fn permissions(&self) -> Option<&dyn Permissions> {
        Some(self)
    }

    /// `--instructions-file`. It has no effort setting: [`Self::takes_effort`]
    /// stays false.
    fn takes_instructions(&self) -> bool {
        true
    }
}

impl Resumer for OtherAgentBackend {
    /// `--continue <id>` in the folder history recorded, with this launch's
    /// tools and rules, and the prompt as the next turn when there is one.
    fn resume(&self, request: &ResumeRequest, folder: &LaunchFolder) -> Result<Launch> {
        if request.conversation_id.trim().is_empty() {
            return Err(Error::backend(&self.id, "resume a conversation with no id"));
        }
        self.spec(
            &request.folder,
            vec!["--continue".into(), request.conversation_id.clone().into()],
            request.conversation_id.clone(),
            &request.composition,
            request.prompt.as_deref(),
            folder,
        )
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;
    use std::process::{Child, Command, Stdio};

    use floti_protocol::BackendFeature;

    use super::*;
    use crate::agent::{RoleInstructions, ToolSupport};
    use crate::testkit::PATIENCE;

    struct World {
        agent: OtherAgent,
        backend: OtherAgentBackend,
        /// Last: fields drop in order, and the folder goes only once nothing in it is open.
        dirs: TestDirs,
    }

    impl World {
        fn new() -> Self {
            let dirs = TestDirs::new();
            let agent = OtherAgent::new(&dirs);
            Self {
                backend: agent.backend(),
                agent,
                dirs,
            }
        }

        fn launch_folder(&self) -> LaunchFolder {
            LaunchFolder::create(&self.dirs.data).unwrap()
        }

        fn launch(&self, request: &LaunchRequest) -> (Launch, LaunchFolder) {
            let folder = self.launch_folder();
            let launch = self.backend.launch(request, &folder).unwrap();
            (launch, folder)
        }

        /// The agent's own arguments in a launch, after the script.
        fn args(&self, launch: &Launch) -> Vec<String> {
            assert_eq!(launch.spec.program, OsString::from("node"));
            launch.spec.args[1..]
                .iter()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect()
        }

        fn command(&self, spec: &LaunchSpec) -> Command {
            let mut command = Command::new(&spec.program);
            command.args(&spec.args).current_dir(&spec.cwd);
            command.env_remove("FAKE_AGENT_VERSION");
            command.envs(spec.env.iter().map(|(name, value)| (name, value)));
            command
        }

        /// Runs `spec` to its end with `input` typed.
        fn run(&self, spec: &LaunchSpec, input: &str) -> (std::process::Output, u32) {
            let mut child = self
                .command(spec)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("run node");
            let pid = child.id();
            // A run that fails at once has closed its input already.
            let _ = child.stdin.take().unwrap().write_all(input.as_bytes());
            (child.wait_with_output().unwrap(), pid)
        }
    }

    fn request(folder: PathBuf) -> LaunchRequest {
        LaunchRequest {
            folder,
            name: "child".into(),
            ..LaunchRequest::default()
        }
    }

    fn server(name: &str) -> AgentToolServer {
        AgentToolServer {
            name: name.to_owned(),
            url: format!("http://127.0.0.1:41000/mcp/{name}"),
            token: "secret-token".to_owned(),
            allowed_tools: Vec::new(),
            allowed_commands: Vec::new(),
        }
    }

    #[test]
    fn it_has_mcp_tools_and_moves_no_call_to_the_background_and_has_no_mcp_tasks() {
        let world = World::new();
        assert_eq!(world.backend.id().as_str(), OtherAgentBackend::ID);
        assert_eq!(
            world.backend.tool_support(),
            ToolSupport {
                backgrounds_long_calls: false,
                mcp_tasks: false,
                mcp_tools: true,
            }
        );
        let descriptor = world.backend.capabilities();
        for feature in [
            BackendFeature::Run,
            BackendFeature::Resume,
            BackendFeature::AgentTools,
        ] {
            assert_eq!(
                descriptor.support(feature),
                floti_protocol::Support::Declared,
                "{feature:?}"
            );
        }
    }

    #[test]
    fn the_opening_prompt_is_the_last_positional_argument_with_no_separator() {
        let world = World::new();
        let (launch, _folder) = world.launch(&LaunchRequest {
            prompt: Some("  review the change  ".into()),
            ..request(world.dirs.folder("work"))
        });
        let args = world.args(&launch);
        assert_eq!(args.last().unwrap(), "review the change");
        assert!(!args.iter().any(|arg| arg == "--"), "{args:?}");
        assert!(args.iter().any(|arg| arg == "--conversation"));
        assert_eq!(
            launch.spec.conversation_id.as_deref(),
            Some(args[args.iter().position(|arg| arg == "--conversation").unwrap() + 1].as_str())
        );

        // A prompt that starts with a dash is not an option.
        let (dashed, _folder) = world.launch(&LaunchRequest {
            prompt: Some("--not-a-flag".into()),
            ..request(world.dirs.folder("work"))
        });
        let args = world.args(&dashed);
        assert_eq!(args[args.len() - 2..], ["--", "--not-a-flag"]);

        // No prompt, or a blank one, passes none.
        for prompt in [None, Some("   ".to_owned())] {
            let (bare, _folder) = world.launch(&LaunchRequest {
                prompt,
                ..request(world.dirs.folder("work"))
            });
            assert_eq!(world.args(&bare).last().unwrap(), "child");
        }
    }

    #[test]
    fn agent_tools_come_from_its_own_config_flag_and_their_allowances_are_its_own() {
        let world = World::new();
        let mut agents = server("floti-agents");
        agents.allowed_tools = vec!["agents_start".into(), "agents_stop".into()];
        agents.allowed_commands = vec!["floti agent start".into(), "floti agent stop".into()];
        let (launch, folder) = world.launch(&LaunchRequest {
            composition: Composition {
                agent_tools: vec![server("helm-sessions"), agents],
                ..Composition::default()
            },
            prompt: Some("go".into()),
            ..request(world.dirs.folder("work"))
        });
        let args = world.args(&launch);
        let at = args.iter().position(|arg| arg == "--tools-config").unwrap();
        assert_eq!(
            args[at + 1],
            folder.path().join("tools.json").display().to_string()
        );
        assert_eq!(
            args[at + 2..],
            [
                "--allow-tool",
                "floti-agents.agents_start",
                "--allow-tool",
                "floti-agents.agents_stop",
                "--allow-shell",
                "floti agent start",
                "--allow-shell",
                "floti agent stop",
                "go",
            ]
        );
        // Not Claude Code's flags, names or file shape.
        for claude in ["--mcp-config", "--allowedTools", "--disallowedTools"] {
            assert!(
                !args.iter().any(|arg| arg == claude),
                "{claude} in {args:?}"
            );
        }
        assert!(
            !args
                .iter()
                .any(|arg| arg.starts_with("mcp__") || arg.starts_with("Bash("))
        );
        let file: serde_json::Value =
            serde_json::from_slice(&std::fs::read(folder.path().join("tools.json")).unwrap())
                .unwrap();
        assert_eq!(file["servers"][1]["name"], "floti-agents");
        assert_eq!(file["servers"][1]["bearer"], "secret-token");
        assert!(file.get("mcpServers").is_none());

        // No families, no file and no flag.
        let (bare, folder) = world.launch(&request(world.dirs.folder("work")));
        assert!(!world.args(&bare).iter().any(|arg| arg == "--tools-config"));
        assert!(!folder.path().join("tools.json").exists());
    }

    #[test]
    fn a_roles_rules_become_its_own_flags() {
        let world = World::new();
        let (launch, _folder) = world.launch(&LaunchRequest {
            composition: Composition {
                permission_mode: Some(PermissionMode::Plan),
                allowed_tools: vec![
                    "Read".into(),
                    "Bash(git status:*)".into(),
                    "mcp__helm-sessions__sessions_list".into(),
                ],
                ..Composition::default()
            },
            ..request(world.dirs.folder("work"))
        });
        let args = world.args(&launch);
        let at = args.iter().position(|arg| arg == "--mode").unwrap();
        assert_eq!(args[at + 1], "plan");
        assert_eq!(
            args[at + 2..],
            [
                "--allow-tool",
                "read",
                "--allow-shell",
                "git status",
                "--allow-tool",
                "helm-sessions.sessions_list",
            ]
        );

        let permissions = world.backend.permissions().unwrap();
        for (mode, name) in [
            (PermissionMode::Plan, Some("plan")),
            (PermissionMode::Manual, Some("ask")),
            (PermissionMode::AcceptEdits, Some("edit")),
            (PermissionMode::BypassPermissions, Some("yolo")),
            (PermissionMode::Auto, None),
            (PermissionMode::DontAsk, None),
        ] {
            let expected: Vec<OsString> =
                name.map_or(Vec::new(), |name| vec!["--mode".into(), name.into()]);
            assert_eq!(permissions.arguments(mode), expected, "{mode:?}");
        }
    }

    #[test]
    fn a_rule_it_cannot_enforce_is_refused_naming_the_rule_and_the_backend() {
        use crate::agent::ToolRules;
        let world = World::new();
        let refused = |rules: ToolRules| {
            world
                .backend
                .check_rules(&rules)
                .expect_err("the rule is refused")
                .to_string()
        };

        // It cannot disallow a single tool.
        assert_eq!(
            refused(ToolRules {
                disallowed_tools: vec!["Bash(rm:*)".into()],
                ..ToolRules::default()
            }),
            "other-agent cannot enforce the disallowed_tools rule Bash(rm:*)"
        );
        // Nor take a mode it has no name for.
        assert_eq!(
            refused(ToolRules {
                permission_mode: Some(PermissionMode::DontAsk),
                ..ToolRules::default()
            }),
            "other-agent cannot enforce the permission mode don't ask"
        );
        // Nor allow a tool it has no equivalent for.
        assert_eq!(
            refused(ToolRules {
                allowed_tools: vec!["Read".into(), "WebFetch".into()],
                ..ToolRules::default()
            }),
            "other-agent cannot enforce the allowed_tools rule WebFetch"
        );
        // The first rule it cannot enforce is the one named.
        assert_eq!(
            refused(ToolRules {
                permission_mode: Some(PermissionMode::Auto),
                disallowed_tools: vec!["Edit".into()],
                ..ToolRules::default()
            }),
            "other-agent cannot enforce the permission mode auto"
        );
        // What it can enforce is not refused.
        world
            .backend
            .check_rules(&ToolRules {
                permission_mode: Some(PermissionMode::Manual),
                allowed_tools: vec!["Read".into(), "Bash(git diff:*)".into()],
                disallowed_tools: Vec::new(),
            })
            .unwrap();

        // A launch that carries a disallowed tool is refused too, and
        // leaves nothing written.
        let folder = world.launch_folder();
        let err = world
            .backend
            .launch(
                &LaunchRequest {
                    composition: Composition {
                        disallowed_tools: vec!["Bash(rm:*)".into()],
                        agent_tools: vec![server("helm-sessions")],
                        ..Composition::default()
                    },
                    ..request(world.dirs.folder("work"))
                },
                &folder,
            )
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            "other-agent cannot enforce the disallowed_tools rule Bash(rm:*)"
        );
        assert!(!folder.path().join("tools.json").exists());
    }

    #[test]
    fn a_run_records_what_it_was_given_and_answers_what_is_typed() {
        let world = World::new();
        let mut agents = server("floti-agents");
        agents.allowed_tools = vec!["agents_start".into()];
        agents.allowed_commands = vec!["floti agent start".into()];
        let work = world.dirs.folder("work");
        let (launch, _folder) = world.launch(&LaunchRequest {
            composition: Composition {
                agent_tools: vec![agents],
                permission_mode: Some(PermissionMode::Manual),
                model: Some("small".into()),
                allowed_tools: vec!["Read".into()],
                ..Composition::default()
            },
            prompt: Some("check the build".into()),
            ..request(work)
        });
        let (output, pid) = world.run(&launch.spec, "what now\n/exit\n");
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let screen = String::from_utf8_lossy(&output.stdout);
        assert!(screen.contains("Noted: check the build"), "{screen}");
        assert!(screen.contains("Noted: what now"), "{screen}");

        let record = world.agent.record(pid).expect("the run is recorded");
        assert_eq!(record.opening_prompt.as_deref(), Some("check the build"));
        assert_eq!(record.received, ["what now", "/exit"]);
        assert_eq!(record.mode.as_deref(), Some("ask"));
        assert_eq!(record.model.as_deref(), Some("small"));
        assert_eq!(record.title.as_deref(), Some("child"));
        assert_eq!(record.allowed_tools, ["floti-agents.agents_start", "read"]);
        assert_eq!(record.allowed_shell, ["floti agent start"]);
        assert_eq!(
            record.mcp_servers["floti-agents"],
            OtherAgentServer {
                url: "http://127.0.0.1:41000/mcp/floti-agents".into(),
                bearer: "secret-token".into(),
            }
        );
        assert_eq!(
            Some(record.conversation.as_str()),
            launch.spec.conversation_id.as_deref()
        );
        assert_eq!(record.exit_code, Some(0));
        assert_eq!(world.agent.records().len(), 1);
    }

    #[test]
    fn a_roles_body_goes_in_an_instructions_file_it_loads_and_is_never_typed() {
        let world = World::new();
        let (launch, folder) = world.launch(&LaunchRequest {
            composition: Composition {
                model: Some("small".into()),
                instructions: Some(RoleInstructions {
                    role: "reviewer".into(),
                    body: "Read the code before you give findings.\n".into(),
                }),
                ..Composition::default()
            },
            prompt: Some("review the change".into()),
            ..request(world.dirs.folder("work"))
        });
        let args = world.args(&launch);
        let file = folder.path().join("instructions.md");
        let at = args
            .iter()
            .position(|arg| arg == "--instructions-file")
            .expect("the flag is passed");
        assert_eq!(args[at + 1], file.display().to_string());
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "# Role: reviewer\n\nRead the code before you give findings.\n"
        );
        // The prompt stays the last argument, and is only the task.
        assert_eq!(args.last().unwrap(), "review the change");

        let (output, pid) = world.run(&launch.spec, "/exit\n");
        assert!(output.status.success());
        let record = world.agent.record(pid).expect("the run is recorded");
        assert_eq!(
            record.instructions.as_deref(),
            Some("# Role: reviewer\n\nRead the code before you give findings.\n")
        );
        assert_eq!(record.model.as_deref(), Some("small"));
        assert_eq!(record.received, ["/exit"]);
        assert_eq!(record.opening_prompt.as_deref(), Some("review the change"));

        // No role, no file and no flag.
        let (bare, folder) = world.launch(&request(world.dirs.folder("work")));
        assert!(
            !world
                .args(&bare)
                .iter()
                .any(|arg| arg == "--instructions-file")
        );
        assert!(!folder.path().join("instructions.md").exists());
    }

    #[test]
    fn a_conversation_reopens_only_in_the_folder_it_was_recorded_in() {
        let world = World::new();
        let work = world.dirs.folder("work");
        let elsewhere = world.dirs.folder("elsewhere");
        let (first, _folder) = world.launch(&request(work.clone()));
        let (output, _pid) = world.run(&first.spec, "/exit\n");
        assert!(output.status.success());
        let conversation = first.spec.conversation_id.clone().unwrap();

        let reopen = |folder: PathBuf| {
            let launch_folder = world.launch_folder();
            world
                .backend
                .resumer()
                .expect("it resumes")
                .resume(
                    &ResumeRequest {
                        conversation_id: conversation.clone(),
                        folder,
                        prompt: None,
                        composition: Composition::default(),
                    },
                    &launch_folder,
                )
                .unwrap()
        };
        let again = reopen(work);
        assert_eq!(
            world.args(&again)[..2],
            ["--continue", conversation.as_str()]
        );
        assert_eq!(
            again.spec.conversation_id.as_deref(),
            Some(conversation.as_str())
        );
        let (output, pid) = world.run(&again.spec, "/exit\n");
        assert!(output.status.success());
        assert!(world.agent.record(pid).unwrap().resumed);

        let (output, pid) = world.run(&reopen(elsewhere).spec, "/exit\n");
        assert!(!output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stderr)
                .contains(&format!("no conversation {conversation} in this folder"))
        );
        assert_eq!(world.agent.record(pid).unwrap().exit_code, Some(1));
    }

    /// Ends when dropped, so a failed assertion leaves nothing running.
    struct Kill(Child);

    impl Drop for Kill {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn it_exits_once_the_process_that_owns_it_is_gone() {
        let world = World::new();
        // The owner: a process that ends itself when this test process does,
        // so a failure here leaves it nothing to wait for.
        let test_pid = std::process::id();
        let mut owner = Kill(
            Command::new("node")
                .arg("-e")
                .arg(format!(
                    "setInterval(() => {{ try {{ process.kill({test_pid}, 0) }} \
                     catch (error) {{ if (error.code !== 'EPERM') process.exit(0) }} }}, 250)"
                ))
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .spawn()
                .expect("run node"),
        );
        // Nearer to the fake than the test's own owner file, so it is the one found.
        std::fs::write(
            world.agent.home().join("test-owner"),
            owner.0.id().to_string(),
        )
        .unwrap();

        let (launch, _folder) = world.launch(&request(world.dirs.folder("work")));
        let mut fake = Kill(
            world
                .command(&launch.spec)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("run node"),
        );
        let pid = fake.0.id();
        // Its input stays open, so only its owner going can end it.
        let _held = fake.0.stdin.take();
        world
            .agent
            .wait_for_record(pid, PATIENCE, |record| record.exit_code.is_none());

        owner.0.kill().unwrap();
        owner.0.wait().unwrap();
        let deadline = Instant::now() + PATIENCE;
        let status = loop {
            if let Some(status) = fake.0.try_wait().unwrap() {
                break status;
            }
            assert!(
                Instant::now() < deadline,
                "the fake kept running after its owner was gone"
            );
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(status.success());
        world
            .agent
            .wait_for_record(pid, PATIENCE, |record| record.exit_code == Some(0));
    }
}
