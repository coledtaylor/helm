//! A plugin folder, read: the manifest validated, every file it names found
//! inside the folder, and the icon inlined.
//!
//! Read at every start and every reload, never cached across runs: a plugin
//! is developed in place, and the folder is the truth about it. The
//! sentences are today's (`desktop/main/plugins/loader.ts`).

use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;

use super::manifest::{self, MANIFEST_FILE, Manifest, Reading};

/// A manifest is a page of JSON. Past this it is something else.
const MANIFEST_MAX_BYTES: u64 = 256 * 1024;

/// Past this an icon is not an icon: the SDK's `ICON_MAX_BYTES`.
const ICON_MAX_BYTES: usize = 64 * 1024;

/// A folder whose manifest passed and whose files are all there.
#[derive(Debug, Clone, PartialEq)]
pub struct LoadedPlugin {
    /// The folder as the user registered it.
    pub path: String,
    /// The same folder with every link resolved: what containment is checked
    /// against.
    pub dir: PathBuf,
    pub manifest: Manifest,
    /// A `data:` URL.
    pub icon: Option<String>,
    pub warnings: Vec<String>,
}

/// Why a folder did not load, and what its manifest said it was.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadFailure {
    pub error: String,
    pub warnings: Vec<String>,
    pub id: Option<String>,
    /// What the manifest said its name was, or the folder's own name when
    /// there was no manifest to read.
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum LoadResult {
    Loaded(Box<LoadedPlugin>),
    Failed(LoadFailure),
}

/// Reads the folder at `path`.
pub fn load_folder(path: &str) -> LoadResult {
    let failed = |error: String| {
        LoadResult::Failed(LoadFailure {
            error,
            warnings: Vec::new(),
            id: None,
            name: Some(folder_name(path)),
        })
    };
    let Ok(dir) = std::fs::canonicalize(path) else {
        return failed("the folder does not exist".into());
    };
    if !dir.is_dir() {
        return failed("this is not a folder".into());
    }
    let file = dir.join(MANIFEST_FILE);
    let text = match std::fs::metadata(&file) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return failed(format!("there is no {MANIFEST_FILE} in this folder"));
        }
        Ok(meta) if meta.len() > MANIFEST_MAX_BYTES => {
            return failed(format!("{MANIFEST_FILE} is larger than a manifest can be"));
        }
        _ => match std::fs::read(&file) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(err) => return failed(format!("{MANIFEST_FILE} could not be read: {err}")),
        },
    };
    let reading = match manifest::read(&text) {
        Ok(reading) => reading,
        Err(why) => return failed(why),
    };
    let (manifest, warnings, files) = match reading {
        Reading::Json { message } => {
            return failed(format!("{MANIFEST_FILE} is not valid JSON: {message}"));
        }
        Reading::Invalid {
            errors,
            warnings,
            id,
            name,
        } => {
            return LoadResult::Failed(LoadFailure {
                error: errors.join("; "),
                warnings,
                id,
                name,
            });
        }
        Reading::Ok {
            manifest,
            warnings,
            files,
        } => (manifest, warnings, files),
    };
    let refuse = |error: String, warnings: Vec<String>, manifest: &Manifest| {
        LoadResult::Failed(LoadFailure {
            error,
            warnings,
            id: Some(manifest.id.clone()),
            name: Some(manifest.name.clone()),
        })
    };
    for named in &files {
        if let Some(problem) = file_problem(&dir, &named.path) {
            return refuse(format!("{}: {problem}", named.field), warnings, &manifest);
        }
    }
    let icon = match manifest.icon.as_deref().map(|entry| icon_data(&dir, entry)) {
        None => None,
        Some(Ok(icon)) => Some(icon),
        Some(Err(why)) => return refuse(format!("icon: {why}"), warnings, &manifest),
    };
    LoadResult::Loaded(Box::new(LoadedPlugin {
        path: path.to_owned(),
        dir,
        manifest: *manifest,
        icon,
        warnings,
    }))
}

/// The last part of a folder's path, as a name for a folder that said none.
fn folder_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| path.to_owned())
}

/// Where a file the manifest names really is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Inside {
    File(PathBuf),
    Outside,
    Missing,
}

/// A path under `dir` (already resolved) as the file it really is, links
/// followed, so a junction in a plugin's folder cannot serve a file from
/// outside it.
pub fn resolve_inside(dir: &Path, entry: &str) -> Inside {
    let lexical = dir.join(entry);
    if lexical
        .components()
        .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Inside::Outside;
    }
    match std::fs::canonicalize(&lexical) {
        Ok(real) if !real.is_file() => Inside::Missing,
        Ok(real) if real.starts_with(dir) => Inside::File(real),
        Ok(_) => Inside::Outside,
        Err(_) => Inside::Missing,
    }
}

/// Why a file the manifest names is not one in the folder. A missing page or
/// module is almost always a plugin that has not been built, so it says so.
fn file_problem(dir: &Path, entry: &str) -> Option<String> {
    match resolve_inside(dir, entry) {
        Inside::File(_) => None,
        Inside::Outside => Some(format!("{entry} is outside the plugin folder")),
        Inside::Missing => {
            let lower = entry.to_ascii_lowercase();
            let built = [".html", ".htm", ".js", ".mjs"]
                .iter()
                .any(|ext| lower.ends_with(ext));
            let hint = if built {
                " - has the plugin been built?"
            } else {
                ""
            };
            Some(format!("{entry} does not exist{hint}"))
        }
    }
}

/// The rail icon, inlined as a `data:` URL: a client draws it as a mask, and
/// reading it here once means the rail never waits on a plugin's folder.
fn icon_data(dir: &Path, entry: &str) -> Result<String, String> {
    let Inside::File(target) = resolve_inside(dir, entry) else {
        return Err(format!("{entry} is not a file in the plugin folder"));
    };
    let svg = target
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("svg"));
    let kind = if svg { "image/svg+xml" } else { "image/png" };
    let bytes =
        std::fs::read(&target).map_err(|err| format!("{entry} could not be read: {err}"))?;
    if bytes.len() > ICON_MAX_BYTES {
        return Err(format!("{entry} is over {} KB", ICON_MAX_BYTES / 1024));
    }
    Ok(format!("data:{kind};base64,{}", STANDARD.encode(bytes)))
}
