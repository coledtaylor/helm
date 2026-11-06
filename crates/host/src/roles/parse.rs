//! A role file read: YAML front matter between `---` lines, then the body.
//!
//! The front matter is split as a note's is (`workspace::render::frontmatter`)
//! and parsed with `serde_yaml_ng`. **A file that is not exactly a role is
//! bad, never half a role**: a front matter that does not parse, a key no role
//! has and a value outside its field's choices each make the whole file bad,
//! with every problem named, because a typo such as `disalowed_tools` must
//! never quietly drop a rule.

use std::collections::BTreeMap;

use floti_protocol::BackendId;
use floti_protocol::channels::common::PermissionMode;
use floti_protocol::channels::sessions::EffortLevel;
use serde_yaml_ng::{Mapping, Value};

use super::{Role, RoleClass};
use crate::workspace::render::frontmatter::parse_note_frontmatter;

/// The fields a role file has.
pub const FIELDS: &[&str] = &[
    "description",
    "profile",
    "backend",
    "model",
    "effort",
    "permission",
    "class",
    "worktree",
    "can_start",
    "allowed_tools",
    "disallowed_tools",
    "command",
    "submit",
    "stop",
];

/// The efforts a role may give.
const EFFORTS: &str = "low, medium, high, xhigh or max";

/// The permission modes a role may ask for.
const PERMISSIONS: &str = "plan, dont-ask, manual, accept-edits, auto or bypass-permissions";

/// The role `name` that `source` (the text of `<name>.md`) describes, or every
/// problem with it, joined, as a sentence fragment.
///
/// # Errors
///
/// What is wrong with the file, when anything is.
pub fn parse_role(name: &str, source: &str) -> Result<Role, String> {
    let front = parse_note_frontmatter(source);
    if !front.present {
        let text = source.strip_prefix('\u{feff}').unwrap_or(source);
        return Err(if text.trim_start().starts_with("---") {
            "its front matter must start on the file's first line with --- and end with a --- line"
                .to_owned()
        } else {
            "it has no front matter: a role file starts with --- lines around its fields".to_owned()
        });
    }
    if let Some(error) = front.error {
        return Err(format!("its front matter does not parse: {error}"));
    }
    let fields = front.data.unwrap_or_default();

    let mut role = Role::new(name, []);
    role.instructions = front.body.trim().to_owned();
    let mut problems: Vec<String> = Vec::new();
    for (key, value) in &fields {
        let Some(key) = key.as_str() else {
            problems.push("a key that is not text".to_owned());
            continue;
        };
        if let Err(problem) = apply(&mut role, key, value) {
            problems.push(problem);
        }
    }
    if problems.is_empty() {
        Ok(role)
    } else {
        Err(problems.join("; "))
    }
}

/// Sets the field `key` of `role` from `value`.
fn apply(role: &mut Role, key: &str, value: &Value) -> Result<(), String> {
    match key {
        "description" => role.description = text(key, value)?.unwrap_or_default(),
        "profile" => role.profile = text(key, value)?,
        "backend" => role.backends = backends(value)?,
        "model" => role.models = keyed_text(key, value)?,
        "effort" => role.efforts = efforts(value)?,
        "permission" => role.permission = permission(value)?,
        "class" => role.class = class(value)?,
        "worktree" => role.worktree = flag(key, value)?,
        "can_start" => role.can_start = flag(key, value)?,
        "allowed_tools" => role.allowed_tools = list(key, value)?,
        "disallowed_tools" => role.disallowed_tools = list(key, value)?,
        "command" => role.command = text(key, value)?,
        "submit" => role.submit = text(key, value)?,
        "stop" => role.stop = text(key, value)?,
        other => {
            return Err(format!(
                "{other} is not a field a role has (the fields are {})",
                FIELDS.join(", ")
            ));
        }
    }
    Ok(())
}

/// A text field: nothing for a null or blank value.
fn text(key: &str, value: &Value) -> Result<Option<String>, String> {
    match value {
        Value::Null => Ok(None),
        Value::String(text) => Ok(Some(text.trim().to_owned()).filter(|text| !text.is_empty())),
        _ => Err(format!("{key} must be text")),
    }
}

/// `yes`, `no`, `true` or `false`.
fn flag(key: &str, value: &Value) -> Result<bool, String> {
    match value {
        Value::Null => Ok(false),
        Value::Bool(flag) => Ok(*flag),
        Value::String(word) => match word.trim().to_ascii_lowercase().as_str() {
            "yes" | "true" => Ok(true),
            "no" | "false" => Ok(false),
            _ => Err(format!("{key} must be yes, no, true or false, not {word}")),
        },
        _ => Err(format!("{key} must be yes, no, true or false")),
    }
}

/// A comma list or a YAML list.
fn list(key: &str, value: &Value) -> Result<Vec<String>, String> {
    let items: Vec<String> = match value {
        Value::Null => return Ok(Vec::new()),
        Value::String(text) => split_commas(text),
        Value::Sequence(items) => items
            .iter()
            .map(|item| match item {
                Value::String(text) => Ok(text.trim().to_owned()),
                _ => Err(format!("{key} must list text")),
            })
            .collect::<Result<_, _>>()?,
        _ => return Err(format!("{key} must be a comma list or a list")),
    };
    Ok(items.into_iter().filter(|item| !item.is_empty()).collect())
}

