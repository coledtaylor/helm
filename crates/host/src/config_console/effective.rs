//! What a session would be given, computed before one is launched: the
//! skills, commands, agents and workflows it could address and by what
//! name, the settings each layer gives it, the instruction files it reads in
//! order, and the MCP servers it could load.
//!
//! Two facts make it a prediction rather than a guess. An overlay's
//! contributions are namespaced by its plugin name, which the launcher picks
//! ([`overlay_plugin_names`]), so `<overlay>:think` follows from the
//! composition alone. Settings merge per leaf, local over project over user,
//! so the winner is decided at `env.A`, not at `env`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use floti_protocol::channels::workspace::{
    ConfigFileKind, ConfigScopeKind, EffectiveEntry, EffectiveInstruction, EffectiveMcpServer,
    EffectiveOverlay, EffectiveSetting, EffectiveSource, EffectiveView, McpScope, SettingCandidate,
    SettingsLayer, SettingsLayerKind, SharedName,
};

use super::files::normalize;
use super::json::Json;
use super::time::now_iso;
use super::tree::{project_scope, scope_files, user_scope};
use super::{AgentConfig, compare_names};
use crate::agent::AgentBackend;
use crate::agent::claude_code::overlay_plugin_names;
use crate::agent::harness::is_same_or_ancestor;

/// What the view is computed for.
#[derive(Debug, Clone, Default)]
pub struct EffectiveInput {
    pub cwd: PathBuf,
    pub overlays: Vec<PathBuf>,
    pub profile_id: Option<u64>,
    pub profile_name: Option<String>,
}

#[derive(Default)]
struct Entries {
    skills: Vec<EffectiveEntry>,
    commands: Vec<EffectiveEntry>,
    agents: Vec<EffectiveEntry>,
    workflows: Vec<EffectiveEntry>,
}

impl Entries {
    fn count(&self) -> usize {
        self.skills.len() + self.commands.len() + self.agents.len() + self.workflows.len()
    }

    fn extend(&mut self, other: Entries) {
        self.skills.extend(other.skills);
        self.commands.extend(other.commands);
        self.agents.extend(other.agents);
        self.workflows.extend(other.workflows);
    }
}

/// One source's contributions, addressed as a session would address them:
/// bare for the user's and the folder's own, prefixed for an overlay's.
fn entries_from(
    backend: &dyn AgentBackend,
    base: &Path,
    source: EffectiveSource,
    namespace: Option<&str>,
) -> Entries {
    let scope = match source {
        EffectiveSource::User => user_scope(base),
        _ => project_scope(base, ConfigScopeKind::Project, None),
    };
    let mut entries = Entries::default();
    for file in scope_files(backend, &scope).unwrap_or_default() {
        let bucket = match file.kind {
            ConfigFileKind::Skill => &mut entries.skills,
            ConfigFileKind::Command => &mut entries.commands,
            ConfigFileKind::Agent => &mut entries.agents,
            ConfigFileKind::Workflow => &mut entries.workflows,
            _ => continue,
        };
        bucket.push(EffectiveEntry {
            invocation: namespace
                .map_or_else(|| file.name.clone(), |ns| format!("{ns}:{}", file.name)),
            name: file.name,
            source,
            namespace: namespace.map(str::to_owned),
            origin: scope.path.clone(),
            path: file.path,
            description: file.description,
        });
    }
    entries
}

/// One settings file, flattened to its leaves.
struct Layer {
    kind: SettingsLayerKind,
    file: PathBuf,
    exists: bool,
    /// Leaf path to the JSON of its value, in the file's order.
    values: Vec<(String, String)>,
    error: Option<String>,
}

impl Layer {
    fn get(&self, key: &str) -> Option<&str> {
        self.values
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    }
}

/// Objects are descended into; an array is a leaf, because the agent takes
/// a list such as `permissions.allow` whole.
fn flatten(value: &Json, prefix: &str, into: &mut Vec<(String, String)>) {
    if let Json::Object(entries) = value {
        if entries.is_empty() {
            into.push((prefix.to_owned(), "{}".to_owned()));
            return;
        }
        for (key, child) in entries {
            let path = if prefix.is_empty() {
                key.clone()
            } else {
                format!("{prefix}.{key}")
            };
            flatten(child, &path, into);
        }
        return;
    }
    if !prefix.is_empty() {
        into.push((prefix.to_owned(), value.compact()));
    }
}

