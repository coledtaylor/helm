//! Ending a process tree on Linux, through its process group: the
//! implementation it shares with macOS.

pub use super::unix::Native;

#[cfg(any(test, feature = "testkit"))]
pub use super::unix::descendants;
