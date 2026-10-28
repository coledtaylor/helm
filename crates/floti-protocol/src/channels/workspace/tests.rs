//! Every settings, setup, discovery, roots, harness, template, config
//! console, content and Files channel from `shared/ipc.ts` is declared with
//! typed payloads, setup speaks of agent backends rather than of Claude, and
//! each payload survives a trip through a CBOR frame.

use std::collections::BTreeMap;
use std::fmt::Debug;

use ciborium::Value;
use serde::Serialize;
use serde::de::DeserializeOwned;
use ts_rs::TS;

use super::*;
use crate::backend::{BackendId, Knowable};
use crate::bytes::Bytes;
use crate::capability::Capability;
use crate::channel::{
    Catalogue, ChannelKind, EventChannel, RequestChannel, from_payload, to_payload,
};
use crate::frame::{FrameDecoder, encode_frame};
use crate::message::{Event, Message, Payload, Request, Response, Snapshot};

const EVENT: ChannelKind = ChannelKind::Event { snapshot: false };
const STATE: ChannelKind = ChannelKind::Event { snapshot: true };
const REQUEST: ChannelKind = ChannelKind::Request;
const FILES: Option<Capability> = Some(Capability::Files);

/// Every ipc.ts host channel in this domain, as the protocol declares it.
const DECLARED: &[(&str, ChannelKind, Option<Capability>)] = &[
    ("app:info", REQUEST, None),
    ("settings:read", REQUEST, None),
    ("settings:write", REQUEST, None),
    ("settings:changed", STATE, None),
    ("setup:status", REQUEST, None),
    ("setup:locateBackend", REQUEST, None),
    ("setup:complete", REQUEST, None),
    ("discovery:cached", REQUEST, None),
    ("discovery:scan", REQUEST, None),
    ("discovery:updated", STATE, None),
    ("scan:status", STATE, None),
    ("git:updated", STATE, None),
    // Not in ipc.ts: the desktop's main process saw its window's focus itself.
    ("git:refresh", REQUEST, None),
    ("roots:suggest", REQUEST, None),
    ("roots:accept", REQUEST, None),
    ("roots:remove", REQUEST, None),
    ("harness:create", REQUEST, None),
    ("template:list", REQUEST, None),
    ("template:preview", REQUEST, None),
    ("template:detail", REQUEST, None),
    ("template:create", REQUEST, None),
    ("template:rename", REQUEST, None),
    ("template:delete", REQUEST, None),
    ("template:metadata", REQUEST, None),
    ("template:substitute", REQUEST, None),
    ("template:import", REQUEST, None),
    ("template:folderPreview", REQUEST, None),
    ("template:fromFolder", REQUEST, None),
    ("config:scopes", REQUEST, None),
    ("config:tree", REQUEST, None),
    ("config:read", REQUEST, None),
    ("config:render", REQUEST, None),
    ("config:write", REQUEST, None),
    ("config:snapshots", REQUEST, None),
    ("config:snapshot", REQUEST, None),
    ("config:restore", REQUEST, None),
    ("config:watch", REQUEST, None),
    ("config:create", REQUEST, None),
    ("config:rename", REQUEST, None),
    ("config:delete", REQUEST, None),
    ("config:effective", REQUEST, None),
    ("config:mcpPreview", REQUEST, None),
    ("config:mcpAdd", REQUEST, None),
    ("config:mcpRemove", REQUEST, None),
    ("config:mcpApprove", REQUEST, None),
    ("config:mcpList", REQUEST, None),
    ("config:doctor", REQUEST, None),
    ("config:externalChange", EVENT, None),
    ("editor:highlight", REQUEST, None),
    ("content:scopes", REQUEST, FILES),
    ("content:document", REQUEST, FILES),
    ("content:render", REQUEST, FILES),
    ("content:search", REQUEST, FILES),
    ("content:write", REQUEST, FILES),
    ("content:snapshots", REQUEST, FILES),
    ("content:restore", REQUEST, FILES),
    ("content:artifact", REQUEST, FILES),
    // Not in ipc.ts: the desktop's main process answered the frame's loads
    // from its own protocol handler.
    ("content:artifactBytes", REQUEST, FILES),
    ("content:wikilink", REQUEST, FILES),
    ("files:dir", REQUEST, FILES),
    ("files:status", REQUEST, FILES),
    ("files:read", REQUEST, FILES),
    ("files:list", REQUEST, FILES),
    ("files:watch", REQUEST, FILES),
    ("files:changed", EVENT, FILES),
];

fn domain() -> Catalogue {
    let mut catalogue = Catalogue::new();
    declare(&mut catalogue);
    catalogue
}

/// Frames `message`, decodes it as a client would, and returns what arrived.
fn over_the_wire(message: Message) -> Message {
    let mut decoder = FrameDecoder::new();
    decoder.push(&encode_frame(&message).unwrap());
    let arrived = decoder.next_message().unwrap().unwrap();
    assert!(decoder.next_message().unwrap().is_none());
    arrived
}

fn arrives_intact<T>(value: &T, wrap: impl FnOnce(Payload) -> Message) -> T
where
    T: Serialize + DeserializeOwned + PartialEq + Debug,
{
    let payload = match over_the_wire(wrap(to_payload(value).unwrap())) {
        Message::Request(Request { payload, .. })
        | Message::Response(Response { payload, .. })
        | Message::Event(Event { payload, .. })
        | Message::Snapshot(Snapshot { state: payload, .. }) => payload,
        other => panic!("unexpected {other:?}"),
    };
    let decoded: T = from_payload(&payload).unwrap();
    assert_eq!(&decoded, value);
    decoded
}

/// A request and its response on channel `C` both survive the wire, and the
/// catalogue accepts the request as `C`'s.
fn exchange<C: RequestChannel>(request: C::Request, response: C::Response)
where
    C::Request: PartialEq + Debug,
    C::Response: PartialEq + Debug,
{
    let catalogue = domain();
    let wire = Request {
        id: 7,
        channel: C::NAME.into(),
        payload: to_payload(&request).unwrap(),
    };
    let decl = catalogue
        .check_request(&wire)
        .unwrap_or_else(|reply| panic!("{} refused its own request: {reply:?}", C::NAME));
    assert_eq!(decl.name(), C::NAME);

    arrives_intact(&request, |payload| {
        Message::Request(Request {
            id: 7,
            channel: C::NAME.into(),
            payload,
        })
    });
    arrives_intact(&response, |payload| {
        Message::Response(Response { id: 7, payload })
    });
}

