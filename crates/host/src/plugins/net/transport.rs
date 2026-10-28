//! One hop of `floti.fetch` over the network: a request sent as it is, and
//! its answer, with a redirect reported rather than followed.
//!
//! The client sends no cookies and keeps none, caches nothing, follows no
//! redirect of its own, and uses the system proxy. Its certificates are
//! checked by the OS's verifier, except for a request to a loopback address
//! (`localhost`, `127.0.0.1` or `[::1]`), which goes direct and accepts a
//! self-signed certificate: a service on this machine, or a local build of an
//! API, which is the rule the browser pane follows and for the same reason.

use std::sync::OnceLock;

use floti_protocol::channels::plugins::PluginErrorCode;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, LOCATION};
use reqwest::{Client, Method, StatusCode, redirect};
use url::{Host, Url};

use crate::plugins::call::PluginCallError;

/// A response body past this is refused rather than held in memory.
pub const RESPONSE_MAX_BYTES: usize = 32 * 1024 * 1024;

/// Which client a hop goes out on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// A loopback address: direct, and a self-signed certificate is accepted.
    Loopback,
    /// Anywhere else: the system proxy, and certificates the OS trusts.
    Verified,
}

impl Route {
    /// The route for `url`. Deliberately narrow: a wider rule is a wider
    /// hole, and a certificate exception hangs off it.
    pub fn for_url(url: &Url) -> Self {
        let loopback = match url.host() {
            Some(Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
            Some(Host::Ipv4(address)) => address == std::net::Ipv4Addr::LOCALHOST,
            Some(Host::Ipv6(address)) => address == std::net::Ipv6Addr::LOCALHOST,
            None => false,
        };
        if loopback {
            Self::Loopback
        } else {
            Self::Verified
        }
    }
}

/// One request, ready to send: secrets filled, headers final.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hop {
    pub url: Url,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

/// What one hop came back with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HopResult {
    Response {
        status: u16,
        status_text: String,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    },
    Redirect {
        status: u16,
        status_text: String,
        location: String,
        headers: Vec<(String, String)>,
    },
}

/// The two clients, each made the first time a hop needs it.
#[derive(Default)]
pub struct Transport {
    verified: OnceLock<Result<Client, String>>,
    loopback: OnceLock<Result<Client, String>>,
}

fn network(message: impl Into<String>) -> PluginCallError {
    PluginCallError::new(PluginErrorCode::Network, message)
}

/// The error and every cause under it, as one line.
fn described(err: &(dyn std::error::Error + 'static)) -> String {
    let mut text = err.to_string();
    let mut source = err.source();
    while let Some(cause) = source {
        let cause_text = cause.to_string();
        if !text.contains(&cause_text) {
            text.push_str(": ");
            text.push_str(&cause_text);
        }
        source = cause.source();
    }
    text
}

fn make_client(route: Route) -> Result<Client, String> {
    // Every rustls client in the process uses ring; a provider installed
    // already (by this or anything else) is kept.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let builder = Client::builder()
        .tls_backend_rustls()
        .redirect(redirect::Policy::none());
    let builder = match route {
        Route::Loopback => builder.no_proxy().tls_danger_accept_invalid_certs(true),
        Route::Verified => builder,
    };
    builder.build().map_err(|err| {
        format!(
            "Floti could not set up its network client: {}",
            described(&err)
        )
    })
}

fn header_pairs(headers: &HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_owned(),
                String::from_utf8_lossy(value.as_bytes()).into_owned(),
            )
        })
        .collect()
}

fn is_redirect(status: StatusCode) -> bool {
    matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
}

impl Transport {
    pub fn new() -> Self {
        Self::default()
    }

    fn client(&self, route: Route) -> Result<&Client, PluginCallError> {
        let slot = match route {
            Route::Loopback => &self.loopback,
            Route::Verified => &self.verified,
        };
        slot.get_or_init(|| make_client(route))
            .as_ref()
            .map_err(|message| network(message.clone()))
    }

    /// Sends `hop` on `route`'s client and reads its answer. A header the
    /// transport cannot send is refused as `invalid` before anything goes
    /// out; a body past [`RESPONSE_MAX_BYTES`] and any transport failure are
    /// `network`.
    pub async fn send(&self, hop: &Hop, route: Route) -> Result<HopResult, PluginCallError> {
        let method = Method::from_bytes(hop.method.as_bytes())
            .map_err(|_| PluginCallError::invalid("fetch needs a method"))?;
        let mut headers = HeaderMap::new();
        for (name, value) in &hop.headers {
            let name = HeaderName::from_bytes(name.as_bytes()).map_err(|err| {
                PluginCallError::invalid(format!("a header was refused: {name}: {err}"))
            })?;
            let value = HeaderValue::from_str(value).map_err(|err| {
                PluginCallError::invalid(format!("a header was refused: {name}: {err}"))
            })?;
            headers.append(name, value);
        }
        let client = self.client(route)?;
        let origin = hop.url.origin().ascii_serialization();
        let mut request = client.request(method, hop.url.clone()).headers(headers);
        if let Some(body) = &hop.body {
            request = request.body(body.clone());
        }
        let mut response = request
            .send()
            .await
            .map_err(|err| network(format!("{origin}: {}", described(&err))))?;

        let status = response.status();
        let status_text = status.canonical_reason().unwrap_or_default().to_owned();
        let response_headers = header_pairs(response.headers());
        if is_redirect(status)
            && let Some(location) = response.headers().get(LOCATION)
        {
            return Ok(HopResult::Redirect {
                status: status.as_u16(),
                status_text,
                location: String::from_utf8_lossy(location.as_bytes()).into_owned(),
                headers: response_headers,
            });
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|err| network(format!("{origin}: {}", described(&err))))?
        {
            if body.len() + chunk.len() > RESPONSE_MAX_BYTES {
                return Err(network(format!(
                    "the response is over {} MB",
                    RESPONSE_MAX_BYTES / 1024 / 1024
                )));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(HopResult::Response {
            status: status.as_u16(),
            status_text,
            headers: response_headers,
            body,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_three_loopback_spellings_accept_a_self_signed_certificate() {
        let route = |url: &str| Route::for_url(&Url::parse(url).unwrap());
        for loopback in [
            "http://localhost/",
            "https://LOCALHOST:8443/",
            "http://127.0.0.1:3000/",
            "http://[::1]:3000/",
        ] {
            assert_eq!(route(loopback), Route::Loopback, "{loopback}");
        }
        for elsewhere in [
            "http://127.0.0.2:3000/",
            "http://localhost.example.com/",
            "http://notlocalhost/",
            "https://example.com/",
        ] {
            assert_eq!(route(elsewhere), Route::Verified, "{elsewhere}");
        }
    }
}
