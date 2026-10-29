//! `floti.fetch`: a plugin's only way onto the network, with today's rules
//! (`desktop/main/plugins/net.ts`).
//!
//! A background script has no network of its own. It hands the request here,
//! and the host sends it: to an origin the manifest's `network` lists and
//! nowhere else, with the `{{secrets}}` the user allowed filled in, following
//! redirects itself so that every hop is checked against the same list
//! rather than only the first.
//!
//! Redirects are taken one hop at a time, as new requests built from the
//! plugin's own template. That is what keeps a secret from following a
//! redirect somewhere it was not allowed to go: each hop's `{{key}}`s are
//! filled for that hop's origin, or the request stops, and a URL the
//! *server* supplied is never searched for placeholders at all.
//!
//! - [`substitute`]: where a placeholder is filled and how it is escaped.
//! - [`transport`]: one hop over the network, redirects reported.
//! - [`service`]: what a `service:/path` request asks of the plugin's
//!   service.

pub mod service;
pub mod substitute;
pub mod transport;

use std::sync::Arc;
use std::time::Duration;

use floti_protocol::Payload;
use floti_protocol::channels::plugins::PluginErrorCode;
use url::Url;

use self::service::{PluginServices, SERVICE_TOKEN_HEADER, ServiceEndpoint};
use self::substitute::{has_placeholder, substitute_body, substitute_headers, substitute_url};
use self::transport::{Hop, HopResult, Route, Transport};
use super::call::{
    CallContext, FetchRedirect, Methods, PluginCallError, PluginFetchRequest, PluginFetchResponse,
    answer,
};
use super::manifest::Manifest;
use super::secrets::{SecretUse, SecretsAccess};

/// Every request ends by this, its response read or not.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(120);
/// A request body past this is refused before anything is sent.
pub const REQUEST_MAX_BYTES: usize = 16 * 1024 * 1024;
/// More hops than this (the first request and each redirect) fail.
pub const MAX_HOPS: usize = 20;
const URL_MAX: usize = 8192;
const HEADERS_MAX: usize = 200;

/// Headers the transport owns. A page cannot set them in a browser either,
/// and here a wrong `Host` or `Content-Length` would be a request that lies
/// about itself.
const TRANSPORT_HEADERS: [&str; 10] = [
    "host",
    "content-length",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "te",
    "trailer",
    "expect",
    "proxy-connection",
];

/// Taken off a request whose redirect leaves its origin, as `fetch` does,
/// and the two it would have kept in a cookie jar.
const CROSS_ORIGIN_DROPPED: [&str; 3] = ["authorization", "cookie", "proxy-authorization"];

const REFUSED_METHODS: [&str; 3] = ["CONNECT", "TRACE", "TRACK"];

/// `floti.fetch`, with what it reaches secrets and services through.
pub struct Net {
    transport: Transport,
    secrets: Arc<dyn SecretsAccess>,
    services: Arc<dyn PluginServices>,
    timeout: Duration,
}

/// Serves `floti.fetch` with `net`.
pub fn register_methods(methods: &Methods, net: Arc<Net>) {
    methods.register("fetch", move |context, args| {
        let net = Arc::clone(&net);
        async move { answer(&net.fetch(&context, &args).await?) }
    });
}

impl Net {
    pub fn new(secrets: Arc<dyn SecretsAccess>, services: Arc<dyn PluginServices>) -> Self {
        Self {
            transport: Transport::new(),
            secrets,
            services,
            timeout: FETCH_TIMEOUT,
        }
    }

    /// The same, with every request ended by `timeout` instead of
    /// [`FETCH_TIMEOUT`].
    #[must_use]
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// The transport the hops go out on.
    pub fn transport(&self) -> &Transport {
        &self.transport
    }

    /// Answers one `floti.fetch` call. Cancelling `context.cancel` ends the
    /// request where it is.
    pub async fn fetch(
        &self,
        context: &CallContext,
        args: &[Payload],
    ) -> Result<PluginFetchResponse, PluginCallError> {
        let request = read_request(args.first())?;
        let target = Url::parse(&request.url)
            .map_err(|_| PluginCallError::invalid(format!("{} is not a URL", request.url)))?;
        let origin = target.origin().ascii_serialization();
        let limit = self.timeout;
        tokio::select! {
            answer = tokio::time::timeout(limit, self.follow(context, request, target)) => {
                answer.unwrap_or_else(|_| Err(PluginCallError::new(
                    PluginErrorCode::Timeout,
                    format!("no answer from {origin} within {}s", limit.as_secs_f64()),
                )))
            }
            () = context.cancel.cancelled() => {
                Err(PluginCallError::new(PluginErrorCode::Aborted, "the request was cancelled"))
            }
        }
    }

