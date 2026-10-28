//! The V8 platform and the base isolate every plugin script runs in.
//!
//! The platform starts once per process ([`start_platform`]). An isolate
//! ([`base_runtime`]) has deno_core's core and nothing of deno's beyond it,
//! plus the web's data types (`web.js`): what a script there can do is
//! compute, until the host gives it more. Once whatever else the caller
//! installs is in place, every global outside ECMAScript's, the web types
//! and the names the caller keeps is removed.

use std::sync::Once;

use deno_core::url::{Url, form_urlencoded, quirks};
use deno_core::{Extension, JsRuntime, OpState, RuntimeOptions, op2, v8};
use deno_error::JsErrorBox;

/// Starts the V8 platform, once for the whole process. Every isolate is made
/// after it; calling it again does nothing.
pub fn start_platform() {
    static PLATFORM: Once = Once::new();
    PLATFORM.call_once(|| JsRuntime::init_platform(None));
}

/// How loud a console line is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsoleLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl ConsoleLevel {
    fn parse(level: &str) -> Self {
        match level {
            "debug" => Self::Debug,
            "warn" => Self::Warn,
            "error" => Self::Error,
            _ => Self::Info,
        }
    }
}

/// Where an isolate's `console` writes. Without one, what it writes goes
/// nowhere: never to the host's own output.
pub struct ConsoleSink(pub Box<ConsoleWriter>);

/// What a [`ConsoleSink`] calls for each line.
pub type ConsoleWriter = dyn Fn(ConsoleLevel, &str);

/// What an isolate starts with beyond the base.
#[derive(Default)]
pub struct IsolateOptions {
    /// Installed after the web types and before the isolate is confined, so
    /// their ESM can capture what they need from the core.
    pub extensions: Vec<Extension>,
    /// Globals the extensions add that scripts may reach.
    pub keep: Vec<&'static str>,
    pub console: Option<ConsoleSink>,
}

/// A new isolate with the web's data types, confined to them, ECMAScript's
/// own globals and `options.keep`.
pub fn base_runtime(options: IsolateOptions) -> Result<JsRuntime, String> {
    start_platform();
    let mut extensions = vec![floti_web::init()];
    extensions.extend(options.extensions);
    let mut runtime = JsRuntime::try_new(RuntimeOptions {
        extensions,
        ..Default::default()
    })
    .map_err(|err| format!("could not start a plugin isolate: {err}"))?;
    if let Some(sink) = options.console {
        runtime.op_state().borrow_mut().put(sink);
    }
    let keep = serde_json::to_string(&options.keep).map_err(|err| err.to_string())?;
    runtime
        .execute_script(
            "floti:confine",
            format!("globalThis.__flotiConfine({keep})"),
        )
        .map_err(|err| format!("could not confine a plugin isolate: {err}"))?;
    Ok(runtime)
}

/// Runs `code` as a script and answers what it evaluated to, as a string.
pub fn evaluate_to_string(
    runtime: &mut JsRuntime,
    name: &'static str,
    code: String,
) -> Result<String, String> {
    let value = runtime
        .execute_script(name, code)
        .map_err(|err| err.to_string())?;
    deno_core::scope!(scope, runtime);
    let local = v8::Local::new(scope, value);
    Ok(local.to_rust_string_lossy(scope))
}

deno_core::extension!(
    floti_web,
    ops = [
        op_floti_url_parse,
        op_floti_url_set,
        op_floti_form_parse,
        op_floti_form_serialize,
        op_floti_utf8_decode,
        op_floti_console,
    ],
    esm_entry_point = "ext:floti_web/web.js",
    esm = [dir "src/plugins", "web.js"],
);

