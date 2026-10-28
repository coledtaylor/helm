//! HTML artifacts: files on this disk a client frames, served from the
//! folder they are pinned to and with the network taken away.
//!
//! An artifact is content Floti did not produce, so a frame reaches it only
//! through an address the host minted for a file the user opened:
//! `floti-artifact://<token>/<name>`. Two gates, both necessary. The token
//! decides which folder is addressable at all, and the containment check then
//! decides which files inside it are, so `..%2f..%2fsecret` resolves, fails
//! the check and is refused rather than read.
//!
//! The policy names no `http:` anywhere: remote content is not blocked by a
//! rule, it has nowhere to be requested from. Inline script and style are
//! allowed because a generated report is one file with its CSS and JS inside
//! it; they can do nothing outside a frame with no network and no origin.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use floti_protocol::channels::workspace::ArtifactLink;

use super::guard::segments_below;
use crate::config_console::normalize;
use crate::workspace::render::wikilinks::{WikiIndex, find_wikilinks, parse_wikilink};

/// The scheme an artifact address uses.
pub const ARTIFACT_SCHEME: &str = "floti-artifact";

/// How many artifacts stay addressable at once: a session that opens a
/// hundred should not keep a hundred folders reachable.
const MAX_OPEN: usize = 32;

/// What an artifact frame may do.
pub const ARTIFACT_CSP: &str = "default-src 'none'; \
script-src 'unsafe-inline' 'unsafe-eval' floti-artifact:; \
style-src 'unsafe-inline' floti-artifact:; \
img-src data: blob: floti-artifact:; \
font-src data: floti-artifact:; \
media-src data: blob: floti-artifact:; \
connect-src 'none'; \
frame-src 'none'; \
object-src 'none'; \
form-action 'none'; \
base-uri 'none'";

/// The content type each served extension gets; anything else is bytes.
const MIME: &[(&str, &str)] = &[
    (".html", "text/html; charset=utf-8"),
    (".htm", "text/html; charset=utf-8"),
    (".css", "text/css; charset=utf-8"),
    (".js", "text/javascript; charset=utf-8"),
    (".mjs", "text/javascript; charset=utf-8"),
    (".json", "application/json; charset=utf-8"),
    (".svg", "image/svg+xml"),
    (".png", "image/png"),
    (".jpg", "image/jpeg"),
    (".jpeg", "image/jpeg"),
    (".gif", "image/gif"),
    (".webp", "image/webp"),
    (".avif", "image/avif"),
    (".ico", "image/x-icon"),
    (".woff", "font/woff"),
    (".woff2", "font/woff2"),
    (".txt", "text/plain; charset=utf-8"),
    (".md", "text/plain; charset=utf-8"),
];

/// A wikilink the entry document carries, and whether the scope answers it.
/// It holds no path: the frame is untrusted code, and a path in it is a path
/// it can read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactWikilink {
    pub target: String,
    pub heading: Option<String>,
    pub resolved: bool,
}

#[derive(Debug, Clone)]
struct Pinned {
    dir: PathBuf,
    file: PathBuf,
    links: Vec<ArtifactWikilink>,
}

/// What an artifact address answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactResponse {
    pub status: u16,
    /// Header names, lower-cased, with their values.
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

impl ArtifactResponse {
    fn plain(status: u16, text: &str) -> Self {
        Self {
            status,
            headers: vec![("content-type", "text/plain; charset=utf-8".to_owned())],
            body: text.as_bytes().to_vec(),
        }
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// The folders artifacts may be served from, keyed by an unguessable token.
#[derive(Default)]
pub struct Artifacts {
    open: Mutex<(HashMap<String, Pinned>, VecDeque<String>)>,
}

impl Artifacts {
    /// Mints an address for `file`, pinned to its folder. Minted per open
    /// rather than remembered, so a token never outlives the document it was
    /// issued for.
    pub fn mint(&self, file: &Path, links: Vec<ArtifactWikilink>) -> ArtifactLink {
        let file = normalize(file);
        let dir = file
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| file.clone());
        let mut bytes = [0u8; 16];
        crate::agent::fill_random(&mut bytes);
        let token = crate::agent::hex(&bytes);
        let name = file
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "index.html".to_owned());

        let mut open = self.open.lock().unwrap_or_else(PoisonError::into_inner);
        let (pinned, order) = &mut *open;
        pinned.insert(token.clone(), Pinned { dir, file, links });
        order.push_back(token.clone());
        while order.len() > MAX_OPEN {
            if let Some(oldest) = order.pop_front() {
                pinned.remove(&oldest);
            }
        }
        ArtifactLink {
            url: format!("{ARTIFACT_SCHEME}://{token}/{}", encode_component(&name)),
            token,
        }
    }

