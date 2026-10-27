//! Every channel in the desktop's `shared/ipc.ts` lands somewhere: declared in
//! the protocol (under its own name or a recorded backend-neutral rename, or
//! as the client-to-host side of a stream), or listed as client-only or
//! host-internal with a reason. No client-only channel is declared.

use std::path::Path;

use floti_protocol::Catalogue;
use floti_protocol::channels::boundary::{
    CLIENT_ONLY, HOST_INTERNAL, Placement, RENAMED, declared_client_only, placement,
};
use floti_protocol::{Capability, RequestChannel};

/// The object literals in ipc.ts whose keys are every channel.
const CHANNEL_LISTS: [&str; 3] = ["REQUEST_CHANNELS", "SEND_CHANNELS", "EVENT_CHANNELS"];

fn ipc_ts() -> String {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/desktop/src/shared/ipc.ts");
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()))
}

/// The keys of `export const <list> = Object.keys({ 'name': true, ... })`.
fn channel_names(source: &str, list: &str) -> Vec<String> {
    let opening = format!("export const {list} = Object.keys({{");
    let start = source
        .find(&opening)
        .unwrap_or_else(|| panic!("ipc.ts has no `{opening}`"))
        + opening.len();
    let body = &source[start..];
    let body = &body[..body
        .find('}')
        .unwrap_or_else(|| panic!("`{list}` is never closed"))];
    body.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| {
            let name = line
                .strip_prefix('\'')
                .and_then(|rest| rest.split_once('\''))
                .map(|(name, _)| name)
                .unwrap_or_else(|| panic!("`{list}` has a line that is not a channel: {line}"));
            name.to_owned()
        })
        .collect()
}

fn every_ipc_channel() -> Vec<String> {
    let source = ipc_ts();
    let mut names: Vec<String> = CHANNEL_LISTS
        .iter()
        .flat_map(|list| channel_names(&source, list))
        .collect();
    names.sort();
    names.dedup();
    names
}

/// One line per channel that lands nowhere, naming it.
fn unplaced(catalogue: &Catalogue, names: &[String]) -> Vec<String> {
    names
        .iter()
        .filter(|name| placement(catalogue, name).is_none())
        .map(|name| {
            format!(
                "`{name}` in shared/ipc.ts is neither declared in the protocol nor listed as \
                 client-only or host-internal in channels/boundary.rs"
            )
        })
        .collect()
}

#[test]
fn every_channel_in_ipc_ts_is_declared_client_only_or_host_internal() {
    let names = every_ipc_channel();
    // The parse found the lists: a broken parse must not pass by finding
    // nothing.
    for known in [
        "app:info",
        "session:input",
        "plugins:toolResult",
        "files:changed",
    ] {
        assert!(
            names.iter().any(|name| name == known),
            "parsed no `{known}`"
        );
    }
    assert!(names.len() > 150, "parsed only {} channels", names.len());

    let missing = unplaced(&Catalogue::protocol(), &names);
    assert!(missing.is_empty(), "{}", missing.join("\n"));
}

#[test]
fn a_channel_in_ipc_ts_the_protocol_does_not_place_fails_naming_it() {
    let mut names = every_ipc_channel();
    names.push("session:teleport".into());
    let missing = unplaced(&Catalogue::protocol(), &names);
    assert_eq!(missing.len(), 1);
    assert!(missing[0].contains("`session:teleport`"), "{}", missing[0]);
}

#[test]
fn no_client_only_channel_appears_in_the_protocol() {
    let declared = declared_client_only(&Catalogue::protocol());
    assert!(
        declared.is_empty(),
        "client-only channels are declared in the protocol: {declared:?}"
    );
    // The browser pane, clipboard, window, theme, dialogs and diagnostics.
    for name in [
        "browser:open",
        "browser:bounds",
        "clipboard:write",
        "shell:openExternal",
        "theme:current",
        "themes:list",
        "path:chooseDirectory",
        "probe:req",
        "term:create",
        "update:check",
    ] {
        assert!(
            matches!(
                placement(&Catalogue::protocol(), name),
                Some(Placement::ClientOnly(_))
            ),
            "`{name}` stays in the client"
        );
    }
}

struct BrowserOpen;
impl RequestChannel for BrowserOpen {
    const NAME: &'static str = "browser:open";
    const CAPABILITY: Option<Capability> = Some(Capability::Browser);
    type Request = String;
    type Response = ();
}

#[test]
fn a_client_only_channel_declared_in_the_protocol_is_caught_by_name() {
    let mut catalogue = Catalogue::protocol();
    catalogue.request::<BrowserOpen>();
    assert_eq!(declared_client_only(&catalogue), ["browser:open"]);
}

#[test]
fn renamed_and_stream_carried_channels_land_on_declared_protocol_channels() {
    let catalogue = Catalogue::protocol();
    assert_eq!(
        placement(&catalogue, "setup:locateClaude"),
        Some(Placement::Declared("setup:locateBackend"))
    );
    assert!(catalogue.get("setup:locateClaude").is_none());
    for (_, renamed) in RENAMED {
        assert!(catalogue.get(renamed).is_some(), "`{renamed}` is declared");
    }
    assert_eq!(
        placement(&catalogue, "session:input"),
        Some(Placement::CarriedOnStream("session:data"))
    );
    assert_eq!(
        placement(&catalogue, "pterm:input"),
        Some(Placement::CarriedOnStream("pterm:data"))
    );
}

#[test]
fn every_client_only_and_host_internal_entry_names_an_ipc_ts_channel_and_a_reason() {
    let names = every_ipc_channel();
    for entry in CLIENT_ONLY.iter().chain(HOST_INTERNAL) {
        assert!(
            !entry.reason.is_empty(),
            "`{}` has no reason",
            entry.channels
        );
        assert!(
            names.iter().any(|name| entry.covers(name)),
            "`{}` matches no channel in shared/ipc.ts",
            entry.channels
        );
    }
    for name in [
        "plugins:tool",
        "plugins:toolCancel",
        "plugins:toolResult",
        "plugins:backgroundState",
    ] {
        assert!(matches!(
            placement(&Catalogue::protocol(), name),
            Some(Placement::HostInternal(_))
        ));
    }
}
