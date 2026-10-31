//! Each enabled plugin's folder, watched as today's `watchFolder`
//! (`desktop/main/plugins/host.ts`) watches it: a change to the manifest or
//! to a file it names, written by a build, reads the plugin again.
//!
//! Only those paths count. A plugin is usually a repository, and a watch
//! that read it again on every `node_modules` write or editor save in `src/`
//! would reload the plugin under the user while they typed. What counts is
//! the manifest and the top folder of each page, the icon, the background
//! and a `node` service's script, whole: a page's scripts and styles are
//! beside it. A folder whose manifest could not be read counts any change
//! outside `node_modules` and `.git`, so its first build is noticed.
//!
//! A burst of changes is read once, [`WATCH_DEBOUNCE`] after its last
//! event. Windows reports a file being *read* as a change (its last-access
//! time moved), so a service starting or a page loading would reload the
//! plugin under itself: a change is a file that came, went, or has another
//! size or modification time than at the read ([`fingerprint`]).
//!
//! The OS's watch is `notify`'s, which is the one interface over each OS's
//! own; nothing here differs by OS.

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::manifest::{MANIFEST_FILE, Manifest};
use floti_protocol::channels::plugins::PluginServiceKind;

/// How long after a burst's last event the folder is read again.
pub const WATCH_DEBOUNCE: Duration = Duration::from_millis(400);

/// Past this many watched files a folder's fingerprint is not taken, and
/// every burst reads it again.
pub const FINGERPRINT_FILES_MAX: usize = 5000;

const SKIPPED: [&str; 2] = ["node_modules", ".git"];

/// Which paths under a plugin's folder count, by their first segment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Relevant {
    /// The manifest and the top folders of the files it names.
    Roots(BTreeSet<String>),
    /// Anything outside `node_modules` and `.git`: a folder whose manifest
    /// could not be read.
    Anything,
}

impl Relevant {
    /// What counts in the folder of a plugin that loaded.
    pub fn of(manifest: &Manifest) -> Self {
        let node_service = manifest
            .service
            .as_ref()
            .filter(|service| service.kind == PluginServiceKind::Node)
            .map(|service| service.command.as_str());
        let named = manifest
            .icon
            .as_deref()
            .into_iter()
            .chain(manifest.background.as_deref())
            .chain(manifest.panels.values().map(|panel| panel.entry.as_str()))
            .chain(manifest.tabs.values().map(|tab| tab.entry.as_str()))
            .chain(node_service);
        let mut roots = BTreeSet::from([MANIFEST_FILE.to_owned()]);
        roots.extend(
            named
                .filter_map(top_segment)
                .filter(|top| top != "node_modules"),
        );
        Self::Roots(roots)
    }

    /// Whether the path `rel`, by its segments under the folder, counts.
    pub fn counts(&self, rel: &[String]) -> bool {
        let Some(first) = rel.first() else {
            return false;
        };
        match self {
            Self::Roots(roots) => roots.contains(first),
            Self::Anything => !SKIPPED.contains(&first.as_str()),
        }
    }
}

/// An entry's first segment, `./` and empty segments aside.
fn top_segment(entry: &str) -> Option<String> {
    entry
        .split(['/', '\\'])
        .find(|part| !part.is_empty() && *part != ".")
        .map(str::to_owned)
}

/// What the watched files under `dir` are: each one's path, size and
/// modification time. `None` past [`FINGERPRINT_FILES_MAX`] of them.
pub fn fingerprint(dir: &Path, relevant: &Relevant) -> Option<String> {
    let mut lines = Vec::new();
    if !walk(dir, &mut Vec::new(), relevant, &mut lines) {
        return None;
    }
    lines.sort();
    Some(lines.join("\n"))
}

fn walk(dir: &Path, rel: &mut Vec<String>, relevant: &Relevant, lines: &mut Vec<String>) -> bool {
    let here = rel
        .iter()
        .fold(dir.to_path_buf(), |path, part| path.join(part));
    let Ok(names) = std::fs::read_dir(&here) else {
        return true;
    };
    for name in names.flatten() {
        let name = name.file_name().to_string_lossy().into_owned();
        if SKIPPED.contains(&name.as_str()) {
            continue;
        }
        rel.push(name);
        let counted = rel.len() > 1 || relevant.counts(rel);
        if counted && !visit(dir, &here, rel, relevant, lines) {
            return false;
        }
        rel.pop();
    }
    true
}

