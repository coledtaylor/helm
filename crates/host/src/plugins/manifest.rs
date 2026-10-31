//! A plugin's `helm-plugin.json`, read by the SDK's own validator.
//!
//! The validator is `packages/plugin-sdk/src/manifest.js`, embedded as it is
//! and run in a base isolate, so what this host accepts is what
//! `helm-plugin validate` accepts and what it says when it refuses is what
//! the author already reads. The host passes `apiVersions: [1, 2]`. Version
//! 1 is today's Helm plugin: its `background` is a `.html` page, which runs
//! in the client that frames it, never on the host. Version 2 reads every
//! field as version 1 does, except that `background` is a `.js` or `.mjs`
//! module, which the host runs in its own engine.
//!
//! One isolate serves every reading in the process, on a thread of its own:
//! an isolate is tied to the thread that made it.

use std::collections::BTreeMap;
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock, PoisonError};

use deno_core::JsRuntime;
use floti_protocol::channels::plugins::{
    PluginCommandInfo, PluginPanelAction, PluginRail, PluginServiceKind, PluginServiceStart,
    PluginSettingSpec,
};
use serde::Deserialize;

use super::engine::{IsolateOptions, base_runtime, evaluate_to_string};

/// The manifest's file name in a plugin folder.
pub const MANIFEST_FILE: &str = "helm-plugin.json";

/// The bridge version whose background scripts the host's engine runs.
pub const API_VERSION: u8 = 2;

/// The bridge version whose background is a page a client frames.
pub const PAGE_BACKGROUND_API_VERSION: u8 = 1;

const VALIDATOR: &str = include_str!("../../../../packages/plugin-sdk/src/manifest.js");

/// What the host asks of the validator: the parsed manifest's reading, with
/// `exec` as a list so its order survives, and what the manifest said its id
/// and name were when it is refused.
const READER: &str = r#"
globalThis.__flotiReadManifest = (text) => {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return JSON.stringify({ kind: "json", message: String(error?.message ?? error) });
  }
  const said = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const id = typeof said.id === "string" ? said.id : null;
  const name = typeof said.name === "string" ? said.name : null;
  const result = validateManifest(raw, { apiVersions: [1, 2] });
  if (!result.ok) {
    return JSON.stringify({ kind: "invalid", errors: result.errors, warnings: result.warnings, id, name });
  }
  const manifest = result.manifest;
  return JSON.stringify({
    kind: "ok",
    warnings: result.warnings,
    files: manifestFiles(manifest),
    manifest: {
      ...manifest,
      exec: Object.entries(manifest.exec).map(([name, spec]) => ({ name, ...spec })),
    },
  });
};
"#;

/// A manifest that passed, as the validator normalized it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub api_version: u8,
    pub id: String,
    pub name: String,
    pub version: Option<String>,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub rail: Option<PluginRail>,
    pub panels: BTreeMap<String, PanelSpec>,
    pub tabs: BTreeMap<String, TabSpec>,
    pub page_strip: bool,
    /// A `.js` or `.mjs` module in the folder, for version 2; a `.html`
    /// page, for version 1.
    pub background: Option<String>,
    pub commands: Vec<PluginCommandInfo>,
    pub settings: Vec<PluginSettingSpec>,
    pub network: Vec<OriginPattern>,
    pub secrets: Vec<String>,
    /// In the order the manifest lists them.
    pub exec: Vec<ExecSpec>,
    pub service: Option<ServiceSpec>,
    pub agent: Option<AgentSpec>,
    pub sessions: SessionsSpec,
}

impl Manifest {
    /// The background script the host's engine runs: a version 2
    /// manifest's. A version 1 background page runs in a client.
    pub fn host_background(&self) -> Option<&str> {
        (self.api_version >= API_VERSION)
            .then_some(self.background.as_deref())
            .flatten()
    }

