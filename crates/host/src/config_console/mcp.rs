//! MCP servers, managed by running the agent's own CLI rather than editing
//! its files: `claude mcp add-json` and `remove` own three files depending on
//! scope, in shapes that are the CLI's to change. The console only predicts
//! the result well enough to show a diff first, and re-reads the file after
//! the CLI has run.

use std::path::{Path, PathBuf};

use floti_protocol::channels::workspace::{
    McpAddRequest, McpDiffLine, McpDiffSign, McpPreview, McpScope,
};

use super::AgentConfig;
use super::files::{normalize, read_file};
use super::json::Json;

/// The file a scope's command rewrites: the folder's `.mcp.json` for
/// `project`, the agent's global config for `local` and `user`.
pub fn target_file(agent: &AgentConfig, scope: McpScope, cwd: &Path) -> PathBuf {
    match scope {
        McpScope::Project => normalize(cwd).join(".mcp.json"),
        McpScope::Local | McpScope::User => agent.global_config.clone(),
    }
}

pub fn scope_flag(scope: McpScope) -> &'static str {
    match scope {
        McpScope::Local => "local",
        McpScope::User => "user",
        McpScope::Project => "project",
    }
}

/// A line diff by longest common subsequence. The trailing newline of each
/// side is dropped, so a file ending in one shows no added blank line.
pub fn diff_lines(before: &str, after: &str) -> Vec<McpDiffLine> {
    let split = |text: &str| -> Vec<String> {
        if text.is_empty() {
            return Vec::new();
        }
        let text = text.replace("\r\n", "\n");
        let text = text.strip_suffix('\n').unwrap_or(&text);
        text.split('\n').map(str::to_owned).collect()
    };
    let (a, b) = (split(before), split(after));
    let mut lcs = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            lcs[i][j] = if a[i] == b[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }
    let line = |sign, text: &str| McpDiffLine {
        sign,
        text: text.to_owned(),
    };
    let mut out = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        if a[i] == b[j] {
            out.push(line(McpDiffSign::Kept, &a[i]));
            i += 1;
            j += 1;
        } else if lcs[i + 1][j] >= lcs[i][j + 1] {
            out.push(line(McpDiffSign::Removed, &a[i]));
            i += 1;
        } else {
            out.push(line(McpDiffSign::Added, &b[j]));
            j += 1;
        }
    }
    out.extend(a[i..].iter().map(|text| line(McpDiffSign::Removed, text)));
    out.extend(b[j..].iter().map(|text| line(McpDiffSign::Added, text)));
    out
}

/// What the target file would hold with this server in it, merged as the
/// CLI merges it: into `mcpServers` by name, replacing an entry of the same
/// name whole.
pub fn preview(agent: &AgentConfig, request: &McpAddRequest) -> McpPreview {
    let cwd = Path::new(&request.cwd);
    let file = target_file(agent, request.scope, cwd);
    let current = read_file(&file);
    let before = if current.exists {
        current.content
    } else {
        String::new()
    };
    let shown = file.display().to_string();
    let refuse = |error: String| McpPreview {
        file: shown.clone(),
        before: before.clone(),
        after: before.clone(),
        diff: Vec::new(),
        replaces: None,
        error: Some(error),
    };

    let Some(server) = Json::parse_object(&request.json) else {
        return refuse(
            "The server configuration must be a JSON object, e.g. {\"command\":\"node\",\"args\":[\"server.js\"]}."
                .to_owned(),
        );
    };
    if request.name.trim().is_empty() {
        return refuse("A server needs a name.".to_owned());
    }
    let cannot_predict = || {
        refuse(format!(
            "{shown} is not a JSON object, so Floti cannot predict what the CLI would write into it."
        ))
    };
    let Some(mut next) = Json::parse_object(&before) else {
        return cannot_predict();
    };

    // `local` and `user` differ only in where in the global config the
    // server lands: under this folder's entry for `local`, at the top for
    // `user`. A project's `.mcp.json` holds only `mcpServers`.
    let key = normalize(cwd).display().to_string();
    let container = match request.scope {
        McpScope::Local => next
            .object_at("projects")
            .and_then(|projects| projects.object_at(&key)),
        McpScope::User | McpScope::Project => Some(&mut next),
    };
    let Some(servers) = container.and_then(|container| container.object_at("mcpServers")) else {
        return cannot_predict();
    };
    let replaces = servers.get(&request.name).map(Json::pretty);
    servers.set(&request.name, server);

    let after = format!("{}\n", next.pretty());
    McpPreview {
        diff: diff_lines(&before, &after),
        file: shown,
        before,
        after,
        replaces,
        error: None,
    }
}

/// `settings.local.json` with `name` approved or revoked for the project,
/// or the sentence for why it cannot be. Approval is a decision about this
/// machine, so it goes in the local file a repository does not commit.
pub fn approval(current: &str, file: &Path, name: &str, approved: bool) -> Result<String, String> {
    let mut document = if current.trim().is_empty() {
        Json::Object(Vec::new())
    } else {
        match Json::parse(current) {
            Ok(document) if document.is_object() => document,
            _ => {
                return Err(format!(
                    "{} is not a JSON object, so Floti will not add a key to it.",
                    file.display()
                ));
            }
        }
    };
    let list = |document: &Json, key: &str| {
        let mut names = document.get(key).map(Json::strings).unwrap_or_default();
        names.sort();
        names.dedup();
        names
    };
    let mut enabled = list(&document, "enabledMcpjsonServers");
    let mut disabled = list(&document, "disabledMcpjsonServers");
    let (add_to, take_from) = if approved {
        (&mut enabled, &mut disabled)
    } else {
        (&mut disabled, &mut enabled)
    };
    take_from.retain(|n| n != name);
    if !add_to.iter().any(|n| n == name) {
        add_to.push(name.to_owned());
    }
    let sorted = |mut names: Vec<String>| {
        names.sort_by(|a, b| super::compare_names(a, b));
        Json::Array(names.into_iter().map(Json::String).collect())
    };
    document.set("enabledMcpjsonServers", sorted(enabled));
    if disabled.is_empty() {
        document.remove("disabledMcpjsonServers");
    } else {
        document.set("disabledMcpjsonServers", sorted(disabled));
    }
    Ok(format!("{}\n", document.pretty()))
}
