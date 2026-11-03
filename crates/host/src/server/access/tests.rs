//! The role table, the presence window on tokio's paused clock, and the live
//! connections a revoke closes.

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;

use floti_protocol::Catalogue;
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::noise::KeyPair;

use super::{
    Asker, Confirmations, Gate, Least, LiveConnections, PRESENCE_WINDOW, gate, refusal, rule, ruled,
};
use crate::devices::Role;
use crate::server::clock::HostClock;
use crate::server::{Host, HostConfig, shell_backend};
use crate::session::ClientId;
use crate::testkit::{RunningHost, TestDirs};

const ROLES: [Role; 3] = [Role::Viewer, Role::Operator, Role::Admin];

fn here(role: Role) -> Asker {
    Asker {
        role,
        away: false,
        present: false,
    }
}

fn rank(role: Role) -> u8 {
    super::rank(role)
}

#[tokio::test(flavor = "multi_thread")]
async fn s10_every_channel_the_host_serves_has_a_least_role_and_every_rule_names_a_channel() {
    let dirs = TestDirs::new();
    let endpoint = dirs.endpoint();
    let config = HostConfig {
        run: Default::default(),
        folders: dirs.folders(),
        endpoint,
        backends: vec![Arc::new(shell_backend(&dirs.user_env()))],
        inherited_env: Vec::new(),
    };
    let (host, served) = RunningHost::start_with(config, Host::served_channels);
    host.stop(HostStopReason::Stop).await;

    let ruled: BTreeSet<&str> = ruled().collect();
    let unruled: Vec<&&str> = served.difference(&ruled).collect();
    assert!(
        unruled.is_empty(),
        "these channels are served with no least role decided for them: {unruled:?}"
    );
    let catalogue = Catalogue::protocol();
    let unknown: Vec<&&str> = ruled
        .iter()
        .filter(|name| catalogue.get(name).is_none())
        .collect();
    assert!(
        unknown.is_empty(),
        "these rules name no channel: {unknown:?}"
    );
    assert_eq!(ruled.len(), super::RULES.len(), "a channel has two rules");
}

#[test]
fn s10_each_channel_is_answered_for_the_roles_it_allows_and_refused_for_the_others() {
    for name in ruled() {
        let least = rule(name).unwrap().least;
        for role in ROLES {
            let allowed = match least {
                Least::Viewer => true,
                Least::Operator => rank(role) >= rank(Role::Operator),
                Least::Admin | Least::AdminUnlessItself => role == Role::Admin,
            };
            let gated = gate(name, here(role), false);
            if allowed {
                assert_eq!(gated, Gate::Open, "{name} for {role:?}");
            } else {
                let Gate::NotPermitted(sentence) = gated else {
                    panic!("{name} was not refused to {role:?}: {gated:?}");
                };
                assert!(
                    sentence.ends_with(&format!(
                        "this device is paired as {}.",
                        role.with_article()
                    )),
                    "{sentence}"
                );
            }
        }
    }
}

#[test]
fn s10_a_channel_with_no_least_role_is_served_to_no_device() {
    for role in ROLES {
        assert_eq!(
            gate("devices:somethingNew", here(role), false),
            Gate::NotPermitted("This host serves `devices:somethingNew` to no device.".to_owned())
        );
    }
}

#[test]
fn s3_s9_an_admin_action_is_refused_naming_what_it_takes_and_what_the_device_is_paired_as() {
    assert_eq!(
        gate("devices:approve", here(Role::Operator), false),
        Gate::NotPermitted(
            "Listing, approving or revoking devices takes an admin device, and this device is \
             paired as an operator."
                .to_owned()
        )
    );
    assert_eq!(
        gate("plugins:add", here(Role::Viewer), false),
        Gate::NotPermitted(
            "Adding, removing or switching a plugin takes an admin device, and this device is \
             paired as a viewer."
                .to_owned()
        )
    );
    assert_eq!(
        gate("session:start", here(Role::Viewer), false),
        Gate::NotPermitted(refusal(
            "Starting, stopping or changing a session",
            Role::Operator,
            Role::Viewer
        ))
    );
}