    /// What its pages call the bridge, which sentences about a call name:
    /// `helm` for version 1, `floti` for version 2.
    pub fn bridge(&self) -> &'static str {
        if self.api_version == PAGE_BACKGROUND_API_VERSION {
            "helm"
        } else {
            "floti"
        }
    }

    /// The scheme its pages are served on: `helm-plugin` for the bridge
    /// called `helm` (version 1), `floti-plugin` for `floti` (version 2).
    pub fn page_scheme(&self) -> &'static str {
        if self.api_version == PAGE_BACKGROUND_API_VERSION {
            "helm-plugin"
        } else {
            "floti-plugin"
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelSpec {
    pub title: String,
    pub entry: String,
    pub actions: Vec<PluginPanelAction>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabSpec {
    pub title: String,
    pub entry: String,
}

/// A `network` entry, read. `origin` is its canonical spelling.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginPattern {
    pub scheme: String,
    pub host: String,
    /// Every subdomain of `host`, and not `host` itself.
    pub wildcard: bool,
    pub port: u16,
    pub origin: String,
}

impl OriginPattern {
    /// One origin as the user or a manifest wrote it, read as the SDK's
    /// `parseOrigin` reads it: `http` or `https`, an optional `*.` in front
    /// of a domain (every subdomain of it, not the domain itself), a host,
    /// an optional port and an optional trailing slash. `None` for anything
    /// else: a path, a query, credentials, another scheme, a wildcard
    /// anywhere but the front or over an IP address.
    pub fn parse(entry: &str) -> Option<Self> {
        let entry = entry.trim();
        let (scheme, rest) = entry.split_once("://")?;
        let scheme = scheme.to_ascii_lowercase();
        if scheme != "http" && scheme != "https" {
            return None;
        }
        let rest = rest.strip_suffix('/').unwrap_or(rest);
        let (wildcard, rest) = match rest.strip_prefix("*.") {
            Some(rest) => (true, rest),
            None => (false, rest),
        };
        if rest.is_empty()
            || rest
                .chars()
                .any(|c| matches!(c, '/' | '?' | '#' | '@') || c.is_whitespace())
        {
            return None;
        }
        // A port is the digits after the last colon, when there are one to
        // five of them and something before them.
        let (raw_host, port) = match rest.rsplit_once(':') {
            Some((host, digits))
                if !host.is_empty()
                    && (1..=5).contains(&digits.len())
                    && digits.bytes().all(|b| b.is_ascii_digit()) =>
            {
                (host, Some(digits))
            }
            _ => (rest, None),
        };
        if raw_host.contains('*') {
            return None;
        }
        let parsed = url::Url::parse(&format!("{scheme}://{raw_host}")).ok()?;
        let host = parsed.host_str()?.to_owned();
        if host.is_empty() {
            return None;
        }
        let is_ip = host.starts_with('[') || host.parse::<std::net::Ipv4Addr>().is_ok();
        if wildcard && (is_ip || !host.contains('.')) {
            return None;
        }
        let default_port: u16 = if scheme == "https" { 443 } else { 80 };
        let port = match port {
            None => default_port,
            Some(digits) => digits.parse::<u16>().ok().filter(|port| *port >= 1)?,
        };
        let origin = format!(
            "{scheme}://{}{host}{}",
            if wildcard { "*." } else { "" },
            if port == default_port {
                String::new()
            } else {
                format!(":{port}")
            }
        );
        Some(Self {
            scheme,
            host,
            wildcard,
            port,
            origin,
        })
    }

    /// Whether `url` is one this pattern allows, as the SDK's
    /// `originMatches` says: scheme and port exactly, and the host itself or,
    /// for a wildcard, a subdomain of it.
    pub fn matches(&self, url: &url::Url) -> bool {
        if url.scheme() != self.scheme || url.port_or_known_default() != Some(self.port) {
            return false;
        }
        let Some(host) = url.host_str() else {
            return false;
        };
        if self.wildcard {
            host.strip_suffix(self.host.as_str())
                .is_some_and(|prefix| prefix.len() > 1 && prefix.ends_with('.'))
        } else {
            host == self.host
        }
    }
}

/// A program the manifest names, with its fixed leading arguments.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecSpec {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceSpec {
    pub kind: PluginServiceKind,
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub start: PluginServiceStart,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSpec {
    pub instructions: Option<String>,
    /// In the order the manifest lists them. Never empty.
    pub tools: Vec<AgentTool>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTool {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
    pub read_only: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsSpec {
    pub start: bool,
    pub list: bool,
}

/// A file the manifest names, for the loader to find in the folder.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedFile {
    pub field: String,
    pub path: String,
}

/// What the validator made of a manifest's text.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Reading {
    /// The text is not JSON.
    Json { message: String },
    /// JSON the validator refused, with every reason.
    Invalid {
        errors: Vec<String>,
        warnings: Vec<String>,
        id: Option<String>,
        name: Option<String>,
    },
    Ok {
        warnings: Vec<String>,
        files: Vec<NamedFile>,
        manifest: Box<Manifest>,
    },
}

type Job = (String, mpsc::Sender<Result<Reading, String>>);

/// Reads a manifest's text with the SDK's validator.
///
/// `Err` is the host's own failure (the isolate would not start), never the
/// manifest's.
pub fn read(text: &str) -> Result<Reading, String> {
    let (reply, answer) = mpsc::channel();
    validator()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .send((text.to_owned(), reply))
        .map_err(|_| "the manifest validator has stopped".to_owned())?;
    answer
        .recv()
        .map_err(|_| "the manifest validator has stopped".to_owned())?
}

/// The one validator thread, started on first use.
fn validator() -> &'static Mutex<tokio::sync::mpsc::UnboundedSender<Job>> {
    static VALIDATOR_THREAD: OnceLock<Mutex<tokio::sync::mpsc::UnboundedSender<Job>>> =
        OnceLock::new();
    VALIDATOR_THREAD.get_or_init(|| {
        let (jobs, queue) = tokio::sync::mpsc::unbounded_channel::<Job>();
        std::thread::Builder::new()
            .name("floti manifest validator".into())
            .spawn(move || serve(queue))
            .expect("start the manifest validator's thread");
        Mutex::new(jobs)
    })
}

