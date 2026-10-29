//! `floti.exec`: a program the manifest names, run with the arguments the
//! plugin passes and no shell, with today's rules
//! (`desktop/main/plugins/exec.ts`).
//!
//! The manifest is the whole of what can run. A plugin names a program by
//! the key it has in `exec`, never by a path or a command line, and its
//! arguments go to the program as an array, so text a user typed into a
//! plugin's form is an argument, never a command. The one place a line is
//! composed is a batch file, which Windows can only run through `cmd.exe`,
//! and that goes through the launcher's quoting, as every batch file the
//! host runs does.
//!
//! This is the edge of the sandbox: what runs here runs with the user's
//! rights, which is why a plugin that declares a program says so.
//!
//! - [`program`]: finding the program and the environment it gets.
//! - [`run`]: running it, its limits, and ending its tree.

pub mod program;
pub mod run;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use floti_protocol::Payload;
use floti_protocol::channels::plugins::PluginErrorCode;

use self::program::{Missing, find_program, launch, plain, program_env};
use super::call::{CallContext, ExecRequest, ExecResult, Methods, PluginCallError, answer};
use super::net::substitute::substitute_env;
use super::secrets::{SecretUse, SecretsAccess};

/// How long a program may run when the call does not say.
pub const EXEC_TIMEOUT_DEFAULT_MS: u64 = 60_000;
/// The most a call may give it.
pub const EXEC_TIMEOUT_MAX_MS: u64 = 600_000;
/// Programs one plugin may have running at once.
pub const EXEC_CONCURRENCY: usize = 8;
const STDIN_MAX_BYTES: usize = 16 * 1024 * 1024;
const ARGS_MAX: usize = 256;

/// `floti.exec`, with what it reaches secrets through and how many programs
/// each plugin has running.
pub struct Exec {
    secrets: Arc<dyn SecretsAccess>,
    running: Arc<Mutex<HashMap<String, usize>>>,
}

/// Serves `floti.exec`, filling declared environments from `secrets`.
pub fn register_methods(methods: &Methods, secrets: Arc<dyn SecretsAccess>) {
    let exec = Arc::new(Exec::new(secrets));
    methods.register("exec", move |context, args| {
        let exec = Arc::clone(&exec);
        async move { answer(&exec.exec(&context, &args).await?) }
    });
}

/// One of a plugin's running programs, counted until it is dropped.
struct Slot {
    running: Arc<Mutex<HashMap<String, usize>>>,
    plugin: String,
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut running = self.running.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(count) = running.get_mut(&self.plugin) {
            *count -= 1;
            if *count == 0 {
                running.remove(&self.plugin);
            }
        }
    }
}

/// `^[a-z0-9][a-z0-9-]{0,31}$`: the SDK's `NAME_PATTERN`.
fn is_program_name(name: &str) -> bool {
    let lower_or_digit = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit();
    let mut chars = name.chars();
    chars.next().is_some_and(lower_or_digit)
        && name.len() <= 32
        && chars.all(|c| lower_or_digit(c) || c == '-')
}

impl Exec {
    pub fn new(secrets: Arc<dyn SecretsAccess>) -> Self {
        Self {
            secrets,
            running: Arc::default(),
        }
    }

    /// Takes one of `plugin`'s [`EXEC_CONCURRENCY`] places, or refuses as
    /// `unavailable`.
    fn slot(&self, plugin: &str) -> Result<Slot, PluginCallError> {
        let mut running = self.running.lock().unwrap_or_else(PoisonError::into_inner);
        let count = running.entry(plugin.to_owned()).or_default();
        if *count >= EXEC_CONCURRENCY {
            return Err(PluginCallError::unavailable(format!(
                "this plugin already has {EXEC_CONCURRENCY} programs running"
            )));
        }
        *count += 1;
        Ok(Slot {
            running: Arc::clone(&self.running),
            plugin: plugin.to_owned(),
        })
    }

