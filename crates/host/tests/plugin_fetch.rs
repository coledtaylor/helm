//! `floti.fetch` on the host: a plugin's only way onto the network, through
//! the call layer every `floti.*` method goes through.
//!
//! Each test builds a registry over a store of its own, with `floti.fetch`
//! registered on it and a stand-in for the secret store, and calls the
//! method as a background script's call arrives. The servers it reaches are
//! in this file: plain HTTP/1.1 on `127.0.0.1:0`, one thread per connection,
//! recording every request they are sent, with TLS under a self-signed
//! certificate when a test needs it.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use base64::Engine;
use floti_host::plugins::background::NoBackground;
use floti_host::plugins::call::CallOrigin;
use floti_host::plugins::call::{
    CallContext, CancelToken, FetchRedirect, PluginCallError, PluginFetchRequest,
    PluginFetchResponse,
};
use floti_host::plugins::net::service::{
    EndpointFuture, NoServices, PluginServices, SERVICE_TOKEN_HEADER, ServiceEndpoint,
};
use floti_host::plugins::net::transport::{Hop, Route, Transport};
use floti_host::plugins::net::{Net, register_methods};
use floti_host::plugins::secrets::{SecretUse, SecretValue, SecretsAccess};
use floti_host::plugins::{PluginCall, Registry, RegistryParts};
use floti_host::store::Store;
use floti_host::testkit::{PATIENCE, TestDirs};
use floti_protocol::Payload;
use floti_protocol::channels::plugins::{PluginErrorCode, PluginSecretState, PluginSurfaceKind};
use serde_json::{Value, json};

// ---------------------------------------------------------------------------
// A server on 127.0.0.1
// ---------------------------------------------------------------------------

/// One request a server was sent.
#[derive(Debug, Clone)]
struct Seen {
    method: String,
    /// The path and query, as sent.
    target: String,
    /// Names lowercased.
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Seen {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(each, _)| each == name)
            .map(|(_, value)| value.as_str())
    }
}

/// What happens after the head of a reply is written.
enum Then {
    /// The body, then the connection closes.
    Body(Vec<u8>),
    /// Nothing more: the server waits for the client to hang up.
    Hang,
    /// This many bytes of body, with no length given.
    Stream(usize),
}

struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    then: Then,
}

fn reply(status: u16, headers: &[(&str, &str)], body: &str) -> Reply {
    Reply {
        status,
        headers: headers
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect(),
        then: Then::Body(body.as_bytes().to_vec()),
    }
}

fn redirect(status: u16, location: &str) -> Reply {
    reply(status, &[("location", location)], "")
}

type Routes = Arc<dyn Fn(&Seen) -> Reply + Send + Sync>;

/// The certificate and key a TLS server answers with: made for this file
/// alone, for `localhost`, `127.0.0.1` and `::1`, and trusted by nobody.
const TEST_CERTIFICATE: &str = "MIIBrTCCAVSgAwIBAgIUdqwvF+A6llUw3ygLV9CSYqXqouUwCgYIKoZIzj0EAwIwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAyODIxMzc1MVoYDzIxMjYxMDA0MjEzNzUxWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAR3oGuHC4xv13/zyWQ258ppLuUSG1TRUmL+zoHUUUBD0sNaDX9N2B8H3C9I/+YDNMIdMx5CZLhY5yyZzplOZI9vo4GBMH8wHQYDVR0OBBYEFBrqaGkbPjg+vb356iNsSkaHF5dZMB8GA1UdIwQYMBaAFBrqaGkbPjg+vb356iNsSkaHF5dZMA8GA1UdEwEB/wQFMAMBAf8wLAYDVR0RBCUwI4IJbG9jYWxob3N0hwR/AAABhxAAAAAAAAAAAAAAAAAAAAABMAoGCCqGSM49BAMCA0cAMEQCIC0fcqh8rbQDQFhJYcBS10XdI2hpAHLos9HHx+/EQIXwAiAH2bNyUsfSLGILIapfn4BSR8u0BDqkoOoa0PbNNBQU4A==";
const TEST_CERTIFICATE_KEY: &str = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgJTwtCnUhtynnwkU/bWri+eRCV89NMIoQds8YfoH5Ur6hRANCAAR3oGuHC4xv13/zyWQ258ppLuUSG1TRUmL+zoHUUUBD0sNaDX9N2B8H3C9I/+YDNMIdMx5CZLhY5yyZzplOZI9v";

fn tls_config() -> Arc<rustls::ServerConfig> {
    let decode = |text: &str| {
        base64::engine::general_purpose::STANDARD
            .decode(text)
            .unwrap()
    };
    let certificate = rustls::pki_types::CertificateDer::from(decode(TEST_CERTIFICATE));
    let key = rustls::pki_types::PrivateKeyDer::Pkcs8(rustls::pki_types::PrivatePkcs8KeyDer::from(
        decode(TEST_CERTIFICATE_KEY),
    ));
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(vec![certificate], key)
    .unwrap();
    Arc::new(config)
}

struct Server {
    port: u16,
    scheme: &'static str,
    seen: Arc<Mutex<Vec<Seen>>>,
    /// The targets whose client hung up while the server waited.
    hung_up: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    accept: Option<JoinHandle<()>>,
}

impl Server {
    fn start(routes: impl Fn(&Seen) -> Reply + Send + Sync + 'static) -> Self {
        Self::listen(Arc::new(routes), None)
    }

    fn start_tls(routes: impl Fn(&Seen) -> Reply + Send + Sync + 'static) -> Self {
        Self::listen(Arc::new(routes), Some(tls_config()))
    }

