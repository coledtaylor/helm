//! macOS: a Node release has its executable at `bin/node`.

use std::path::{Path, PathBuf};

use super::NodeLayout;

/// The macOS layout.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl NodeLayout for Native {
    fn binary_in(&self, folder: &Path) -> PathBuf {
        folder.join("bin").join("node")
    }
}
