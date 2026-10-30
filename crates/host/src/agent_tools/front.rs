//! The listener's own layer in front of `rmcp`: every check a request has to
//! pass, in order, before any of it is parsed.
//!
//! 1. **Origin** (403). A request announcing itself as from a web page that
//!    is not on this machine has no business here whatever it carries, and
//!    refusing it before the token comparison keeps the token out of a
//!    timing loop driven by something that is not an agent.
//! 2. **Token** (401, `WWW-Authenticate: Bearer`), before the route. A caller
//!    without a token learns nothing about this server but that it is there:
//!    a path that does not exist is answered exactly as one that does, and
//!    the body is never read: like every refusal before step 5, it is only
//!    thrown away, unparsed, once the answer is decided.
//! 3. **Route** (404): a path no family serves, a switched-off family's, or
//!    a family the token's launch was not given. After the token, so each is
//!    a clean 404 to a session that holds one.
//! 4. **Method** (405, `Allow: POST`): nothing here pushes to a session, so
//!    there is no SSE stream to GET.
//! 5. **Body size** (413), read at most once and only now.
//! 6. **JSON-RPC** (200 with an error): not JSON, a batch, or a method no
//!    family has, answered as today's listener answers them.

use std::convert::Infallible;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use bytes::Bytes;
use http::header::{
    ACCEPT, ALLOW, AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE, ORIGIN, WWW_AUTHENTICATE,
};
use http::request::Parts;
use http::{HeaderMap, HeaderValue, Method, Request, Response, StatusCode};
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, LengthLimitError, Limited};
use hyper::body::{Body as _, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::JoinSet;

use super::mcp::{self, FamilyService};
use super::tokens::Tokens;
use super::{Caller, ToolFamily};

/// The largest request body read: far past any tool call's arguments.
pub(super) const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

/// How long a connection may take to send a request's headers.
const HEADER_PATIENCE: Duration = Duration::from_secs(10);

/// How long the body of a refused request is waited for, to be thrown away.
const DISCARD_PATIENCE: Duration = Duration::from_secs(5);

type Answer = Response<BoxBody<Bytes, Infallible>>;

/// The families and the tokens, shared by every connection.
pub(super) struct Router {
    families: Vec<Family>,
    tokens: Mutex<Tokens>,
}

struct Family {
    def: Arc<dyn ToolFamily>,
    service: FamilyService,
}

impl Router {
    pub(super) fn new(families: Vec<Arc<dyn ToolFamily>>) -> Self {
        Self {
            families: families
                .into_iter()
                .map(|def| Family {
                    service: mcp::service(Arc::clone(&def)),
                    def,
                })
                .collect(),
            tokens: Mutex::new(Tokens::default()),
        }
    }

    pub(super) fn families_on(&self) -> impl Iterator<Item = &Arc<dyn ToolFamily>> {
        self.families
            .iter()
            .map(|family| &family.def)
            .filter(|def| def.is_on())
    }

    pub(super) fn tokens(&self) -> MutexGuard<'_, Tokens> {
        self.tokens
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    async fn answer(&self, request: Request<Incoming>) -> Answer {
        let (mut parts, body) = request.into_parts();
        let (family, caller) = match self.admit(&parts) {
            Ok(admitted) => admitted,
            Err(refused) => {
                discard(body);
                return *refused;
            }
        };

        let body = match Limited::new(body, MAX_BODY_BYTES).collect().await {
            Ok(collected) => collected.to_bytes(),
            Err(err) if err.is::<LengthLimitError>() => {
                return refusal(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "That request was too large for a tool call.",
                );
            }
            Err(_) => return refusal(StatusCode::BAD_REQUEST, "The request's body was cut short."),
        };

        if let Some(refused) = jsonrpc_refusal(&body, family.def.name()) {
            return refused;
        }
        // Every answer here is JSON, so what the caller says it accepts
        // changes nothing; `rmcp` would refuse a client that left
        // `text/event-stream` out, which no rule here asks for.
        parts
            .headers
            .insert(ACCEPT, HeaderValue::from_static(MCP_ACCEPT));
        parts.extensions.insert(caller);
        let mut answer = family
            .service
            .handle(Request::from_parts(parts, Full::new(body)))
            .await;
        no_store(answer.headers_mut());
        answer
    }

    /// The first four checks, made on the head alone: the family a request
    /// is for and who is calling, or the refusal it gets.
    fn admit(&self, parts: &Parts) -> Result<(&Family, Caller), Box<Answer>> {
        if !origin_allowed(&parts.headers) {
            return Err(Box::new(refusal(
                StatusCode::FORBIDDEN,
                "Floti serves its agent tools to local processes, not to web pages.",
            )));
        }

        let Some(holder) =
            authorization(&parts.headers).and_then(|value| self.tokens().resolve(value.as_bytes()))
        else {
            let mut answer = refusal(
                StatusCode::UNAUTHORIZED,
                "Floti's agent tools need the bearer token from the session's own tool configuration.",
            );
            answer
                .headers_mut()
                .insert(WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
            return Err(Box::new(answer));
        };

        let path = parts.uri.path();
        let Some(family) = self.families.iter().find(|family| {
            family.def.route() == path && family.def.is_on() && holder.holds(family.def.name())
        }) else {
            return Err(Box::new(refusal(StatusCode::NOT_FOUND, "Not found.")));
        };

        if parts.method != Method::POST {
            let mut answer = refusal(
                StatusCode::METHOD_NOT_ALLOWED,
                "Floti's agent tools take POST only.",
            );
            answer
                .headers_mut()
                .insert(ALLOW, HeaderValue::from_static("POST"));
            return Err(Box::new(answer));
        }

        Ok((family, holder.caller))
    }
}

/// Throws away the body of a request refused on its head, after the refusal
/// was decided and while it is being sent. Nothing of the body is kept or
/// looked at, and the refusal never waits for it.
///
/// Dropping the body unread would be wrong: hyper then stops reading and
/// closes the connection, and body bytes still on their way, or unread in
/// the socket, make the OS answer them with a reset. On Windows a reset
/// discards what the client had received but not yet read, so the refusal
/// is lost and the client sees the connection aborted. Draining it lets the
/// connection close cleanly once the body is in, as Node's server does when
/// it dumps an unread request body after the response.
///
/// The drain stops at `MAX_BODY_BYTES` or after `DISCARD_PATIENCE`, and a
/// client that sends more or stalls longer may be cut off.
fn discard(mut body: Incoming) {
    if body.is_end_stream() {
        return;
    }
    tokio::spawn(async move {
        let drain = async {
            let mut left = MAX_BODY_BYTES;
            while let Some(Ok(frame)) = body.frame().await {
                let Ok(data) = frame.into_data() else {
                    continue;
                };
                match left.checked_sub(data.len()) {
                    Some(rest) => left = rest,
                    None => break,
                }
            }
        };
        let _ = tokio::time::timeout(DISCARD_PATIENCE, drain).await;
    });
}

/// Accepts connections until `stopped` resolves (sent or dropped), then
/// ends every connection still open.
pub(super) async fn serve(
    listener: TcpListener,
    router: Arc<Router>,
    mut stopped: oneshot::Receiver<()>,
) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            _ = &mut stopped => break,
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    connections.spawn(connection(stream, Arc::clone(&router)));
                }
                // A connection that failed before it was accepted, or the
                // OS out of sockets for a moment: neither ends the listener.
                Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
            },
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
    drop(listener);
    connections.shutdown().await;
}

