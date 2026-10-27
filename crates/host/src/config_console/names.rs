//! What a config file may be called, where a new one goes and what is in it.
//!
//! "How the agent would address it" is the whole rule: a skill by its
//! folder, a command by its path, colon-separated (`commands/spec/plan.md`
//! is `/spec:plan`), a settings file only by the exact name the CLI looks
//! for. A client checks these as the user types; the host checks them again,
//! because the check that counts is the one beside the write.

use floti_protocol::channels::workspace::{ConfigFile, ConfigFileKind, CreatableKind};

/// The kinds a rename applies to: those whose name is their address.
pub fn is_renamable(kind: ConfigFileKind) -> bool {
    matches!(
        kind,
        ConfigFileKind::Skill
            | ConfigFileKind::Command
            | ConfigFileKind::Agent
            | ConfigFileKind::Rule
    )
}

/// Why `kind` cannot be renamed, in a sentence.
pub fn rename_refusal(kind: ConfigFileKind) -> Option<&'static str> {
    if is_renamable(kind) {
        return None;
    }
    Some(match kind {
        ConfigFileKind::Hook | ConfigFileKind::Other => {
            "Claude Code addresses this file by its path rather than by a name, and its extension matters to whatever runs it. Rename it in your file manager."
        }
        _ => {
            "Claude Code finds this file by its exact name, so renaming it would stop it being read at all."
        }
    })
}

/// The longest one step of a name may be.
const MAX_SEGMENT: usize = 64;

/// The deepest a name may go: the tree walk lists no deeper.
const MAX_SEGMENTS: usize = 5;

/// Names Windows gives no file, whatever the API says.
fn reserved_device(segment: &str) -> bool {
    matches!(segment, "con" | "prn" | "aux" | "nul")
        || ["com", "lpt"].iter().any(|prefix| {
            segment.len() == 4
                && segment.starts_with(prefix)
                && segment.as_bytes()[3].is_ascii_digit()
                && segment.as_bytes()[3] != b'0'
        })
}

/// Lowercase letters and digits, with single hyphens between them.
fn plain_segment(segment: &str) -> bool {
    !segment.is_empty()
        && !segment.starts_with('-')
        && !segment.ends_with('-')
        && !segment.contains("--")
        && segment
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// A typed name split into its steps, or the sentence naming the rule it
/// broke. `:`, `/` and `\` all separate steps: a command is shown as
/// `spec:plan` and stored as `spec/plan.md`.
pub fn check_name(kind: ConfigFileKind, raw: &str) -> Result<Vec<String>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Give it a name.".to_owned());
    }
    let segments: Vec<String> = trimmed.split([':', '/', '\\']).map(str::to_owned).collect();
    if kind == ConfigFileKind::Skill && segments.len() > 1 {
        return Err(
            "A skill name is a single word - the folder it lives in. Skills are not namespaced by path."
                .to_owned(),
        );
    }
    if segments.len() > MAX_SEGMENTS {
        return Err(format!(
            "That is {} levels deep; {MAX_SEGMENTS} is the most.",
            segments.len()
        ));
    }
    for segment in &segments {
        if segment.is_empty() {
            return Err(
                "An empty step in the name - two separators together, or one at an end.".to_owned(),
            );
        }
        if segment.chars().count() > MAX_SEGMENT {
            return Err(format!(
                "\"{segment}\" is longer than {MAX_SEGMENT} characters."
            ));
        }
        if reserved_device(segment) {
            return Err(format!(
                "Windows reserves \"{segment}\" for a device and will not name a file that."
            ));
        }
        if !plain_segment(segment) {
            return Err(
                "Lowercase letters, digits and single hyphens between them - that is how the CLI addresses one of these."
                    .to_owned(),
            );
        }
    }
    Ok(segments)
}

/// Where a new file goes and what goes in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilePlan {
    /// Relative to the scope's base folder, forward-slashed, as
    /// `ConfigFile::rel_path` is.
    pub rel_path: String,
    /// For a skill, the folder that carries its name.
    pub dir_rel_path: Option<String>,
    /// How the agent addresses it: `/spec:plan`, `think`, `settings.json`.
    pub address: String,
    /// The scaffold, newline-terminated.
    pub content: String,
}

/// The `.claude` prefix, which the user scope has none of: its base folder
/// is the config folder.
fn inside(user_scope: bool, parts: &[&str]) -> String {
    let mut all: Vec<&str> = if user_scope {
        Vec::new()
    } else {
        vec![".claude"]
    };
    all.extend_from_slice(parts);
    all.join("/")
}

