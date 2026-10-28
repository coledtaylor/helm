//! `app:info`: the host's identity, read once by a client at connect.

use floti_protocol::channels::workspace::AppInfo;

use crate::platform::folders::Folders;
use crate::platform::startup;
use crate::server::HostRun;
use crate::store::{MIGRATIONS, Store};

/// Where a client sends the user for a newer host: the project's releases
/// page, as today's app names it. Opened by the client, never fetched by the
/// host.
pub const RELEASES_URL: &str = "https://github.com/coledtaylor/helm/releases/latest";

/// The host's version, how it was started, where its data and database are,
/// the migrations its store has, and the user's home folder for showing
/// paths from `~`.
pub fn app_info(run: &HostRun, folders: &Folders, store: &Store) -> AppInfo {
    let outcome = store.migrations();
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_owned(),
        mode: run.mode,
        data_dir: folders.data.display().to_string(),
        db_file: store.file().display().to_string(),
        migrations: MIGRATIONS
            .iter()
            .map(|migration| migration.tag)
            .filter(|tag| outcome.applied.contains(tag) || outcome.already_applied.contains(tag))
            .map(str::to_owned)
            .collect(),
        windows_build: startup::windows_build(),
        home: run
            .home
            .as_ref()
            .map(|home| home.display().to_string())
            .unwrap_or_default(),
        releases_url: RELEASES_URL.to_owned(),
    }
}
