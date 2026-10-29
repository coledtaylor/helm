//! What a background script may import: its plugin's own files, by a
//! relative path, and nothing else.
//!
//! A specifier that is not `./` or `../` (a bare name, a remote, `node:`,
//! `npm:`, `file:` or an absolute path) is refused before it is resolved,
//! and a relative one is refused when the file it names, links resolved,
//! is outside the plugin's folder. The same holds for `import()`.

use std::path::{Path, PathBuf};

use deno_core::{
    ModuleLoadOptions, ModuleLoadReferrer, ModuleLoadResponse, ModuleLoader, ModuleResolveResponse,
    ModuleSource, ModuleSourceCode, ModuleSpecifier, ModuleType, RequestedModuleType,
    ResolutionKind, resolve_import,
};
use deno_error::JsErrorBox;

/// Loads modules from one plugin folder.
pub(super) struct PluginModules {
    /// The folder, as the file system names it with links resolved.
    folder: PathBuf,
}

impl PluginModules {
    pub fn new(folder: &Path) -> Self {
        Self {
            folder: std::fs::canonicalize(folder).unwrap_or_else(|_| folder.to_path_buf()),
        }
    }

    /// The main module's address.
    pub fn main(&self, module: &str) -> Result<ModuleSpecifier, String> {
        ModuleSpecifier::from_file_path(self.folder.join(module))
            .map_err(|()| format!("{module} is not a file the host can name"))
    }

    /// The file `url` names, when it is inside the plugin's folder.
    fn inside(&self, url: &ModuleSpecifier, asked: &str) -> Result<PathBuf, JsErrorBox> {
        let outside = || {
            JsErrorBox::type_error(format!(
                "Refused to import {asked}: it is outside the plugin's folder, and a background script imports only its own files"
            ))
        };
        if url.scheme() != "file" {
            return Err(outside());
        }
        let path = url.to_file_path().map_err(|()| outside())?;
        let real = std::fs::canonicalize(&path).map_err(|_| {
            JsErrorBox::type_error(format!(
                "Cannot find module {asked}: there is no such file in the plugin's folder"
            ))
        })?;
        if real.starts_with(&self.folder) {
            Ok(real)
        } else {
            Err(outside())
        }
    }
}

fn is_relative(specifier: &str) -> bool {
    specifier.starts_with("./") || specifier.starts_with("../")
}

impl ModuleLoader for PluginModules {
    fn resolve(
        &self,
        specifier: &str,
        referrer: &str,
        kind: ResolutionKind,
    ) -> ModuleResolveResponse {
        let url = if matches!(kind, ResolutionKind::MainModule) {
            ModuleSpecifier::parse(specifier).map_err(JsErrorBox::from_err)?
        } else if is_relative(specifier) {
            resolve_import(specifier, referrer).map_err(JsErrorBox::from_err)?
        } else {
            return Err(JsErrorBox::type_error(format!(
                "Refused to import {specifier}: a background script imports only its plugin's own files, by a path starting ./ or ../"
            )));
        };
        self.inside(&url, specifier)?;
        Ok(url)
    }

    fn load(
        &self,
        specifier: &ModuleSpecifier,
        _referrer: Option<&ModuleLoadReferrer>,
        options: ModuleLoadOptions,
    ) -> ModuleLoadResponse {
        ModuleLoadResponse::Sync(self.read(specifier, &options))
    }
}

impl PluginModules {
    fn read(
        &self,
        specifier: &ModuleSpecifier,
        options: &ModuleLoadOptions,
    ) -> Result<ModuleSource, JsErrorBox> {
        let path = self.inside(specifier, specifier.as_str())?;
        let json = path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("json"));
        let module_type = match (&options.requested_module_type, json) {
            (RequestedModuleType::Json, true) => ModuleType::Json,
            (RequestedModuleType::None, false) => ModuleType::JavaScript,
            (RequestedModuleType::Json, false) => {
                return Err(JsErrorBox::type_error(format!(
                    "{specifier} is not a JSON module"
                )));
            }
            (RequestedModuleType::None, true) => {
                return Err(JsErrorBox::type_error(format!(
                    "{specifier} is JSON: import it with {{ type: \"json\" }}"
                )));
            }
            _ => {
                return Err(JsErrorBox::type_error(format!(
                    "{specifier} is imported as a kind of module a background script does not load"
                )));
            }
        };
        let code = std::fs::read_to_string(&path)
            .map_err(|err| JsErrorBox::type_error(format!("Could not read {specifier}: {err}")))?;
        Ok(ModuleSource::new(
            module_type,
            ModuleSourceCode::String(code.into()),
            specifier,
            None,
        ))
    }
}