    async fn follow(
        &self,
        context: &CallContext,
        request: PluginFetchRequest,
        mut target: Url,
    ) -> Result<PluginFetchResponse, PluginCallError> {
        let manifest = &context.manifest;

        // The plugin's own service: reached by path, on the loopback port the
        // host gave it, with the token it was given. It gets its secrets
        // through its environment, so a placeholder in a request to it is a
        // mistake.
        let mut service: Option<ServiceEndpoint> = None;
        if target.scheme() == "service" {
            if manifest.service.is_none() {
                return Err(PluginCallError::not_declared(
                    "this plugin declares no service",
                ));
            }
            if has_placeholder(&request.url)
                || request
                    .headers
                    .iter()
                    .any(|(_, value)| has_placeholder(value))
            {
                return Err(PluginCallError::new(
                    PluginErrorCode::Secret,
                    "a service gets its secrets through its environment, not in requests to it",
                ));
            }
            let endpoint = self.services.endpoint(context).await?;
            let path = target.path();
            let separator = if path.starts_with('/') { "" } else { "/" };
            let query = target
                .query()
                .map(|query| format!("?{query}"))
                .unwrap_or_default();
            target = endpoint
                .origin
                .join(&format!("{separator}{path}{query}"))
                .map_err(|_| PluginCallError::invalid(format!("{} is not a URL", request.url)))?;
            service = Some(endpoint);
        } else {
            check_reach(&target, manifest, "")?;
        }

        let mut method = request.method;
        let mut body = request.body;
        let mut headers: Vec<(String, String)> = request
            .headers
            .into_iter()
            .filter(|(name, _)| !TRANSPORT_HEADERS.contains(&name.to_ascii_lowercase().as_str()))
            .filter(|(name, _)| {
                service.is_none() || !name.eq_ignore_ascii_case(SERVICE_TOKEN_HEADER)
            })
            .collect();
        let mut redirected = false;

        for hops in 0.. {
            let hop_origin = target.origin().ascii_serialization();
            let mut reveal = |key: &str| {
                self.secrets
                    .reveal(
                        &context.plugin,
                        &manifest.secrets,
                        key,
                        SecretUse::Request {
                            origin: &hop_origin,
                        },
                    )
                    .map(|value| value.expose().to_owned())
            };
            let content_type = headers
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case("content-type"))
                .map(|(_, value)| value.clone());
            let mut hop_headers = substitute_headers(&headers, &mut reveal)?;
            if let Some(endpoint) = &service {
                hop_headers.push((SERVICE_TOKEN_HEADER.to_owned(), endpoint.token.clone()));
            }
            let hop = Hop {
                // Only the plugin's own URL is searched for placeholders. A
                // Location header is the server's text, and filling it would
                // let a server name the secret it wants.
                url: if hops == 0 && service.is_none() {
                    substitute_url(&target, &mut reveal)?
                } else {
                    target.clone()
                },
                method: method.clone(),
                headers: hop_headers,
                body: substitute_body(body.as_deref(), content_type.as_deref(), &mut reveal)?,
            };

            let (status, status_text, location, response_headers) =
                match self.transport.send(&hop, Route::for_url(&hop.url)).await? {
                    HopResult::Response {
                        status,
                        status_text,
                        headers,
                        body,
                    } => {
                        return Ok(PluginFetchResponse {
                            status,
                            status_text,
                            headers,
                            body,
                            url: target.to_string(),
                            redirected,
                        });
                    }
                    HopResult::Redirect {
                        status,
                        status_text,
                        location,
                        headers,
                    } => (status, status_text, location, headers),
                };

            match request.redirect {
                FetchRedirect::Error => {
                    return Err(network(format!(
                        "{hop_origin} redirected, and the request said not to follow"
                    )));
                }
                FetchRedirect::Manual => {
                    return Ok(PluginFetchResponse {
                        status,
                        status_text,
                        headers: response_headers,
                        body: Vec::new(),
                        url: target.to_string(),
                        redirected,
                    });
                }
                FetchRedirect::Follow => {}
            }
            if hops + 1 >= MAX_HOPS {
                return Err(network(format!("more than {MAX_HOPS} redirects")));
            }

            let next = target.join(&location).map_err(|_| {
                network(format!(
                    "{hop_origin} redirected to something that is not a URL"
                ))
            })?;
            match &service {
                Some(endpoint) => {
                    if next.origin() != endpoint.origin.origin() {
                        return Err(PluginCallError::not_declared(
                            "the service redirected away from itself",
                        ));
                    }
                }
                None => check_reach(&next, manifest, " (a redirect)")?,
            }

            // A 303, and a 301 or 302 answering a POST, become a GET with no
            // body: what every browser does, so a plugin's request behaves
            // here as it would anywhere else.
            let to_get = if status == 303 {
                method != "HEAD"
            } else {
                matches!(status, 301 | 302) && method == "POST"
            };
            if to_get {
                method = "GET".to_owned();
                body = None;
                headers.retain(|(name, _)| !name.to_ascii_lowercase().starts_with("content-"));
            }
            if next.origin() != target.origin() {
                headers.retain(|(name, _)| {
                    !CROSS_ORIGIN_DROPPED.contains(&name.to_ascii_lowercase().as_str())
                });
            }
            target = next;
            redirected = true;
        }
        unreachable!("the hop loop returns from within")
    }
}