/// The validator's isolate lives on a tokio runtime of its own thread: V8
/// posts delayed tasks (its garbage collector's among them) to the runtime
/// an isolate was created in, and aborts the process when there is none.
/// Waiting for the next manifest on that runtime lets those tasks run.
fn serve(mut queue: tokio::sync::mpsc::UnboundedReceiver<Job>) {
    let local = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(local) => local,
        Err(err) => {
            let why = format!("the manifest validator could not start: {err}");
            while let Some((_, reply)) = queue.blocking_recv() {
                let _ = reply.send(Err(why.clone()));
            }
            return;
        }
    };
    local.block_on(async move {
        let mut runtime = start();
        while let Some((text, reply)) = queue.recv().await {
            let answer = match &mut runtime {
                Ok(runtime) => validate(runtime, &text),
                Err(why) => Err(why.clone()),
            };
            let _ = reply.send(answer);
        }
    });
}

fn start() -> Result<JsRuntime, String> {
    let mut runtime = base_runtime(IsolateOptions {
        keep: vec!["__flotiReadManifest"],
        ..IsolateOptions::default()
    })?;
    let module = format!("{VALIDATOR}\n{READER}");
    runtime
        .lazy_load_es_module_with_code("ext:floti/manifest.js", module)
        .map_err(|err| format!("could not load the manifest validator: {err}"))?;
    Ok(runtime)
}