fn visit(
    dir: &Path,
    here: &Path,
    rel: &mut Vec<String>,
    relevant: &Relevant,
    lines: &mut Vec<String>,
) -> bool {
    let name = rel.last().expect("a name was just pushed");
    let Ok(meta) = std::fs::symlink_metadata(here.join(name)) else {
        return true;
    };
    if meta.is_dir() {
        return walk(dir, rel, relevant, lines);
    }
    let modified = meta
        .modified()
        .ok()
        .and_then(|at| at.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |at| at.as_nanos());
    lines.push(format!("{}\t{}\t{modified}", rel.join("/"), meta.len()));
    lines.len() <= FINGERPRINT_FILES_MAX
}

/// Told the path (`/`-separated, under the folder) whose change read the
/// folder again.
pub type OnChange = Arc<dyn Fn(String) + Send + Sync>;

/// One folder's watch. Dropping it stops the OS's watch and any reading
/// already due.
pub struct FolderWatch {
    task: JoinHandle<()>,
    /// Held for its handle; dropping it stops the OS's watch.
    _watcher: RecommendedWatcher,
}

impl Drop for FolderWatch {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl FolderWatch {
    /// Watches `dir` for changes `relevant` counts, on `runtime`, and tells
    /// `on_change` once a burst of them settled into a change. `None` when
    /// the folder cannot be watched: the plugin still works, it just is not
    /// read again by itself.
    pub fn start(
        dir: &Path,
        relevant: Relevant,
        runtime: &tokio::runtime::Handle,
        on_change: OnChange,
    ) -> Option<Self> {
        if !dir.is_dir() {
            return None;
        }
        let baseline = fingerprint(dir, &relevant);
        let (events, received) = mpsc::unbounded_channel::<String>();
        // The folder as the OS may spell it in its events: macOS reports a
        // temporary folder under /private/var, which is /var as written.
        let spellings: Vec<PathBuf> = std::iter::once(dir.to_path_buf())
            .chain(std::fs::canonicalize(dir).ok())
            .collect();
        let counting = relevant.clone();
        let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
            let Ok(event) = event else {
                return;
            };
            if matches!(event.kind, EventKind::Access(_)) {
                return;
            }
            for path in &event.paths {
                if let Some(rel) = below(&spellings, path)
                    && counting.counts(&rel)
                {
                    let _ = events.send(rel.join("/"));
                }
            }
        })
        .ok()?;
        watcher.watch(dir, RecursiveMode::Recursive).ok()?;
        let folder = dir.to_path_buf();
        let task = runtime.spawn(settle(
            received,
            WATCH_DEBOUNCE,
            move || fingerprint(&folder, &relevant),
            baseline,
            on_change,
        ));
        Some(Self {
            task,
            _watcher: watcher,
        })
    }
}

