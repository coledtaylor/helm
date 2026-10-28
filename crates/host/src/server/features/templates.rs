//! Harness templates: every `template:*` channel, and `harness:create`.
//!
//! The templates folder is `templates` in the host's config folder. The
//! shipped README and example are written there when the feature starts and
//! only when the folder is absent; after that it is the user's, and the host
//! writes there only when a client asks it to create, rename, describe,
//! fill, import into or delete a template, each confined to one template's
//! folder.
//!
//! `harness:create` makes the harness, then adds it to the scan roots unless
//! a root already covers it, so the launcher sees what the user made without
//! listing it twice. The outcome carries the roots after.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use floti_protocol::channel::Router;
use floti_protocol::channels::workspace::{
    CreateHarness, CreateHarnessOutcome, CreateTemplate, DeleteTemplate, ImportIntoTemplate,
    ListTemplates, PreviewFolderTemplate, PreviewTemplate, ReadTemplateDetail, RenameTemplate,
    SaveFolderAsTemplate, SubstituteTemplateFile, TemplateImportResult, WriteTemplateMetadata,
};

use super::config::off_the_workers;
use super::{Feature, FeatureContext};
use crate::config_console::normalize;
use crate::server::hosted::Hosted;
use crate::session::ClientId;
use crate::workspace::discovery::add_roots;
use crate::workspace::settings::SettingsService;
use crate::workspace::templates::authoring::{
    create_template, delete_template, import_into_template, make_substitutable,
    preview_folder_as_template, read_template_detail, rename_template, save_folder_as_template,
    write_template_metadata,
};
use crate::workspace::templates::harness::create_harness;
use crate::workspace::templates::import::resolve_import;
use crate::workspace::templates::reader::{list_templates, preview_template};
use crate::workspace::templates::seed::seed_templates;
use crate::workspace::templates::{below, templates_folder};

pub(crate) struct Templates {
    hosted: Arc<Hosted>,
    settings: Arc<SettingsService>,
    dir: PathBuf,
}

impl Templates {
    pub fn new(context: &FeatureContext) -> crate::Result<Self> {
        let dir = templates_folder(&context.workspace.folders);
        // A folder that could not be seeded is not a host that cannot start:
        // the picker still has the built-in scaffold, and the listing names
        // the folder it could not read.
        if let Some(problem) = seed_templates(&dir).problem {
            eprintln!("floti host: {problem}");
        }
        Ok(Self {
            hosted: Arc::clone(&context.hosted),
            settings: Arc::clone(&context.workspace.settings),
            dir,
        })
    }

    fn harness(
        &self,
        request: &floti_protocol::channels::workspace::CreateHarnessRequest,
    ) -> Result<CreateHarnessOutcome, String> {
        let made = create_harness(request, Some(&self.dir))?;
        let current = self
            .settings
            .read()
            .map_err(|err| err.to_string())?
            .scan_roots;
        let roots = match &made.path {
            Some(path) if !current.iter().any(|root| covers(Path::new(root), path)) => {
                add_roots(&self.settings, &[path.display().to_string()])?
            }
            _ => current,
        };
        Ok(CreateHarnessOutcome {
            path: made.path.map(|path| path.display().to_string()),
            created: made.created,
            problems: made.problems,
            roots,
        })
    }

    fn import(
        &self,
        request: &floti_protocol::channels::workspace::ImportIntoTemplateRequest,
    ) -> TemplateImportResult {
        let refused = |problems: Vec<String>| TemplateImportResult {
            ok: false,
            created: Vec::new(),
            replaced: Vec::new(),
            problems,
        };
        let backends = self.hosted.backends();
        let Some(backend) = backends.iter().find(|backend| {
            backend
                .config()
                .and_then(|config| config.console())
                .is_some()
        }) else {
            return refused(vec![
                "No agent on this host has a config console.".to_owned(),
            ]);
        };
        let (files, skipped) = match resolve_import(backend.as_ref(), request) {
            Ok(resolved) => resolved,
            Err(problem) => return refused(vec![problem]),
        };
        if files.is_empty() {
            return refused(if skipped.is_empty() {
                vec!["Nothing was selected.".to_owned()]
            } else {
                skipped
            });
        }
        let mut result = import_into_template(&self.dir, &request.template, &files);
        result.problems.splice(0..0, skipped);
        result
    }
}

/// Whether the scan root `root` already lists `path`: it is the root or
/// somewhere under it.
fn covers(root: &Path, path: &Path) -> bool {
    let (root, path) = (normalize(root), normalize(path));
    root.as_os_str().eq_ignore_ascii_case(path.as_os_str()) || below(&root, &path).is_some()
}

impl Feature for Templates {
    fn requests<'a>(&'a self, _client: ClientId, router: &mut Router<'a>) {
        let dir = self.dir.as_path();
        router
            .handle::<ListTemplates>(move |()| Ok(off_the_workers(|| list_templates(dir))))
            .handle::<PreviewTemplate>(move |request| {
                Ok(off_the_workers(|| {
                    preview_template(dir, &request.template, request.mode)
                }))
            })
            .handle::<ReadTemplateDetail>(move |template| {
                Ok(off_the_workers(|| {
                    read_template_detail(dir, &template.template)
                }))
            })
            .handle::<CreateTemplate>(move |request| {
                let store = self.hosted.ledger().store();
                Ok(create_template(store.connection(), dir, &request))
            })
            .handle::<RenameTemplate>(move |request| Ok(rename_template(dir, &request)))
            .handle::<DeleteTemplate>(move |template| {
                Ok(off_the_workers(|| delete_template(dir, &template.template)))
            })
            .handle::<WriteTemplateMetadata>(move |request| {
                let store = self.hosted.ledger().store();
                Ok(write_template_metadata(store.connection(), dir, &request))
            })
            .handle::<SubstituteTemplateFile>(move |request| Ok(make_substitutable(dir, &request)))
            .handle::<ImportIntoTemplate>(move |request| {
                Ok(off_the_workers(|| self.import(&request)))
            })
            .handle::<PreviewFolderTemplate>(|request| {
                Ok(off_the_workers(|| {
                    preview_folder_as_template(&request.dir, request.kind)
                }))
            })
            .handle::<SaveFolderAsTemplate>(move |request| {
                Ok(off_the_workers(|| {
                    let store = self.hosted.ledger().store();
                    save_folder_as_template(store.connection(), dir, &request)
                }))
            })
            .handle::<CreateHarness>(move |request| off_the_workers(|| self.harness(&request)));
    }
}

#[cfg(test)]
mod tests;