async fn connection(stream: TcpStream, router: Arc<Router>) {
    let service = service_fn(move |request| {
        let router = Arc::clone(&router);
        async move { Ok::<_, Infallible>(router.answer(request).await) }
    });
    let _ = http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(HEADER_PATIENCE)
        .serve_connection(TokioIo::new(stream), service)
        .await;
}

/// No `Origin`, `Origin: null`, or a loopback one: `localhost`, `127.0.0.1`
/// or `[::1]`, on any port. Anything else, or anything unreadable, is a page.
fn origin_allowed(headers: &HeaderMap) -> bool {
    headers.get_all(ORIGIN).iter().all(|value| {
        value
            .to_str()
            .is_ok_and(|origin| origin == "null" || is_loopback_origin(origin))
    })
}

fn is_loopback_origin(origin: &str) -> bool {
    let Some((scheme, rest)) = origin.split_once("://") else {
        return false;
    };
    if scheme.is_empty() || rest.contains(['/', '?', '#', '@']) {
        return false;
    }
    let host = if let Some(bracketed) = rest.strip_prefix('[') {
        match bracketed.split_once(']') {
            Some((host, "")) => host,
            Some((host, port)) if port.strip_prefix(':').is_some_and(is_port) => host,
            _ => return false,
        }
    } else {
        match rest.split_once(':') {
            Some((host, port)) if is_port(port) => host,
            Some(_) => return false,
            None => rest,
        }
    };
    host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1"
}