/// `path`'s segments under whichever spelling of the folder it is under.
fn below(spellings: &[PathBuf], path: &Path) -> Option<Vec<String>> {
    let rel = spellings
        .iter()
        .find_map(|root| path.strip_prefix(root).ok())?;
    let parts: Vec<String> = rel
        .components()
        .filter_map(|part| match part {
            Component::Normal(name) => Some(name.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    (!parts.is_empty()).then_some(parts)
}

/// Gathers each burst of `events` until `debounce` passes with none, then
/// tells `on_change` the last path when the files moved from `baseline`
/// (or could not be fingerprinted), and stops: the folder is read again,
/// and that read watches it anew. A burst that moved nothing is let go.
pub async fn settle(
    mut events: mpsc::UnboundedReceiver<String>,
    debounce: Duration,
    now: impl Fn() -> Option<String>,
    baseline: Option<String>,
    on_change: OnChange,
) {
    while let Some(mut last) = events.recv().await {
        loop {
            tokio::select! {
                biased;
                next = events.recv() => match next {
                    Some(path) => last = path,
                    None => return,
                },
                () = tokio::time::sleep(debounce) => break,
            }
        }
        let fresh = now();
        if fresh.is_some() && fresh == baseline {
            continue;
        }
        on_change(last);
        return;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::plugins::manifest::{Reading, read};

    fn manifest(text: &str) -> Manifest {
        match read(text).unwrap() {
            Reading::Ok { manifest, .. } => *manifest,
            other => panic!("refused: {other:?}"),
        }
    }

    fn rel(path: &str) -> Vec<String> {
        path.split('/').map(str::to_owned).collect()
    }

    #[test]
    fn the_manifest_and_the_top_folder_of_each_file_it_names_count_and_nothing_else() {
        let relevant = Relevant::of(&manifest(
            r#"{ "apiVersion": 1, "id": "x", "name": "X", "icon": "./icon.svg",
                "background": "dist/background.html",
                "panels": { "main": { "title": "Main", "entry": "panel/index.html" } },
                "tabs": { "board": { "title": "Board", "entry": "dist/board.html" } },
                "service": { "node": "server/main.mjs" } }"#,
        ));
        for counted in [
            "helm-plugin.json",
            "icon.svg",
            "dist/background.html",
            "dist/assets/app.js",
            "panel/style.css",
            "server/main.mjs",
        ] {
            assert!(relevant.counts(&rel(counted)), "{counted}");
        }
        for ignored in ["src/panel.tsx", "node_modules/x/index.js", "README.md", ""] {
            assert!(!relevant.counts(&rel(ignored)), "{ignored}");
        }

        let unread = Relevant::Anything;
        assert!(unread.counts(&rel("dist/index.html")));
        assert!(!unread.counts(&rel("node_modules/x")) && !unread.counts(&rel(".git/HEAD")));
    }

    #[test]
    fn the_fingerprint_moves_with_a_watched_file_and_not_with_another() {
        let dirs = crate::testkit::TestDirs::new();
        let dir = dirs.plugin_folder(
            "watched plugin",
            r#"{ "apiVersion": 1, "id": "w", "name": "W" }"#,
            &[("panel/index.html", "one"), ("src/main.ts", "x")],
        );
        let relevant = Relevant::Roots(BTreeSet::from([
            MANIFEST_FILE.to_owned(),
            "panel".to_owned(),
        ]));
        let before = fingerprint(&dir, &relevant).unwrap();
        assert!(before.contains("panel/index.html\t3\t"), "{before}");
        assert!(!before.contains("src/"), "{before}");

        std::fs::write(dir.join("src").join("main.ts"), "changed").unwrap();
        assert_eq!(fingerprint(&dir, &relevant).unwrap(), before);
        std::fs::write(dir.join("panel").join("index.html"), "two!").unwrap();
        assert_ne!(fingerprint(&dir, &relevant).unwrap(), before);
    }

    /// A settling watch fed by hand, with what it told and what the files
    /// fingerprint as now.
    struct Settling {
        events: mpsc::UnboundedSender<String>,
        told: Arc<Mutex<Vec<String>>>,
        files: Arc<Mutex<Option<String>>>,
        task: JoinHandle<()>,
    }

    impl Settling {
        fn start() -> Self {
            let (events, received) = mpsc::unbounded_channel();
            let told: Arc<Mutex<Vec<String>>> = Arc::default();
            let files = Arc::new(Mutex::new(Some("at the read".to_owned())));
            let into = Arc::clone(&told);
            let now = Arc::clone(&files);
            let task = tokio::spawn(settle(
                received,
                WATCH_DEBOUNCE,
                move || now.lock().unwrap().clone(),
                Some("at the read".to_owned()),
                Arc::new(move |path| into.lock().unwrap().push(path)),
            ));
            Self {
                events,
                told,
                files,
                task,
            }
        }

        fn told(&self) -> Vec<String> {
            self.told.lock().unwrap().clone()
        }

        /// Lets the watch take what was sent, then moves the clock `by`.
        async fn step(&self, by: Duration) {
            Self::settle().await;
            tokio::time::advance(by).await;
            Self::settle().await;
        }

        async fn settle() {
            for _ in 0..8 {
                tokio::task::yield_now().await;
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_burst_of_changes_reads_the_folder_once_after_its_last_change() {
        let watch = Settling::start();
        *watch.files.lock().unwrap() = Some("edited".into());
        watch.events.send("panel/index.html".into()).unwrap();
        watch.step(Duration::from_millis(300)).await;
        watch.events.send("panel/app.js".into()).unwrap();
        watch.step(Duration::from_millis(300)).await;
        assert!(watch.told().is_empty(), "the burst is still going");
        watch.step(Duration::from_millis(101)).await;
        assert_eq!(watch.told(), ["panel/app.js"]);
        assert!(watch.task.is_finished(), "a read watches the folder anew");
    }

    #[tokio::test(start_paused = true)]
    async fn a_burst_that_changed_no_file_reads_nothing_and_the_next_change_does() {
        let watch = Settling::start();
        watch.events.send("panel/index.html".into()).unwrap();
        watch.step(WATCH_DEBOUNCE + Duration::from_millis(1)).await;
        assert!(watch.told().is_empty(), "a file read is not a change");
        assert!(!watch.task.is_finished());

        *watch.files.lock().unwrap() = None;
        watch.events.send("helm-plugin.json".into()).unwrap();
        watch.step(WATCH_DEBOUNCE + Duration::from_millis(1)).await;
        assert_eq!(
            watch.told(),
            ["helm-plugin.json"],
            "too many files to tell is a change"
        );
    }
}