/// A URL's parts, in the order `web.js` reads them.
fn parts(url: &Url) -> Vec<String> {
    vec![
        quirks::href(url).to_owned(),
        quirks::origin(url),
        quirks::protocol(url).to_owned(),
        quirks::username(url).to_owned(),
        quirks::password(url).to_owned(),
        quirks::host(url).to_owned(),
        quirks::hostname(url).to_owned(),
        quirks::port(url).to_owned(),
        quirks::pathname(url).to_owned(),
        quirks::search(url).to_owned(),
        quirks::hash(url).to_owned(),
    ]
}

#[op2]
#[serde]
fn op_floti_url_parse(
    #[string] href: String,
    #[string] base: String,
    has_base: bool,
) -> Result<Vec<String>, JsErrorBox> {
    let parsed = if has_base {
        Url::parse(&base)
            .map_err(|_| JsErrorBox::type_error(format!("Invalid base URL: '{base}'")))?
            .join(&href)
    } else {
        Url::parse(&href)
    };
    parsed
        .map(|url| parts(&url))
        .map_err(|_| JsErrorBox::type_error(format!("Invalid URL: '{href}'")))
}

/// One setter. As the standard has it, a value a part cannot take leaves the
/// URL as it was; only `href` throws.
#[op2]
#[serde]
fn op_floti_url_set(
    #[string] href: String,
    #[string] part: String,
    #[string] value: String,
) -> Result<Vec<String>, JsErrorBox> {
    let mut url =
        Url::parse(&href).map_err(|_| JsErrorBox::type_error(format!("Invalid URL: '{href}'")))?;
    match part.as_str() {
        "href" => quirks::set_href(&mut url, &value)
            .map_err(|_| JsErrorBox::type_error(format!("Invalid URL: '{value}'")))?,
        "protocol" => drop(quirks::set_protocol(&mut url, &value)),
        "username" => drop(quirks::set_username(&mut url, &value)),
        "password" => drop(quirks::set_password(&mut url, &value)),
        "host" => drop(quirks::set_host(&mut url, &value)),
        "hostname" => drop(quirks::set_hostname(&mut url, &value)),
        "port" => drop(quirks::set_port(&mut url, &value)),
        "pathname" => quirks::set_pathname(&mut url, &value),
        "search" => quirks::set_search(&mut url, &value),
        "hash" => quirks::set_hash(&mut url, &value),
        other => return Err(JsErrorBox::type_error(format!("a URL has no part {other}"))),
    }
    Ok(parts(&url))
}

#[op2]
#[serde]
fn op_floti_form_parse(#[string] text: String) -> Vec<(String, String)> {
    form_urlencoded::parse(text.as_bytes())
        .into_owned()
        .collect()
}

#[op2]
#[string]
fn op_floti_form_serialize(#[serde] pairs: Vec<(String, String)>) -> String {
    form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs)
        .finish()
}

#[op2]
#[string]
fn op_floti_utf8_decode(
    #[buffer] bytes: &[u8],
    fatal: bool,
    strip_bom: bool,
) -> Result<String, JsErrorBox> {
    let bytes = match bytes {
        [0xEF, 0xBB, 0xBF, rest @ ..] if strip_bom => rest,
        all => all,
    };
    if fatal {
        std::str::from_utf8(bytes)
            .map(str::to_owned)
            .map_err(|_| JsErrorBox::type_error("The encoded data is not valid UTF-8"))
    } else {
        Ok(String::from_utf8_lossy(bytes).into_owned())
    }
}