    fn listen(routes: Routes, tls: Option<Arc<rustls::ServerConfig>>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let hung_up = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let scheme = if tls.is_some() { "https" } else { "http" };
        let accept = {
            let (seen, hung_up, stop) =
                (Arc::clone(&seen), Arc::clone(&hung_up), Arc::clone(&stop));
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    if stop.load(Ordering::SeqCst) {
                        return;
                    }
                    let Ok(stream) = stream else { continue };
                    let (routes, seen, hung_up, tls) = (
                        Arc::clone(&routes),
                        Arc::clone(&seen),
                        Arc::clone(&hung_up),
                        tls.clone(),
                    );
                    std::thread::spawn(move || match tls {
                        Some(config) => {
                            let Ok(connection) = rustls::ServerConnection::new(config) else {
                                return;
                            };
                            serve(
                                rustls::StreamOwned::new(connection, stream),
                                &routes,
                                &seen,
                                &hung_up,
                            );
                        }
                        None => serve(stream, &routes, &seen, &hung_up),
                    });
                }
            })
        };
        Self {
            port,
            scheme,
            seen,
            hung_up,
            stop,
            accept: Some(accept),
        }
    }

    fn origin(&self) -> String {
        format!("{}://127.0.0.1:{}", self.scheme, self.port)
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.origin())
    }

    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    fn targets(&self) -> Vec<String> {
        self.seen().into_iter().map(|seen| seen.target).collect()
    }

    /// Waits for the client of `target` to hang up.
    async fn hung_up(&self, target: &str) {
        let started = Instant::now();
        while !self
            .hung_up
            .lock()
            .unwrap()
            .iter()
            .any(|each| each == target)
        {
            assert!(started.elapsed() < PATIENCE, "{target} was never hung up");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        if let Some(accept) = self.accept.take() {
            let _ = accept.join();
        }
    }
}

