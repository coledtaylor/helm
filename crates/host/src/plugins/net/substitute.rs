//! Where `{{key}}` is replaced by a secret, and how the value is written
//! there: today's rules (`desktop/main/plugins/substitute.ts`).
//!
//! Pure: the secret itself arrives through `reveal`, which is where
//! permission is decided ([`crate::plugins::secrets::SecretsAccess`]). What
//! this file owns is the spelling, because a value put into a URL, a JSON
//! body and a header each has to be escaped for that place: a token with a
//! `"` in it pasted raw into JSON is a request the server cannot parse, and
//! one with a newline pasted into a header is a second header.

use std::collections::BTreeMap;

use url::Url;

use crate::plugins::call::PluginCallError;
use crate::plugins::secrets::refusal;

/// The longest key a placeholder names: the SDK's `SECRET_KEY_PATTERN`.
const KEY_MAX: usize = 64;

/// Which spellings of a placeholder a text holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Spelling {
    /// `{{key}}` only: a header, a JSON or plain text body, an environment.
    Braces,
    /// `{{key}}`, or `%7B%7Bkey%7D%7D` as a URL percent-encodes the braces
    /// in a path: a URL and a form.
    UrlForms,
}

/// The length of the opening at the start of `text`, if one is there.
fn opening(text: &str, spelling: Spelling) -> Option<usize> {
    if text.starts_with("{{") {
        Some(2)
    } else if spelling == Spelling::UrlForms
        && text.len() >= 6
        && text.is_char_boundary(6)
        && text[..6].eq_ignore_ascii_case("%7B%7B")
    {
        Some(6)
    } else {
        None
    }
}

/// The length of the closing at the start of `text`, if one is there.
fn closing(text: &str, spelling: Spelling) -> Option<usize> {
    if text.starts_with("}}") {
        Some(2)
    } else if spelling == Spelling::UrlForms
        && text.len() >= 6
        && text.is_char_boundary(6)
        && text[..6].eq_ignore_ascii_case("%7D%7D")
    {
        Some(6)
    } else {
        None
    }
}

fn is_key_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-')
}

/// The placeholder at the start of `text`: its whole length and its key.
fn placeholder_at(text: &str, spelling: Spelling) -> Option<(usize, &str)> {
    let open = opening(text, spelling)?;
    let rest = &text[open..];
    let first = *rest.as_bytes().first()?;
    if !first.is_ascii_alphanumeric() {
        return None;
    }
    let key_len = rest.bytes().take_while(|byte| is_key_char(*byte)).count();
    if key_len > KEY_MAX {
        return None;
    }
    let close = closing(&rest[key_len..], spelling)?;
    Some((open + key_len + close, &rest[..key_len]))
}

/// Every placeholder in `text` replaced by `fill`'s answer for its key, or
/// `None` when there is none.
fn replace(
    text: &str,
    spelling: Spelling,
    fill: &mut dyn FnMut(&str) -> Result<String, PluginCallError>,
) -> Result<Option<String>, PluginCallError> {
    let mut out = String::new();
    let mut copied = 0;
    let mut at = 0;
    let mut found = false;
    while at < text.len() {
        if let Some((len, key)) = placeholder_at(&text[at..], spelling) {
            out.push_str(&text[copied..at]);
            out.push_str(&fill(key)?);
            found = true;
            at += len;
            copied = at;
        } else {
            at += text[at..].chars().next().map_or(1, char::len_utf8);
        }
    }
    if !found {
        return Ok(None);
    }
    out.push_str(&text[copied..]);
    Ok(Some(out))
}

fn holds(text: &str, spelling: Spelling) -> bool {
    text.char_indices()
        .any(|(at, _)| placeholder_at(&text[at..], spelling).is_some())
}

/// Whether `text` writes a placeholder in either spelling, or anything that
/// starts one percent-encoded: what a request to a plugin's service may not
/// hold, since a service gets its secrets through its environment.
pub fn has_placeholder(text: &str) -> bool {
    holds(text, Spelling::Braces) || text.to_ascii_uppercase().contains("%7B%7B")
}

