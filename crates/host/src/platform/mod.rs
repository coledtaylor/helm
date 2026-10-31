//! What differs by OS, behind one trait per concern.
//!
//! Each concern is a folder with the trait in `mod.rs` and one file per OS
//! (`windows.rs`, `macos.rs`, `linux.rs`), each defining `Native`, the
//! implementation chosen at compile time. Those files, and the lines in each
//! `mod.rs` that pick one, are the only code in the host conditional on the
//! OS. Everything else calls the trait through `Native`.
//!
//! A concern with no implementation on an OS yet answers
//! [`Error::Unsupported`](crate::Error::Unsupported), which callers show as
//! Unknown while the feature around it keeps working.

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
compile_error!("the Floti host runs on Windows, macOS and Linux");

pub mod folders;
pub mod launcher;
pub mod links;
pub mod node_runtime;
pub mod private_files;
pub mod process_table;
pub mod process_tree;
pub mod secret_seal;
pub mod socket;
pub mod startup;