/// Reads one request from `stream`: its head, then as much body as it says.
fn read_seen(stream: &mut impl Read) -> Option<Seen> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        if let Some(at) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break at;
        }
        let read = stream.read(&mut chunk).ok().filter(|read| *read > 0)?;
        buffer.extend_from_slice(&chunk[..read]);
    };
    let head = String::from_utf8_lossy(&buffer[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next()?.split(' ');
    let method = request_line.next()?.to_owned();
    let target = request_line.next()?.to_owned();
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    let length: usize = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .map_or(0, |(_, value)| value.parse().unwrap_or(0));
    let mut body = buffer[head_end + 4..].to_vec();
    while body.len() < length {
        let read = stream.read(&mut chunk).ok().filter(|read| *read > 0)?;
        body.extend_from_slice(&chunk[..read]);
    }
    Some(Seen {
        method,
        target,
        headers,
        body,
    })
}

fn serve(
    mut stream: impl Read + Write,
    routes: &Routes,
    seen: &Mutex<Vec<Seen>>,
    hung_up: &Mutex<Vec<String>>,
) {
    let Some(request) = read_seen(&mut stream) else {
        return;
    };
    seen.lock().unwrap().push(request.clone());
    let answer = routes(&request);
    let mut head = format!(
        "HTTP/1.1 {} Whatever\r\nconnection: close\r\n",
        answer.status
    );
    for (name, value) in &answer.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    match &answer.then {
        Then::Body(body) => head.push_str(&format!("content-length: {}\r\n", body.len())),
        Then::Hang => head.push_str("content-length: 1\r\n"),
        Then::Stream(_) => {}
    }
    head.push_str("\r\n");
    if stream.write_all(head.as_bytes()).is_err() {
        return;
    }
    match answer.then {
        Then::Body(body) => {
            let _ = stream.write_all(&body);
            let _ = stream.flush();
        }
        Then::Hang => {
            let _ = stream.flush();
            let mut sink = [0u8; 256];
            while matches!(stream.read(&mut sink), Ok(read) if read > 0) {}
            hung_up.lock().unwrap().push(request.target);
        }
        Then::Stream(mut left) => {
            let block = vec![b'x'; 64 * 1024];
            while left > 0 {
                let take = left.min(block.len());
                if stream.write_all(&block[..take]).is_err() {
                    return;
                }
                left -= take;
            }
            let _ = stream.flush();
        }
    }
}

/// A port nothing listens on.
fn closed_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

// ---------------------------------------------------------------------------
// The world each test runs in
// ---------------------------------------------------------------------------

/// A stored secret: its value, and the plugins and origins it may be used
/// for.
struct Stored {
    value: String,
    plugins: Vec<String>,
    origins: Vec<String>,
}

/// The secret store's stand-in: what it was given, refused as the store
/// refuses, and every reveal it answered.
#[derive(Default)]
struct TestSecrets {
    stored: Mutex<HashMap<String, Stored>>,
}

impl TestSecrets {
    fn store(&self, key: &str, value: &str, plugins: &[&str], origins: &[&str]) {
        let owned = |list: &[&str]| list.iter().map(|each| (*each).to_owned()).collect();
        self.stored.lock().unwrap().insert(
            key.to_owned(),
            Stored {
                value: value.to_owned(),
                plugins: owned(plugins),
                origins: owned(origins),
            },
        );
    }
}

fn secret_refusal(message: String) -> PluginCallError {
    PluginCallError::new(PluginErrorCode::Secret, message)
}

impl SecretsAccess for TestSecrets {
    fn state(&self, plugin: &str, key: &str) -> PluginSecretState {
        match self.stored.lock().unwrap().get(key) {
            Some(stored) if stored.plugins.iter().any(|p| p == plugin) => PluginSecretState::Ready,
            Some(_) => PluginSecretState::NotAllowed,
            None => PluginSecretState::Missing,
        }
    }

    fn reveal(
        &self,
        plugin: &str,
        declared: &[String],
        key: &str,
        use_: SecretUse<'_>,
    ) -> Result<SecretValue, PluginCallError> {
        if !declared.iter().any(|name| name == key) {
            return Err(secret_refusal(format!(
                "{{{{{key}}}}} is not one of the secrets the manifest declares"
            )));
        }
        let stored = self.stored.lock().unwrap();
        let Some(secret) = stored.get(key) else {
            return Err(secret_refusal(format!("{{{{{key}}}}} is not stored")));
        };
        if !secret.plugins.iter().any(|p| p == plugin) {
            return Err(secret_refusal(format!(
                "{{{{{key}}}}} is not allowed for this plugin"
            )));
        }
        let SecretUse::Request { origin } = use_ else {
            panic!("fetch reveals for a request");
        };
        if !secret.origins.iter().any(|each| each == origin) {
            return Err(secret_refusal(format!(
                "{{{{{key}}}}} may not be sent to {origin}"
            )));
        }
        Ok(SecretValue::new(secret.value.clone()))
    }
}

/// A service at a server of the test's, with a token for the run.
struct TestService {
    origin: String,
}

impl PluginServices for TestService {
    fn endpoint(&self, _context: &CallContext) -> EndpointFuture {
        let origin = url::Url::parse(&self.origin).unwrap();
        Box::pin(async move {
            Ok(ServiceEndpoint {
                origin,
                token: "run-token".into(),
            })
        })
    }
}

struct World {
    registry: Registry,
    secrets: Arc<TestSecrets>,
    store: Arc<Mutex<Store>>,
    /// Last: the store is closed before its folder goes.
    dirs: TestDirs,
}

impl World {
    fn new() -> Self {
        Self::with(|secrets| Net::new(secrets, Arc::new(NoServices)))
    }

    fn with(net: impl FnOnce(Arc<dyn SecretsAccess>) -> Net) -> Self {
        let dirs = TestDirs::new();
        let store = Arc::new(Mutex::new(Store::open(&dirs.data).unwrap()));
        let secrets = Arc::new(TestSecrets::default());
        let registry = Registry::new(RegistryParts {
            store: Arc::clone(&store),
            background: Arc::new(NoBackground),
            secrets: Arc::clone(&secrets) as Arc<dyn SecretsAccess>,
            services: Arc::new(NoServices),
            logs: Default::default(),
            publish: Box::new(|_| ()),
            deliver: Box::new(|_| ()),
        });
        register_methods(
            registry.methods(),
            Arc::new(net(Arc::clone(&secrets) as Arc<dyn SecretsAccess>)),
        );
        registry.start().unwrap();
        Self {
            registry,
            secrets,
            store,
            dirs,
        }
    }

    /// A plugin `id` whose network is `network`, registered.
    fn plugin(&self, id: &str, network: &[String], secrets: &[&str], extra: Value) -> String {
        let mut manifest = json!({
            "apiVersion": 2,
            "id": id,
            "name": id,
            "network": network,
            "secrets": secrets,
        });
        if let (Some(fields), Some(more)) = (manifest.as_object_mut(), extra.as_object()) {
            fields.extend(more.clone());
        }
        let folder = self
            .dirs
            .plugin_folder(&format!("plugin {id}"), &manifest.to_string(), &[]);
        let path = text(&folder);
        self.registry.add(&path).unwrap();
        path
    }

    fn call(&self, plugin: &str, args: Vec<Payload>, cancel: CancelToken) -> Call {
        let registry = self.registry.clone();
        let call = PluginCall {
            plugin: plugin.to_owned(),
            surface: PluginSurfaceKind::Background,
            origin: CallOrigin::Host,
            method: "fetch".into(),
            args,
            cancel,
        };
        tokio::spawn(async move {
            registry
                .call(call)
                .await
                .map(|answer| answer.deserialized::<PluginFetchResponse>().unwrap())
        })
    }

    async fn fetch(
        &self,
        plugin: &str,
        request: &PluginFetchRequest,
    ) -> Result<PluginFetchResponse, PluginCallError> {
        self.call(plugin, vec![payload(request)], CancelToken::new())
            .await
            .unwrap()
    }

    fn stop(self) {
        self.registry.shutdown();
        drop(self.registry);
        let store = Arc::try_unwrap(self.store)
            .unwrap_or_else(|_| panic!("nothing else holds the store"))
            .into_inner()
            .unwrap();
        store.close().unwrap();
    }
}

type Call = tokio::task::JoinHandle<Result<PluginFetchResponse, PluginCallError>>;

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn payload<T: serde::Serialize>(value: &T) -> Payload {
    Payload::serialized(value).unwrap()
}

fn request(
    method: &str,
    url: &str,
    headers: &[(&str, &str)],
    body: Option<&[u8]>,
) -> PluginFetchRequest {
    PluginFetchRequest {
        url: url.to_owned(),
        method: method.to_owned(),
        headers: headers
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect(),
        body: body.map(<[u8]>::to_vec),
        redirect: FetchRedirect::Follow,
    }
}

fn get(url: &str) -> PluginFetchRequest {
    request("GET", url, &[], None)
}

fn header<'a>(response: &'a PluginFetchResponse, name: &str) -> Option<&'a str> {
    response
        .headers
        .iter()
        .find(|(each, _)| each == name)
        .map(|(_, value)| value.as_str())
}