/// `encodeURIComponent`: every byte but the unreserved ones percent-encoded.
pub fn encode_uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// A key's value, or the `secret` refusal saying why not.
pub type Reveal<'a> = dyn FnMut(&str) -> Result<String, PluginCallError> + 'a;

/// A request URL with its secrets in place.
///
/// Only after the origin: a placeholder in the host or port would let a
/// secret decide where a request goes, which is the one thing the reach
/// check has to have settled before any secret is read.
pub fn substitute_url(url: &Url, reveal: &mut Reveal<'_>) -> Result<Url, PluginCallError> {
    let host = url.host_str().unwrap_or_default();
    if holds(host, Spelling::UrlForms) {
        return Err(PluginCallError::invalid(
            "a secret may not be used in the host of a URL",
        ));
    }
    let rest = match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_owned(),
    };
    let Some(filled) = replace(&rest, Spelling::UrlForms, &mut |key| {
        reveal(key).map(|value| encode_uri_component(&value))
    })?
    else {
        return Ok(url.clone());
    };
    let port = url
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    Url::parse(&format!("{}://{host}{port}{filled}", url.scheme())).map_err(|err| {
        PluginCallError::invalid(format!("the URL with its secrets is not a URL: {err}"))
    })
}

/// Header values with their secrets in place. A name is never substituted.
pub fn substitute_headers(
    headers: &[(String, String)],
    reveal: &mut Reveal<'_>,
) -> Result<Vec<(String, String)>, PluginCallError> {
    headers
        .iter()
        .map(|(name, value)| {
            let filled = replace(value, Spelling::Braces, &mut |key| {
                let secret = reveal(key)?;
                if secret.contains(['\r', '\n', '\0']) {
                    return Err(refusal(
                        "a secret with a line break cannot be sent in a header".to_owned(),
                    ));
                }
                Ok(secret)
            })?;
            Ok((name.clone(), filled.unwrap_or_else(|| value.clone())))
        })
        .collect()
}

/// A JSON string's escapes for `value`, without the quotes around it.
fn json_escaped(value: &str) -> String {
    let quoted = serde_json::to_string(value).unwrap_or_default();
    quoted
        .strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
        .unwrap_or_default()
        .to_owned()
}

/// A request body with its secrets in place, escaped for the body's type: a
/// JSON string's escapes for JSON, form encoding for a form, and the value
/// as it is for any other text. A body that is not UTF-8 text is binary and
/// is sent untouched.
pub fn substitute_body(
    body: Option<&[u8]>,
    content_type: Option<&str>,
    reveal: &mut Reveal<'_>,
) -> Result<Option<Vec<u8>>, PluginCallError> {
    let Some(body) = body else {
        return Ok(None);
    };
    let Ok(text) = std::str::from_utf8(body) else {
        return Ok(Some(body.to_vec()));
    };
    let kind = content_type
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let filled = if kind == "application/x-www-form-urlencoded" {
        replace(text, Spelling::UrlForms, &mut |key| {
            reveal(key).map(|value| encode_uri_component(&value))
        })?
    } else {
        let json = kind == "application/json" || kind.ends_with("+json");
        replace(text, Spelling::Braces, &mut |key| {
            reveal(key).map(|value| if json { json_escaped(&value) } else { value })
        })?
    };
    Ok(Some(
        filled.map_or_else(|| body.to_vec(), String::into_bytes),
    ))
}

/// A program's environment, its `{{key}}`s replaced.
pub fn substitute_env(
    env: &BTreeMap<String, String>,
    reveal: &mut Reveal<'_>,
) -> Result<Vec<(String, String)>, PluginCallError> {
    env.iter()
        .map(|(name, value)| {
            let filled = replace(value, Spelling::Braces, &mut |key| reveal(key))?;
            Ok((name.clone(), filled.unwrap_or_else(|| value.clone())))
        })
        .collect()
}