fn network(message: String) -> PluginCallError {
    PluginCallError::new(PluginErrorCode::Network, message)
}

/// Whether `url` is one the plugin may reach, or the reason it is not.
pub fn check_reach(url: &Url, manifest: &Manifest, what: &str) -> Result<(), PluginCallError> {
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err(PluginCallError::not_declared(format!(
            "{}: URLs cannot be fetched{what}",
            url.scheme()
        )));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(PluginCallError::invalid(
            "put credentials in a header, not in the URL",
        ));
    }
    if !manifest.network.iter().any(|pattern| pattern.matches(url)) {
        return Err(PluginCallError::not_declared(format!(
            "{}{what} is not one of the origins the manifest's network lists",
            url.origin().ascii_serialization()
        )));
    }
    Ok(())
}

/// Whether `method` is an HTTP token.
fn is_token(method: &str) -> bool {
    !method.is_empty()
        && method.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                        | b'-'
                )
        })
}

fn field<'a>(map: &'a [(Payload, Payload)], name: &str) -> Option<&'a Payload> {
    map.iter()
        .find(|(key, _)| key.as_text() == Some(name))
        .map(|(_, value)| value)
}

/// The request as the bridge sent it, every field checked: it came from a
/// plugin.
pub fn read_request(raw: Option<&Payload>) -> Result<PluginFetchRequest, PluginCallError> {
    let map = raw
        .and_then(Payload::as_map)
        .ok_or_else(|| PluginCallError::invalid("fetch needs a request"))?;
    let url = field(map, "url")
        .and_then(Payload::as_text)
        .filter(|url| url.len() <= URL_MAX)
        .ok_or_else(|| PluginCallError::invalid("fetch needs a URL"))?;
    let method = field(map, "method")
        .and_then(Payload::as_text)
        .filter(|method| is_token(method))
        .ok_or_else(|| PluginCallError::invalid("fetch needs a method"))?
        .to_ascii_uppercase();
    if REFUSED_METHODS.contains(&method.as_str()) {
        return Err(PluginCallError::invalid(format!(
            "{method} is not a method fetch sends"
        )));
    }
    let pairs = || PluginCallError::invalid("headers must be name and value pairs");
    let listed = field(map, "headers")
        .and_then(Payload::as_array)
        .filter(|list| list.len() <= HEADERS_MAX)
        .ok_or_else(pairs)?;
    let headers = listed
        .iter()
        .map(|pair| match pair.as_array().map(Vec::as_slice) {
            Some([name, value]) => match (name.as_text(), value.as_text()) {
                (Some(name), Some(value)) => Ok((name.to_owned(), value.to_owned())),
                _ => Err(pairs()),
            },
            _ => Err(pairs()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let body = match field(map, "body") {
        None | Some(Payload::Null) => None,
        Some(Payload::Bytes(bytes)) => Some(bytes.clone()),
        Some(_) => return Err(PluginCallError::invalid("the body must be bytes")),
    };
    if body
        .as_ref()
        .is_some_and(|body| body.len() > REQUEST_MAX_BYTES)
    {
        return Err(PluginCallError::invalid(format!(
            "a request body is limited to {} MB",
            REQUEST_MAX_BYTES / 1024 / 1024
        )));
    }
    let redirect = match field(map, "redirect").and_then(Payload::as_text) {
        Some("follow") => FetchRedirect::Follow,
        Some("manual") => FetchRedirect::Manual,
        Some("error") => FetchRedirect::Error,
        _ => {
            return Err(PluginCallError::invalid(
                "redirect must be follow, manual or error",
            ));
        }
    };
    Ok(PluginFetchRequest {
        url: url.to_owned(),
        method,
        headers,
        body,
        redirect,
    })
}
