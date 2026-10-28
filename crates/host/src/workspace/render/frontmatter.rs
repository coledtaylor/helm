//! The YAML block at the top of a note, parsed for display.
//!
//! A block that will not parse is still `present`, still taken off the body
//! and carries its error, so frontmatter never reaches the renderer as three
//! dashes and a heading. An opening fence with no closing one is a document
//! that starts with a rule, not frontmatter.

use floti_protocol::channels::workspace::ContentChip;
use serde_yaml_ng::{Mapping, Value};

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedFrontmatter {
    pub present: bool,
    /// The text between the fences, without them.
    pub raw: String,
    /// The document after the closing fence.
    pub body: String,
    /// The 1-based line the closing fence sits on; 0 with no block.
    pub end_line: u32,
    pub fields: Vec<ContentChip>,
    /// The parsed block, when it parsed.
    pub data: Option<Mapping>,
    pub error: Option<String>,
}

/// Keys shown first, in this order; the rest follow in file order.
const LEADING_KEYS: [&str; 4] = ["title", "type", "date", "tags"];

/// Splits the block off `source`, tolerating a BOM and CRLF.
pub fn parse_note_frontmatter(source: &str) -> ParsedFrontmatter {
    let text = source.strip_prefix('\u{feff}').unwrap_or(source);
    let absent = || ParsedFrontmatter {
        present: false,
        raw: String::new(),
        body: text.to_owned(),
        end_line: 0,
        fields: Vec::new(),
        data: None,
        error: None,
    };
    let lines: Vec<&str> = text.split('\n').collect();
    let fence = |line: &str| line.strip_suffix('\r').unwrap_or(line).trim().to_owned();
    if lines.first().map(|line| fence(line)).as_deref() != Some("---") {
        return absent();
    }
    let Some(end) = (1..lines.len()).find(|&i| matches!(fence(lines[i]).as_str(), "---" | "..."))
    else {
        return absent();
    };

    let raw = lines[1..end]
        .iter()
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect::<Vec<_>>()
        .join("\n");
    let body = lines[end + 1..].join("\n");

    let parsed =
        serde_yaml_ng::from_str::<Value>(if raw.is_empty() { "{}" } else { &raw }).map(|value| {
            match value {
                Value::Tagged(tagged) => tagged.value,
                other => other,
            }
        });
    let (data, error) = match parsed {
        Ok(Value::Null) => (Some(Mapping::new()), None),
        Ok(Value::Mapping(mapping)) => (Some(mapping), None),
        Ok(_) => (
            None,
            Some("The frontmatter is not a set of key/value pairs.".to_owned()),
        ),
        Err(err) => (
            None,
            Some(
                err.to_string()
                    .lines()
                    .next()
                    .unwrap_or("Unparseable")
                    .to_owned(),
            ),
        ),
    };

    ParsedFrontmatter {
        present: true,
        raw,
        body,
        end_line: u32::try_from(end + 1).unwrap_or(u32::MAX),
        fields: data.as_ref().map(chips_for).unwrap_or_default(),
        data,
        error,
    }
}

/// One frontmatter value as a string, for a list row.
pub fn frontmatter_string(data: Option<&Mapping>, key: &str) -> Option<String> {
    let value = data?.get(key)?;
    if value.is_null() {
        return None;
    }
    let text = scalar(value);
    (!text.is_empty()).then_some(text)
}

/// `tags: [a, b]`, `tags: a, b` or a block sequence, each as a list.
pub fn frontmatter_tags(data: Option<&Mapping>) -> Vec<String> {
    let Some(value) = data.and_then(|data| data.get("tags")) else {
        return Vec::new();
    };
    let list: Vec<String> = match value {
        Value::Null => return Vec::new(),
        Value::Sequence(items) => items.iter().map(scalar).collect(),
        other => scalar(other).split(',').map(str::to_owned).collect(),
    };
    list.iter()
        .map(|tag| {
            let tag = tag.trim();
            tag.strip_prefix('#').unwrap_or(tag).to_owned()
        })
        .filter(|tag| !tag.is_empty())
        .collect()
}

fn chips_for(data: &Mapping) -> Vec<ContentChip> {
    let entries: Vec<(String, &Value)> = data
        .iter()
        .map(|(key, value)| (scalar(key), value))
        .collect();
    let leading = LEADING_KEYS
        .iter()
        .filter_map(|key| entries.iter().find(|(name, _)| name == key));
    let rest = entries
        .iter()
        .filter(|(name, _)| !LEADING_KEYS.contains(&name.as_str()));
    let mut chips = Vec::new();
    for (key, value) in leading.chain(rest) {
        if value.is_null() {
            continue;
        }
        let values: Vec<String> = match value {
            Value::Sequence(items) => items.iter().map(scalar).filter(|v| !v.is_empty()).collect(),
            other => Some(scalar(other))
                .filter(|v| !v.is_empty())
                .into_iter()
                .collect(),
        };
        if values.is_empty() {
            continue;
        }
        chips.push(ContentChip {
            key: key.clone(),
            value: values.join(", "),
            values,
        });
    }
    chips
}

/// One value as a chip shows it: a list joined, a map as JSON.
fn scalar(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number_text(number),
        Value::String(text) => text.clone(),
        Value::Sequence(items) => items
            .iter()
            .map(scalar)
            .filter(|v| !v.is_empty())
            .collect::<Vec<_>>()
            .join(", "),
        Value::Mapping(_) => serde_json::to_string(value).unwrap_or_default(),
        Value::Tagged(tagged) => scalar(&tagged.value),
    }
}

/// A number as JavaScript writes it: `1`, not `1.0`.
fn number_text(number: &serde_yaml_ng::Number) -> String {
    if let Some(n) = number.as_i64() {
        return n.to_string();
    }
    if let Some(n) = number.as_u64() {
        return n.to_string();
    }
    let n = number.as_f64().unwrap_or(f64::NAN);
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    format!("{n}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leading_keys_come_first_and_the_rest_keep_file_order() {
        let parsed = parse_note_frontmatter(
            "---\nstatus: open\ntags: [a, '#b']\nowner: me\ntype: journal\nversion: 1.0\n---\nbody\n",
        );
        let keys: Vec<&str> = parsed.fields.iter().map(|chip| chip.key.as_str()).collect();
        assert_eq!(keys, ["type", "tags", "status", "owner", "version"]);
        assert_eq!(parsed.fields[4].value, "1");
        assert_eq!(frontmatter_tags(parsed.data.as_ref()), ["a", "b"]);
        assert_eq!(parsed.end_line, 7);
    }

    #[test]
    fn a_bom_and_crlf_still_open_a_block_and_a_quoted_date_is_its_text() {
        let parsed =
            parse_note_frontmatter("\u{feff}---\r\ndate: \"2026-08-10\"\r\n---\r\n# T\r\n");
        assert!(parsed.present);
        assert_eq!(
            frontmatter_string(parsed.data.as_ref(), "date").as_deref(),
            Some("2026-08-10")
        );
        assert_eq!(parsed.body, "# T\r\n");
    }

    #[test]
    fn a_block_that_is_not_a_map_says_so() {
        let parsed = parse_note_frontmatter("---\n- a\n- b\n---\nbody\n");
        assert!(parsed.present);
        assert_eq!(
            parsed.error.as_deref(),
            Some("The frontmatter is not a set of key/value pairs.")
        );
        assert!(parsed.fields.is_empty());
    }
}
