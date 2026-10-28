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
//!    the body is never read.
//! 3. **Route** (404): a path no family serves, or a switched-off family's.
//!    After the token, so a switched-off family is a clean 404 to a session
//!    that holds one.
//! 4. **Method** (405, `Allow: POST`): nothing here pushes to a session, so
//!    there is no SSE stream to GET.
//! 5. **Body size** (413), read at most once and only now.

use std::convert::Infallible;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use bytes::Bytes;
use http::header::{ALLOW, AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE, ORIGIN, WWW_AUTHENTICATE};
use http::{HeaderMap, HeaderValue, Method, Request, Response, StatusCode};
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, LengthLimitError, Limited};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::JoinSet;

use super::ToolFamily;
use super::mcp::{self, FamilyService};
use super::tokens::Tokens;

/// The largest request body read: far past any tool call's arguments.
pub(super) const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

/// How long a connection may take to send a request's headers.
const HEADER_PATIENCE: Duration = Duration::from_secs(10);

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
        if !origin_allowed(request.headers()) {
            return refusal(
                StatusCode::FORBIDDEN,
                "Floti serves its agent tools to local processes, not to web pages.",
            );
        }

        let Some(caller) = authorization(request.headers())
            .and_then(|value| self.tokens().resolve(value.as_bytes()))
        else {
            let mut answer = refusal(
                StatusCode::UNAUTHORIZED,
                "Floti's agent tools need the bearer token from the session's own tool configuration.",
            );
            answer
                .headers_mut()
                .insert(WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
            return answer;
        };

        let path = request.uri().path();
        let Some(family) = self
            .families
            .iter()
            .find(|family| family.def.route() == path && family.def.is_on())
        else {
            return refusal(StatusCode::NOT_FOUND, "Not found.");
        };

        if request.method() != Method::POST {
            let mut answer = refusal(
                StatusCode::METHOD_NOT_ALLOWED,
                "Floti's agent tools take POST only.",
            );
            answer
                .headers_mut()
                .insert(ALLOW, HeaderValue::from_static("POST"));
            return answer;
        }

        let (mut parts, body) = request.into_parts();
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

        parts.extensions.insert(caller);
        let mut answer = family
            .service
            .handle(Request::from_parts(parts, Full::new(body)))
            .await;
        no_store(answer.headers_mut());
        answer
    }
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