pub fn kind_of(kind: CreatableKind) -> ConfigFileKind {
    match kind {
        CreatableKind::Skill => ConfigFileKind::Skill,
        CreatableKind::Command => ConfigFileKind::Command,
        CreatableKind::Agent => ConfigFileKind::Agent,
        CreatableKind::Rule => ConfigFileKind::Rule,
        CreatableKind::Settings => ConfigFileKind::Settings,
        CreatableKind::SettingsLocal => ConfigFileKind::SettingsLocal,
        CreatableKind::ClaudeMd => ConfigFileKind::ClaudeMd,
        CreatableKind::Mcp => ConfigFileKind::Mcp,
    }
}

/// The creatable kind a listed file is, for the kinds a rename re-plans.
pub fn creatable(kind: ConfigFileKind) -> Option<CreatableKind> {
    Some(match kind {
        ConfigFileKind::Skill => CreatableKind::Skill,
        ConfigFileKind::Command => CreatableKind::Command,
        ConfigFileKind::Agent => CreatableKind::Agent,
        ConfigFileKind::Rule => CreatableKind::Rule,
        _ => return None,
    })
}

/// Where a new file of `kind` called `name` goes in a scope, and its
/// scaffold: the smallest file the agent loads, with the field that decides
/// whether it is used filled in with a sentence saying so.
pub fn plan_file(kind: CreatableKind, name: &str, user_scope: bool) -> Result<FilePlan, String> {
    match kind {
        CreatableKind::Mcp if user_scope => {
            return Err("A .mcp.json is read from a project folder. The user scope has none - user MCP servers live in ~/.claude.json, which the MCP tab manages.".to_owned());
        }
        CreatableKind::SettingsLocal if user_scope => {
            return Err("A settings.local.json is the project-local layer. The user scope is the layer underneath it, and its file is settings.json.".to_owned());
        }
        _ => {}
    }

    let fixed = |rel_path: String, address: &str, content: String| FilePlan {
        rel_path,
        dir_rel_path: None,
        address: address.to_owned(),
        content,
    };
    match kind {
        CreatableKind::Settings => {
            return Ok(fixed(
                inside(user_scope, &["settings.json"]),
                "settings.json",
                "{}\n".to_owned(),
            ));
        }
        CreatableKind::SettingsLocal => {
            return Ok(fixed(
                inside(user_scope, &["settings.local.json"]),
                "settings.local.json",
                "{}\n".to_owned(),
            ));
        }
        // Beside `.claude` for a project and inside it for the user scope,
        // which is the same path from each scope's own base.
        CreatableKind::ClaudeMd => {
            return Ok(fixed(
                "CLAUDE.md".to_owned(),
                "CLAUDE.md",
                claude_md_scaffold(),
            ));
        }
        CreatableKind::Mcp => {
            return Ok(fixed(
                ".mcp.json".to_owned(),
                ".mcp.json",
                "{\n  \"mcpServers\": {}\n}\n".to_owned(),
            ));
        }
        _ => {}
    }

    let segments = check_name(kind_of(kind), name)?;
    let leaf = segments.last().cloned().unwrap_or_default();
    if kind == CreatableKind::Skill {
        let dir = inside(user_scope, &["skills", &leaf]);
        return Ok(FilePlan {
            rel_path: format!("{dir}/SKILL.md"),
            dir_rel_path: Some(dir),
            content: skill_scaffold(&leaf),
            address: leaf,
        });
    }
    let folder = match kind {
        CreatableKind::Command => "commands",
        CreatableKind::Agent => "agents",
        _ => "rules",
    };
    let file = format!("{}.md", segments.join("/"));
    let rel_path = inside(user_scope, &[folder, &file]);
    let (address, content) = match kind {
        CreatableKind::Command => {
            let address = format!("/{}", segments.join(":"));
            let content = command_scaffold(&address);
            (address, content)
        }
        CreatableKind::Agent => (segments.join("/"), agent_scaffold(&leaf)),
        _ => (segments.join("/"), rule_scaffold(&leaf)),
    };
    Ok(FilePlan {
        rel_path,
        dir_rel_path: None,
        address,
        content,
    })
}

// No `: ` in any frontmatter value below: in YAML that makes a mapping, and
// the file would not load.