fn load_layer(kind: SettingsLayerKind, file: PathBuf) -> Layer {
    let mut values = Vec::new();
    let Ok(raw) = std::fs::read_to_string(&file) else {
        return Layer {
            kind,
            file,
            exists: false,
            values,
            error: None,
        };
    };
    let error = match Json::parse(&raw) {
        Ok(doc) => {
            flatten(&doc, "", &mut values);
            None
        }
        Err(error) => Some(error),
    };
    Layer {
        kind,
        file,
        exists: true,
        values,
        error,
    }
}

/// The precedence chain, highest first: local, project, user.
fn settings_chain(cwd: &Path, user_dir: &Path) -> Vec<Layer> {
    vec![
        load_layer(
            SettingsLayerKind::Local,
            cwd.join(".claude").join("settings.local.json"),
        ),
        load_layer(
            SettingsLayerKind::Project,
            cwd.join(".claude").join("settings.json"),
        ),
        load_layer(SettingsLayerKind::User, user_dir.join("settings.json")),
    ]
}

fn resolve_settings(chain: &[Layer]) -> Vec<EffectiveSetting> {
    let mut keys: Vec<&str> = chain
        .iter()
        .flat_map(|layer| layer.values.iter().map(|(key, _)| key.as_str()))
        .collect();
    keys.sort_by(|a, b| compare_names(a, b));
    keys.dedup();
    keys.into_iter()
        .filter_map(|key| {
            let candidates: Vec<SettingCandidate> = chain
                .iter()
                .filter_map(|layer| {
                    layer.get(key).map(|value| SettingCandidate {
                        layer: layer.kind,
                        file: layer.file.display().to_string(),
                        value: value.to_owned(),
                    })
                })
                .collect();
            let winner = candidates.first()?.clone();
            Some(EffectiveSetting {
                key: key.to_owned(),
                // Only an override when a lower layer says something else.
                overridden: candidates.iter().any(|c| c.value != winner.value),
                value: winner.value,
                winner: winner.layer,
                winner_file: winner.file,
                candidates,
            })
        })
        .collect()
}

fn read_object(file: &Path) -> Option<Json> {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|text| Json::parse(&text).ok())
        .filter(Json::is_object)
}

fn servers_in(doc: Option<&Json>) -> &[(String, Json)] {
    doc.and_then(|doc| doc.get("mcpServers"))
        .and_then(Json::entries)
        .unwrap_or_default()
}

fn transport_of(config: &Json) -> String {
    if !config.is_object() {
        return "unknown".to_owned();
    }
    match config.get("type").or_else(|| config.get("transport")) {
        Some(Json::String(declared)) => declared.clone(),
        _ if matches!(config.get("url"), Some(Json::String(_))) => "http".to_owned(),
        _ => "stdio".to_owned(),
    }
}

/// A folder as a key is written: separators folded to one, no trailing one,
/// lowercase. The agent keys `projects` by whatever string it was started
/// with, which on Windows is not one string per folder.
fn fold_key(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    let mut last_was_separator = false;
    for c in path.chars() {
        if c == '/' || c == '\\' {
            if !last_was_separator {
                out.push('\\');
            }
            last_was_separator = true;
        } else {
            out.extend(c.to_lowercase());
            last_was_separator = false;
        }
    }
    if out.ends_with('\\') && out.len() > 1 {
        out.pop();
    }
    out
}

/// The global config's `projects` entry for `cwd`, found by what the key
/// means: separators and case folded, and where the folder is there twice,
/// the entry that defines servers.
pub fn project_entry<'a>(projects: Option<&'a Json>, cwd: &Path) -> Option<&'a Json> {
    let wanted = fold_key(&normalize(cwd).display().to_string());
    let mut fallback = None;
    for (name, value) in projects?.entries()? {
        if fold_key(name) != wanted || !value.is_object() {
            continue;
        }
        if !servers_in(Some(value)).is_empty() {
            return Some(value);
        }
        fallback.get_or_insert(value);
    }
    fallback
}