/// A state channel's snapshot and event both survive the wire.
fn state<C: EventChannel>(snapshot: C::Snapshot, event: C::Event)
where
    C::Snapshot: PartialEq + Debug,
    C::Event: PartialEq + Debug,
{
    assert!(C::SNAPSHOT, "{} should carry state", C::NAME);
    arrives_intact(&snapshot, |state| {
        Message::Snapshot(Snapshot {
            subscription: 1,
            seq: 0,
            state,
        })
    });
    arrives_intact(&event, |payload| {
        Message::Event(Event {
            subscription: 1,
            seq: 1,
            payload,
        })
    });
}

fn event<C: EventChannel>(value: C::Event)
where
    C::Event: PartialEq + Debug,
{
    assert!(!C::SNAPSHOT, "{} should not carry state", C::NAME);
    arrives_intact(&value, |payload| {
        Message::Event(Event {
            subscription: 1,
            seq: 1,
            payload,
        })
    });
}

fn encoded<T: Serialize>(value: &T) -> Value {
    Value::serialized(value).unwrap()
}

fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    value
        .as_map()
        .unwrap()
        .iter()
        .find(|(key, _)| key.as_text() == Some(name))
        .map(|(_, value)| value)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn settings() -> HostSettings {
    HostSettings {
        scan_roots: vec!["C:\\work".into(), "D:\\more work".into()],
        pinned_projects: vec!["C:\\work\\api".into()],
        first_run_completed_at: Some("2026-10-01T09:00:00Z".into()),
        backend_paths: BTreeMap::from([(BackendId::claude_code(), "C:\\tools\\claude.exe".into())]),
        terminal_shell: None,
        transcript_archive_max_bytes: 512 * 1024 * 1024,
        browser_mcp: true,
        browser_mcp_local_only: false,
        session_mcp: true,
        restore_without_asking: false,
    }
}

fn backend_status() -> BackendStatus {
    BackendStatus {
        installed: true,
        path: Some("C:\\Users\\someone\\.local\\bin\\claude.exe".into()),
        source: Some(ExecutableSource::Discovered),
        version: Some("2.1.225 (Claude Code)".into()),
        semver: Some("2.1.225".into()),
        tested: true,
        tested_range: TestedRange {
            min: "2.1.200".into(),
            max: "2.1.299".into(),
        },
        config_dir: Some("C:\\Users\\someone\\.claude".into()),
        config_dir_exists: true,
        signed_in: Knowable::Known(true),
        sign_in_signal: "a sign-in record exists".into(),
        error: None,
    }
}

fn git_state() -> GitState {
    GitState {
        branch: Some("main".into()),
        detached: false,
        dirty: 3,
        ahead: 1,
        behind: 0,
        error: None,
    }
}

fn inventory() -> ClaudeInventory {
    ClaudeInventory {
        skills: 4,
        commands: 20,
        agents: 1,
        hooks: true,
        settings: true,
        claude_md: true,
        mcp: false,
    }
}

fn project() -> Project {
    Project {
        path: "C:\\work\\hub\\repos\\api".into(),
        name: "api".into(),
        kind: ProjectKind::Repo,
        harness_path: Some("C:\\work\\hub".into()),
        has_claude_dir: true,
        inventory: inventory(),
        git: Some(git_state()),
    }
}

fn discovery() -> DiscoveryResult {
    DiscoveryResult {
        roots: vec!["C:\\work".into()],
        harnesses: vec![Harness {
            path: "C:\\work\\hub".into(),
            name: "hub".into(),
            template: Some("minimal".into()),
            version: None,
            repo_paths: vec!["C:\\work\\hub\\repos\\api".into()],
        }],
        projects: vec![project()],
        errors: vec![DiscoveryError {
            path: "E:\\".into(),
            message: "The drive is not ready.".into(),
        }],
        scanned_at: "2026-10-27T10:00:00Z".into(),
        duration_ms: Millis(41.5),
    }
}

fn file_content() -> ConfigFileContent {
    ConfigFileContent {
        path: "C:\\work\\api\\.claude\\skills\\think\\SKILL.md".into(),
        exists: true,
        content: "---\nname: think\n---\nThink first.\n".into(),
        hash: "ab12".into(),
        size: 34,
        mtime_ms: Millis(1_761_559_200_123.25),
        binary: false,
    }
}

fn write_result() -> WriteConfigResult {
    WriteConfigResult {
        ok: false,
        file: file_content(),
        snapshot_id: None,
        unchanged: false,
        conflict: Some(WriteConflict {
            on_disk_hash: "cd34".into(),
            on_disk_content: "Changed elsewhere.\n".into(),
            mtime_ms: Millis(1_761_559_300_000.0),
        }),
        error: None,
    }
}

fn write_request() -> WriteConfigRequest {
    WriteConfigRequest {
        scope_path: "C:\\work\\api".into(),
        path: "C:\\work\\api\\.claude\\skills\\think\\SKILL.md".into(),
        content: "Think twice.\n".into(),
        expected_hash: Some("ab12".into()),
        reason: ConfigWriteReason::Edit,
    }
}

fn snapshot_meta() -> ConfigSnapshotMeta {
    ConfigSnapshotMeta {
        id: 88,
        scope_path: "C:\\work\\api".into(),
        file_path: ".claude/skills/think/SKILL.md".into(),
        content_hash: "ab12".into(),
        bytes: 34,
        reason: ConfigWriteReason::Delete,
        created_at: "2026-10-27T10:00:00Z".into(),
    }
}

fn scoped_file() -> ScopedFile {
    ScopedFile {
        scope_path: "C:\\work\\hub".into(),
        path: "C:\\work\\hub\\notes\\plan.md".into(),
    }
}