fn skill_scaffold(name: &str) -> String {
    [
        "---".to_owned(),
        format!("name: {name}"),
        "description: What this skill does and when Claude should load it. This line is the only part read while deciding, so it is what makes the skill get used.".to_owned(),
        "---".to_owned(),
        String::new(),
        format!("# {name}"),
        String::new(),
        "Replace this with the instructions themselves.".to_owned(),
        String::new(),
    ]
    .join("\n")
}

fn command_scaffold(address: &str) -> String {
    [
        "---".to_owned(),
        format!("description: What {address} does, as one line for the slash-command menu."),
        "---".to_owned(),
        String::new(),
        "Replace this with the prompt this command runs.".to_owned(),
        String::new(),
        "$ARGUMENTS is whatever was typed after the command name.".to_owned(),
        String::new(),
    ]
    .join("\n")
}

fn agent_scaffold(name: &str) -> String {
    [
        "---".to_owned(),
        format!("name: {name}"),
        "description: When to hand work to this agent and what it is good at. The main agent reads this line to decide whether to delegate.".to_owned(),
        "---".to_owned(),
        String::new(),
        "Replace this with the agent's own system prompt.".to_owned(),
        String::new(),
    ]
    .join("\n")
}

fn rule_scaffold(name: &str) -> String {
    format!("# {name}\n\nReplace this with the rule, stated as an instruction.\n")
}

fn claude_md_scaffold() -> String {
    "# Instructions\n\nEverything here is read by every session started in this scope.\n".to_owned()
}

/// Every file the console addresses as one entry: a skill's whole folder,
/// its `SKILL.md` first, or the one file for every other kind. Taken from
/// the tree's own listing, so what a confirmation names and what the write
/// acts on are the same set.
pub fn config_unit<'a>(files: &'a [ConfigFile], file: &'a ConfigFile) -> Vec<&'a ConfigFile> {
    if file.kind != ConfigFileKind::Skill {
        return vec![file];
    }
    let Some(slash) = file.rel_path.rfind('/') else {
        return vec![file];
    };
    let prefix = format!("{}/", file.rel_path[..slash].to_lowercase());
    let mut unit = vec![file];
    unit.extend(files.iter().filter(|candidate| {
        candidate.path != file.path && candidate.rel_path.to_lowercase().starts_with(&prefix)
    }));
    unit
}

/// A frontmatter block: its flat `key: value` pairs and the 1-based line
/// its closing fence is on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frontmatter {
    pub fields: Vec<(String, String)>,
    pub end_line: usize,
}

/// The block between `---` fences at the top of `text`, tolerating a BOM
/// and CRLF. Indented lines and keys with no value are skipped.
pub fn parse_frontmatter(text: &str) -> Option<Frontmatter> {
    let body = text.strip_prefix('\u{feff}').unwrap_or(text);
    let lines: Vec<&str> = body.split('\n').collect();
    let clean = |line: &str| line.strip_suffix('\r').unwrap_or(line).to_owned();
    if clean(lines.first()?).trim() != "---" {
        return None;
    }
    let end = (1..lines.len()).find(|&i| clean(lines[i]).trim() == "---")?;
    let fields = lines[1..end]
        .iter()
        .filter_map(|line| {
            let line = clean(line);
            if line.starts_with(char::is_whitespace) {
                return None;
            }
            let (key, value) = line.split_once(':')?;
            let key = key.trim_end();
            let valid = !key.is_empty()
                && key
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
            if !valid {
                return None;
            }
            let value = value.trim();
            let value = value.strip_prefix(['\'', '"']).unwrap_or(value);
            let value = value.strip_suffix(['\'', '"']).unwrap_or(value);
            (!value.is_empty()).then(|| (key.to_owned(), value.to_owned()))
        })
        .collect();
    Some(Frontmatter {
        fields,
        end_line: end + 1,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_is_read_between_its_fences_tolerating_a_bom_and_crlf() {
        let parsed = parse_frontmatter("\u{feff}---\r\nname: think\r\ndescription: 'Ponder.'\r\n  nested: x\r\nempty:\r\n---\r\nbody").unwrap();
        assert_eq!(
            parsed.fields,
            vec![
                ("name".to_owned(), "think".to_owned()),
                ("description".to_owned(), "Ponder.".to_owned())
            ]
        );
        assert_eq!(parsed.end_line, 6);
        assert_eq!(parse_frontmatter("no fence"), None);
        assert_eq!(parse_frontmatter("---\nname: open"), None);
    }
}