/// Every MCP server a session in `cwd` could load, and whether it would:
/// the global config's entry for the folder (`local`), the folder's
/// `.mcp.json` (`project`, behind approval), then the global config's top
/// level (`user`).
fn effective_mcp(cwd: &Path, chain: &[Layer], global: &Path) -> Vec<EffectiveMcpServer> {
    let project_file = cwd.join(".mcp.json");
    let global_doc = read_object(global);
    let per_project = project_entry(global_doc.as_ref().and_then(|doc| doc.get("projects")), cwd);

    let winning = |key: &str| chain.iter().find_map(|layer| layer.get(key));
    let approval_layer = |key: &str| {
        chain
            .iter()
            .find(|layer| layer.get(key).is_some())
            .map(|layer| layer.file.display().to_string())
    };
    let list = |key: &str| {
        winning(key)
            .and_then(|raw| Json::parse(raw).ok())
            .map(|value| value.strings())
            .unwrap_or_default()
    };
    let enabled = list("enabledMcpjsonServers");
    let disabled = list("disabledMcpjsonServers");
    let enable_all = winning("enableAllProjectMcpServers") == Some("true");

    let mut rows = Vec::new();
    let mut seen: BTreeMap<String, McpScope> = BTreeMap::new();
    let scope_name = |scope: McpScope| match scope {
        McpScope::Local => "local",
        McpScope::User => "user",
        McpScope::Project => "project",
    };
    let mut add = |name: &str, scope: McpScope, file: &Path, config: &Json| {
        let shadowed_by = seen.get(name).map(|first| scope_name(*first).to_owned());
        seen.entry(name.to_owned()).or_insert(scope);
        let (approved, approved_by) = if scope == McpScope::Project {
            if disabled.iter().any(|n| n == name) {
                (Some(false), approval_layer("disabledMcpjsonServers"))
            } else if enabled.iter().any(|n| n == name) {
                (Some(true), approval_layer("enabledMcpjsonServers"))
            } else if enable_all {
                (Some(true), approval_layer("enableAllProjectMcpServers"))
            } else {
                (Some(false), None)
            }
        } else {
            (None, None)
        };
        rows.push(EffectiveMcpServer {
            name: name.to_owned(),
            scope,
            file: file.display().to_string(),
            config: config.pretty(),
            transport: transport_of(config),
            approved,
            approved_by,
            shadowed_by,
        });
    };

    for (name, config) in servers_in(per_project) {
        add(name, McpScope::Local, global, config);
    }
    let project_doc = read_object(&project_file);
    for (name, config) in servers_in(project_doc.as_ref()) {
        add(name, McpScope::Project, &project_file, config);
    }
    for (name, config) in servers_in(global_doc.as_ref()) {
        add(name, McpScope::User, global, config);
    }
    rows.sort_by(|a, b| {
        compare_names(&a.name, &b.name).then_with(|| scope_name(a.scope).cmp(scope_name(b.scope)))
    });
    rows
}

fn file_bytes(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .ok()
        .filter(std::fs::Metadata::is_file)
        .map(|meta| meta.len())
}