    /// The bytes `url` addresses, under the artifact policy, or the refusal:
    /// 400 for an address that is not one, 404 for a token or file that is
    /// not there, 403 for a path out of the pinned folder.
    pub fn serve(&self, url: &str) -> ArtifactResponse {
        let Some(rest) = url
            .strip_prefix(ARTIFACT_SCHEME)
            .and_then(|rest| rest.strip_prefix("://"))
        else {
            return ArtifactResponse::plain(400, "Bad request");
        };
        let rest = rest.split(['?', '#']).next().unwrap_or_default();
        let mut parts = rest.split('/').filter(|part| !part.is_empty());
        let token = parts.next().unwrap_or_default();
        let Some(entry) = self.pinned(token) else {
            return ArtifactResponse::plain(404, "Not found");
        };

        let mut rel = Vec::new();
        for part in parts {
            match decode_component(part) {
                Some(decoded) => rel.push(decoded),
                None => return ArtifactResponse::plain(400, "Bad request"),
            }
        }
        let target = if rel.is_empty() {
            entry.file.clone()
        } else {
            normalize(
                &rel.iter()
                    .fold(entry.dir.clone(), |path, part| path.join(part)),
            )
        };
        if segments_below(&entry.dir, &target).is_none() {
            return ArtifactResponse::plain(403, "Forbidden");
        }

        let mut bytes = match std::fs::metadata(&target) {
            Ok(meta) if meta.is_file() => match std::fs::read(&target) {
                Ok(bytes) => bytes,
                Err(_) => return ArtifactResponse::plain(404, "Not found"),
            },
            _ => return ArtifactResponse::plain(404, "Not found"),
        };

        // The entry document, and only that one, gets the wikilink
        // bootstrap; a stylesheet or a script beside it is served verbatim.
        let ext = extension(&target);
        let is_entry = target.display().to_string().to_lowercase()
            == entry.file.display().to_string().to_lowercase();
        if is_entry && (ext == ".html" || ext == ".htm") {
            let html = String::from_utf8_lossy(&bytes).into_owned();
            bytes = with_wikilinks(&html, &entry.links).into_bytes();
        }

        let content_type = MIME
            .iter()
            .find(|(known, _)| *known == ext)
            .map_or("application/octet-stream", |(_, mime)| mime);
        ArtifactResponse {
            status: 200,
            headers: vec![
                ("content-type", content_type.to_owned()),
                ("content-security-policy", ARTIFACT_CSP.to_owned()),
                ("x-content-type-options", "nosniff".to_owned()),
                // A generated report is edited by hand afterwards; a cached
                // copy of the version before the edit is the wrong answer.
                ("cache-control", "no-store".to_owned()),
            ],
            body: bytes,
        }
    }

    fn pinned(&self, token: &str) -> Option<Pinned> {
        let open = self.open.lock().unwrap_or_else(PoisonError::into_inner);
        open.0.get(token).cloned()
    }
}

fn extension(path: &Path) -> String {
    path.extension()
        .map(|ext| format!(".{}", ext.to_string_lossy().to_lowercase()))
        .unwrap_or_default()
}

/// The `[[wikilinks]]` an HTML file carries and whether `index` answers
/// them, scanned from its own bytes, each target once.
pub fn artifact_wikilinks(index: &WikiIndex, path: &Path) -> Vec<ArtifactWikilink> {
    let Ok(raw) = std::fs::read(path) else {
        return Vec::new();
    };
    let source = String::from_utf8_lossy(&raw);
    let self_path = path.display().to_string();
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for found in find_wikilinks(&source) {
        let link = parse_wikilink(&found.inner, found.embed);
        if link.target.is_empty() || !seen.insert(link.target.to_lowercase()) {
            continue;
        }
        out.push(ArtifactWikilink {
            resolved: index.resolve(&link, Some(&self_path)).is_some(),
            target: link.target,
            heading: link.heading,
        });
    }
    out
}

/// The entry document with the wikilink bootstrap before its last
/// `</body>`, or after everything when it has none.
///
/// The frame is untrusted code, so this is written for a hostile document:
/// no paths cross into it, only which targets resolve; a click posts the
/// target back for the client to resolve through `content:wikilink`; and
/// only text nodes outside links, scripts and editables are rewritten. The
/// table is read from `document.currentScript.previousElementSibling`, so a
/// document that defined a global of the same name cannot change it. The
/// stylesheet's raw colours are the one place they are right: the frame's
/// document has an opaque origin and none of the client's tokens.
pub fn with_wikilinks(html: &str, links: &[ArtifactWikilink]) -> String {
    if links.is_empty() {
        return html.to_owned();
    }
    let table: serde_json::Map<String, serde_json::Value> = links
        .iter()
        .map(|link| {
            (
                link.target.to_lowercase(),
                serde_json::Value::Bool(link.resolved),
            )
        })
        .collect();
    // `</script>` inside a JSON island ends it and `<!--` opens a comment in
    // one; both are escaped rather than hoped about.
    let table = serde_json::Value::Object(table)
        .to_string()
        .replace('<', "\\u003c");
    let bootstrap = BOOTSTRAP.replace("{table}", &table);
    match html.rfind("</body>") {
        Some(close) => format!("{}{bootstrap}{}", &html[..close], &html[close..]),
        None => format!("{html}{bootstrap}"),
    }
}

