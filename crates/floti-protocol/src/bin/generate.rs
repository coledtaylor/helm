//! Writes the protocol's JSON Schema and TypeScript into
//! `crates/floti-protocol/generated/`.

use floti_protocol::Catalogue;
use floti_protocol::generate::{generated_dir, write_generated};

fn main() {
    let dir = generated_dir();
    match write_generated(&dir, &Catalogue::protocol()) {
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
}