/// `text` split at the commas that are not inside parentheses, so that a
/// rule such as `Bash(git log --format=a,b:*)` stays whole.
fn split_commas(text: &str) -> Vec<String> {
    let mut items = Vec::new();
    let mut depth = 0_u32;
    let mut current = String::new();
    for c in text.chars() {
        match c {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => {
                items.push(current.trim().to_owned());
                current.clear();
                continue;
            }
            _ => {}
        }
        current.push(c);
    }
    items.push(current.trim().to_owned());
    items
}

/// One backend id or several, in order, as a comma list or a YAML list. An id
/// the host does not know is valid: it is simply not installed.
fn backends(value: &Value) -> Result<Vec<BackendId>, String> {
    let ids = list("backend", value)?;
    if matches!(value, Value::Sequence(_) | Value::String(_)) && ids.is_empty() {
        return Err(
            "backend lists no backend; leave the line out for every installed agent".into(),
        );
    }
    let mut out: Vec<BackendId> = Vec::new();
    for id in ids {
        if id.chars().any(char::is_whitespace) {
            return Err(format!("backend {id} is not a backend id"));
        }
        let id = id.to_ascii_lowercase();
        if !out.iter().any(|seen| seen.as_str() == id) {
            out.push(BackendId::new(id));
        }
    }
    Ok(out)
}

/// A map from a backend id to a text.
fn keyed_text(key: &str, value: &Value) -> Result<BTreeMap<String, String>, String> {
    let map = keyed(key, value)?;
    let mut out = BTreeMap::new();
    for (backend, item) in map {
        match item {
            Value::String(text) if !text.trim().is_empty() => {
                out.insert(backend, text.trim().to_owned());
            }
            _ => return Err(format!("{key} for {backend} must be text")),
        }
    }
    Ok(out)
}

/// A map from a backend id to an effort.
fn efforts(value: &Value) -> Result<BTreeMap<String, EffortLevel>, String> {
    let mut out = BTreeMap::new();
    for (backend, item) in keyed("effort", value)? {
        let level = item
            .as_str()
            .and_then(|word| match word.trim().to_ascii_lowercase().as_str() {
                "low" => Some(EffortLevel::Low),
                "medium" => Some(EffortLevel::Medium),
                "high" => Some(EffortLevel::High),
                "xhigh" => Some(EffortLevel::Xhigh),
                "max" => Some(EffortLevel::Max),
                _ => None,
            })
            .ok_or_else(|| format!("effort for {backend} must be {EFFORTS}"))?;
        out.insert(backend, level);
    }
    Ok(out)
}

/// A mapping's entries, keyed by a backend id (in lowercase).
fn keyed(key: &str, value: &Value) -> Result<Vec<(String, Value)>, String> {
    match value {
        Value::Null => Ok(Vec::new()),
        Value::Mapping(map) => entries(key, map),
        _ => Err(format!(
            "{key} is a map from a backend id to a value, such as claude-code: opus"
        )),
    }
}

fn entries(key: &str, map: &Mapping) -> Result<Vec<(String, Value)>, String> {
    map.iter()
        .map(|(backend, value)| match backend.as_str() {
            Some(backend) if !backend.trim().is_empty() => {
                Ok((backend.trim().to_ascii_lowercase(), value.clone()))
            }
            _ => Err(format!("{key} must be keyed by backend ids")),
        })
        .collect()
}

/// A permission mode, written with hyphens or spaces or in camelCase.
fn permission(value: &Value) -> Result<Option<PermissionMode>, String> {
    let word = match value {
        Value::Null => return Ok(None),
        Value::String(word) => word,
        _ => return Err(format!("permission must be {PERMISSIONS}")),
    };
    let squashed: String = word
        .chars()
        .filter(|c| !matches!(c, ' ' | '-' | '_' | '\''))
        .collect::<String>()
        .to_ascii_lowercase();
    match squashed.as_str() {
        "plan" => Ok(Some(PermissionMode::Plan)),
        "dontask" => Ok(Some(PermissionMode::DontAsk)),
        "manual" => Ok(Some(PermissionMode::Manual)),
        "acceptedits" => Ok(Some(PermissionMode::AcceptEdits)),
        "auto" => Ok(Some(PermissionMode::Auto)),
        "bypasspermissions" => Ok(Some(PermissionMode::BypassPermissions)),
        _ => Err(format!("permission must be {PERMISSIONS}, not {word}")),
    }
}

/// `light` or `heavy`.
fn class(value: &Value) -> Result<RoleClass, String> {
    match value {
        Value::Null => Ok(RoleClass::Light),
        Value::String(word) => match word.trim().to_ascii_lowercase().as_str() {
            "light" => Ok(RoleClass::Light),
            "heavy" => Ok(RoleClass::Heavy),
            _ => Err(format!("class must be light or heavy, not {word}")),
        },
        _ => Err("class must be light or heavy".to_owned()),
    }
}