const BOOTSTRAP: &str = r#"
<script type="application/json" data-helm-wikilinks>{table}</script>
<script>
(function () {
  var node = document.currentScript && document.currentScript.previousElementSibling
  if (!node) return
  var known = {}
  try { known = JSON.parse(node.textContent || '{}') } catch (e) { return }
  var RE = /\[\[([^\]\[\n|#][^\]\[\n]*?)((?:#[^\]\[\n|]*)?)((?:\|[^\]\[\n]*)?)\]\]/g
  var SKIP = { A: 1, SCRIPT: 1, STYLE: 1, TEXTAREA: 1, CODE: 1, PRE: 1 }
  var style = document.createElement('style')
  style.textContent = '.helm-wikilink{color:#5A4DA8;text-decoration:underline;text-underline-offset:2px;cursor:pointer}'
    + '.helm-wikilink-broken{color:#9A6B12;text-decoration:underline dotted;cursor:default}'
  document.head && document.head.appendChild(style)

  function walk(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentElement
        while (p) {
          if (SKIP[p.tagName] || p.isContentEditable) return NodeFilter.FILTER_REJECT
          p = p.parentElement
        }
        return (n.nodeValue || '').indexOf('[[') < 0
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT
      }
    })
    var targets = []
    for (var n = walker.nextNode(); n; n = walker.nextNode()) targets.push(n)
    for (var i = 0; i < targets.length; i++) replace(targets[i])
  }

  function replace(node) {
    var text = node.nodeValue || ''
    var frag = document.createDocumentFragment()
    var at = 0
    RE.lastIndex = 0
    for (var m = RE.exec(text); m; m = RE.exec(text)) {
      if (m.index > at) frag.appendChild(document.createTextNode(text.slice(at, m.index)))
      var target = (m[1] || '').trim()
      var heading = (m[2] || '').replace('#', '').trim()
      var alias = (m[3] || '').replace('|', '').trim()
      var ok = known[target.toLowerCase()] === true
      var a = document.createElement('a')
      a.className = ok ? 'helm-wikilink' : 'helm-wikilink helm-wikilink-broken'
      a.textContent = alias || (heading ? target + ' \u00a7 ' + heading : target)
      a.setAttribute('data-helm-wikilink', target)
      if (heading) a.setAttribute('data-helm-heading', heading)
      if (!ok) a.title = 'No note in this scope answers to that name yet'
      frag.appendChild(a)
      at = m.index + m[0].length
    }
    if (at === 0) return
    if (at < text.length) frag.appendChild(document.createTextNode(text.slice(at)))
    node.parentNode && node.parentNode.replaceChild(frag, node)
  }

  document.addEventListener('click', function (event) {
    var el = event.target
    while (el && el !== document.body && !(el.getAttribute && el.getAttribute('data-helm-wikilink'))) {
      el = el.parentElement
    }
    if (!el || !el.getAttribute) return
    var target = el.getAttribute('data-helm-wikilink')
    if (!target) return
    event.preventDefault()
    if (el.className.indexOf('helm-wikilink-broken') >= 0) return
    try {
      parent.postMessage(
        { helm: 'wikilink', target: target, heading: el.getAttribute('data-helm-heading') || null },
        '*'
      )
    } catch (e) { /* No parent to tell. Nothing else to do. */ }
  })

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { walk(document.body) })
  } else {
    walk(document.body)
  }
})()
</script>
"#;

/// A path segment percent-encoded the way `encodeURIComponent` does.
pub fn encode_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// A percent-encoded segment decoded, or `None` when it is not valid
/// percent-encoded UTF-8.
pub fn decode_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let hex = text.get(at + 1..at + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_segment_round_trips_through_its_encoding() {
        let name = "lesson one (draft)/..\u{e9}.html";
        assert_eq!(
            decode_component(&encode_component(name)).as_deref(),
            Some(name)
        );
        assert_eq!(
            decode_component("..%2fsecret.txt").as_deref(),
            Some("../secret.txt")
        );
        assert_eq!(decode_component("%zz"), None);
    }

    #[test]
    fn the_island_escapes_what_would_end_it() {
        let links = [ArtifactWikilink {
            target: "</script><b>".to_owned(),
            heading: None,
            resolved: false,
        }];
        let html = with_wikilinks("<body><p>x</p></body>", &links);
        assert!(html.contains("\\u003c/script>\\u003cb>"));
        assert!(html.ends_with("</script>\n</body>"));
    }
}
