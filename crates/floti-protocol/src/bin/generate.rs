//! Writes the protocol's JSON Schema and TypeScript into
//! `crates/floti-protocol/generated/`, and the current protocol version's
//! record into `crates/floti-protocol/versions/` when there is none. A record
//! that is there and differs from the protocol is left as it is: the command
//! names each difference and the rule to bump the version by, and fails.

use floti_protocol::generate::{generated_dir, write_generated};
use floti_protocol::record::{Written, records_dir, write_record};
use floti_protocol::{Catalogue, PROTOCOL_VERSION};

fn main() {
    let catalogue = Catalogue::protocol();
    let dir = generated_dir();
    match write_generated(&dir, &catalogue) {
        Ok(paths) => {
            for path in paths {
                println!("wrote {}", path.display());
            }
        }
        Err(error) => {
            eprintln!("could not write {}: {error}", dir.display());
            std::process::exit(1);
        }
    }
    let records = records_dir();
    match write_record(&records, PROTOCOL_VERSION, &catalogue) {
        Ok(Written::Wrote(path)) => println!("wrote {}", path.display()),
        Ok(Written::Current) => {
            println!("the record of Floti protocol {PROTOCOL_VERSION} is current")
        }
        Ok(Written::Differs(why)) => {
            eprintln!("{why}");
            std::process::exit(1);
        }
        Err(error) => {
            eprintln!(
                "could not write the record in {}: {error}",
                records.display()
            );
            std::process::exit(1);
        }
    }
}
