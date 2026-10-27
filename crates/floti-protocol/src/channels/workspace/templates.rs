//! Harness templates: `template:*`.
//!
//! Every write lands inside the templates folder and nowhere else, and
//! `template:import` reads its sources without writing a byte back.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{HarnessMode, Millis};

request_channel!(
    /// The picker's rows: `minimal` first and always, then the templates
    /// folder's.
    ListTemplates = "template:list", () => TemplateListing
);
request_channel!(
    /// What a harness made from a template would receive.
    PreviewTemplate = "template:preview", TemplatePreviewRequest => TemplatePreview
);
request_channel!(
    /// One template's files, with what a harness would receive each as.
    ReadTemplateDetail = "template:detail", TemplateRef => TemplateDetail
);
request_channel!(
    /// Scaffolds a `template.yaml` and an empty tree.
    CreateTemplate = "template:create", CreateTemplateRequest => TemplateWriteResult
);
request_channel!(
    /// Moves the folder; a template's id is its folder name.
    RenameTemplate = "template:rename", RenameTemplateRequest => TemplateWriteResult
);
request_channel!(
    /// Removes the folder, unlinking any link rather than walking it. Final.
    DeleteTemplate = "template:delete", TemplateRef => TemplateDeleteResult
);
request_channel!(
    WriteTemplateMetadata = "template:metadata", TemplateMetadataRequest => TemplateWriteResult
);
request_channel!(
    /// Renames one file to `x.tpl`, which opts it in to substitution.
    SubstituteTemplateFile = "template:substitute", TemplateFileRequest => TemplateWriteResult
);
request_channel!(
    /// Copies chosen entries of a config scope's tree into a template, named
    /// by the paths `config:tree` reports.
    ImportIntoTemplate = "template:import", ImportIntoTemplateRequest => TemplateImportResult
);
request_channel!(
    /// What saving a folder as a template would copy, before anything is.
    PreviewFolderTemplate = "template:folderPreview", FolderTemplateRequest => FolderTemplatePreview
);
request_channel!(
    /// Copies the ticked entries of a folder into a new template.
    SaveFolderAsTemplate = "template:fromFolder", SaveFolderAsTemplateRequest => SaveFolderAsTemplateResult
);

/// One row of the template picker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TemplateChoice {
    /// The folder name, and what a harness records. `minimal` for the
    /// built-in scaffold.
    pub id: String,
    pub label: String,
    pub description: Option<String>,
    /// `order:` from `template.yaml`; null sorts last.
    pub order: Option<i32>,
    /// The built-in scaffold, which has no folder behind it.
    pub built_in: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TemplateListing {
    pub templates: Vec<TemplateChoice>,
    /// Where the user's templates live.
    pub dir: String,
    /// One sentence per template that could not be read.
    pub problems: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TemplatePreviewRequest {
    pub template: String,
    #[serde(default)]
    pub mode: Option<HarnessMode>,
}

/// What a new harness's "What gets written" lists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TemplatePreview {
    pub template: String,
    /// The manifest first, then everything else by path.
    pub entries: Vec<String>,
    /// The sentence under the list.
    pub note: String,
    pub problems: Vec<String>,
}

/// A template, by id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TemplateRef {
    pub template: String,
}

/// One file in a template, and what a harness would receive it as.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TemplateFile {
    /// Relative to the template folder, forward-slashed.
    pub rel_path: String,
    /// The path a new harness gets; empty when the file is not written.
    pub target: String,
    #[ts(type = "number")]
    pub size: u64,
    pub mtime_ms: Millis,
    /// A `.tpl`, whose placeholders are filled in on the way out.
    pub substituted: bool,
    /// A link, which is refused. Listed so the author can see why.
    pub link: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TemplateDetail {
    pub id: String,
    pub dir: String,
    pub label: String,
    pub description: String,
    /// Whether there is a `template.yaml` at all; absent is legal.
    pub has_manifest: bool,
    /// Everything but `template.yaml`, by path.
    pub files: Vec<TemplateFile>,
    pub file_count: u32,
    #[ts(type = "number")]
    pub total_bytes: u64,
    /// The newest modification time in the tree.
    pub modified_at_ms: Millis,
    pub problems: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct CreateTemplateRequest {
    pub name: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RenameTemplateRequest {
    pub template: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TemplateMetadataRequest {
    pub template: String,
    pub label: String,
    pub description: String,
}

/// One file inside a template.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TemplateFileRequest {
    pub template: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TemplateWriteResult {
    pub ok: bool,
    /// The template's id afterwards, or null when nothing was written.
    pub template: Option<String>,
    /// What went wrong, as sentences.
    pub problems: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TemplateDeleteResult {
    pub ok: bool,
    /// The template that is gone, or null when nothing was removed.
    pub template: Option<String>,
    pub problems: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ImportIntoTemplateRequest {
    pub template: String,
    /// The config scope the entries are in.
    pub scope_path: String,
    /// Paths as `config:tree` reports them for that scope.
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TemplateImportResult {
    pub ok: bool,
    /// Targets that did not exist before, relative to the template.
    pub created: Vec<String>,
    /// Targets that did, and were replaced.
    pub replaced: Vec<String>,
    pub problems: Vec<String>,
}

/// Which kind of folder becomes a template. The defaults and the wording
/// differ; nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum FolderTemplateKind {
    Harness,
    Folder,
}

/// A folder to save as a template, as the client's picker produced it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct FolderTemplateRequest {
    pub dir: String,
    pub kind: FolderTemplateKind,
}

/// One entry at the top of the folder, and whether it would be copied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    pub name: String,
    pub directory: bool,
    /// Files under it that would be copied; `truncated` says the count
    /// stopped.
    pub file_count: u32,
    #[ts(type = "number")]
    pub bytes: u64,
    pub truncated: bool,
    /// Ticked when the dialog opens.
    pub included: bool,
    /// Set when the host will not copy it whatever is ticked, and why.
    pub refused: Option<String>,
    /// A link. Never followed, never copied.
    pub link: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct FolderTemplatePreview {
    pub dir: String,
    pub kind: FolderTemplateKind,
    pub entries: Vec<FolderEntry>,
    /// Files and bytes of everything ticked by default.
    pub file_count: u32,
    #[ts(type = "number")]
    pub total_bytes: u64,
    pub note: String,
    pub problems: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SaveFolderAsTemplateRequest {
    pub dir: String,
    pub kind: FolderTemplateKind,
    pub name: String,
    pub label: String,
    pub description: String,
    /// The top-level entries to copy.
    pub include: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SaveFolderAsTemplateResult {
    pub ok: bool,
    pub template: Option<String>,
    pub problems: Vec<String>,
    /// What landed, relative to the template.
    pub created: Vec<String>,
    pub file_count: u32,
    #[ts(type = "number")]
    pub total_bytes: u64,
}
