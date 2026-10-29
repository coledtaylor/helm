//! A plugin as a client draws it: [`PluginInfo`], shaped as today's
//! `core/plugins/info.ts` shapes it.
//!
//! A page is `floti-plugin://<id>/<entry>`, one origin per plugin. A
//! folder that did not load is still listed, with its error and every
//! surface empty. Status and badge show only while the plugin is on.

use std::collections::BTreeMap;

use floti_protocol::channels::plugins::{
    PluginAgentInfo, PluginBackgroundInfo, PluginBackgroundState, PluginExecInfo, PluginInfo,
    PluginPanelInfo, PluginSecretInfo, PluginServiceInfo, PluginServiceState, PluginSettingValue,
    PluginStatusItem, PluginTabInfo, PluginToolInfo,
};

use super::loader::{LoadFailure, LoadedPlugin};
use super::secrets::SecretsAccess;
use super::store::PluginFolder;

/// The scheme plugin pages are served on.
pub const PLUGIN_SCHEME: &str = "floti-plugin";

/// What a plugin's MCP server is called in a session, before its id: the
/// SDK's `AGENT_SERVER_PREFIX`, which its tool-name limits are counted with.
pub const AGENT_SERVER_PREFIX: &str = "helm-plugin-";

/// What is happening to one registered folder now.
pub struct Live<'a> {
    pub folder: &'a PluginFolder,
    pub revision: u64,
    pub status: Option<&'a PluginStatusItem>,
    pub badge: Option<u32>,
    pub background: PluginBackgroundState,
    pub background_error: Option<&'a str>,
}

/// A page's address on the plugin's origin, each segment of its entry
/// encoded as `encodeURIComponent` encodes it.
pub fn page_url(id: &str, entry: &str) -> String {
    let path: Vec<String> = entry.split('/').map(encode_component).collect();
    format!("{PLUGIN_SCHEME}://{id}/{}", path.join("/"))
}

fn encode_component(segment: &str) -> String {
    const KEPT: &[u8] = b"-_.!~*'()";
    let mut out = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        if byte.is_ascii_alphanumeric() || KEPT.contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// A folder that did not load.
pub fn failed(live: &Live<'_>, failure: &LoadFailure) -> PluginInfo {
    PluginInfo {
        path: live.folder.path.clone(),
        id: failure.id.clone(),
        name: failure
            .name
            .clone()
            .unwrap_or_else(|| live.folder.path.clone()),
        version: None,
        description: None,
        enabled: live.folder.enabled,
        error: Some(failure.error.clone()),
        warnings: failure.warnings.clone(),
        revision: live.revision,
        icon: None,
        rail: None,
        panels: BTreeMap::new(),
        tabs: BTreeMap::new(),
        page_strip: false,
        background: None,
        commands: Vec::new(),
        settings: Vec::new(),
        setting_values: BTreeMap::new(),
        network: Vec::new(),
        secrets: Vec::new(),
        exec: Vec::new(),
        service: None,
        runs_programs: false,
        agent: None,
        starts_sessions: false,
        sees_sessions: false,
        status: live.folder.enabled.then(|| live.status.cloned()).flatten(),
        badge: live.folder.enabled.then_some(live.badge).flatten(),
    }
}

/// A folder that loaded.
pub fn loaded(
    live: &Live<'_>,
    plugin: &LoadedPlugin,
    setting_values: BTreeMap<String, PluginSettingValue>,
    secrets: &dyn SecretsAccess,
) -> PluginInfo {
    let manifest = &plugin.manifest;
    let id = manifest.id.as_str();
    PluginInfo {
        path: live.folder.path.clone(),
        id: Some(manifest.id.clone()),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        description: manifest.description.clone(),
        enabled: live.folder.enabled,
        error: None,
        warnings: plugin.warnings.clone(),
        revision: live.revision,
        icon: plugin.icon.clone(),
        rail: manifest.rail.clone(),
        panels: manifest
            .panels
            .iter()
            .map(|(key, panel)| {
                let info = PluginPanelInfo {
                    title: panel.title.clone(),
                    url: page_url(id, &panel.entry),
                    actions: panel.actions.clone(),
                };
                (key.clone(), info)
            })
            .collect(),
        tabs: manifest
            .tabs
            .iter()
            .map(|(key, tab)| {
                let info = PluginTabInfo {
                    title: tab.title.clone(),
                    url: page_url(id, &tab.entry),
                };
                (key.clone(), info)
            })
            .collect(),
        page_strip: manifest.page_strip,
        background: manifest
            .background
            .as_deref()
            .map(|module| PluginBackgroundInfo {
                url: page_url(id, module),
                state: live.background,
                error: live.background_error.map(str::to_owned),
            }),
        commands: manifest.commands.clone(),
        settings: manifest.settings.clone(),
        setting_values,
        network: manifest
            .network
            .iter()
            .map(|pattern| pattern.origin.clone())
            .collect(),
        secrets: manifest
            .secrets
            .iter()
            .map(|key| PluginSecretInfo {
                key: key.clone(),
                state: secrets.state(id, key),
            })
            .collect(),
        exec: manifest
            .exec
            .iter()
            .map(|spec| PluginExecInfo {
                name: spec.name.clone(),
                command: spec.command.clone(),
                args: spec.args.clone(),
            })
            .collect(),
        service: manifest.service.as_ref().map(|service| PluginServiceInfo {
            kind: service.kind,
            command: service.command.clone(),
            start: service.start,
            state: PluginServiceState::Stopped,
            pid: None,
            port: None,
            restarts: 0,
            error: None,
        }),
        runs_programs: !manifest.exec.is_empty() || manifest.service.is_some(),
        agent: manifest.agent.as_ref().map(|agent| PluginAgentInfo {
            enabled: live.folder.tools_enabled,
            server: format!("{AGENT_SERVER_PREFIX}{id}"),
            instructions: agent.instructions.clone(),
            tools: agent
                .tools
                .iter()
                .map(|tool| PluginToolInfo {
                    name: tool.name.clone(),
                    description: tool.description.clone(),
                })
                .collect(),
        }),
        starts_sessions: manifest.sessions.start,
        sees_sessions: manifest.sessions.list,
        status: live.folder.enabled.then(|| live.status.cloned()).flatten(),
        badge: live.folder.enabled.then_some(live.badge).flatten(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_is_on_the_plugins_own_origin_with_each_segment_encoded() {
        assert_eq!(
            page_url("factory", "dist/tabs/run board.html"),
            "floti-plugin://factory/dist/tabs/run%20board.html"
        );
        assert_eq!(
            page_url("x", "a/é#?.js"),
            "floti-plugin://x/a/%C3%A9%23%3F.js"
        );
    }
}
