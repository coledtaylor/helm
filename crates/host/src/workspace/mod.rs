//! The workspace: what the host knows about the user's folders and serves to
//! a client's sidebar, launcher, settings and Files view, the way today's
//! app does in `packages/core` and the desktop's main process.
//!
//! - [`settings`]: the host's settings, typed over `app_settings`.
//! - [`app`]: the host's identity, `app:info`.
//! - [`setup`]: each backend's executable, version and sign-in.
//! - [`roots`]: the folders the host knows, which every Files and content
//!   request must name.
//! - [`discovery`]: scanning roots for projects and harnesses, and their git
//!   state.
//! - [`profiles`]: saved launch profiles.
//! - [`templates`]: harness templates in the user's templates folder.
//! - [`content`]: notes and documents in a known scope, and the note write.
//! - [`render`]: markdown and code rendered to sanitised HTML.
//! - [`files`]: the Files view's listing, reading, git status and watching.

pub mod app;
pub mod content;
pub mod discovery;
pub mod files;
pub mod profiles;
pub mod render;
pub mod roots;
pub mod settings;
pub mod setup;
pub mod templates;