fn validate(runtime: &mut JsRuntime, text: &str) -> Result<Reading, String> {
    let literal = serde_json::to_string(text).map_err(|err| err.to_string())?;
    let answer = evaluate_to_string(
        runtime,
        "floti:read-manifest",
        format!("globalThis.__flotiReadManifest({literal})"),
    )
    .map_err(|err| format!("the manifest validator failed: {err}"))?;
    serde_json::from_str(&answer)
        .map_err(|err| format!("the manifest validator answered what the host cannot read: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal(api_version: u8) -> String {
        format!(r#"{{ "apiVersion": {api_version}, "id": "minimal", "name": "Minimal" }}"#)
    }

    #[test]
    fn a_version_2_manifest_reads_with_every_optional_part_filled_in() {
        let Reading::Ok {
            manifest,
            warnings,
            files,
        } = read(&minimal(2)).unwrap()
        else {
            panic!("refused");
        };
        assert!(warnings.is_empty() && files.is_empty());
        assert_eq!(manifest.api_version, 2);
        assert_eq!(manifest.id, "minimal");
        assert!(manifest.exec.is_empty() && manifest.background.is_none());
    }

    #[test]
    fn a_version_1_manifest_reads_with_its_background_page_for_a_client_to_frame() {
        let text = r#"{ "apiVersion": 1, "id": "old", "name": "Old", "background": "bg.html" }"#;
        let Reading::Ok {
            manifest, files, ..
        } = read(text).unwrap()
        else {
            panic!("refused");
        };
        assert_eq!(manifest.api_version, 1);
        assert_eq!(manifest.background.as_deref(), Some("bg.html"));
        assert_eq!(manifest.host_background(), None, "a page runs in a client");
        assert_eq!(manifest.page_scheme(), "helm-plugin");
        assert_eq!(files.len(), 1);

        let Reading::Ok { manifest, .. } = read(&minimal(1)).unwrap() else {
            panic!("refused");
        };
        assert_eq!((manifest.api_version, manifest.background), (1, None));
    }

    #[test]
    fn a_version_1_background_is_a_page_and_a_version_2_one_a_module() {
        let Reading::Invalid { errors, .. } =
            read(r#"{ "apiVersion": 1, "id": "x", "name": "X", "background": "bg.mjs" }"#).unwrap()
        else {
            panic!("a version 1 background module was read");
        };
        assert!(errors[0].contains("background"), "{errors:?}");

        let Reading::Ok { manifest, .. } =
            read(r#"{ "apiVersion": 2, "id": "x", "name": "X", "background": "bg.mjs" }"#).unwrap()
        else {
            panic!("refused");
        };
        assert_eq!(manifest.host_background(), Some("bg.mjs"));
        assert_eq!(manifest.page_scheme(), "floti-plugin");
    }

    #[test]
    fn an_api_version_this_host_does_not_run_is_refused_naming_both() {
        assert_eq!(
            read(&minimal(3)).unwrap(),
            Reading::Invalid {
                errors: vec![
                    "apiVersion 3 is not supported: this host runs apiVersion 1, 2 plugins".into()
                ],
                warnings: vec![],
                id: Some("minimal".into()),
                name: Some("Minimal".into()),
            }
        );
    }

    #[test]
    fn background_is_a_module_and_exec_keeps_its_order() {
        let text = r#"{ "apiVersion": 2, "id": "x", "name": "X", "background": "bg.mjs",
            "exec": { "zeta": "z", "alpha": { "command": "a", "args": ["-v"] } } }"#;
        let Reading::Ok {
            manifest, files, ..
        } = read(text).unwrap()
        else {
            panic!("refused");
        };
        assert_eq!(manifest.background.as_deref(), Some("bg.mjs"));
        let names: Vec<&str> = manifest
            .exec
            .iter()
            .map(|spec| spec.name.as_str())
            .collect();
        assert_eq!(names, ["zeta", "alpha"]);
        assert_eq!(
            files,
            [NamedFile {
                field: "background".into(),
                path: "bg.mjs".into()
            }]
        );
        let page = r#"{ "apiVersion": 2, "id": "x", "name": "X", "background": "bg.html" }"#;
        assert!(matches!(read(page).unwrap(), Reading::Invalid { .. }));
    }

    #[test]
    fn text_that_is_not_json_is_said_as_the_parser_says_it() {
        let Reading::Json { message } = read("{ nope").unwrap() else {
            panic!("parsed");
        };
        assert!(!message.is_empty(), "{message}");
    }
}
