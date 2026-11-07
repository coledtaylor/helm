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
//!
//! A tool call is abandoned, and its family's future dropped, when nobody is
//! waiting for its answer any more: its connection closed, the session sent
//! `notifications/cancelled` naming it (on another request: the transport is
//! stateless), or the session's token was revoked.

use std::collections::HashMap;
use std::convert::Infallible;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use http::header::{
    ACCEPT, ALLOW, AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE, ORIGIN, WWW_AUTHENTICATE,
};
use http::request::Parts;
use http::{HeaderMap, HeaderValue, Method, Request, Response, StatusCode};
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, LengthLimitError, Limited};
use hyper::body::{Body, Frame, Incoming, SizeHint};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinSet;

use rmcp::model::{ProtocolVersion, TASKS_EXTENSION_ID};

use super::mcp::{self, Abandoned, FamilyService};
use super::tasks::{AsTask, Tasks};
use super::tokens::Tokens;
use super::{Caller, Delivery, FamilySource, GrantId, Hook, JsonObject, SHELL_HEADER, ToolFamily};

/// The largest request body read: far past any tool call's arguments.
pub(super) const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

/// How long a connection may take to send a request's headers.
const HEADER_PATIENCE: Duration = Duration::from_secs(10);

/// How long the body of a refused request is waited for, to be thrown away.
const DISCARD_PATIENCE: Duration = Duration::from_secs(5);

type Answer = Response<BoxBody<Bytes, Infallible>>;

/// The families and the tokens, shared by every connection.
pub(super) struct Router {
    /// The families this listener always has, in order.
    families: Vec<Arc<Family>>,
    /// The families that come and go, read on every request and grant.
    source: Option<Arc<dyn FamilySource>>,
    tokens: Mutex<Tokens>,
    /// The tool calls each grant has waiting, by JSON-RPC id, so a session's
    /// `notifications/cancelled` and its token's revocation reach them.
    in_flight: Mutex<InFlight>,
    /// The calls answered as tasks, held by grant.
    tasks: Arc<Tasks>,
}

type InFlight = HashMap<GrantId, HashMap<String, watch::Sender<bool>>>;

struct Family {
    def: Arc<dyn ToolFamily>,
    service: FamilyService,
}

impl Family {
    fn new(def: Arc<dyn ToolFamily>) -> Arc<Self> {
        Arc::new(Self {
            service: mcp::service(Arc::clone(&def)),
            def,
        })
    }
}

impl Router {
    pub(super) fn new(
        families: Vec<Arc<dyn ToolFamily>>,
        source: Option<Arc<dyn FamilySource>>,
    ) -> Self {
        Self {
            families: families.into_iter().map(Family::new).collect(),
            source,
            tokens: Mutex::new(Tokens::default()),
            in_flight: Mutex::new(HashMap::new()),
            tasks: Arc::default(),
        }
    }

    /// Every family now: the fixed ones, then each from the source whose
    /// name and route no family before it has.
    fn families_now(&self) -> Vec<Arc<dyn ToolFamily>> {
        let mut all: Vec<Arc<dyn ToolFamily>> = self
            .families
            .iter()
            .map(|family| Arc::clone(&family.def))
            .collect();
        if let Some(source) = &self.source {
            for family in source.families() {
                let clashes = all
                    .iter()
                    .any(|other| other.name() == family.name() || other.route() == family.route());
                if !clashes && family.route().starts_with('/') {
                    all.push(family);
                }
            }
        }
        all
    }

    /// The families switched on now.
    pub(super) fn families_on(&self) -> Vec<Arc<dyn ToolFamily>> {
        self.families_now()
            .into_iter()
            .filter(|family| family.is_on())
            .collect()
    }

    /// Abandons every call `grant` has waiting, and drops every task it has
    /// held, with nothing they asked for on delivery run: its token is gone.
    pub(super) fn abandon_grant(&self, grant: GrantId) {
        if let Some(calls) = self.in_flight().remove(&grant) {
            for abandoned in calls.values() {
                let _ = abandoned.send(true);
            }
        }
        self.tasks.abandon_grant(grant);
    }