#[op2(fast)]
fn op_floti_console(state: &mut OpState, #[string] level: &str, #[string] text: &str) {
    if let Some(sink) = state.try_borrow::<ConsoleSink>() {
        (sink.0)(ConsoleLevel::parse(level), text);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    fn eval(runtime: &mut JsRuntime, code: &str) -> String {
        evaluate_to_string(runtime, "floti:test", code.to_owned()).unwrap()
    }

    fn isolate() -> JsRuntime {
        base_runtime(IsolateOptions::default()).unwrap()
    }

    #[test]
    fn an_isolate_has_the_web_data_types_and_nothing_of_deno() {
        let mut runtime = isolate();
        let present = eval(
            &mut runtime,
            "['URL','URLSearchParams','Headers','TextEncoder','TextDecoder','AbortController',\
             'AbortSignal','Event','EventTarget','DOMException','structuredClone','console']\
             .filter((name) => typeof globalThis[name] === 'undefined').join(',')",
        );
        assert_eq!(present, "");
        let gone = eval(
            &mut runtime,
            "['Deno','__bootstrap','__flotiConfine','WebAssembly','queueMicrotask']\
             .filter((name) => name in globalThis).join(',')",
        );
        assert_eq!(gone, "");
    }

    #[test]
    fn urls_and_their_search_params_read_as_the_standard_has_them() {
        let mut runtime = isolate();
        assert_eq!(
            eval(
                &mut runtime,
                "const u = new URL('../b?x=1#h', 'https://Example.com:443/a/c');\
                 [u.href, u.origin, u.host, u.pathname, u.search, u.hash].join(' ')"
            ),
            "https://example.com/b?x=1#h https://example.com example.com /b ?x=1 #h"
        );
        assert_eq!(
            eval(
                &mut runtime,
                "const v = new URL('http://h/p?a=1&b=2');\
                 v.searchParams.append('c', 'x y'); v.searchParams.delete('a'); v.href"
            ),
            "http://h/p?b=2&c=x+y"
        );
        assert_eq!(
            eval(
                &mut runtime,
                "try { new URL('nope'); 'parsed' } catch (e) { e instanceof TypeError ? e.message : 'other' }"
            ),
            "Invalid URL: 'nope'"
        );
        assert_eq!(
            eval(
                &mut runtime,
                "String(new URLSearchParams({ a: '1', b: 'é' }))"
            ),
            "a=1&b=%C3%A9"
        );
    }

    #[test]
    fn headers_text_abort_and_clone_behave_as_in_a_browser() {
        let mut runtime = isolate();
        assert_eq!(
            eval(
                &mut runtime,
                "const h = new Headers([['B', '2'], ['a', ' 1 ']]); h.append('b', '3');\
                 JSON.stringify([...h])"
            ),
            r#"[["a","1"],["b","2, 3"]]"#
        );
        assert_eq!(
            eval(
                &mut runtime,
                "new TextDecoder().decode(new TextEncoder().encode('\u{feff}hé'))"
            ),
            "hé"
        );
        assert_eq!(
            eval(
                &mut runtime,
                "const c = new AbortController(); let heard = '';\
                 c.signal.addEventListener('abort', () => { heard = c.signal.reason.name });\
                 c.abort(); heard"
            ),
            "AbortError"
        );
        assert_eq!(
            eval(
                &mut runtime,
                "try { structuredClone(() => 1); 'cloned' } catch (e) { e.name }"
            ),
            "DataCloneError"
        );
        assert_eq!(
            eval(
                &mut runtime,
                "JSON.stringify(structuredClone({ a: [1, { b: 2 }] }))"
            ),
            r#"{"a":[1,{"b":2}]}"#
        );
    }

    #[test]
    fn console_writes_to_the_sink_the_host_gives_it() {
        let lines: Arc<Mutex<Vec<(ConsoleLevel, String)>>> = Arc::default();
        let into = Arc::clone(&lines);
        let mut runtime = base_runtime(IsolateOptions {
            console: Some(ConsoleSink(Box::new(move |level, text| {
                into.lock().unwrap().push((level, text.to_owned()));
            }))),
            ..IsolateOptions::default()
        })
        .unwrap();
        eval(
            &mut runtime,
            "console.log('n=%d', 4, { a: 1 }); console.warn('careful'); 'done'",
        );
        assert_eq!(
            *lines.lock().unwrap(),
            [
                (ConsoleLevel::Info, "n=4 { a: 1 }".to_owned()),
                (ConsoleLevel::Warn, "careful".to_owned())
            ]
        );
    }
}
