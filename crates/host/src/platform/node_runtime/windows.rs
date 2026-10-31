//! Windows: a Node release has `node.exe` at its top.

use std::path::{Path, PathBuf};

use super::NodeLayout;

/// The Windows layout.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl NodeLayout for Native {
    fn binary_in(&self, folder: &Path) -> PathBuf {
        folder.join("node.exe")
    }
}