    /// Abandons every call waiting and drops every task: the listener is
    /// stopping.
    pub(super) fn abandon_all(&self) {
        for (_, calls) in self.in_flight().drain() {
            for abandoned in calls.values() {
                let _ = abandoned.send(true);
            }
        }
        self.tasks.abandon_all();
    }

    fn in_flight(&self) -> MutexGuard<'_, InFlight> {
        self.in_flight
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    pub(super) fn tokens(&self) -> MutexGuard<'_, Tokens> {
        self.tokens
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    async fn answer(self: &Arc<Self>, request: Request<Incoming>) -> Answer {
        let (mut parts, body) = request.into_parts();
        let (family, mut caller) = match self.admit(&parts) {
            Ok(admitted) => admitted,
            Err(refused) => {
                discard(body);
                return *refused;
            }
        };
        // `floti agent` says it is a command in the session's shell. It is
        // the request's own account of itself, which only chooses how a wait
        // is held, and the token above is what says who is calling.
        caller.shell = parts
            .headers
            .get(SHELL_HEADER)
            .is_some_and(|value| value.as_bytes() == b"1");

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
        // A call is registered so it can be abandoned; a cancel abandons the
        // one it names, of this token's calls only.
        let message = cancellation_of(&body);
        let waiting = match &message {
            Cancellation::Call(call) => {
                let (abandoned, watching) = watch::channel(false);
                self.in_flight()
                    .entry(caller.grant)
                    .or_default()
                    .insert(call.key.clone(), abandoned);
                parts.extensions.insert(Abandoned(watching));
                Some(Waiting {
                    router: Arc::clone(self),
                    grant: caller.grant,
                    key: call.key.clone(),
                })
            }
            Cancellation::Cancel(key) => {
                if let Some(abandoned) = self
                    .in_flight()
                    .get(&caller.grant)
                    .and_then(|calls| calls.get(key))
                {
                    let _ = abandoned.send(true);
                }
                None
            }
            Cancellation::None => None,
        };
        // `rmcp` would refuse a client that left `text/event-stream` out of
        // what it accepts, which no rule here asks for.
        parts
            .headers
            .insert(ACCEPT, HeaderValue::from_static(MCP_ACCEPT));
        parts.extensions.insert(caller);
        parts.extensions.insert(Arc::clone(&self.tasks));
        // A call answered as a task is a one-reply call that starts one: only
        // when it is at 2026-07-28 and declares the tasks extension, and the
        // family says so. Every other request keeps the answer it has always
        // had.
        let as_task = matches!(
            &message,
            Cancellation::Call(call) if call.declares_tasks
                && family.def.answers_as_task(caller, &call.name, &call.arguments)
        );
        if as_task {
            parts.extensions.insert(AsTask);
        }
        let delivery = Delivery::default();
        parts.extensions.insert(delivery.clone());
        let request = Request::from_parts(parts, Full::new(body));
        // A call that holds is answered as a stream, so it can say it is
        // still there; every other call is one JSON reply.
        if let Cancellation::Call(call) = &message
            && !as_task
            && family.def.holds(caller, &call.name, &call.arguments)
        {
            return stream_call(
                family,
                request,
                call.id.clone(),
                call.progress_token.clone(),
                delivery,
                waiting,
            );
        }
        let mut answer = family.service.handle(request).await;
        no_store(answer.headers_mut());
        match delivery.take() {
            Some(hook) => answer.map(|inner| {
                Confirmed {
                    inner,
                    delivered: Some(hook),
                }
                .boxed()
            }),
            None => answer,
        }
    }

