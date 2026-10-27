//! A client declares capabilities at connect, unknown names are ignored, and
//! each channel says which capability it needs.

use floti_protocol::message::{ClientInfo, ClientKind, Hello};
use floti_protocol::{
    Capability, CapabilitySet, Catalogue, HostIdentity, Message, PROTOCOL_VERSION, RequestChannel,
    StreamChannel,
};

fn hello(capabilities: &[&str]) -> Hello {
    Hello {
        protocol: PROTOCOL_VERSION,
        client: ClientInfo {
            name: "tomorrow's client".into(),
            kind: ClientKind::Phone,
        },
        capabilities: capabilities.iter().map(|name| (*name).to_owned()).collect(),
    }
}

fn host() -> HostIdentity {
    HostIdentity {
        protocol: PROTOCOL_VERSION,
        host_version: "0.1.0".into(),
        backends: Vec::new(),
    }
}

#[test]
fn a_capability_name_the_host_does_not_know_still_connects_and_the_welcome_lists_only_what_it_accepted()
 {
    let (answer, accepted) = host().answer(&hello(&["terminal", "hologram", "files", "smell"]));
    let Message::Welcome(welcome) = answer else {
        panic!("expected a welcome, got {answer:?}")
    };
    assert_eq!(
        welcome.capabilities,
        [Capability::Terminal, Capability::Files]
    );
    assert_eq!(
        accepted.unwrap().to_vec(),
        [Capability::Terminal, Capability::Files]
    );
}

#[test]
fn a_client_with_no_known_capabilities_is_welcomed_with_none() {
    let (answer, _) = host().answer(&hello(&["hologram"]));
    let Message::Welcome(welcome) = answer else {
        panic!("expected a welcome")
    };
    assert!(welcome.capabilities.is_empty());
}

#[test]
fn capability_wire_names_are_the_ones_clients_write() {
    let names: Vec<&str> = Capability::ALL
        .iter()
        .map(|capability| capability.name())
        .collect();
    assert_eq!(names, ["terminal", "files", "pluginPages", "browser"]);
    for capability in Capability::ALL {
        let encoded = ciborium::Value::serialized(&capability).unwrap();
        assert_eq!(encoded.as_text(), Some(capability.name()));
        assert_eq!(Capability::parse(capability.name()), Some(capability));
    }
}

struct PageChannel;
impl StreamChannel for PageChannel {
    const NAME: &'static str = "test:page";
    const CAPABILITY: Option<Capability> = Some(Capability::PluginPages);
    type Open = String;
}

struct OpenChannel;
impl RequestChannel for OpenChannel {
    const NAME: &'static str = "test:open";
    type Request = ();
    type Response = ();
}

#[test]
fn a_channel_declares_the_capability_it_needs_and_a_client_set_covers_it_or_not() {
    let mut catalogue = Catalogue::new();
    catalogue.stream::<PageChannel>().request::<OpenChannel>();
    let page = catalogue.get("test:page").unwrap();
    let open = catalogue.get("test:open").unwrap();
    assert_eq!(page.capability(), Some(Capability::PluginPages));
    assert_eq!(open.capability(), None);

    let terminal_only = CapabilitySet::from_names(["terminal"]);
    assert!(!page.covered_by(&terminal_only));
    assert!(
        open.covered_by(&terminal_only),
        "a channel that needs nothing is covered by any set"
    );
    assert!(open.covered_by(&CapabilitySet::empty()));
    assert!(page.covered_by(&CapabilitySet::from_names(["terminal", "pluginPages"])));
}
