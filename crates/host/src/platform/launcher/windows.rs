//! Starting a program on Windows: a batch file goes through `cmd.exe` with
//! its line in a variable; anything else runs as it is.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use super::{Program, ProgramLauncher, as_given, batch};

/// The Windows implementation.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl ProgramLauncher for Native {
    fn resolve(&self, program: &OsStr, args: &[OsString]) -> Program {
        match find_program(program) {
            Some(found) if batch::is_batch_file(&found) => Program {
                program: comspec(),
                args: batch::cmd_args(),
                env: vec![(batch::LINE_VAR.into(), batch::line(&found, args).into())],
            },
            _ => as_given(program, args),
        }
    }
}

/// `%ComSpec%`, or `cmd.exe` on `PATH` when it is not set.
fn comspec() -> OsString {
    std::env::var_os("ComSpec")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "cmd.exe".into())
}

/// Where `program` is, as `CreateProcess` and a shell would look: as given
/// when it names a folder, otherwise in each `PATH` folder, trying each
/// `PATHEXT` extension when it has none of its own.
fn find_program(program: &OsStr) -> Option<PathBuf> {
    let program = Path::new(program);
    let extensions = extensions(program);
    let candidates = |dir: &Path| -> Vec<PathBuf> {
        extensions
            .iter()
            .map(|ext| {
                let mut name = dir.join(program).into_os_string();
                name.push(ext);
                PathBuf::from(name)
            })
            .collect()
    };
    if program.components().count() > 1 || program.is_absolute() {
        return candidates(Path::new(""))
            .into_iter()
            .find(|path| path.is_file());
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .flat_map(|dir| candidates(&dir))
        .find(|path| path.is_file())
}

/// The extensions to try: none for a name that has one, `PATHEXT`'s for a
/// name that does not.
fn extensions(program: &Path) -> Vec<OsString> {
    if program.extension().is_some() {
        return vec![OsString::new()];
    }
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_owned());
    pathext
        .split(';')
        .filter(|ext| !ext.is_empty())
        .map(|ext| OsString::from(ext.to_lowercase()))
        .collect()
}
