//! Every host channel from `shared/ipc.ts`, by domain.
//!
//! Each domain declares its channels in its own file and registers them in
//! [`declare`]. Payload types that more than one domain uses live in
//! [`common`]. [`boundary`] says where every other ipc.ts channel went: to
//! the client, or nowhere outside the host.

// The channel macros come before the domain modules so every one of them can
// use them.

/// Declares a request channel: a marker type and its [`RequestChannel`]
/// implementation.
///
/// [`RequestChannel`]: crate::channel::RequestChannel
macro_rules! request_channel {
    ($(#[$meta:meta])* $ty:ident = $name:literal, $request:ty => $response:ty $(, needs $cap:ident)?) => {
        $(#[$meta])*
        pub struct $ty;

        impl $crate::channel::RequestChannel for $ty {
            const NAME: &'static str = $name;
            $(const CAPABILITY: Option<$crate::capability::Capability> =
                Some($crate::capability::Capability::$cap);)?
            type Request = $request;
            type Response = $response;
        }
    };
}

/// Declares an event channel. `state` makes one that carries state, whose
/// snapshot is the state (or the type after `snapshot`) and whose events are
/// the state after each change; `event` makes one without.
macro_rules! event_channel {
    ($(#[$meta:meta])* $ty:ident = $name:literal, state $event:ty, snapshot $snapshot:ty $(, needs $cap:ident)?) => {
        $(#[$meta])*
        pub struct $ty;

        impl $crate::channel::EventChannel for $ty {
            const NAME: &'static str = $name;
            $(const CAPABILITY: Option<$crate::capability::Capability> =
                Some($crate::capability::Capability::$cap);)?
            const SNAPSHOT: bool = true;
            type Event = $event;
            type Snapshot = $snapshot;
        }
    };
    ($(#[$meta:meta])* $ty:ident = $name:literal, state $state:ty $(, needs $cap:ident)?) => {
        event_channel!($(#[$meta])* $ty = $name, state $state, snapshot $state $(, needs $cap)?);
    };
    ($(#[$meta:meta])* $ty:ident = $name:literal, event $event:ty $(, needs $cap:ident)?) => {
        $(#[$meta])*
        pub struct $ty;

        impl $crate::channel::EventChannel for $ty {
            const NAME: &'static str = $name;
            $(const CAPABILITY: Option<$crate::capability::Capability> =
                Some($crate::capability::Capability::$cap);)?
            const SNAPSHOT: bool = false;
            type Event = $event;
            type Snapshot = ();
        }
    };
}

/// Declares a byte-stream channel.
macro_rules! stream_channel {
    ($(#[$meta:meta])* $ty:ident = $name:literal, opens $open:ty $(, needs $cap:ident)?) => {
        $(#[$meta])*
        pub struct $ty;

        impl $crate::channel::StreamChannel for $ty {
            const NAME: &'static str = $name;
            $(const CAPABILITY: Option<$crate::capability::Capability> =
                Some($crate::capability::Capability::$cap);)?
            type Open = $open;
        }
    };
}

pub mod agent_browser;
pub mod agent_plugin;
pub mod boundary;
pub mod common;
pub mod host;
pub mod plugins;
pub mod sessions;
pub mod workspace;

use crate::channel::Catalogue;

/// Registers every domain's channels and shared payload types.
pub fn declare(catalogue: &mut Catalogue) {
    common::declare(catalogue);
    host::declare(catalogue);
    sessions::declare(catalogue);
    workspace::declare(catalogue);
    plugins::declare(catalogue);
    agent_browser::declare(catalogue);
    agent_plugin::declare(catalogue);
}