    /// Answers one `floti.exec(name, args, options)` call. Dropping the
    /// call (it was cancelled, the plugin was switched off or the host is
    /// stopping) ends the program's whole tree.
    pub async fn exec(
        &self,
        context: &CallContext,
        args: &[Payload],
    ) -> Result<ExecResult, PluginCallError> {
        let name = args
            .first()
            .and_then(Payload::as_text)
            .filter(|name| is_program_name(name))
            .ok_or_else(|| PluginCallError::invalid("exec needs a program name"))?;
        let spec = context
            .manifest
            .exec
            .iter()
            .find(|spec| spec.name == name)
            .ok_or_else(|| {
                PluginCallError::not_declared(format!(
                    "\"{name}\" is not one of the programs the manifest's exec lists"
                ))
            })?;
        let request = read_request(args.get(1), args.get(2))?;
        let file = find_program(&context.folder, &spec.command).map_err(|missing| {
            let message = match missing {
                Missing::NotFound => format!("{} was not found on this computer", spec.command),
                Missing::Outside => format!("{} is outside the plugin folder", spec.command),
            };
            PluginCallError::new(PluginErrorCode::NotFound, message)
        })?;
        let _slot = self.slot(&context.plugin)?;
        let declared = substitute_env(&spec.env, &mut |key| {
            self.secrets
                .reveal(
                    &context.plugin,
                    &context.manifest.secrets,
                    key,
                    SecretUse::Program,
                )
                .map(|value| value.expose().to_owned())
        })?;
        let all_args: Vec<String> = spec.args.iter().chain(&request.args).cloned().collect();
        let program = launch(&file, &all_args);
        let env = program_env(std::env::vars_os(), declared, &program);
        run::run(
            &program,
            &plain(&context.folder),
            env,
            &request,
            &spec.command,
        )
        .await
    }
}

/// Whether `value` is a call's "not given": absent, `undefined` or `null`.
fn not_given(value: Option<&Payload>) -> bool {
    matches!(value, None | Some(Payload::Null))
}

/// The call's arguments and options to `floti.exec`, checked: they came
/// from a plugin.
pub fn read_request(
    args: Option<&Payload>,
    options: Option<&Payload>,
) -> Result<ExecRequest, PluginCallError> {
    let bad_args = || PluginCallError::invalid("exec arguments must be an array of strings");
    let list: Vec<String> = if not_given(args) {
        Vec::new()
    } else {
        args.and_then(Payload::as_array)
            .ok_or_else(bad_args)?
            .iter()
            .map(|arg| {
                arg.as_text()
                    .filter(|text| !text.contains('\0'))
                    .map(str::to_owned)
                    .ok_or_else(bad_args)
            })
            .collect::<Result<_, _>>()?
    };
    if list.len() > ARGS_MAX {
        return Err(PluginCallError::invalid(format!(
            "exec takes at most {ARGS_MAX} arguments"
        )));
    }
    let mut stdin = None;
    let mut timeout_ms = EXEC_TIMEOUT_DEFAULT_MS;
    if !not_given(options) {
        let map = options
            .and_then(Payload::as_map)
            .ok_or_else(|| PluginCallError::invalid("exec options must be an object"))?;
        let field = |name: &str| {
            map.iter()
                .find(|(key, _)| key.as_text() == Some(name))
                .map(|(_, value)| value)
                .filter(|value| !value.is_null())
        };
        if let Some(value) = field("stdin") {
            let text = value
                .as_text()
                .ok_or_else(|| PluginCallError::invalid("stdin must be a string"))?;
            if text.len() > STDIN_MAX_BYTES {
                return Err(PluginCallError::invalid("stdin is too large"));
            }
            stdin = Some(text.to_owned());
        }
        if let Some(value) = field("timeoutMs") {
            let millis = match value {
                Payload::Integer(number) => {
                    f64::from(i32::try_from(i128::from(*number)).unwrap_or(i32::MAX))
                }
                Payload::Float(number) => *number,
                _ => f64::NAN,
            };
            if !millis.is_finite() || millis <= 0.0 {
                return Err(PluginCallError::invalid(
                    "timeoutMs must be a positive number",
                ));
            }
            // Whole milliseconds, at least one, at most the cap.
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let whole = millis.ceil().min(EXEC_TIMEOUT_MAX_MS as f64) as u64;
            timeout_ms = whole.clamp(1, EXEC_TIMEOUT_MAX_MS);
        }
    }
    Ok(ExecRequest {
        args: list,
        stdin,
        timeout_ms,
    })
}