#[test]
fn s15_any_device_may_revoke_itself_and_only_an_admin_another() {
    for role in ROLES {
        assert_eq!(gate("devices:revoke", here(role), true), Gate::Open);
        let away = Asker {
            role,
            away: true,
            present: false,
        };
        assert_eq!(
            gate("devices:revoke", away, true),
            Gate::Open,
            "no presence"
        );
    }
    assert!(matches!(
        gate("devices:revoke", here(Role::Operator), false),
        Gate::NotPermitted(_)
    ));
    assert_eq!(gate("devices:revoke", here(Role::Admin), false), Gate::Open);
}

#[test]
fn s11_s12_only_an_admin_action_from_an_away_connection_asks_for_presence() {
    let away = |role, present| Asker {
        role,
        away: true,
        present,
    };
    assert_eq!(
        gate("settings:write", away(Role::Admin, false), false),
        Gate::PresenceNeeded
    );
    assert_eq!(
        gate("settings:write", away(Role::Admin, true), false),
        Gate::Open
    );
    // At the host's computer nothing asks.
    assert_eq!(gate("settings:write", here(Role::Admin), false), Gate::Open);
    // Viewer and operator requests never ask.
    assert_eq!(
        gate("session:start", away(Role::Operator, false), false),
        Gate::Open
    );
    assert_eq!(
        gate("session:list", away(Role::Viewer, false), false),
        Gate::Open
    );
}

#[test]
fn s12_presence_never_lets_a_viewer_or_operator_do_what_its_role_does_not() {
    for role in [Role::Viewer, Role::Operator] {
        let present = Asker {
            role,
            away: true,
            present: true,
        };
        assert!(matches!(
            gate("devices:list", present, false),
            Gate::NotPermitted(_)
        ));
        assert!(matches!(
            gate("host:stop", here(role), false),
            Gate::NotPermitted(_)
        ));
    }
}

#[tokio::test(start_paused = true)]
async fn s11_a_presence_lasts_five_minutes_on_the_hosts_clock_and_no_longer() {
    let dirs = TestDirs::new();
    let confirmations = Confirmations::new(HostClock::new(&dirs.data));
    let device = KeyPair::generate().unwrap().public();
    let other = KeyPair::generate().unwrap().public();
    assert!(!confirmations.recent(&device), "none confirmed yet");

    confirmations.confirm(device);
    assert!(confirmations.recent(&device));
    assert!(!confirmations.recent(&other), "kept per device");

    tokio::time::advance(PRESENCE_WINDOW - Duration::from_secs(1)).await;
    assert!(confirmations.recent(&device), "just short of five minutes");
    tokio::time::advance(Duration::from_secs(2)).await;
    assert!(!confirmations.recent(&device), "past five minutes");

    confirmations.confirm(device);
    assert!(confirmations.recent(&device), "confirmed anew");
    confirmations.forget(&device);
    assert!(!confirmations.recent(&device), "forgotten at a revoke");
}

#[tokio::test]
async fn s14_closing_a_devices_connections_closes_every_one_of_them_and_no_other() {
    let live = Arc::new(LiveConnections::default());
    let lost = KeyPair::generate().unwrap().public();
    let kept = KeyPair::generate().unwrap().public();
    let mut window = live.enter(lost, ClientId(1));
    let mut page = live.enter(lost, ClientId(2));
    let other = live.enter(kept, ClientId(3));
    assert_eq!(live.count(&lost), 2);

    assert_eq!(live.close_all(&lost), 2);
    window.closed().await;
    page.closed().await;
    assert_eq!(live.count(&lost), 0);
    assert_eq!(live.count(&kept), 1);

    drop(other);
    assert_eq!(live.count(&kept), 0, "a connection that ends leaves");
    assert_eq!(live.close_all(&lost), 0);
}