fn rendered() -> RenderedMarkdown {
    RenderedMarkdown {
        html: "<h1 id=\"plan\">Plan</h1>".into(),
        frontmatter: RenderedFrontmatter {
            present: true,
            fields: vec![ContentChip {
                key: "tags".into(),
                value: "a, b".into(),
                values: vec!["a".into(), "b".into()],
            }],
            raw: "tags: [a, b]".into(),
            error: None,
            end_line: 3,
        },
        headings: vec![ContentHeading {
            depth: 1,
            text: "Plan".into(),
            slug: "plan".into(),
        }],
        links: vec![ContentWikilink {
            target: "index#top|Home".into(),
            label: "Home".into(),
            heading: Some("top".into()),
            resolved: None,
        }],
        tags: vec!["a".into(), "b".into()],
        words: 120,
        counts: ContentCounts {
            tables: 1,
            task_items: 2,
            task_items_checked: 1,
            code_blocks: 1,
            highlighted_blocks: 1,
            callouts: 0,
            wikilinks: 1,
            broken_wikilinks: 1,
            tags: 2,
            headings: 1,
        },
        unknown_languages: vec!["zig".into()],
        took_ms: Millis(2.75),
    }
}

fn content_file() -> ContentFile {
    ContentFile {
        path: "C:\\work\\hub\\notes\\plan.md".into(),
        rel_path: "notes/plan.md".into(),
        root: "notes".into(),
        root_kind: ContentRootKind::Notes,
        kind: ContentFileKind::Markdown,
        slug: "plan".into(),
        ext: "md".into(),
        title: "Plan".into(),
        size: 900,
        mtime_ms: Millis(1_761_559_200_000.5),
        note_type: Some("journal".into()),
        date: Some("2026-10-27".into()),
        tags: vec!["a".into()],
    }
}