fn is_port(text: &str) -> bool {
    !text.is_empty()
        && text.bytes().all(|byte| byte.is_ascii_digit())
        && text.parse::<u16>().is_ok()
}

/// The one `Authorization` header. Two are no answer at all.
fn authorization(headers: &HeaderMap) -> Option<&HeaderValue> {
    let mut all = headers.get_all(AUTHORIZATION).iter();
    let first = all.next()?;
    all.next().is_none().then_some(first)
}

/// What a streamable-HTTP client accepts, as `rmcp` asks to see it.
const MCP_ACCEPT: &str = "application/json, text/event-stream";

/// The methods every family answers. A request for any other is answered
/// here, in the family's own words, rather than as whatever a library makes
/// of a method it was never given.
const METHODS: [&str; 4] = ["initialize", "ping", "tools/list", "tools/call"];

/// The JSON-RPC error a body is answered with before `rmcp` sees it, as
/// today's listener answers: not JSON (-32700), a batch or anything but one
/// request object (-32600), or a request for a method no family has
/// (-32601). A notification, which has no id, is always `rmcp`'s to accept.
fn jsonrpc_refusal(body: &[u8], family: &str) -> Option<Answer> {
    let Ok(message) = serde_json::from_slice::<serde_json::Value>(body) else {
        return Some(rpc_error(
            &serde_json::Value::Null,
            -32700,
            "Parse error: that was not JSON.",
        ));
    };
    let Some(message) = message.as_object() else {
        let said = if message.is_array() {
            "Floti does not take batched requests."
        } else {
            "That was not a JSON-RPC request."
        };
        return Some(rpc_error(&serde_json::Value::Null, -32600, said));
    };
    let id = message.get("id").filter(|id| !id.is_null())?;
    let method = message
        .get("method")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    (!METHODS.contains(&method)).then(|| {
        rpc_error(
            id,
            -32601,
            &format!("Floti's {family} server has no method \"{method}\"."),
        )
    })
}

fn rpc_error(id: &serde_json::Value, code: i64, message: &str) -> Answer {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
    .to_string();
    let mut answer = Response::new(Full::new(Bytes::from(body)).boxed());
    answer
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    no_store(answer.headers_mut());
    answer
}

fn refusal(status: StatusCode, error: &str) -> Answer {
    let body = serde_json::json!({ "error": error }).to_string();
    let mut answer = Response::new(Full::new(Bytes::from(body)).boxed());
    *answer.status_mut() = status;
    answer
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    no_store(answer.headers_mut());
    answer
}

/// Nothing here is for a browser, and none of it may be cached anywhere.
fn no_store(headers: &mut HeaderMap) {
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
}

#[cfg(test)]
mod tests {
    use super::is_loopback_origin;

    #[test]
    fn a_loopback_origin_is_localhost_127_0_0_1_or_ipv6_loopback_and_nothing_wider() {
        for origin in [
            "http://localhost",
            "https://LOCALHOST:8443",
            "http://127.0.0.1:3000",
            "http://[::1]:3000",
            "http://[::1]",
        ] {
            assert!(is_loopback_origin(origin), "{origin}");
        }
        for origin in [
            "http://127.0.0.2:3000",
            "http://localhost.example.com",
            "http://notlocalhost",
            "https://example.com",
            "http://user@localhost",
            "http://localhost:99999",
            "http://localhost:",
            "http://localhost:+80",
            "http://[::1]3000",
            "localhost",
            "nonsense",
        ] {
            assert!(!is_loopback_origin(origin), "{origin}");
        }
    }
}
