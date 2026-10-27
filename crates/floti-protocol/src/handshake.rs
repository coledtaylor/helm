//! The host's side of `hello`.
//!
//! A client says its protocol version and its capabilities. The host answers
//! with `welcome` (the version in use, the capabilities it accepted and its
//! backends) or with `refused` (both versions, and which side to update).

use crate::backend::BackendDescriptor;
use crate::capability::CapabilitySet;
use crate::message::{Hello, Message, Refused, Welcome};
use crate::version::{ProtocolVersion, negotiate};

/// What a host says about itself at connect.
#[derive(Debug, Clone, PartialEq)]
pub struct HostIdentity {
    pub protocol: ProtocolVersion,
    pub host_version: String,
    pub backends: Vec<BackendDescriptor>,
}

impl HostIdentity {
    /// `welcome` or `refused`, and the capabilities the connection has when
    /// it is accepted.
    pub fn answer(&self, hello: &Hello) -> (Message, Option<CapabilitySet>) {
        match negotiate(self.protocol, hello.protocol) {
            Ok(protocol) => {
                let capabilities =
                    CapabilitySet::from_names(hello.capabilities.iter().map(String::as_str));
                let welcome = Welcome {
                    protocol,
                    host_version: self.host_version.clone(),
                    capabilities: capabilities.to_vec(),
                    backends: self.backends.clone(),
                };
                (Message::Welcome(welcome), Some(capabilities))
            }
            Err(mismatch) => {
                let refused = Refused {
                    host: mismatch.host,
                    client: mismatch.client,
                    update: mismatch.update,
                    message: mismatch.message(),
                };
                (Message::Refused(refused), None)
            }
        }
    }
}
