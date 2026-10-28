//! Saved launch profiles: the `profiles` table today's app keeps, and a
//! profile as a portable YAML document.
//!
//! - [`store`]: listing, saving, deleting and pinning rows, the way
//!   `core/store/profiles.ts` does. Names are unique, compared without case.
//! - [`document`]: a profile as YAML (`core/launch/profile.ts`), with paths
//!   under the profile's root written relative to it and the root written
//!   against home, so an export travels with its harness; and validation.
//! - [`save`], [`import`] and [`export`]: what a client's `profile:save`,
//!   `profile:import` and `profile:export` do, as `desktop/main/profiles.ts`
//!   does them. The save and open dialogs stay in the client: an export is
//!   the document, and an import is given one.

pub mod document;
pub mod store;

use std::path::Path;

use floti_protocol::channels::sessions::{
    ImportProfileResult, Profile, ProfileDocument, ProfileDraft, SaveProfileRequest,
    SaveProfileResult,
};
use rusqlite::Connection;

pub use document::{profile_draft, profile_from_yaml, profile_to_yaml, validate_profile};

use crate::Result;

/// Saves a draft, creating a profile or updating one in place. A draft with
/// problems, a name another profile has, and a profile that has gone are
/// each answered with the sentences, and nothing is written.
pub fn save(conn: &Connection, request: &SaveProfileRequest) -> Result<SaveProfileResult> {
    let refused = |problems: Vec<String>| SaveProfileResult {
        profile: None,
        problems,
    };
    let problems = validate_profile(&request.draft);
    if !problems.is_empty() {
        return Ok(refused(problems));
    }
    let mut draft = request.draft.clone();
    draft.name = draft.name.trim().to_owned();

    let wanted = draft.name.to_lowercase();
    if let Some(clash) = store::list(conn)?
        .into_iter()
        .find(|existing| existing.name.to_lowercase() == wanted && Some(existing.id) != request.id)
    {
        return Ok(refused(vec![format!(
            "A profile named \u{201c}{}\u{201d} already exists.",
            clash.name
        )]));
    }

    let saved = match request.id {
        None => Some(store::create(conn, &draft)?),
        Some(id) => store::update(conn, id, &draft)?,
    };
    Ok(match saved {
        Some(profile) => SaveProfileResult {
            profile: Some(profile),
            problems: Vec::new(),
        },
        None => refused(vec!["That profile no longer exists.".to_owned()]),
    })
}

/// Profile `id` as a document, with the file name a save dialog suggests.
pub fn export(
    conn: &Connection,
    id: u64,
    home: Option<&Path>,
) -> Result<std::result::Result<ProfileDocument, String>> {
    Ok(match store::read(conn, id)? {
        Some(profile) => Ok(ProfileDocument {
            file_name: suggested_file_name(&profile),
            yaml: profile_to_yaml(&profile_draft(&profile), home),
        }),
        None => Err("That profile no longer exists.".to_owned()),
    })
}

/// Adds the profile `document` describes, unpinned. A document that is not
/// a profile is the answer's `error`, naming the file, and nothing is
/// written; a name already taken is given the next free one, named in
/// `renamed_to`, rather than refused or overwritten.
pub fn import(
    conn: &Connection,
    document: &ProfileDocument,
    home: Option<&Path>,
) -> Result<ImportProfileResult> {
    let draft = match profile_from_yaml(&document.yaml, home) {
        Ok(draft) => draft,
        Err(detail) => {
            return Ok(ImportProfileResult {
                profile: None,
                error: Some(format!("{}: {detail}", document.file_name)),
                renamed_to: None,
            });
        }
    };
    let problems = validate_profile(&draft);
    if !problems.is_empty() {
        return Ok(ImportProfileResult {
            profile: None,
            error: Some(format!("{}: {}", document.file_name, problems.join(" "))),
            renamed_to: None,
        });
    }
    let name = store::unique_name(conn, &draft.name)?;
    let renamed_to = (name != draft.name).then(|| name.clone());
    let profile = store::create(conn, &ProfileDraft { name, ..draft })?;
    Ok(ImportProfileResult {
        profile: Some(profile),
        error: None,
        renamed_to,
    })
}

/// A file name a person would recognise in a folder of them.
fn suggested_file_name(profile: &Profile) -> String {
    let mut slug = String::new();
    for c in profile.name.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            slug.push(c);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() { "profile" } else { slug };
    format!("{slug}.floti-profile.yaml")
}