fn dir_listing() -> ContentDirListing {
    ContentDirListing {
        scope_path: "C:\\work\\api".into(),
        rel_path: "".into(),
        entries: vec![
            ContentDirEntry {
                name: "node_modules".into(),
                rel_path: "node_modules".into(),
                path: "C:\\work\\api\\node_modules".into(),
                directory: true,
                link: false,
                kind: None,
                ext: "".into(),
                size: 0,
                mtime_ms: Millis(1.0),
                ignored: true,
                ignored_by: Some(ContentIgnoreReason::Gitignore),
            },
            ContentDirEntry {
                name: "README.md".into(),
                rel_path: "README.md".into(),
                path: "C:\\work\\api\\README.md".into(),
                directory: false,
                link: false,
                kind: Some(ContentFileKind::Markdown),
                ext: "md".into(),
                size: 2048,
                mtime_ms: Millis(2.5),
                ignored: false,
                ignored_by: None,
            },
        ],
        ignored: 1,
        ignore_source: ContentIgnoreReason::Gitignore,
        error: None,
        took_ms: Millis(0.4),
    }
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

#[test]
fn every_workspace_host_channel_from_ipc_ts_is_declared_with_its_kind_and_capability() {
    let catalogue = domain();
    for &(name, kind, capability) in DECLARED {
        let decl = catalogue
            .get(name)
            .unwrap_or_else(|| panic!("`{name}` is not declared"));
        assert_eq!(decl.kind(), kind, "`{name}` has the wrong kind");
        assert_eq!(
            decl.capability(),
            capability,
            "`{name}` needs the wrong capability"
        );
    }
    let declared: Vec<&str> = DECLARED.iter().map(|&(name, ..)| name).collect();
    let extra: Vec<&str> = catalogue
        .channels()
        .map(|decl| decl.name())
        .filter(|name| !declared.contains(name))
        .collect();
    assert!(extra.is_empty(), "declared but not listed here: {extra:?}");
}

#[test]
fn the_workspace_channels_join_the_protocols_catalogue() {
    let protocol = Catalogue::protocol();
    for &(name, kind, capability) in DECLARED {
        let decl = protocol
            .get(name)
            .unwrap_or_else(|| panic!("`{name}` is missing from the protocol"));
        assert_eq!((decl.kind(), decl.capability()), (kind, capability));
    }
}

#[test]
fn client_only_channels_of_these_families_are_not_in_the_protocol() {
    use crate::channels::boundary::{Placement, placement};

    let protocol = Catalogue::protocol();
    for name in [
        "roots:add",
        "files:editor",
        "files:openInEditor",
        "content:artifactConsole",
        "path:chooseDirectory",
        "path:chooseFile",
    ] {
        assert!(
            matches!(placement(&protocol, name), Some(Placement::ClientOnly(_))),
            "`{name}` stays in the client"
        );
        assert!(
            protocol.get(name).is_none(),
            "`{name}` is client-only but declared"
        );
    }
}

// ---------------------------------------------------------------------------
// Setup speaks of agent backends
// ---------------------------------------------------------------------------

#[test]
fn setup_speaks_of_agent_backends_rather_than_of_claude() {
    let catalogue = domain();
    let claude_named: Vec<&str> = catalogue
        .channels()
        .map(|decl| decl.name())
        .filter(|name| name.to_lowercase().contains("claude"))
        .collect();
    assert!(claude_named.is_empty(), "{claude_named:?}");
    assert!(catalogue.get("setup:locateClaude").is_none());
    assert!(catalogue.get("setup:locateBackend").is_some());

    // The setup payloads and the host settings name backends, not Claude.
    for decl in [
        SetupStatus::decl(),
        BackendStatus::decl(),
        LocateBackendRequest::decl(),
        HostSettings::decl(),
        HostSettingsPatch::decl(),
        AppInfo::decl(),
    ] {
        assert!(!decl.to_lowercase().contains("claude"), "{decl}");
    }
}

#[test]
fn setup_status_is_one_status_per_backend_keyed_by_backend_id() {
    let tomorrow = BackendId::new("tomorrows-agent");
    let status = SetupStatus {
        backends: BTreeMap::from([
            (BackendId::claude_code(), backend_status()),
            (
                tomorrow.clone(),
                BackendStatus {
                    installed: false,
                    path: None,
                    source: None,
                    version: None,
                    semver: None,
                    tested: false,
                    tested_range: TestedRange {
                        min: "0.1.0".into(),
                        max: "0.9.0".into(),
                    },
                    config_dir: None,
                    config_dir_exists: false,
                    signed_in: Knowable::Unknown,
                    sign_in_signal: "this backend declares no sign-in check".into(),
                    error: Some("tomorrows-agent was not found.".into()),
                },
            ),
        ]),
    };
    exchange::<ReadSetupStatus>((), status.clone());

    let wire = encoded(&status);
    let backends = field(&wire, "backends").unwrap().as_map().unwrap();
    let keys: Vec<&str> = backends
        .iter()
        .map(|(key, _)| key.as_text().unwrap())
        .collect();
    assert_eq!(keys, ["claude-code", "tomorrows-agent"]);

    // Signed in is yes, no or Unknown, and Unknown is not "no".
    let signed_in = |backend: &BackendId| {
        field(&encoded(&status.backends[backend]), "signedIn")
            .cloned()
            .unwrap()
    };
    assert_ne!(
        signed_in(&tomorrow),
        encoded(&Knowable::<bool>::Known(false))
    );
    assert_eq!(signed_in(&tomorrow), encoded(&Knowable::<bool>::Unknown));
}

#[test]
fn locating_a_backend_names_the_backend_and_takes_the_path_the_clients_picker_chose() {
    exchange::<LocateBackend>(
        LocateBackendRequest {
            backend: BackendId::claude_code(),
            path: "D:\\Program Files\\claude\\claude.exe".into(),
        },
        backend_status(),
    );
    exchange::<CompleteSetup>((), settings());
}

// ---------------------------------------------------------------------------
// App info and settings
// ---------------------------------------------------------------------------

#[test]
fn app_info_and_settings_payloads_survive_the_wire() {
    exchange::<ReadAppInfo>(
        (),
        AppInfo {
            version: "1.0.0".into(),
            mode: AppMode::DevLive,
            data_dir: "C:\\Users\\someone\\AppData\\Local\\Floti".into(),
            db_file: "C:\\Users\\someone\\AppData\\Local\\Floti\\floti.db".into(),
            migrations: vec!["0001_init".into()],
            windows_build: Some(26100),
            home: "C:\\Users\\someone".into(),
            releases_url: "https://example.invalid/releases".into(),
        },
    );
    assert_eq!(encoded(&AppMode::DevLive), Value::Text("dev-live".into()));
    exchange::<ReadSettings>((), settings());
    exchange::<WriteSettings>(
        HostSettingsPatch {
            scan_roots: Some(vec!["C:\\work".into()]),
            ..HostSettingsPatch::default()
        },
        settings(),
    );
    state::<SettingsChanged>(settings(), settings());
}

#[test]
fn a_settings_write_carries_only_the_fields_it_changes_and_null_clears_one() {
    let patch = HostSettingsPatch {
        session_mcp: Some(false),
        terminal_shell: Some(None),
        ..HostSettingsPatch::default()
    };
    let wire = encoded(&patch);
    let keys: Vec<&str> = wire
        .as_map()
        .unwrap()
        .iter()
        .map(|(key, _)| key.as_text().unwrap())
        .collect();
    assert_eq!(keys, ["terminalShell", "sessionMcp"]);
    assert_eq!(field(&wire, "terminalShell"), Some(&Value::Null));

    let decoded: HostSettingsPatch = from_payload(&to_payload(&patch).unwrap()).unwrap();
    assert_eq!(decoded, patch);
    // Left out is unchanged, which is not the same as cleared.
    assert_eq!(decoded.first_run_completed_at, None);
    assert_eq!(decoded.terminal_shell, Some(None));

    let set = HostSettingsPatch {
        terminal_shell: Some(Some("C:\\Program Files\\PowerShell\\7\\pwsh.exe".into())),
        ..HostSettingsPatch::default()
    };
    exchange::<WriteSettings>(set, settings());
    exchange::<WriteSettings>(HostSettingsPatch::default(), settings());
}

// ---------------------------------------------------------------------------
// Discovery, roots and harnesses
// ---------------------------------------------------------------------------

#[test]
fn discovery_payloads_survive_the_wire() {
    exchange::<ReadCachedDiscovery>(
        (),
        vec![CachedProject {
            path: "C:\\work\\hub".into(),
            name: "hub".into(),
            kind: ProjectKind::Harness,
            harness_path: None,
            has_claude_dir: true,
            inventory: inventory(),
            git: None,
            last_seen_at: "2026-10-27T10:00:00Z".into(),
            template: Some("minimal".into()),
        }],
    );
    exchange::<ScanForProjects>(
        ScanRequest {
            include_git: Some(true),
        },
        discovery(),
    );
    state::<DiscoveryUpdated>(None, discovery());
    state::<DiscoveryUpdated>(Some(discovery()), discovery());
    state::<ScanStatusChanged>(
        ScanStatus {
            running: false,
            error: Some("The scan root is gone.".into()),
        },
        ScanStatus {
            running: true,
            error: None,
        },
    );
    let git = BTreeMap::from([
        ("C:\\work\\api".to_owned(), Some(git_state())),
        ("C:\\work\\broken".to_owned(), None),
    ]);
    state::<GitUpdated>(git.clone(), git);
}

#[test]
fn a_scan_request_may_leave_out_include_git() {
    let request = Payload::serialized(&BTreeMap::<String, bool>::new()).unwrap();
    let decoded: ScanRequest = from_payload(&request).unwrap();
    assert_eq!(decoded.include_git, None);
}

#[test]
fn roots_and_harness_payloads_survive_the_wire_and_adding_a_root_takes_a_path() {
    let roots = vec!["C:\\work".to_owned(), "D:\\a folder".to_owned()];
    exchange::<SuggestRoots>((), roots.clone());
    // The folder the client's picker chose arrives on `roots:accept`.
    exchange::<AcceptRoot>(
        RootPath {
            path: "D:\\a folder".into(),
        },
        roots.clone(),
    );
    exchange::<RemoveRoot>(
        RootPath {
            path: "C:\\work".into(),
        },
        vec![],
    );
    exchange::<CreateHarness>(
        CreateHarnessRequest {
            mode: HarnessMode::New,
            dir: "C:\\work\\new hub".into(),
            name: Some("new hub".into()),
            template: Some("team".into()),
        },
        CreateHarnessOutcome {
            path: Some("C:\\work\\new hub".into()),
            created: vec!["harness.yaml".into(), "repos/".into()],
            problems: vec!["notes/a.md could not be written.".into()],
            roots,
        },
    );
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

#[test]
fn template_payloads_survive_the_wire() {
    let written = TemplateWriteResult {
        ok: true,
        template: Some("team".into()),
        problems: vec![],
    };
    exchange::<ListTemplates>(
        (),
        TemplateListing {
            templates: vec![
                TemplateChoice {
                    id: "minimal".into(),
                    label: "Minimal".into(),
                    description: None,
                    order: None,
                    built_in: true,
                },
                TemplateChoice {
                    id: "team".into(),
                    label: "Team".into(),
                    description: Some("Our layout.".into()),
                    order: Some(-1),
                    built_in: false,
                },
            ],
            dir: "C:\\Users\\someone\\.config\\floti\\templates".into(),
            problems: vec!["broken: template.yaml is not YAML.".into()],
        },
    );
    exchange::<PreviewTemplate>(
        TemplatePreviewRequest {
            template: "team".into(),
            mode: Some(HarnessMode::Convert),
        },
        TemplatePreview {
            template: "team".into(),
            entries: vec!["harness.yaml".into(), ".claude/".into()],
            note: "Nothing else is written.".into(),
            problems: vec![],
        },
    );
    exchange::<ReadTemplateDetail>(
        TemplateRef {
            template: "team".into(),
        },
        TemplateDetail {
            id: "team".into(),
            dir: "C:\\templates\\team".into(),
            label: "Team".into(),
            description: "".into(),
            has_manifest: false,
            files: vec![TemplateFile {
                rel_path: "dot-claude/CLAUDE.md.tpl".into(),
                target: ".claude/CLAUDE.md".into(),
                size: 120,
                mtime_ms: Millis(5.5),
                substituted: true,
                link: false,
            }],
            file_count: 1,
            total_bytes: 120,
            modified_at_ms: Millis(5.5),
            problems: vec![],
        },
    );
    exchange::<CreateTemplate>(
        CreateTemplateRequest {
            name: "team".into(),
            label: None,
            description: Some("Ours.".into()),
        },
        written.clone(),
    );
    exchange::<RenameTemplate>(
        RenameTemplateRequest {
            template: "team".into(),
            name: "crew".into(),
        },
        written.clone(),
    );
    exchange::<DeleteTemplate>(
        TemplateRef {
            template: "crew".into(),
        },
        TemplateDeleteResult {
            ok: true,
            template: Some("crew".into()),
            problems: vec![],
        },
    );
    exchange::<WriteTemplateMetadata>(
        TemplateMetadataRequest {
            template: "team".into(),
            label: "Team".into(),
            description: "Ours.".into(),
        },
        written.clone(),
    );
    exchange::<SubstituteTemplateFile>(
        TemplateFileRequest {
            template: "team".into(),
            path: "README.md".into(),
        },
        written,
    );
    exchange::<ImportIntoTemplate>(
        ImportIntoTemplateRequest {
            template: "team".into(),
            scope_path: "C:\\Users\\someone".into(),
            paths: vec!["C:\\Users\\someone\\.claude\\skills\\think\\SKILL.md".into()],
        },
        TemplateImportResult {
            ok: true,
            created: vec!["dot-claude/skills/think/SKILL.md".into()],
            replaced: vec![],
            problems: vec![],
        },
    );
    exchange::<PreviewFolderTemplate>(
        FolderTemplateRequest {
            dir: "C:\\work\\hub".into(),
            kind: FolderTemplateKind::Harness,
        },
        FolderTemplatePreview {
            dir: "C:\\work\\hub".into(),
            kind: FolderTemplateKind::Harness,
            entries: vec![FolderEntry {
                name: "repos".into(),
                directory: true,
                file_count: 10_000,
                bytes: 6_000_000_000,
                truncated: true,
                included: false,
                refused: Some("Repositories are not copied.".into()),
                link: false,
            }],
            file_count: 3,
            total_bytes: 4096,
            note: "Only ticked entries are copied.".into(),
            problems: vec![],
        },
    );
    exchange::<SaveFolderAsTemplate>(
        SaveFolderAsTemplateRequest {
            dir: "C:\\work\\hub".into(),
            kind: FolderTemplateKind::Folder,
            name: "hub".into(),
            label: "Hub".into(),
            description: "".into(),
            include: vec![".claude".into(), "notes".into()],
        },
        SaveFolderAsTemplateResult {
            ok: true,
            template: Some("hub".into()),
            problems: vec![],
            created: vec![".claude/settings.json".into()],
            file_count: 1,
            total_bytes: 40,
        },
    );
}

// ---------------------------------------------------------------------------
// The config console
// ---------------------------------------------------------------------------

#[test]
fn config_console_file_payloads_survive_the_wire() {
    let scope = ConfigScope {
        kind: ConfigScopeKind::Harness,
        path: "C:\\work\\hub".into(),
        claude_dir: "C:\\work\\hub\\.claude".into(),
        label: "hub".into(),
        exists: true,
    };
    exchange::<ListConfigScopes>((), vec![scope.clone()]);
    exchange::<ReadConfigTree>(
        ConfigScopeRef {
            scope_path: "C:\\work\\hub".into(),
        },
        ConfigTree {
            scope,
            files: vec![ConfigFile {
                path: "C:\\work\\hub\\.claude\\settings.local.json".into(),
                rel_path: ".claude/settings.local.json".into(),
                kind: ConfigFileKind::SettingsLocal,
                name: "settings.local.json".into(),
                size: 80,
                mtime_ms: Millis(3.0),
                description: None,
                binary: false,
            }],
            errors: vec!["C:\\work\\hub\\.claude\\locked".into()],
            scanned_at: "2026-10-27T10:00:00Z".into(),
        },
    );
    assert_eq!(
        encoded(&ConfigFileKind::SettingsLocal),
        Value::Text("settings-local".into())
    );
    assert_eq!(
        encoded(&ConfigFileKind::ClaudeMd),
        Value::Text("claude-md".into())
    );
    exchange::<ReadConfigFile>(
        ConfigPath {
            path: file_content().path,
        },
        file_content(),
    );
    exchange::<RenderConfigFile>(
        SourceToRender {
            path: "C:\\work\\hub\\.claude\\hooks\\stop.sh".into(),
            source: "echo done\n".into(),
        },
        ConfigRendered {
            markdown: None,
            code: Some(RenderedCode {
                html: "<span>echo</span>".into(),
                language: "shellscript".into(),
                highlighted: true,
            }),
        },
    );
    exchange::<RenderConfigFile>(
        SourceToRender {
            path: "C:\\work\\hub\\CLAUDE.md".into(),
            source: "# Plan\n".into(),
        },
        ConfigRendered {
            markdown: Some(rendered()),
            code: None,
        },
    );
    exchange::<WriteConfigFile>(write_request(), write_result());
    exchange::<ListConfigSnapshots>(scoped_file(), vec![snapshot_meta()]);
    exchange::<ReadConfigSnapshot>(
        SnapshotRef { id: 88 },
        Some(SnapshotContent {
            content: "Think first.\n".into(),
        }),
    );
    exchange::<ReadConfigSnapshot>(SnapshotRef { id: 89 }, None);
    exchange::<RestoreConfigSnapshot>(
        RestoreSnapshotRequest {
            id: 88,
            path: file_content().path,
        },
        write_result(),
    );
    exchange::<WatchConfigFile>(
        WatchConfigRequest {
            path: Some(file_content().path),
        },
        (),
    );
    exchange::<WatchConfigFile>(WatchConfigRequest { path: None }, ());
    event::<ConfigChangedOutside>(ConfigExternalChange {
        path: file_content().path,
        hash: "".into(),
        exists: false,
        mtime_ms: Millis(0.0),
    });
}

#[test]
fn config_console_create_rename_and_delete_payloads_survive_the_wire() {
    exchange::<CreateConfigFile>(
        CreateConfigRequest {
            scope_path: "C:\\work\\hub".into(),
            kind: CreatableKind::ClaudeMd,
            name: "".into(),
        },
        CreateConfigResult {
            ok: true,
            path: Some("C:\\work\\hub\\CLAUDE.md".into()),
            rel_path: Some("CLAUDE.md".into()),
            snapshot_id: Some(90),
            error: None,
        },
    );
    exchange::<RenameConfigFile>(
        RenameConfigRequest {
            scope_path: "C:\\work\\hub".into(),
            path: "C:\\work\\hub\\.claude\\skills\\think\\SKILL.md".into(),
            name: "ponder".into(),
        },
        RenameConfigResult {
            ok: true,
            path: Some("C:\\work\\hub\\.claude\\skills\\ponder\\SKILL.md".into()),
            rel_path: Some(".claude/skills/ponder/SKILL.md".into()),
            moved: vec![MovedFile {
                from: ".claude/skills/think/SKILL.md".into(),
                to: ".claude/skills/ponder/SKILL.md".into(),
            }],
            snapshot_ids: vec![91, 92],
            frontmatter_renamed: true,
            error: None,
        },
    );
    exchange::<DeleteConfigFile>(
        DeleteConfigRequest {
            scope_path: "C:\\work\\hub".into(),
            path: "C:\\work\\hub\\CLAUDE.md".into(),
        },
        DeleteConfigResult {
            ok: true,
            removed: vec![DeletedConfigFile {
                path: "C:\\work\\hub\\CLAUDE.md".into(),
                rel_path: "CLAUDE.md".into(),
                snapshot_id: 93,
            }],
            error: None,
        },
    );
}

#[test]
fn config_console_effective_view_payloads_survive_the_wire() {
    let entry = EffectiveEntry {
        invocation: "dev:think".into(),
        name: "think".into(),
        source: EffectiveSource::Overlay,
        namespace: Some("dev".into()),
        origin: "C:\\work\\dev".into(),
        path: "C:\\work\\dev\\.claude\\skills\\think\\SKILL.md".into(),
        description: Some("Think first.".into()),
    };
    exchange::<ReadEffectiveView>(
        EffectiveViewRequest {
            profile_id: None,
            cwd: Some("C:\\work\\api".into()),
            overlays: vec!["C:\\work\\dev".into()],
        },
        EffectiveView {
            cwd: "C:\\work\\api".into(),
            profile_id: Some(4),
            profile_name: Some("API work".into()),
            overlays: vec![EffectiveOverlay {
                name: "dev".into(),
                project_path: "C:\\work\\dev".into(),
                exists: true,
                skills: 1,
                commands: 0,
                agents: 0,
                workflows: 0,
            }],
            skills: vec![entry.clone()],
            commands: vec![],
            agents: vec![],
            workflows: vec![entry],
            shared_names: vec![SharedName {
                name: "think".into(),
                invocations: vec!["think".into(), "dev:think".into()],
            }],
            settings_layers: vec![SettingsLayer {
                kind: SettingsLayerKind::Local,
                file: "C:\\work\\api\\.claude\\settings.local.json".into(),
                exists: true,
                keys: 2,
                error: None,
            }],
            settings: vec![EffectiveSetting {
                key: "env.FOO".into(),
                value: "\"1\"".into(),
                winner: SettingsLayerKind::Local,
                winner_file: "C:\\work\\api\\.claude\\settings.local.json".into(),
                candidates: vec![SettingCandidate {
                    layer: SettingsLayerKind::Project,
                    file: "C:\\work\\api\\.claude\\settings.json".into(),
                    value: "\"0\"".into(),
                }],
                overridden: true,
            }],
            instructions: vec![EffectiveInstruction {
                path: "C:\\work\\api\\CLAUDE.md".into(),
                source: EffectiveSource::Cwd,
                bytes: 900,
                origin: "C:\\work\\api".into(),
            }],
            mcp_servers: vec![EffectiveMcpServer {
                name: "github".into(),
                scope: McpScope::Project,
                file: "C:\\work\\api\\.mcp.json".into(),
                config: "{}".into(),
                transport: "stdio".into(),
                approved: None,
                approved_by: None,
                shadowed_by: Some("user".into()),
            }],
            warnings: vec![],
            computed_at: "2026-10-27T10:00:00Z".into(),
        },
    );
    // A request may leave out everything but what it computes for.
    let bare = Payload::serialized(&BTreeMap::from([("profileId", 4)])).unwrap();
    let decoded: EffectiveViewRequest = from_payload(&bare).unwrap();
    assert_eq!(
        decoded,
        EffectiveViewRequest {
            profile_id: Some(4),
            ..EffectiveViewRequest::default()
        }
    );
}

#[test]
fn config_console_mcp_and_doctor_payloads_survive_the_wire() {
    let add = McpAddRequest {
        scope: McpScope::Local,
        name: "github".into(),
        json: "{\"command\":\"gh-mcp\"}".into(),
        cwd: "C:\\work\\api".into(),
    };
    let result = McpResult {
        ok: true,
        output: "Added.".into(),
        exit_code: Some(0),
        after: "{}".into(),
        snapshot_id: Some(94),
    };
    exchange::<PreviewMcpServer>(
        add.clone(),
        McpPreview {
            file: "C:\\Users\\someone\\.claude.json".into(),
            before: "{}".into(),
            after: "{\"mcpServers\":{}}".into(),
            diff: vec![
                McpDiffLine {
                    sign: McpDiffSign::Kept,
                    text: "{".into(),
                },
                McpDiffLine {
                    sign: McpDiffSign::Added,
                    text: "  \"mcpServers\": {}".into(),
                },
                McpDiffLine {
                    sign: McpDiffSign::Removed,
                    text: "}".into(),
                },
            ],
            replaces: None,
            error: None,
        },
    );
    let signs: Vec<Value> = [McpDiffSign::Kept, McpDiffSign::Added, McpDiffSign::Removed]
        .iter()
        .map(encoded)
        .collect();
    assert_eq!(
        signs,
        [
            Value::Text(" ".into()),
            Value::Text("+".into()),
            Value::Text("-".into())
        ]
    );
    exchange::<AddMcpServer>(add, result.clone());
    exchange::<RemoveMcpServer>(
        McpRemoveRequest {
            name: "github".into(),
            scope: McpScope::User,
            cwd: "C:\\work\\api".into(),
        },
        result.clone(),
    );
    exchange::<ApproveMcpServer>(
        McpApproveRequest {
            cwd: "C:\\work\\api".into(),
            name: "github".into(),
            approved: true,
        },
        write_result(),
    );
    exchange::<ListMcpServers>(
        McpListRequest {
            cwd: "C:\\work\\api".into(),
        },
        McpResult {
            exit_code: None,
            ..result
        },
    );
    exchange::<RunDoctor>(
        (),
        DoctorReport {
            output: "Version: 2.1.225\n".into(),
            rows: vec![DoctorRow {
                label: "Version".into(),
                value: "2.1.225".into(),
            }],
            exit_code: Some(0),
            ran_at: "2026-10-27T10:00:00Z".into(),
            duration_ms: Millis(812.0),
            error: None,
        },
    );
    exchange::<HighlightSource>(
        SourceToRender {
            path: "C:\\work\\api\\.claude\\settings.json".into(),
            source: "{}\n".into(),
        },
        EditorHighlight {
            lines: vec!["<span>{}</span>".into()],
            language: "json".into(),
            highlighted: true,
            too_large: false,
            took_ms: Millis(0.8),
        },
    );
}

// ---------------------------------------------------------------------------
// Content and the Files view
// ---------------------------------------------------------------------------

#[test]
fn content_payloads_survive_the_wire() {
    exchange::<ListContentScopes>(
        (),
        vec![ContentScope {
            kind: ConfigScopeKind::Project,
            path: "C:\\work\\api".into(),
            label: "api".into(),
        }],
    );
    exchange::<ReadContentDocument>(
        scoped_file(),
        ContentDocument {
            file: content_file(),
            content: file_content(),
            rendered: Some(rendered()),
            error: None,
        },
    );
    exchange::<RenderContent>(
        ContentRenderRequest {
            scope_path: "C:\\work\\hub".into(),
            path: "C:\\work\\hub\\notes\\plan.md".into(),
            source: "# Plan\n".into(),
        },
        rendered(),
    );
    exchange::<SearchContent>(
        ContentSearchRequest {
            scope_path: "C:\\work\\hub".into(),
            query: "journal-2026".into(),
        },
        ContentSearchResult {
            query: "journal-2026".into(),
            hits: vec![ContentSearchHit {
                path: "C:\\work\\hub\\notes\\journal-2026-10.md".into(),
                rel_path: "notes/journal-2026-10.md".into(),
                root: "notes".into(),
                title: "October".into(),
                matches: 0,
                name_match: true,
                lines: vec![ContentSearchLine {
                    line: 3,
                    text: "see journal-2026-09".into(),
                    from: 4,
                    to: 16,
                }],
            }],
            files_searched: 400,
            body_kinds: vec![ContentFileKind::Markdown, ContentFileKind::Text],
            files_with_text: 350,
            bytes_searched: 9_000_000,
            total_matches: 1,
            took_ms: Millis(12.25),
            cold: true,
            truncated: false,
        },
    );
    exchange::<WriteContent>(write_request(), write_result());
    exchange::<ListContentSnapshots>(scoped_file(), vec![snapshot_meta()]);
    exchange::<RestoreContentSnapshot>(
        RestoreSnapshotRequest {
            id: 88,
            path: "C:\\work\\hub\\notes\\plan.md".into(),
        },
        write_result(),
    );
    exchange::<OpenArtifact>(
        scoped_file(),
        ArtifactLink {
            url: "floti-artifact://3f2a/report.html".into(),
            token: "3f2a".into(),
        },
    );
    exchange::<ResolveWikilink>(
        WikilinkRequest {
            scope_path: "C:\\work\\hub".into(),
            target: "index".into(),
            from: "C:\\work\\hub\\reference\\report.html".into(),
        },
        WikilinkTarget { path: None },
    );

    // An image's bytes are not UTF-8, and arrive as they left.
    let png = artifact_bytes(vec![
        0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0xFF, 0x00,
    ]);
    exchange::<ReadArtifactBytes>(
        ArtifactBytesRequest {
            url: "floti-artifact://3f2a/chart.png".into(),
            offset: 4_194_304,
        },
        png.clone(),
    );
    let wire = encoded(&png);
    assert_eq!(
        field(&wire, "body"),
        Some(&Value::Bytes(png.body.0.clone())),
        "the body is a CBOR byte string"
    );
    assert_eq!(field(&wire, "totalBytes"), Some(&Value::Integer(10.into())));
    assert!(field(&wire, "headers").unwrap().as_array().is_some());

    // A request that leaves the offset out starts at the first byte.
    let bare = to_payload(&BTreeMap::from([("url", "floti-artifact://3f2a/x.html")])).unwrap();
    let request: ArtifactBytesRequest = from_payload(&bare).unwrap();
    assert_eq!(request.offset, 0);
}

fn artifact_bytes(body: Vec<u8>) -> ArtifactBytes {
    ArtifactBytes {
        status: 200,
        headers: vec![
            ArtifactHeader {
                name: "content-type".into(),
                value: "image/png".into(),
            },
            ArtifactHeader {
                name: "content-security-policy".into(),
                value: "default-src 'none'; connect-src 'none'".repeat(8),
            },
            ArtifactHeader {
                name: "x-content-type-options".into(),
                value: "nosniff".into(),
            },
            ArtifactHeader {
                name: "cache-control".into(),
                value: "no-store".into(),
            },
        ],
        total_bytes: body.len() as u64,
        body: Bytes(body),
    }
}

#[test]
fn a_full_artifact_piece_and_its_framing_fit_in_one_frame() {
    let piece = artifact_bytes(vec![0xFF; ARTIFACT_PIECE_LEN as usize]);
    let frame = encode_frame(&Message::Response(Response {
        id: u64::MAX,
        payload: to_payload(&piece).unwrap(),
    }))
    .expect("a full piece is one frame");
    assert!(frame.len() <= crate::frame::MAX_FRAME_LEN as usize + 4);
    assert!(ARTIFACT_PIECE_LEN * 2 < u64::from(crate::frame::MAX_FRAME_LEN));
}

#[test]
fn files_view_payloads_survive_the_wire() {
    let root = "C:\\work\\a repo".to_owned();
    exchange::<ReadFilesDir>(
        FilesDirRequest {
            root: root.clone(),
            rel_path: "".into(),
        },
        dir_listing(),
    );
    exchange::<ReadFilesStatus>(
        FilesRoot { root: root.clone() },
        FilesStatus {
            root: root.clone(),
            repo: Some(root.clone()),
            files: Some(BTreeMap::from([
                ("src/a.rs".to_owned(), GitFileState::Modified),
                ("new.txt".to_owned(), GitFileState::Untracked),
            ])),
            error: None,
        },
    );
    let view = |changes| FileView {
        root: root.clone(),
        path: "C:\\work\\a repo\\src\\a.rs".into(),
        rel_path: "src/a.rs".into(),
        exists: true,
        size: 300,
        mtime_ms: Millis(1_761_559_200_000.0),
        binary: false,
        too_large: false,
        content: "fn main() {}\n".into(),
        eol: Some(LineEnding::Crlf),
        changes,
        error: None,
    };
    for changes in [
        FileChangeState::Tracked {
            lines: LineChanges {
                changed: vec![(1, 3), (10, 10)],
                removed_after: vec![0, 7],
                changed_count: 4,
                removed_count: 2,
            },
        },
        FileChangeState::New,
        FileChangeState::Ignored,
        FileChangeState::Outside,
        FileChangeState::Unknown {
            reason: "git is not installed".into(),
        },
    ] {
        exchange::<ReadFile>(
            FilesPathRequest {
                root: root.clone(),
                path: "src/a.rs".into(),
            },
            view(changes),
        );
    }
    assert_eq!(encoded(&LineEnding::Crlf), Value::Text("CRLF".into()));
    exchange::<ListFiles>(
        FilesRoot { root: root.clone() },
        FileListing {
            root: root.clone(),
            files: vec!["src/a.rs".into()],
            source: FileListSource::Walk,
            truncated: true,
            error: None,
        },
    );
    exchange::<WatchFiles>(
        FilesWatchRequest {
            roots: vec![root.clone()],
        },
        (),
    );
    event::<FilesChanged>(FilesChange {
        root: root.clone(),
        paths: Some(vec!["src/a.rs".into(), ".git".into()]),
    });
    event::<FilesChanged>(FilesChange { root, paths: None });
}

#[test]
fn could_not_look_and_nothing_there_stay_different_answers() {
    let status = |files| FilesStatus {
        root: "C:\\work\\api".into(),
        repo: Some("C:\\work\\api".into()),
        files,
        error: None,
    };
    let unknown = encoded(&status(None));
    let clean = encoded(&status(Some(BTreeMap::new())));
    assert_eq!(field(&unknown, "files"), Some(&Value::Null));
    assert_eq!(field(&clean, "files"), Some(&Value::Map(vec![])));

    let unchanged = FileChangeState::Tracked {
        lines: LineChanges {
            changed: vec![],
            removed_after: vec![],
            changed_count: 0,
            removed_count: 0,
        },
    };
    let could_not_look = FileChangeState::Unknown {
        reason: "git timed out".into(),
    };
    let kind = |state: &FileChangeState| field(&encoded(state), "kind").cloned();
    assert_eq!(kind(&unchanged), Some(Value::Text("tracked".into())));
    assert_eq!(kind(&could_not_look), Some(Value::Text("unknown".into())));
}

#[test]
fn milliseconds_sent_as_a_whole_number_decode() {
    let mut change = encoded(&ConfigExternalChange {
        path: "C:\\work\\api\\CLAUDE.md".into(),
        hash: "ab12".into(),
        exists: true,
        mtime_ms: Millis(0.0),
    });
    for (key, value) in change.as_map_mut().unwrap() {
        if key.as_text() == Some("mtimeMs") {
            *value = Value::Integer(1_761_559_200_000_i64.into());
        }
    }
    let decoded: ConfigExternalChange = change.deserialized().unwrap();
    assert_eq!(decoded.mtime_ms, Millis(1_761_559_200_000.0));
    // And a fraction survives as one.
    assert_eq!(
        encoded(&Millis(2.75)).deserialized::<Millis>().unwrap(),
        Millis(2.75)
    );
}

#[test]
fn a_request_that_does_not_fit_a_workspace_channel_is_refused_naming_it() {
    let catalogue = domain();
    let wire = Request {
        id: 9,
        channel: "files:read".into(),
        payload: to_payload(&FilesRoot {
            root: "C:\\work".into(),
        })
        .unwrap(),
    };
    let reply = catalogue.check_request(&wire).unwrap_err();
    assert_eq!(reply.id, 9);
    assert_eq!(reply.channel, "files:read");
    assert!(reply.message.contains("files:read"), "{}", reply.message);
}
