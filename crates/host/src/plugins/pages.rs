//! The files of a plugin's pages, for the client that draws them
//! (`plugins:file`): what today's `helm-plugin://` handler reads from the
//! folder, a piece at a time.
//!
//! Only a plugin that is on is served, and only a file inside its folder,
//! links followed ([`resolve_inside`]): a path with `..`, an absolute path or
//! a link out of the folder is refused with 403 before anything is read, and
//! a file that is not there with 404. A refusal is an answer, as the page
//! always saw it. The bytes are served as they are on disk: the client
//! injects its runtime and sets its headers, as it does for its own pages.

use std::io::{Read as _, Seek as _, SeekFrom};
use std::path::Path;

use floti_protocol::Bytes;
use floti_protocol::channels::plugins::{PLUGIN_FILE_PIECE_LEN, PluginFile};

use super::loader::{Inside, resolve_inside};
use crate::workspace::content::artifact::content_type_of;

const PLAIN: &str = "text/plain; charset=utf-8";

/// A refusal's whole text, with the version and revision it was read at.
pub fn refusal(status: u16, version: Option<String>, revision: u64) -> PluginFile {
    let text: &[u8] = match status {
        403 => b"Forbidden",
        _ => b"Not found",
    };
    PluginFile {
        status,
        content_type: PLAIN.to_owned(),
        version,
        revision,
        total_bytes: text.len() as u64,
        body: Bytes(text.to_vec()),
    }
}

/// The file at `path` (the page's path on its origin, without its leading
/// `/`) in the folder `dir`, already resolved, from `offset` on: at most
/// [`PLUGIN_FILE_PIECE_LEN`] bytes of it.
pub fn read(
    dir: &Path,
    path: &str,
    offset: u64,
    version: Option<String>,
    revision: u64,
) -> PluginFile {
    let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    if parts.is_empty() || path.contains('\0') {
        return refusal(404, version, revision);
    }
    let target = match resolve_inside(dir, &parts.join("/")) {
        Inside::File(target) => target,
        Inside::Outside => return refusal(403, version, revision),
        Inside::Missing => return refusal(404, version, revision),
    };
    match piece(&target, offset) {
        Ok((body, total_bytes)) => PluginFile {
            status: 200,
            content_type: content_type_of(&target).to_owned(),
            version,
            revision,
            total_bytes,
            body: Bytes(body),
        },
        Err(_) => refusal(404, version, revision),
    }
}

/// At most [`PLUGIN_FILE_PIECE_LEN`] bytes of `target` from `offset`, read
/// with a seek, and the file's length.
fn piece(target: &Path, offset: u64) -> std::io::Result<(Vec<u8>, u64)> {
    let mut file = std::fs::File::open(target)?;
    let total = file.metadata()?.len();
    if offset >= total {
        return Ok((Vec::new(), total));
    }
    file.seek(SeekFrom::Start(offset))?;
    let len = PLUGIN_FILE_PIECE_LEN.min(total - offset);
    let mut body = Vec::with_capacity(usize::try_from(len).unwrap_or_default());
    file.take(len).read_to_end(&mut body)?;
    Ok((body, total))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::TestDirs;

    fn plugin_dir(dirs: &TestDirs) -> std::path::PathBuf {
        let folder = dirs.plugin_folder(
            "pages plugin",
            "{}",
            &[
                ("panel/index.html", "<!doctype html><p>panel</p>"),
                ("panel/app script.js", "console.log(1)"),
            ],
        );
        std::fs::canonicalize(folder).unwrap()
    }

    #[test]
    fn a_page_file_is_served_with_its_type_version_and_revision() {
        let dirs = TestDirs::new();
        let dir = plugin_dir(&dirs);
        let page = read(&dir, "panel/index.html", 0, Some("1.2.0".into()), 7);
        assert_eq!(page.status, 200);
        assert_eq!(page.content_type, "text/html; charset=utf-8");
        assert_eq!((page.version.as_deref(), page.revision), (Some("1.2.0"), 7));
        assert_eq!(page.body.0, b"<!doctype html><p>panel</p>");
        assert_eq!(page.total_bytes, page.body.0.len() as u64);

        let script = read(&dir, "panel/app script.js", 4, None, 7);
        assert_eq!(script.content_type, "text/javascript; charset=utf-8");
        assert_eq!(script.body.0, b"ole.log(1)");
        assert_eq!(script.total_bytes, 14);

        let past = read(&dir, "panel/app script.js", 99, None, 7);
        assert_eq!((past.status, past.body.0.len()), (200, 0));
    }

    #[test]
    fn a_path_outside_the_folder_is_forbidden_and_a_missing_file_not_found() {
        let dirs = TestDirs::new();
        let dir = plugin_dir(&dirs);
        let secret = dirs.root().join("secret.txt");
        std::fs::write(&secret, "not the plugin's").unwrap();

        for outside in ["../secret.txt", "panel/../../secret.txt"] {
            let refused = read(&dir, outside, 0, None, 3);
            assert_eq!(refused.status, 403, "{outside}");
            assert_eq!(refused.body.0, b"Forbidden");
            assert_eq!(refused.content_type, PLAIN);
        }
        // An absolute path is a path on the plugin's origin: refused either
        // way, and never the file it names.
        let absolute = read(&dir, secret.to_str().unwrap(), 0, None, 3);
        assert!(matches!(absolute.status, 403 | 404), "{}", absolute.status);
        assert!(!absolute.body.0.starts_with(b"not the plugin's"));
        for missing in ["panel/gone.html", "", "panel", "a\0b"] {
            let refused = read(&dir, missing, 0, None, 3);
            assert_eq!(refused.status, 404, "{missing:?}");
            assert_eq!(refused.body.0, b"Not found");
            assert_eq!(refused.total_bytes, 9);
        }
    }
}