fn refused(result: Result<PluginFetchResponse, PluginCallError>) -> PluginCallError {
    result.expect_err("the fetch was refused")
}

// ---------------------------------------------------------------------------
// S18: a request to a listed origin, and what is refused before sending
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_request_to_a_listed_origin_is_sent_with_its_method_headers_and_body_with_no_cookies_and_answered_with_what_came_back()
 {
    let server = Server::start(|seen| match seen.target.as_str() {
        "/echo?q=1" => reply(
            201,
            &[
                ("content-type", "application/json"),
                ("x-answer", "yes"),
                ("set-cookie", "session=kept; Path=/"),
            ],
            r#"{"ok":true}"#,
        ),
        _ => reply(200, &[], "again"),
    });
    let world = World::new();
    world.plugin("caller", &[server.origin()], &[], json!({}));

    let sent = request(
        "post",
        &server.url("/echo?q=1"),
        &[("content-type", "application/json"), ("x-custom", "value")],
        Some(br#"{"a":1}"#),
    );
    let response = world.fetch("caller", &sent).await.unwrap();
    assert_eq!(response.status, 201);
    assert_eq!(response.status_text, "Created");
    assert_eq!(header(&response, "x-answer"), Some("yes"));
    assert_eq!(header(&response, "content-type"), Some("application/json"));
    assert_eq!(response.body, br#"{"ok":true}"#);
    assert_eq!(response.url, server.url("/echo?q=1"));
    assert!(!response.redirected);

    let again = world
        .fetch("caller", &get(&server.url("/again")))
        .await
        .unwrap();
    assert_eq!(again.body, b"again");

    let seen = server.seen();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0].method, "POST", "the method is sent upper case");
    assert_eq!(seen[0].header("x-custom"), Some("value"));
    assert_eq!(seen[0].header("content-type"), Some("application/json"));
    assert_eq!(seen[0].body, br#"{"a":1}"#);
    for each in &seen {
        assert_eq!(each.header("cookie"), None, "no cookie is sent or kept");
    }
    world.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_request_to_an_unlisted_origin_with_credentials_a_refused_method_or_a_body_over_16_mb_is_refused_before_anything_is_sent()
 {
    let listed = Server::start(|_| reply(200, &[], "ok"));
    let unlisted = Server::start(|_| reply(200, &[], "ok"));
    let world = World::new();
    world.plugin("careful", &[listed.origin()], &[], json!({}));

    let not_declared = refused(world.fetch("careful", &get(&unlisted.url("/"))).await);
    assert_eq!(not_declared.code, PluginErrorCode::NotDeclared);
    assert_eq!(
        not_declared.message,
        format!(
            "{} is not one of the origins the manifest's network lists",
            unlisted.origin()
        )
    );
    let ftp = refused(world.fetch("careful", &get("ftp://127.0.0.1/file")).await);
    assert_eq!(ftp.code, PluginErrorCode::NotDeclared);

    let with_credentials = format!("http://user:pw@127.0.0.1:{}/", listed.port);
    let credentials = refused(world.fetch("careful", &get(&with_credentials)).await);
    assert_eq!(credentials.code, PluginErrorCode::Invalid);
    assert_eq!(
        credentials.message,
        "put credentials in a header, not in the URL"
    );

    for method in ["CONNECT", "trace", "TRACK"] {
        let refused_method = refused(
            world
                .fetch("careful", &request(method, &listed.url("/"), &[], None))
                .await,
        );
        assert_eq!(refused_method.code, PluginErrorCode::Invalid);
        assert_eq!(
            refused_method.message,
            format!(
                "{} is not a method fetch sends",
                method.to_ascii_uppercase()
            )
        );
    }

    let huge = vec![b'x'; 16 * 1024 * 1024 + 1];
    let too_big = refused(
        world
            .fetch(
                "careful",
                &request("POST", &listed.url("/"), &[], Some(&huge)),
            )
            .await,
    );
    assert_eq!(too_big.code, PluginErrorCode::Invalid);
    assert_eq!(too_big.message, "a request body is limited to 16 MB");

    let shapes: Vec<(Value, &str)> = vec![
        (json!("a string"), "fetch needs a request"),
        (
            json!({ "method": "GET", "headers": [], "redirect": "follow" }),
            "fetch needs a URL",
        ),
        (
            json!({ "url": listed.url("/"), "method": "BAD METHOD", "headers": [], "redirect": "follow" }),
            "fetch needs a method",
        ),
        (
            json!({ "url": listed.url("/"), "method": "GET", "headers": [["only a name"]], "redirect": "follow" }),
            "headers must be name and value pairs",
        ),
        (
            json!({ "url": listed.url("/"), "method": "GET", "headers": [], "body": "text", "redirect": "follow" }),
            "the body must be bytes",
        ),
        (
            json!({ "url": listed.url("/"), "method": "GET", "headers": [], "redirect": "sometimes" }),
            "redirect must be follow, manual or error",
        ),
        (
            json!({ "url": "not a url", "method": "GET", "headers": [], "redirect": "follow" }),
            "not a url is not a URL",
        ),
    ];
    for (shape, message) in shapes {
        let invalid = world
            .call("careful", vec![payload(&shape)], CancelToken::new())
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(invalid.code, PluginErrorCode::Invalid, "{shape}");
        assert_eq!(invalid.message, message);
    }
    let broken_header = refused(
        world
            .fetch(
                "careful",
                &request(
                    "GET",
                    &listed.url("/"),
                    &[("x-split", "one\r\ntwo: three")],
                    None,
                ),
            )
            .await,
    );
    assert_eq!(broken_header.code, PluginErrorCode::Invalid);
    assert!(
        broken_header.message.starts_with("a header was refused"),
        "{broken_header:?}"
    );

    assert!(
        listed.seen().is_empty(),
        "something was sent: {:?}",
        listed.targets()
    );
    assert!(unlisted.seen().is_empty());
    world.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn headers_the_transport_owns_stay_its_own() {
    let server = Server::start(|_| reply(200, &[], "ok"));
    let world = World::new();
    world.plugin("liar", &[server.origin()], &[], json!({}));
    let sent = request(
        "POST",
        &server.url("/"),
        &[
            ("Host", "evil.example"),
            ("Content-Length", "999"),
            ("Connection", "upgrade"),
            ("Transfer-Encoding", "chunked"),
            ("Expect", "100-continue"),
            ("Upgrade", "websocket"),
            ("x-kept", "yes"),
        ],
        Some(b"hello"),
    );
    world.fetch("liar", &sent).await.unwrap();
    let seen = &server.seen()[0];
    assert_eq!(
        seen.header("host"),
        Some(format!("127.0.0.1:{}", server.port).as_str())
    );
    assert_eq!(seen.header("content-length"), Some("5"));
    assert_eq!(seen.body, b"hello");
    for owned in ["transfer-encoding", "expect", "upgrade"] {
        assert_eq!(seen.header(owned), None, "{owned} was sent");
    }
    assert_ne!(seen.header("connection"), Some("upgrade"));
    assert_eq!(seen.header("x-kept"), Some("yes"));
    world.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_response_over_32_mb_a_transport_failure_and_the_time_limit_fail_as_network_or_timeout() {
    let server = Server::start(|seen| match seen.target.as_str() {
        "/huge" => Reply {
            status: 200,
            headers: Vec::new(),
            then: Then::Stream(32 * 1024 * 1024 + 1),
        },
        "/just-enough" => Reply {
            status: 200,
            headers: Vec::new(),
            then: Then::Stream(32 * 1024 * 1024),
        },
        _ => Reply {
            status: 200,
            headers: Vec::new(),
            then: Then::Hang,
        },
    });
    let nothing = format!("http://127.0.0.1:{}", closed_port());
    let world = World::new();
    world.plugin(
        "limits",
        &[server.origin(), nothing.clone()],
        &[],
        json!({}),
    );

    let fits = world
        .fetch("limits", &get(&server.url("/just-enough")))
        .await
        .unwrap();
    assert_eq!(fits.body.len(), 32 * 1024 * 1024);
    let huge = refused(world.fetch("limits", &get(&server.url("/huge"))).await);
    assert_eq!(huge.code, PluginErrorCode::Network, "{huge:?}");
    assert_eq!(huge.message, "the response is over 32 MB");

    let down = refused(world.fetch("limits", &get(&format!("{nothing}/"))).await);
    assert_eq!(down.code, PluginErrorCode::Network, "{down:?}");
    assert!(
        down.message.starts_with(&format!("{nothing}: ")),
        "{down:?}"
    );
    world.stop();

    // The time limit, shortened from 120 s for the test.
    let world = World::with(|secrets| {
        Net::new(secrets, Arc::new(NoServices)).with_timeout(Duration::from_millis(1500))
    });
    world.plugin("limits", &[server.origin()], &[], json!({}));
    let started = Instant::now();
    let late = refused(world.fetch("limits", &get(&server.url("/slow"))).await);
    assert_eq!(late.code, PluginErrorCode::Timeout, "{late:?}");
    assert_eq!(
        late.message,
        format!("no answer from {} within 1.5s", server.origin())
    );
    assert!(started.elapsed() < PATIENCE);
    server.hung_up("/slow").await;
    world.stop();
}

#[test]
fn every_request_ends_by_120_s() {
    assert_eq!(
        floti_host::plugins::net::FETCH_TIMEOUT,
        Duration::from_secs(120)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn service_path_is_not_declared_without_a_service_and_fails_as_service_when_its_service_cannot_be_started()
 {
    let world = World::new();
    world.plugin("serviceless", &[], &[], json!({}));
    world.plugin(
        "served",
        &[],
        &[],
        json!({ "service": { "command": "floti-no-such-service" } }),
    );

    let none = refused(world.fetch("serviceless", &get("service:/api/items")).await);
    assert_eq!(none.code, PluginErrorCode::NotDeclared);
    assert_eq!(none.message, "this plugin declares no service");

    let cannot = refused(world.fetch("served", &get("service:/api/items")).await);
    assert_eq!(cannot.code, PluginErrorCode::Service, "{cannot:?}");
    world.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_service_path_goes_to_the_services_loopback_origin_with_its_token_and_carries_no_secret()
{
    let server = Server::start(|_| reply(200, &[], "from the service"));
    let origin = server.origin();
    let world = World::with(move |secrets| Net::new(secrets, Arc::new(TestService { origin })));
    world.plugin(
        "served",
        &[],
        &["k"],
        json!({ "service": { "command": "floti-no-such-service" } }),
    );

    let sent = request(
        "GET",
        "service:/api/items?x=1",
        &[(SERVICE_TOKEN_HEADER, "forged")],
        None,
    );
    let response = world.fetch("served", &sent).await.unwrap();
    assert_eq!(response.body, b"from the service");
    let seen = &server.seen()[0];
    assert_eq!(seen.target, "/api/items?x=1");
    assert_eq!(
        seen.header(&SERVICE_TOKEN_HEADER.to_ascii_lowercase()),
        Some("run-token")
    );

    let secret = refused(
        world
            .fetch(
                "served",
                &request("GET", "service:/x", &[("authorization", "{{k}}")], None),
            )
            .await,
    );
    assert_eq!(secret.code, PluginErrorCode::Secret);
    assert_eq!(server.seen().len(), 1);
    world.stop();
}

// ---------------------------------------------------------------------------
// S19: redirects, one hop at a time
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn each_redirect_hop_is_checked_against_the_network_a_hop_inside_is_followed_and_one_leaving_it_is_never_sent()
 {
    let elsewhere = Server::start(|_| reply(200, &[], "elsewhere"));
    let other = Server::start(|_| reply(200, &[], "landed"));
    let (other_url, elsewhere_url) = (other.url("/landing"), elsewhere.url("/stolen"));
    let first = Server::start(move |seen| match seen.target.as_str() {
        "/inside" => redirect(302, &other_url),
        _ => redirect(302, &elsewhere_url),
    });
    let world = World::new();
    world.plugin("hops", &[first.origin(), other.origin()], &[], json!({}));

    let followed = world
        .fetch("hops", &get(&first.url("/inside")))
        .await
        .unwrap();
    assert_eq!(followed.body, b"landed");
    assert_eq!(followed.url, other.url("/landing"));
    assert!(followed.redirected);

    let leaving = refused(world.fetch("hops", &get(&first.url("/leaving"))).await);
    assert_eq!(leaving.code, PluginErrorCode::NotDeclared);
    assert_eq!(
        leaving.message,
        format!(
            "{} (a redirect) is not one of the origins the manifest's network lists",
            elsewhere.origin()
        )
    );
    assert!(
        elsewhere.seen().is_empty(),
        "the hop leaving the list was sent"
    );
    world.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn more_than_20_hops_and_a_redirect_to_something_that_is_not_a_url_fail_as_network() {
    let server = Server::start(|seen| {
        if let Some(left) = seen.target.strip_prefix("/chain/") {
            let left: u32 = left.parse().unwrap();
            if left == 0 {
                reply(200, &[], "end of the chain")
            } else {
                redirect(302, &format!("/chain/{}", left - 1))
            }
        } else {
            redirect(302, "http://[::1")
        }
    });
    let world = World::new();
    world.plugin("chains", &[server.origin()], &[], json!({}));

    let nineteen = world
        .fetch("chains", &get(&server.url("/chain/19")))
        .await
        .unwrap();
    assert_eq!(
        nineteen.body, b"end of the chain",
        "twenty hops are followed"
    );
    let twenty = refused(world.fetch("chains", &get(&server.url("/chain/20"))).await);
    assert_eq!(twenty.code, PluginErrorCode::Network);
    assert_eq!(twenty.message, "more than 20 redirects");
    assert_eq!(
        server.targets().len(),
        40,
        "twenty hops each, and the twenty-first never sent"
    );

    let not_a_url = refused(world.fetch("chains", &get(&server.url("/broken"))).await);
    assert_eq!(not_a_url.code, PluginErrorCode::Network);
    assert_eq!(
        not_a_url.message,
        format!(
            "{} redirected to something that is not a URL",
            server.origin()
        )
    );
    world.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_303_turns_a_post_into_a_get_with_no_body_and_a_307_keeps_the_post_and_its_body() {
    let server = Server::start(|seen| match seen.target.as_str() {
        "/see-other" => redirect(303, "/after-303"),
        "/temporary" => redirect(307, "/after-307"),
        _ => reply(200, &[], "done"),
    });
    let world = World::new();
    world.plugin("posts", &[server.origin()], &[], json!({}));
    let post = |path: &str| {
        request(
            "POST",
            &server.url(path),
            &[("content-type", "text/plain")],
            Some(b"the body"),
        )
    };

    world.fetch("posts", &post("/see-other")).await.unwrap();
    world.fetch("posts", &post("/temporary")).await.unwrap();
    let seen = server.seen();
    let after = |target: &str| seen.iter().find(|each| each.target == target).unwrap();
    let got = after("/after-303");
    assert_eq!(got.method, "GET");
    assert!(got.body.is_empty());
    assert_eq!(got.header("content-type"), None);
    let kept = after("/after-307");
    assert_eq!(kept.method, "POST");
    assert_eq!(kept.body, b"the body");
    assert_eq!(kept.header("content-type"), Some("text/plain"));
    world.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn redirect_manual_answers_with_the_redirect_itself_and_redirect_error_refuses_it() {
    let server = Server::start(|seen| match seen.target.as_str() {
        "/moved" => redirect(301, "/new-home"),
        _ => reply(200, &[], "new home"),
    });
    let world = World::new();
    world.plugin("manual", &[server.origin()], &[], json!({}));

    let mut manual = get(&server.url("/moved"));
    manual.redirect = FetchRedirect::Manual;
    let answered = world.fetch("manual", &manual).await.unwrap();
    assert_eq!(answered.status, 301);
    assert_eq!(header(&answered, "location"), Some("/new-home"));
    assert!(answered.body.is_empty());
    assert_eq!(answered.url, server.url("/moved"));
    assert!(!answered.redirected);

    let mut error = get(&server.url("/moved"));
    error.redirect = FetchRedirect::Error;
    let refused_redirect = refused(world.fetch("manual", &error).await);
    assert_eq!(refused_redirect.code, PluginErrorCode::Network);
    assert_eq!(
        refused_redirect.message,
        format!(
            "{} redirected, and the request said not to follow",
            server.origin()
        )
    );
    assert_eq!(
        server.targets(),
        ["/moved", "/moved"],
        "neither followed it"
    );
    world.stop();
}

// ---------------------------------------------------------------------------
// S20: secrets on the way out
// ---------------------------------------------------------------------------

/// A value that needs escaping everywhere it goes.
const AWKWARD: &str = r#"a b"c&d/+=\x"#;

#[tokio::test(flavor = "multi_thread")]
async fn a_secret_placeholder_is_filled_in_the_path_query_a_header_and_a_text_body_escaped_for_where_it_goes_and_the_script_never_sees_it()
 {
    let server = Server::start(|_| reply(200, &[], "ok"));
    let world = World::new();
    world.plugin("filler", &[server.origin()], &["api-key"], json!({}));
    world
        .secrets
        .store("api-key", AWKWARD, &["filler"], &[&server.origin()]);

    let template = server.url("/items/{{api-key}}?key={{api-key}}&plain=1");
    let json_post = request(
        "POST",
        &template,
        &[
            ("authorization", "Bearer {{api-key}}"),
            ("content-type", "application/json; charset=utf-8"),
        ],
        Some(br#"{"token":"{{api-key}}"}"#),
    );
    let answered = world.fetch("filler", &json_post).await.unwrap();
    for text in [
        answered.url.clone(),
        String::from_utf8_lossy(&answered.body).into_owned(),
    ] {
        assert!(!text.contains("a b"), "the secret came back: {text}");
    }
    let form = request(
        "POST",
        &server.url("/form"),
        &[("content-type", "application/x-www-form-urlencoded")],
        Some(b"token={{api-key}}&other=1"),
    );
    world.fetch("filler", &form).await.unwrap();
    let plain = request(
        "POST",
        &server.url("/plain"),
        &[("content-type", "text/plain")],
        Some(b"token {{api-key}}"),
    );
    world.fetch("filler", &plain).await.unwrap();

    let seen = server.seen();
    let encoded = "a%20b%22c%26d%2F%2B%3D%5Cx";
    assert_eq!(
        seen[0].target,
        format!("/items/{encoded}?key={encoded}&plain=1")
    );
    assert_eq!(
        seen[0].header("authorization"),
        Some(format!("Bearer {AWKWARD}").as_str())
    );
    assert_eq!(
        String::from_utf8_lossy(&seen[0].body),
        r#"{"token":"a b\"c&d/+=\\x"}"#
    );
    assert_eq!(
        String::from_utf8_lossy(&seen[1].body),
        format!("token={encoded}&other=1")
    );
    assert_eq!(
        String::from_utf8_lossy(&seen[2].body),
        format!("token {AWKWARD}")
    );
    world.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_secret_for_an_origin_the_user_did_not_allow_an_undeclared_key_or_one_not_stored_or_not_allowed_rejects_with_secret_and_nothing_is_sent()
 {
    let allowed = Server::start(|_| reply(200, &[], "ok"));
    let other = Server::start(|_| reply(200, &[], "ok"));
    let world = World::new();
    world.plugin(
        "guarded",
        &[allowed.origin(), other.origin()],
        &["key", "unset", "theirs"],
        json!({}),
    );
    world
        .secrets
        .store("key", "v", &["guarded"], &[&allowed.origin()]);
    world
        .secrets
        .store("theirs", "v", &["someone-else"], &[&allowed.origin()]);
    let with = |url: String, value: &str| request("GET", &url, &[("x-key", value)], None);

    let cases = [
        (
            with(other.url("/"), "{{key}}"),
            "{{key}} may not be sent to",
        ),
        (
            with(allowed.url("/"), "{{undeclared}}"),
            "{{undeclared}} is not one of the secrets",
        ),
        (
            with(allowed.url("/"), "{{unset}}"),
            "{{unset}} is not stored",
        ),
        (
            with(allowed.url("/"), "{{theirs}}"),
            "{{theirs}} is not allowed for this plugin",
        ),
        (get(&other.url("/{{key}}")), "{{key}} may not be sent to"),
        (
            request("POST", &other.url("/"), &[], Some(b"{{key}}")),
            "{{key}} may not be sent to",
        ),
    ];
    for (sent, message) in cases {
        let refused_secret = refused(world.fetch("guarded", &sent).await);
        assert_eq!(
            refused_secret.code,
            PluginErrorCode::Secret,
            "{refused_secret:?}"
        );
        assert!(
            refused_secret.message.starts_with(message),
            "{refused_secret:?}"
        );
    }
    assert!(allowed.seen().is_empty());
    assert!(other.seen().is_empty());
    world.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_url_the_server_supplied_is_never_searched_for_placeholders() {
    let server = Server::start(|seen| match seen.target.as_str() {
        "/start" => redirect(302, "/landing/{{key}}"),
        _ => reply(200, &[], "landed"),
    });
    let world = World::new();
    world.plugin("trusting", &[server.origin()], &["key"], json!({}));
    world
        .secrets
        .store("key", "the-secret", &["trusting"], &[&server.origin()]);

    world
        .fetch("trusting", &get(&server.url("/start")))
        .await
        .unwrap();
    let landed = &server.targets()[1];
    assert!(!landed.contains("the-secret"), "{landed}");
    assert_eq!(landed, "/landing/%7B%7Bkey%7D%7D");
    world.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_redirect_to_another_origin_drops_authorization_cookie_and_proxy_authorization_and_fills_its_own_placeholders_or_stops_while_the_same_origin_keeps_them()
 {
    let other = Server::start(|_| reply(200, &[], "other"));
    let other_landing = other.url("/landing");
    let first = Server::start(move |seen| match seen.target.as_str() {
        "/cross" => redirect(302, &other_landing),
        "/same" => redirect(302, "/same-landing"),
        _ => reply(200, &[], "first"),
    });
    let world = World::new();
    world.plugin(
        "crossing",
        &[first.origin(), other.origin()],
        &["first-only", "both"],
        json!({}),
    );
    world
        .secrets
        .store("first-only", "f", &["crossing"], &[&first.origin()]);
    world.secrets.store(
        "both",
        "b",
        &["crossing"],
        &[&first.origin(), &other.origin()],
    );
    let credentialed = |path: &str, key: &str| {
        request(
            "GET",
            &first.url(path),
            &[
                ("authorization", "Bearer token"),
                ("cookie", "c=1"),
                ("proxy-authorization", "Basic p"),
                ("x-key", &format!("{{{{{key}}}}}")),
            ],
            None,
        )
    };

    let stopped = refused(
        world
            .fetch("crossing", &credentialed("/cross", "first-only"))
            .await,
    );
    assert_eq!(stopped.code, PluginErrorCode::Secret, "{stopped:?}");
    assert!(
        other.seen().is_empty(),
        "a hop its secret may not go to was sent"
    );

    world
        .fetch("crossing", &credentialed("/cross", "both"))
        .await
        .unwrap();
    let landed = &other.seen()[0];
    for dropped in ["authorization", "cookie", "proxy-authorization"] {
        assert_eq!(landed.header(dropped), None, "{dropped} crossed origins");
    }
    assert_eq!(
        landed.header("x-key"),
        Some("b"),
        "filled for its own origin"
    );

    world
        .fetch("crossing", &credentialed("/same", "first-only"))
        .await
        .unwrap();
    let same = first
        .seen()
        .into_iter()
        .find(|each| each.target == "/same-landing")
        .unwrap();
    assert_eq!(same.header("authorization"), Some("Bearer token"));
    assert_eq!(same.header("cookie"), Some("c=1"));
    assert_eq!(same.header("proxy-authorization"), Some("Basic p"));
    assert_eq!(same.header("x-key"), Some("f"));
    world.stop();
}

// ---------------------------------------------------------------------------
// S21: ending a request, and certificates
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn aborting_switching_the_plugin_off_or_stopping_the_host_ends_the_request_and_rejects_as_aborted()
 {
    let server = Server::start(|_| Reply {
        status: 200,
        headers: Vec::new(),
        then: Then::Hang,
    });
    let world = World::new();
    let folder = world.plugin("hanging", &[server.origin()], &[], json!({}));
    let registry = world.registry.clone();

    ended_by(&world, &server, "/aborted", CancelToken::cancel).await;
    ended_by(&world, &server, "/switched-off", |_| {
        registry.set_enabled(&folder, false).unwrap();
    })
    .await;
    registry.set_enabled(&folder, true).unwrap();
    ended_by(&world, &server, "/host-stopped", |_| registry.shutdown()).await;
    drop(registry);
    world.stop();
}

/// Sends a request to `path`, which the server never answers, waits for it
/// to arrive, does `end` to it, and checks the call rejects as aborted and
/// the request is ended.
async fn ended_by(world: &World, server: &Server, path: &str, end: impl FnOnce(&CancelToken)) {
    let cancel = CancelToken::new();
    let call = world.call(
        "hanging",
        vec![payload(&get(&server.url(path)))],
        cancel.clone(),
    );
    let started = Instant::now();
    while !server.targets().iter().any(|each| each == path) {
        assert!(started.elapsed() < PATIENCE, "{path} never arrived");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    end(&cancel);
    let aborted = tokio::time::timeout(PATIENCE, call)
        .await
        .expect("the call answered")
        .unwrap()
        .unwrap_err();
    assert_eq!(aborted.code, PluginErrorCode::Aborted, "{aborted:?}");
    server.hung_up(path).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_self_signed_certificate_is_accepted_from_a_loopback_address() {
    let server = Server::start_tls(|_| reply(200, &[], "over tls"));
    let world = World::new();
    world.plugin("local", &[server.origin()], &[], json!({}));
    let response = world.fetch("local", &get(&server.url("/"))).await.unwrap();
    assert_eq!(response.body, b"over tls");
    assert_eq!(server.targets(), ["/"]);
    world.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_self_signed_certificate_from_any_other_address_is_refused_as_network() {
    let server = Server::start_tls(|_| reply(200, &[], "over tls"));
    let hop = Hop {
        url: url::Url::parse(&server.url("/")).unwrap(),
        method: "GET".into(),
        headers: Vec::new(),
        body: None,
    };
    // The route every address but the three loopback spellings takes.
    assert_eq!(
        Route::for_url(&url::Url::parse("https://192.0.2.1/").unwrap()),
        Route::Verified
    );
    let refused_certificate = Transport::new()
        .send(&hop, Route::Verified)
        .await
        .unwrap_err();
    assert_eq!(
        refused_certificate.code,
        PluginErrorCode::Network,
        "{refused_certificate:?}"
    );
    assert!(
        server.targets().is_empty(),
        "a request went over an untrusted connection"
    );
}