/// The view for `input`, from the agent's files as `backend` lists them.
pub fn effective_view(
    backend: &dyn AgentBackend,
    agent: &AgentConfig,
    input: &EffectiveInput,
) -> EffectiveView {
    let cwd = normalize(&input.cwd);
    let user_dir = normalize(&agent.config_dir);
    let mut warnings = Vec::new();

    let mut overlay_paths: Vec<PathBuf> = Vec::new();
    for path in input.overlays.iter().map(|path| normalize(path)) {
        if !overlay_paths.contains(&path) {
            overlay_paths.push(path);
        }
    }
    // The launcher's own naming, so the prediction is its answer.
    let names = overlay_plugin_names(&overlay_paths);

    let mut entries = entries_from(backend, &user_dir, EffectiveSource::User, None);
    entries.extend(entries_from(backend, &cwd, EffectiveSource::Cwd, None));

    let mut overlays = Vec::new();
    for (index, path) in overlay_paths.iter().enumerate() {
        let name = names.get(index).cloned().unwrap_or_else(|| {
            path.file_name()
                .map(|name| name.to_string_lossy().to_lowercase())
                .unwrap_or_default()
        });
        let shown = path.display().to_string();
        if !path.is_dir() {
            warnings.push(format!(
                "{shown} is not on disk, so nothing would be composed from it."
            ));
            overlays.push(EffectiveOverlay {
                name,
                project_path: shown,
                exists: false,
                skills: 0,
                commands: 0,
                agents: 0,
                workflows: 0,
            });
            continue;
        }
        let from = entries_from(backend, path, EffectiveSource::Overlay, Some(&name));
        let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
        overlays.push(EffectiveOverlay {
            name,
            project_path: shown.clone(),
            exists: true,
            skills: count(from.skills.len()),
            commands: count(from.commands.len()),
            agents: count(from.agents.len()),
            workflows: count(from.workflows.len()),
        });
        if from.count() == 0 {
            warnings.push(format!(
                "{shown} has no skills, commands, agents or workflows to compose - only its CLAUDE.md would arrive."
            ));
        }
        entries.extend(from);
    }

    let by_invocation =
        |a: &EffectiveEntry, b: &EffectiveEntry| compare_names(&a.invocation, &b.invocation);
    entries.skills.sort_by(by_invocation);
    entries.commands.sort_by(by_invocation);
    entries.agents.sort_by(by_invocation);
    entries.workflows.sort_by(by_invocation);

    // A name more than one source carries: every copy resolves under its own
    // invocation, so this is a map, not a warning.
    let mut shared: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for entry in entries
        .skills
        .iter()
        .chain(&entries.commands)
        .chain(&entries.agents)
        .chain(&entries.workflows)
    {
        shared
            .entry(entry.name.clone())
            .or_default()
            .push(entry.invocation.clone());
    }
    let mut shared_names: Vec<SharedName> = shared
        .into_iter()
        .filter(|(_, invocations)| invocations.len() > 1)
        .map(|(name, mut invocations)| {
            invocations.sort();
            SharedName { name, invocations }
        })
        .collect();
    shared_names.sort_by(|a, b| compare_names(&a.name, &b.name));

    let chain = settings_chain(&cwd, &user_dir);
    let settings_layers = chain
        .iter()
        .map(|layer| SettingsLayer {
            kind: layer.kind,
            file: layer.file.display().to_string(),
            exists: layer.exists,
            keys: u32::try_from(layer.values.len()).unwrap_or(u32::MAX),
            error: layer.error.clone(),
        })
        .collect();
    for layer in &chain {
        if let Some(error) = &layer.error {
            warnings.push(format!(
                "{} is not valid JSON, so the CLI ignores it: {error}",
                layer.file.display()
            ));
        }
    }

    // The order a session receives them: the user's, the folder's, then each
    // overlay's through `--append-system-prompt-file`. An overlay at or above
    // the folder arrives once, from the agent's own walk up from it.
    let mut instructions = Vec::new();
    let mut add_instruction = |path: PathBuf, source: EffectiveSource, origin: &Path| {
        if let Some(bytes) = file_bytes(&path) {
            instructions.push(EffectiveInstruction {
                path: path.display().to_string(),
                source,
                bytes,
                origin: origin.display().to_string(),
            });
        }
    };
    add_instruction(user_dir.join("CLAUDE.md"), EffectiveSource::User, &user_dir);
    add_instruction(cwd.join("CLAUDE.md"), EffectiveSource::Cwd, &cwd);
    for overlay in overlays.iter().filter(|overlay| overlay.exists) {
        let path = PathBuf::from(&overlay.project_path);
        if !is_same_or_ancestor(&path, &cwd) {
            add_instruction(path.join("CLAUDE.md"), EffectiveSource::Overlay, &path);
        } else if path != cwd {
            add_instruction(path.join("CLAUDE.md"), EffectiveSource::Cwd, &path);
        }
    }

    EffectiveView {
        cwd: cwd.display().to_string(),
        profile_id: input.profile_id,
        profile_name: input.profile_name.clone(),
        overlays,
        skills: entries.skills,
        commands: entries.commands,
        agents: entries.agents,
        workflows: entries.workflows,
        shared_names,
        settings: resolve_settings(&chain),
        mcp_servers: effective_mcp(&cwd, &chain, &agent.global_config),
        settings_layers,
        instructions,
        warnings,
        computed_at: now_iso(),
    }
}