    /// The first four checks, made on the head alone: the family a request
    /// is for and who is calling, or the refusal it gets.
    fn admit(&self, parts: &Parts) -> Result<(Arc<Family>, Caller), Box<Answer>> {
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
        let admits = |def: &Arc<dyn ToolFamily>| {
            def.route() == path && def.is_on() && holder.holds(def.name())
        };
        let family = match self.families.iter().find(|family| admits(&family.def)) {
            Some(family) => Arc::clone(family),
            None => match self
                .families_now()
                .into_iter()
                .skip(self.families.len())
                .find(admits)
            {
                Some(def) => Family::new(def),
                None => return Err(Box::new(refusal(StatusCode::NOT_FOUND, "Not found."))),
            },
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

/// Takes a call out of the waiting ones once it is answered or dropped.
struct Waiting {
    router: Arc<Router>,
    grant: GrantId,
    key: String,
}

impl Drop for Waiting {
    fn drop(&mut self) {
        let mut in_flight = self.router.in_flight();
        if let Some(calls) = in_flight.get_mut(&self.grant) {
            calls.remove(&self.key);
            if calls.is_empty() {
                in_flight.remove(&self.grant);
            }
        }
    }
}

/// How often a held call says it is still there. Well inside the five
/// minutes of silence after which an agent gives up on an HTTP tool call.
pub(super) const PROGRESS_EVERY: Duration = Duration::from_secs(60);

/// What a held call says each [`PROGRESS_EVERY`]: a progress notification on
/// the request's token, or, for a request that gave none, a log notification,
/// since a progress notification without a token names nothing. Tokio's own
/// clock, so a test steps it.
pub(super) struct Progress {
    ticks: tokio::time::Interval,
    token: Option<serde_json::Value>,
    sent: u64,
}

impl Progress {
    /// A ticker whose first notification is one `every` from now.
    pub(super) fn new(every: Duration, token: Option<serde_json::Value>) -> Self {
        let mut ticks = tokio::time::interval_at(tokio::time::Instant::now() + every, every);
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        Self {
            ticks,
            token,
            sent: 0,
        }
    }

    /// Resolves at the next notification, as the server-sent event that
    /// carries it. Cancel-safe.
    pub(super) async fn next(&mut self) -> Bytes {
        self.ticks.tick().await;
        self.sent += 1;
        let notification = match &self.token {
            Some(token) => serde_json::json!({
                "jsonrpc": "2.0",
                "method": "notifications/progress",
                "params": {
                    "progressToken": token,
                    "progress": self.sent,
                    "message": "Still waiting.",
                },
            }),
            None => serde_json::json!({
                "jsonrpc": "2.0",
                "method": "notifications/message",
                "params": { "level": "info", "logger": "floti", "data": "Still waiting." },
            }),
        };
        event(&notification.to_string())
    }
}

/// `json` as one server-sent event.
fn event(json: &str) -> Bytes {
    Bytes::from(format!("data: {json}\n\n"))
}

/// What a streamed reply is made of.
enum Chunk {
    /// A progress notification.
    Event(Bytes),
    /// The result, with what to run once the connection has taken it.
    Last(Bytes, Option<Hook>),
}

/// A streamed reply: what the call sends as it holds, until its result.
struct Streamed {
    events: mpsc::Receiver<Chunk>,
    /// Run when the stream ends after its result was handed over.
    on_end: Option<Hook>,
}

impl Body for Streamed {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        match self.events.poll_recv(cx) {
            Poll::Ready(Some(Chunk::Event(bytes))) => Poll::Ready(Some(Ok(Frame::data(bytes)))),
            Poll::Ready(Some(Chunk::Last(bytes, hook))) => {
                self.on_end = hook;
                Poll::Ready(Some(Ok(Frame::data(bytes))))
            }
            Poll::Ready(None) => {
                if let Some(hook) = self.on_end.take() {
                    hook();
                }
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

/// A reply body that runs a hook once its last frame has been handed to the
/// connection: when the family asked to hear that its answer arrived. A body
/// dropped before that, because the connection went, never runs it.
struct Confirmed {
    inner: BoxBody<Bytes, Infallible>,
    delivered: Option<Hook>,
}

impl Body for Confirmed {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        let polled = Pin::new(&mut self.inner).poll_frame(cx);
        let last = match &polled {
            Poll::Ready(Some(Ok(_))) => self.inner.is_end_stream(),
            Poll::Ready(None) => true,
            _ => false,
        };
        if last && let Some(hook) = self.delivered.take() {
            hook();
        }
        polled
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

/// Answers a call that holds as a stream: a notification each
/// [`PROGRESS_EVERY`] while `request` is being answered, then its result as
/// the last event. The call runs in a task of its own that ends, and so
/// abandons the call, the moment nobody reads the stream any more.
fn stream_call(
    family: Arc<Family>,
    request: Request<Full<Bytes>>,
    id: serde_json::Value,
    token: Option<serde_json::Value>,
    delivery: Delivery,
    waiting: Option<Waiting>,
) -> Answer {
    let (events, reader) = mpsc::channel(4);
    tokio::spawn(async move {
        let _waiting = waiting;
        let mut progress = Progress::new(PROGRESS_EVERY, token);
        let handled = family.service.handle(request);
        tokio::pin!(handled);
        let answered = loop {
            tokio::select! {
                answered = &mut handled => break answered,
                notification = progress.next() => {
                    if events.send(Chunk::Event(notification)).await.is_err() {
                        return;
                    }
                }
                () = events.closed() => return,
            }
        };
        let json = answered
            .into_body()
            .collect()
            .await
            .map(|collected| collected.to_bytes())
            .ok()
            .filter(|bytes| serde_json::from_slice::<serde_json::Value>(bytes).is_ok())
            .unwrap_or_else(|| {
                Bytes::from(
                    serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": { "code": -32603, "message": "Floti could not answer that call." },
                    })
                    .to_string(),
                )
            });
        let last = event(&String::from_utf8_lossy(&json));
        let _ = events.send(Chunk::Last(last, delivery.take())).await;
    });
    let mut answer = Response::new(
        Streamed {
            events: reader,
            on_end: None,
        }
        .boxed(),
    );
    answer
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    no_store(answer.headers_mut());
    answer
}

/// What a body says about cancellation.
enum Cancellation {
    /// A `tools/call` request: one that can be abandoned.
    Call(Box<CallInfo>),
    /// `notifications/cancelled`, naming the request it gives up on.
    Cancel(String),
    None,
}

/// A `tools/call` request as the listener reads it before `rmcp` does.
struct CallInfo {
    /// Its JSON-RPC id, as the text a cancel names it by.
    key: String,
    id: serde_json::Value,
    name: String,
    arguments: JsonObject,
    /// What the client asked progress to be reported on, when it did.
    progress_token: Option<serde_json::Value>,
    /// The request's metadata names 2026-07-28 and the client capabilities it
    /// carries declare the tasks extension: the only request a call may be
    /// answered as a task to.
    declares_tasks: bool,
}

/// Whether a `tools/call`'s `_meta` names the revision that carries tasks and
/// declares the tasks extension.
fn declares_tasks(meta: Option<&serde_json::Value>) -> bool {
    let Some(meta) = meta else {
        return false;
    };
    meta.get("io.modelcontextprotocol/protocolVersion")
        .and_then(serde_json::Value::as_str)
        == Some(ProtocolVersion::V_2026_07_28.as_str())
        && meta
            .get("io.modelcontextprotocol/clientCapabilities")
            .and_then(|capabilities| capabilities.get("extensions"))
            .and_then(|extensions| extensions.get(TASKS_EXTENSION_ID))
            .is_some_and(serde_json::Value::is_object)
}

fn cancellation_of(body: &[u8]) -> Cancellation {
    let Ok(serde_json::Value::Object(message)) = serde_json::from_slice(body) else {
        return Cancellation::None;
    };
    let method = message
        .get("method")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    match message.get("id").filter(|id| !id.is_null()) {
        Some(id) if method == "tools/call" => {
            let params = message.get("params");
            Cancellation::Call(Box::new(CallInfo {
                key: id.to_string(),
                id: id.clone(),
                name: params
                    .and_then(|params| params.get("name"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                arguments: params
                    .and_then(|params| params.get("arguments"))
                    .and_then(serde_json::Value::as_object)
                    .cloned()
                    .unwrap_or_default(),
                progress_token: params
                    .and_then(|params| params.get("_meta"))
                    .and_then(|meta| meta.get("progressToken"))
                    .filter(|token| token.is_string() || token.is_number())
                    .cloned(),
                declares_tasks: declares_tasks(params.and_then(|params| params.get("_meta"))),
            }))
        }
        Some(_) => Cancellation::None,
        None if method == "notifications/cancelled" => message
            .get("params")
            .and_then(|params| params.get("requestId"))
            .filter(|id| !id.is_null())
            .map_or(Cancellation::None, |id| {
                Cancellation::Cancel(id.to_string())
            }),
        None => Cancellation::None,
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
/// of a method it was never given. `tasks/get` and `tasks/cancel` are every
/// family's to be asked, and a family that offers no tasks answers them as a
/// method it has not got; `tasks/update` is no family's, since no task here
/// ever asks its client for input.
const METHODS: [&str; 7] = [
    "initialize",
    "server/discover",
    "ping",
    "tools/list",
    "tools/call",
    "tasks/get",
    "tasks/cancel",
];

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
    use std::sync::atomic::{AtomicBool, Ordering};

    use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
    use serde_json::{Value, json};
    use tokio::sync::Notify;

    use super::super::{Caller, Delivery, GrantId, ToolFamily, ToolFuture};
    use super::*;

    /// A family with one tool, `hold`, that holds until the test releases it,
    /// and says whether it was dropped before that or delivered.
    struct Holdup {
        release: Notify,
        finished: AtomicBool,
        dropped: AtomicBool,
        delivered: Arc<AtomicBool>,
    }

    impl Holdup {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                release: Notify::new(),
                finished: AtomicBool::new(false),
                dropped: AtomicBool::new(false),
                delivered: Arc::new(AtomicBool::new(false)),
            })
        }
    }

    /// Notes that the call it lives in was dropped.
    struct DropNote<'a>(&'a AtomicBool);

    impl Drop for DropNote<'_> {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    impl ToolFamily for Holdup {
        fn name(&self) -> &str {
            "floti-holdup"
        }

        fn route(&self) -> &str {
            "/mcp/holdup"
        }

        fn instructions(&self) -> &str {
            "Tools that hold."
        }

        fn is_on(&self) -> bool {
            true
        }

        fn tools(&self) -> Vec<Tool> {
            let Value::Object(schema) = json!({ "type": "object", "properties": {} }) else {
                unreachable!("a schema is an object")
            };
            vec![Tool::new("hold", "Holds until released.", schema)]
        }

        fn holds(&self, _caller: Caller, _name: &str, _arguments: &JsonObject) -> bool {
            true
        }

        fn call<'a>(
            &'a self,
            _caller: Caller,
            _name: &'a str,
            _arguments: JsonObject,
        ) -> ToolFuture<'a> {
            Box::pin(async move {
                let _note = DropNote(&self.dropped);
                self.release.notified().await;
                self.finished.store(true, Ordering::SeqCst);
                CallToolResult::success(vec![ContentBlock::text("released")])
            })
        }

        fn call_with<'a>(
            &'a self,
            caller: Caller,
            name: &'a str,
            arguments: JsonObject,
            delivery: Delivery,
        ) -> ToolFuture<'a> {
            let delivered = Arc::clone(&self.delivered);
            delivery.on_delivered(move || delivered.store(true, Ordering::SeqCst));
            self.call(caller, name, arguments)
        }
    }

    /// A `tools/call` of `hold` with id 7, carrying `token` as its progress
    /// token when there is one.
    fn hold_request(token: Option<&str>, delivery: &Delivery) -> Request<Full<Bytes>> {
        let mut params = json!({ "name": "hold", "arguments": {} });
        if let Some(token) = token {
            params["_meta"] = json!({ "progressToken": token });
        }
        let body = json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": params });
        let mut request = Request::builder()
            .method(Method::POST)
            .uri("/mcp/holdup")
            .header(http::header::HOST, "127.0.0.1:1")
            .header(ACCEPT, MCP_ACCEPT)
            .header(CONTENT_TYPE, "application/json")
            .body(Full::new(Bytes::from(body.to_string())))
            .expect("a request");
        request.extensions_mut().insert(Caller {
            grant: GrantId::for_tests(1),
            session: None,
            shell: false,
        });
        request.extensions_mut().insert(delivery.clone());
        request
    }

    /// The held call of `family`, as the listener answers it.
    fn held(family: &Arc<Holdup>, token: Option<&str>) -> BoxBody<Bytes, Infallible> {
        let delivery = Delivery::default();
        let answer = stream_call(
            Family::new(Arc::clone(family) as Arc<dyn ToolFamily>),
            hold_request(token, &delivery),
            json!(7),
            token.map(|token| json!(token)),
            delivery,
            None,
        );
        assert_eq!(answer.headers()[CONTENT_TYPE], "text/event-stream");
        answer.into_body()
    }

    /// The next server-sent event of a stream, or none at its end.
    async fn next_event(body: &mut BoxBody<Bytes, Infallible>) -> Option<Value> {
        let frame = body.frame().await?.ok()?;
        let data = frame.into_data().ok()?;
        let text = String::from_utf8(data.to_vec()).expect("text");
        let json = text.strip_prefix("data: ")?.strip_suffix("\n\n")?;
        Some(serde_json::from_str(json).expect("an event carries JSON"))
    }

    /// Lets the family's call be answered `after` from now.
    fn release_after(family: &Arc<Holdup>, after: Duration) {
        let family = Arc::clone(family);
        tokio::spawn(async move {
            tokio::time::sleep(after).await;
            family.release.notify_one();
        });
    }

    /// `elapsed` is `expected`, give or take the clock's millisecond.
    fn is_about(elapsed: Duration, expected: Duration) -> bool {
        elapsed >= expected && elapsed < expected + Duration::from_millis(50)
    }

    #[tokio::test(start_paused = true)]
    async fn a_held_call_says_it_is_still_there_each_minute_and_then_gives_its_result() {
        let family = Holdup::new();
        let mut body = held(&family, Some("tok"));
        let start = tokio::time::Instant::now();
        // The call is answered halfway through the third minute.
        release_after(&family, Duration::from_secs(150));

        for minute in 1..=2u64 {
            let progress = next_event(&mut body).await.expect("a notification");
            assert_eq!(progress["method"], "notifications/progress");
            assert_eq!(progress["params"]["progressToken"], "tok");
            assert_eq!(progress["params"]["progress"], minute);
            assert!(
                is_about(start.elapsed(), Duration::from_secs(60 * minute)),
                "minute {minute} came at {:?}",
                start.elapsed()
            );
        }
        let result = next_event(&mut body).await.expect("the result");
        assert_eq!(result["id"], 7);
        assert_eq!(result["result"]["content"][0]["text"], "released");
        assert!(
            is_about(start.elapsed(), Duration::from_secs(150)),
            "the result came with nothing between the second minute and it: {:?}",
            start.elapsed()
        );
        assert!(
            next_event(&mut body).await.is_none(),
            "the result is the last event"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_held_call_that_gave_no_progress_token_is_told_with_a_log_notification() {
        let family = Holdup::new();
        let mut body = held(&family, None);
        release_after(&family, Duration::from_secs(90));

        let notice = next_event(&mut body).await.expect("a notification");
        assert_eq!(notice["method"], "notifications/message");
        assert_eq!(notice["params"]["level"], "info");
        assert!(notice["params"].get("progressToken").is_none(), "{notice}");
        let result = next_event(&mut body).await.expect("the result");
        assert_eq!(result["result"]["content"][0]["text"], "released");
    }

    #[tokio::test(start_paused = true)]
    async fn a_call_answered_before_the_first_minute_is_only_its_result() {
        let family = Holdup::new();
        let mut body = held(&family, Some("tok"));
        family.release.notify_one();

        let result = next_event(&mut body).await.expect("the result");
        assert_eq!(result["id"], 7);
        assert!(next_event(&mut body).await.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn the_hook_runs_once_the_result_has_been_handed_over() {
        let family = Holdup::new();
        let mut body = held(&family, Some("tok"));
        release_after(&family, Duration::from_secs(70));

        next_event(&mut body).await.expect("a notification");
        assert!(
            !family.delivered.load(Ordering::SeqCst),
            "a notification is not the answer"
        );
        next_event(&mut body).await.expect("the result");
        assert!(next_event(&mut body).await.is_none());
        assert!(
            family.delivered.load(Ordering::SeqCst),
            "the answer was handed over in full"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_stream_dropped_before_its_result_abandons_the_call_and_never_delivers() {
        let family = Holdup::new();
        let mut body = held(&family, Some("tok"));
        next_event(&mut body).await.expect("a notification");
        drop(body);

        // The call's task ends when nobody reads, and drops the call with it.
        for _ in 0..100 {
            if family.dropped.load(Ordering::SeqCst) {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(
            family.dropped.load(Ordering::SeqCst),
            "the call was dropped"
        );
        family.release.notify_one();
        tokio::task::yield_now().await;
        assert!(!family.finished.load(Ordering::SeqCst), "it never finished");
        assert!(
            !family.delivered.load(Ordering::SeqCst),
            "an answer nobody took is not delivered"
        );
    }

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
