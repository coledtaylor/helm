//! The listener over real loopback HTTP, with families made here.

use std::net::{IpAddr, Ipv6Addr, SocketAddr, UdpSocket};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::front::MAX_BODY_BYTES;
use super::*;

/// How long a test waits on a connection or an answer.
const PATIENCE: Duration = Duration::from_secs(10);

const MCP_ACCEPT: &str = "application/json, text/event-stream";

/// A family with two tools: `whoami`, read-only, which says which session
/// called, and `echo`, which is not marked read-only.
struct TestFamily {
    name: &'static str,
    route: &'static str,
    on: AtomicBool,
}

impl TestFamily {
    fn new(name: &'static str, route: &'static str) -> Arc<Self> {
        Arc::new(Self {
            name,
            route,
            on: AtomicBool::new(true),
        })
    }

    fn switch(&self, on: bool) {
        self.on.store(on, Ordering::SeqCst);
    }
}

impl ToolFamily for TestFamily {
    fn name(&self) -> &str {
        self.name
    }

    fn route(&self) -> &str {
        self.route
    }

    fn instructions(&self) -> &str {
        "Test tools. whoami is read-only awareness."
    }

    fn is_on(&self) -> bool {
        self.on.load(Ordering::SeqCst)
    }

    fn tools(&self) -> Vec<Tool> {
        let schema = |value: Value| match value {
            Value::Object(map) => map,
            _ => unreachable!("a schema is an object"),
        };
        vec![
            Tool::new(
                "whoami",
                "Says which session called. Read-only.",
                schema(json!({ "type": "object", "properties": {} })),
            )
            .with_annotations(ToolAnnotations::new().read_only(true)),
            Tool::new(
                "echo",
                "Answers its arguments.",
                schema(json!({ "type": "object" })),
            ),
        ]
    }

    fn call<'a>(&'a self, caller: Caller, name: &'a str, arguments: JsonObject) -> ToolFuture<'a> {
        Box::pin(async move {
            let text = match name {
                "whoami" => match caller.session {
                    Some(SessionId(id)) => format!("session {id}"),
                    None => "no session".to_owned(),
                },
                _ => Value::Object(arguments).to_string(),
            };
            CallToolResult::success(vec![ContentBlock::text(text)])
        })
    }
}

/// A listener serving `floti-test` at `/mcp/test` and `floti-other` at
/// `/mcp/other`.
struct World {
    listener: AgentToolsListener,
    test: Arc<TestFamily>,
    other: Arc<TestFamily>,
}

fn two_families() -> World {
    let test = TestFamily::new("floti-test", "/mcp/test");
    let other = TestFamily::new("floti-other", "/mcp/other");
    let families: Vec<Arc<dyn ToolFamily>> = vec![test.clone(), other.clone()];
    World {
        listener: AgentToolsListener::new(families),
        test,
        other,
    }
}

impl World {
    fn grant(&self) -> Grant {
        self.listener
            .grant()
            .expect("the listener binds")
            .expect("a family is on, so a token is minted")
    }

    fn address(&self) -> SocketAddr {
        self.listener.address().expect("the listener is bound")
    }
}

fn token(grant: &Grant) -> &str {
    &grant.servers[0].token
}

/// An answer, as it came over the socket.
#[derive(Debug)]
struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    fn json(&self) -> Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|err| panic!("{err}: {}", String::from_utf8_lossy(&self.body)))
    }

    /// A JSON-RPC answer's result, when it is a 200 with one.
    fn result(&self) -> Value {
        assert_eq!(self.status, 200, "{self:?}");
        let answer = self.json();
        assert!(answer.get("error").is_none(), "{answer}");
        answer["result"].clone()
    }
}

/// One request on its own connection: `head` is everything but the body,
/// and `body` is sent after it, all of it before the answer is read.
async fn exchange(address: SocketAddr, head: &str, body: &[u8]) -> Reply {
    tokio::time::timeout(PATIENCE, async {
        let mut stream = TcpStream::connect(address).await.expect("connect");
        stream.write_all(head.as_bytes()).await.expect("send head");
        if !body.is_empty() {
            stream.write_all(body).await.expect("send body");
        }
        // An answer to HEAD says how long its body would be and sends none.
        read_reply(&mut stream, !head.starts_with("HEAD ")).await
    })
    .await
    .expect("an answer within the patience")
}

async fn read_reply(stream: &mut TcpStream, has_body: bool) -> Reply {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8192];
    let end_of_head = loop {
        if let Some(at) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break at;
        }
        let read = stream.read(&mut chunk).await.expect("read the answer");
        assert!(read > 0, "the connection closed before an answer");
        buffer.extend_from_slice(&chunk[..read]);
    };
    let head = String::from_utf8(buffer[..end_of_head].to_vec()).expect("a text head");
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|line| line.split(' ').nth(1))
        .and_then(|code| code.parse().ok())
        .expect("a status line");
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| (key.trim().to_owned(), value.trim().to_owned()))
        .collect();
    let mut body = buffer[end_of_head + 4..].to_vec();
    let length = headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.parse::<usize>().ok());
    match length {
        _ if !has_body => {}
        Some(length) => {
            while body.len() < length {
                let read = stream.read(&mut chunk).await.expect("read the body");
                assert!(read > 0, "the connection closed inside the body");
                body.extend_from_slice(&chunk[..read]);
            }
        }
        None => {
            stream.read_to_end(&mut body).await.expect("read the body");
        }
    }
    Reply {
        status,
        headers,
        body,
    }
}

fn head(
    method: &str,
    address: SocketAddr,
    path: &str,
    headers: &[(&str, &str)],
    length: usize,
) -> String {
    let mut head = format!("{method} {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n");
    for (key, value) in headers {
        head.push_str(&format!("{key}: {value}\r\n"));
    }
    head.push_str(&format!("Content-Length: {length}\r\n\r\n"));
    head
}

/// A request with these headers and body, as an MCP client sends one.
async fn send(
    address: SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> Reply {
    let mut all = vec![("Accept", MCP_ACCEPT), ("Content-Type", "application/json")];
    all.extend_from_slice(headers);
    exchange(
        address,
        &head(method, address, path, &all, body.len()),
        body.as_bytes(),
    )
    .await
}

/// A JSON-RPC request with id 1, carrying `token`.
async fn rpc(address: SocketAddr, path: &str, token: &str, method: &str, params: Value) -> Reply {
    rpc_from(address, path, token, method, params, &[]).await
}

async fn rpc_from(
    address: SocketAddr,
    path: &str,
    token: &str,
    method: &str,
    params: Value,
    headers: &[(&str, &str)],
) -> Reply {
    let auth = format!("Bearer {token}");
    let mut all = vec![("Authorization", auth.as_str())];
    all.extend_from_slice(headers);
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
    send(address, "POST", path, &all, &body.to_string()).await
}

async fn call(address: SocketAddr, path: &str, token: &str, tool: &str) -> (bool, String) {
    let result = rpc(
        address,
        path,
        token,
        "tools/call",
        json!({ "name": tool, "arguments": {} }),
    )
    .await
    .result();
    let failed = result["isError"].as_bool().unwrap_or(false);
    let text = result["content"][0]["text"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    (failed, text)
}

fn initialize(version: &str) -> Value {
    json!({
        "protocolVersion": version,
        "capabilities": {},
        "clientInfo": { "name": "test client", "version": "1" }
    })
}

/// Whether a connection to `address` is accepted.
async fn accepts(address: SocketAddr) -> bool {
    matches!(
        tokio::time::timeout(PATIENCE, TcpStream::connect(address)).await,
        Ok(Ok(_))
    )
}

/// Waits for `address` to stop accepting connections.
async fn refuses_soon(address: SocketAddr) -> bool {
    let deadline = Instant::now() + PATIENCE;
    while Instant::now() < deadline {
        if !accepts(address).await {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

/// This machine's address on its default route, when it has one that is not
/// loopback. A UDP socket "connected" to a documentation address sends
/// nothing; it only asks the OS which address it would use.
fn outward_address() -> Option<IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then_some(ip)
}

#[tokio::test]
async fn s1_binds_127_0_0_1_on_a_port_the_os_chose_and_accepts_nothing_elsewhere() {
    let world = two_families();
    assert_eq!(
        world.listener.address(),
        None,
        "nothing is bound before a launch asks"
    );

    let grant = world.grant();
    let address = world.address();
    assert_eq!(address.ip(), IpAddr::from([127, 0, 0, 1]));
    assert_ne!(address.port(), 0);
    for server in &grant.servers {
        assert!(
            server
                .url
                .starts_with(&format!("http://127.0.0.1:{}/", address.port())),
            "{}",
            server.url
        );
    }

    // Ephemeral: a second listener is handed a port of its own.
    let second = two_families();
    second.grant();
    assert_ne!(second.address().port(), address.port());

    assert!(accepts(address).await);
    // The IPv4 loopback alone: `::` or `0.0.0.0` would have answered these.
    let ipv6 = SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), address.port());
    assert!(!accepts(ipv6).await, "nothing listens on [::1]");
    if let Some(outward) = outward_address() {
        let outward = SocketAddr::new(outward, address.port());
        assert!(!accepts(outward).await, "nothing listens on {outward}");
    }

    world.listener.stop().await;
    second.listener.stop().await;
}

#[tokio::test]
async fn s2_answers_401_with_a_bearer_challenge_before_reading_the_body_whatever_the_path() {
    let world = two_families();
    let grant = world.grant();
    let address = world.address();
    let token = token(&grant).to_owned();
    let last = if token.ends_with('0') { '1' } else { '0' };
    let off_by_one = format!("{}{last}", &token[..token.len() - 1]);
    let wrong: Vec<Option<String>> = vec![
        None,
        Some(format!("Bearer {off_by_one}")),
        Some(format!("Bearer {token}0")),
        Some(format!("Bearer {}", &token[1..])),
        Some(format!("Basic {token}")),
        Some(format!("Bearer{token}")),
        Some(token.clone()),
        Some("Bearer ".to_owned()),
    ];

    let routes = ["/mcp/test", "/mcp/other", "/nothing-here", "/", "/health"];
    let mut answers = Vec::new();
    for path in routes {
        for authorization in &wrong {
            let mut headers = vec![("Accept", MCP_ACCEPT)];
            if let Some(value) = authorization {
                headers.push(("Authorization", value));
            }
            // A body announced and never sent: answering at all means it
            // was not waited for, and a body that is not JSON would have
            // been a parse error had it been read.
            let reply = exchange(
                address,
                &head("POST", address, path, &headers, 1 << 20),
                b"",
            )
            .await;
            assert_eq!(reply.status, 401, "{path} with {authorization:?}");
            assert_eq!(reply.header("www-authenticate"), Some("Bearer"));
            answers.push(reply.body);
        }
        let get = exchange(address, &head("GET", address, path, &[], 0), b"").await;
        assert_eq!(get.status, 401, "GET {path}");
        answers.push(get.body);
    }
    // Every one says the same thing, so none says which routes exist.
    assert!(answers.windows(2).all(|pair| pair[0] == pair[1]));

    // Two Authorization headers are no answer, even with the right token.
    let right = format!("Bearer {token}");
    let twice = send(
        address,
        "POST",
        "/mcp/test",
        &[("Authorization", &right), ("Authorization", &right)],
        "{}",
    )
    .await;
    assert_eq!(twice.status, 401);

    // And the right one, in any case of its scheme, is let in.
    for scheme in ["Bearer", "bearer", "BEARER"] {
        let auth = format!("{scheme} {token}");
        let ping = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }).to_string();
        let reply = send(
            address,
            "POST",
            "/mcp/test",
            &[("Authorization", &auth)],
            &ping,
        )
        .await;
        assert_eq!(reply.result(), json!({}));
    }

    world.listener.stop().await;
}

#[tokio::test]
async fn s3_refuses_a_non_loopback_origin_with_403_whatever_token_it_carries() {
    let world = two_families();
    let grant = world.grant();
    let address = world.address();
    let token = token(&grant);

    for origin in [
        "https://example.com",
        "http://127.0.0.2:3000",
        "http://localhost.example.com",
    ] {
        let from_page = rpc_from(
            address,
            "/mcp/test",
            token,
            "ping",
            json!({}),
            &[("Origin", origin)],
        )
        .await;
        assert_eq!(from_page.status, 403, "{origin}");
        // Refused before the token is looked at: no token is the same 403.
        let reply = exchange(
            address,
            &head(
                "POST",
                address,
                "/nothing-here",
                &[("Origin", origin)],
                1 << 20,
            ),
            b"",
        )
        .await;
        assert_eq!(reply.status, 403, "{origin} without a token");
    }

    for origin in [
        "http://localhost:3000",
        "http://127.0.0.1:5173",
        "http://[::1]:8080",
        "null",
    ] {
        let local = rpc_from(
            address,
            "/mcp/test",
            token,
            "ping",
            json!({}),
            &[("Origin", origin)],
        )
        .await;
        assert_eq!(local.result(), json!({}), "{origin}");
    }

    world.listener.stop().await;
}

#[tokio::test]
async fn s4_gives_two_sessions_their_own_tokens_on_one_port_each_answered_as_itself() {
    let world = two_families();
    let alpha = world.grant();
    let beta = world.grant();
    assert_ne!(token(&alpha), token(&beta));
    assert_ne!(alpha.id, beta.id);
    let urls = |grant: &Grant| {
        grant
            .servers
            .iter()
            .map(|s| s.url.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(urls(&alpha), urls(&beta), "one port, one route per family");
    for server in &alpha.servers {
        assert_eq!(
            server.token,
            token(&alpha),
            "one token for all of a session's families"
        );
    }

    let address = world.address();
    // A call that arrives before the host has bound the session is nobody's yet.
    assert_eq!(
        call(address, "/mcp/test", token(&alpha), "whoami").await,
        (false, "no session".to_owned())
    );

    world.listener.bind_session(alpha.id, SessionId(11));
    world.listener.bind_session(beta.id, SessionId(22));
    for route in ["/mcp/test", "/mcp/other"] {
        assert_eq!(
            call(address, route, token(&alpha), "whoami").await,
            (false, "session 11".to_owned())
        );
        assert_eq!(
            call(address, route, token(&beta), "whoami").await,
            (false, "session 22".to_owned())
        );
    }

    world.listener.stop().await;
}

#[tokio::test]
async fn s5_a_revoked_token_is_answered_401_while_the_other_sessions_token_still_works() {
    let world = two_families();
    let alpha = world.grant();
    let beta = world.grant();
    let address = world.address();

    world.listener.revoke(alpha.id);
    for route in ["/mcp/test", "/mcp/other"] {
        assert_eq!(
            rpc(address, route, token(&alpha), "ping", json!({}))
                .await
                .status,
            401
        );
        assert_eq!(
            rpc(address, route, token(&beta), "ping", json!({}))
                .await
                .result(),
            json!({})
        );
    }
    // Revoking it again changes nothing.
    world.listener.revoke(alpha.id);
    assert_eq!(
        rpc(address, "/mcp/test", token(&beta), "ping", json!({}))
            .await
            .status,
        200
    );

    world.listener.stop().await;
}

#[tokio::test]
async fn s6_answers_a_path_no_family_serves_404_and_any_method_but_post_405() {
    let world = two_families();
    let grant = world.grant();
    let address = world.address();
    let auth = format!("Bearer {}", token(&grant));

    for path in [
        "/",
        "/mcp",
        "/mcp/",
        "/MCP/TEST",
        "/mcp/test/",
        "/mcp/test/list",
        "/mcp/testing",
        "/health",
    ] {
        let reply = send(address, "POST", path, &[("Authorization", &auth)], "{}").await;
        assert_eq!(reply.status, 404, "{path}");
    }
    // A query does not make a route.
    let ping = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }).to_string();
    let queried = send(
        address,
        "POST",
        "/mcp/test?x=1",
        &[("Authorization", &auth)],
        &ping,
    )
    .await;
    assert_eq!(queried.result(), json!({}));

    for route in ["/mcp/test", "/mcp/other"] {
        for method in ["GET", "DELETE", "PUT", "PATCH", "OPTIONS", "HEAD"] {
            let reply = exchange(
                address,
                &head(method, address, route, &[("Authorization", &auth)], 0),
                b"",
            )
            .await;
            assert_eq!(reply.status, 405, "{method} {route}");
            assert_eq!(reply.header("allow"), Some("POST"), "{method} {route}");
        }
    }

    world.listener.stop().await;
}

#[tokio::test]
async fn stopping_closes_the_port_and_a_listener_started_after_knows_no_earlier_token() {
    let world = two_families();
    let alpha = world.grant();
    let beta = world.grant();
    let address = world.address();

    world.listener.stop().await;
    assert_eq!(world.listener.address(), None);
    assert!(
        !accepts(address).await,
        "the port accepts nothing once stop returns"
    );

    let after = two_families();
    let gamma = after.grant();
    let address = after.address();
    for stale in [&alpha, &beta] {
        assert_eq!(
            rpc(address, "/mcp/test", token(stale), "ping", json!({}))
                .await
                .status,
            401
        );
    }
    assert_eq!(
        rpc(address, "/mcp/test", token(&gamma), "ping", json!({}))
            .await
            .status,
        200
    );

    // A stopped listener that binds again knows none of its own old tokens.
    let delta = world.grant();
    let rebound = world.address();
    assert_eq!(
        rpc(rebound, "/mcp/test", token(&beta), "ping", json!({}))
            .await
            .status,
        401
    );
    assert_eq!(
        rpc(rebound, "/mcp/test", token(&delta), "ping", json!({}))
            .await
            .status,
        200
    );

    after.listener.stop().await;
    world.listener.stop().await;
}

#[tokio::test]
async fn with_every_family_off_it_binds_nothing_and_mints_no_token() {
    let world = two_families();
    world.test.switch(false);
    world.other.switch(false);

    world.listener.sync().expect("sync");
    assert_eq!(world.listener.grant().expect("no bind is attempted"), None);
    assert_eq!(world.listener.address(), None);
    assert!(world.listener.served_names().is_empty());

    // One family on is one route, and the launch is told of it alone.
    world.other.switch(true);
    world.listener.sync().expect("sync");
    assert!(world.listener.address().is_some());
    let grant = world.grant();
    let names: Vec<&str> = grant.servers.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["floti-other"]);

    world.listener.stop().await;
}

#[tokio::test]
async fn a_family_switched_off_has_no_route_no_server_and_no_tools_until_it_is_back() {
    let world = two_families();
    let alpha = world.grant();
    let address = world.address();
    let token = token(&alpha);
    assert_eq!(world.listener.served_names(), ["floti-test", "floti-other"]);

    world.test.switch(false);
    assert_eq!(
        rpc(address, "/mcp/test", token, "tools/list", json!({}))
            .await
            .status,
        404
    );
    assert_eq!(
        rpc(address, "/mcp/other", token, "tools/list", json!({}))
            .await
            .status,
        200
    );
    assert_eq!(world.listener.served_names(), ["floti-other"]);
    let beta = world.grant();
    let names: Vec<&str> = beta.servers.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(
        names,
        ["floti-other"],
        "a session launched now is not told of it"
    );

    world.test.switch(true);
    assert_eq!(
        rpc(address, "/mcp/test", token, "tools/list", json!({}))
            .await
            .status,
        200
    );
    assert_eq!(world.listener.served_names(), ["floti-test", "floti-other"]);

    world.listener.stop().await;
}

#[tokio::test]
async fn it_lets_go_of_its_port_when_no_family_is_on_and_no_session_holds_a_token() {
    let world = two_families();
    let alpha = world.grant();
    let address = world.address();
    let token = token(&alpha).to_owned();

    // Every family off while a session still holds its token: the port stays
    // the session's, every route 404, and a family back on answers it again.
    world.test.switch(false);
    world.other.switch(false);
    world.listener.sync().expect("sync");
    assert_eq!(world.listener.address(), Some(address));
    assert_eq!(
        rpc(address, "/mcp/test", &token, "ping", json!({}))
            .await
            .status,
        404
    );
    world.test.switch(true);
    world.listener.sync().expect("sync");
    assert_eq!(
        rpc(address, "/mcp/test", &token, "ping", json!({}))
            .await
            .status,
        200
    );

    // Off again, and the last token revoked: nothing is left listening.
    world.test.switch(false);
    world.listener.sync().expect("sync");
    world.listener.revoke(alpha.id);
    assert_eq!(world.listener.address(), None);
    assert!(refuses_soon(address).await, "the port is let go");

    world.listener.stop().await;
}

#[tokio::test]
async fn initialize_names_the_family_and_negotiates_the_protocol_version() {
    let world = two_families();
    let grant = world.grant();
    let address = world.address();
    let token = token(&grant);

    for (asked, agreed) in [
        ("2025-06-18", "2025-06-18"),
        ("2025-03-26", "2025-03-26"),
        ("2024-11-05", "2024-11-05"),
        ("1999-01-01", "2025-06-18"),
    ] {
        let result = rpc(address, "/mcp/test", token, "initialize", initialize(asked))
            .await
            .result();
        assert_eq!(result["protocolVersion"], agreed, "asked for {asked}");
        assert_eq!(result["serverInfo"]["name"], "floti-test");
        assert_eq!(
            result["instructions"],
            "Test tools. whoami is read-only awareness."
        );
        assert!(result["capabilities"]["tools"].is_object());
    }
    let other = rpc(
        address,
        "/mcp/other",
        token,
        "initialize",
        initialize("2025-06-18"),
    )
    .await
    .result();
    assert_eq!(other["serverInfo"]["name"], "floti-other");

    world.listener.stop().await;
}

#[tokio::test]
async fn a_notification_is_answered_202_with_no_body_and_a_ping_with_an_empty_result() {
    let world = two_families();
    let grant = world.grant();
    let address = world.address();
    let auth = format!("Bearer {}", token(&grant));

    let notification = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
    let reply = send(
        address,
        "POST",
        "/mcp/test",
        &[("Authorization", &auth)],
        &notification.to_string(),
    )
    .await;
    assert_eq!(reply.status, 202);
    assert!(
        reply.body.is_empty(),
        "{:?}",
        String::from_utf8_lossy(&reply.body)
    );

    let ping = rpc(address, "/mcp/test", token(&grant), "ping", json!({})).await;
    assert_eq!(ping.result(), json!({}));
    assert_eq!(ping.header("cache-control"), Some("no-store"));

    // Not JSON at all is refused, never answered as a call.
    let garbage = send(
        address,
        "POST",
        "/mcp/test",
        &[("Authorization", &auth)],
        "{ not json",
    )
    .await;
    assert_ne!(garbage.status, 200);
    assert_ne!(garbage.status, 202);

    world.listener.stop().await;
}

#[tokio::test]
async fn tools_are_listed_with_their_read_only_hint_and_called_for_the_caller() {
    let world = two_families();
    let grant = world.grant();
    world.listener.bind_session(grant.id, SessionId(7));
    let address = world.address();
    let token = token(&grant);

    let tools = rpc(address, "/mcp/test", token, "tools/list", json!({}))
        .await
        .result();
    let listed: Vec<(&str, Option<bool>)> = tools["tools"]
        .as_array()
        .expect("a list")
        .iter()
        .map(|tool| {
            (
                tool["name"].as_str().unwrap_or_default(),
                tool["annotations"]["readOnlyHint"].as_bool(),
            )
        })
        .collect();
    assert_eq!(listed, [("whoami", Some(true)), ("echo", None)]);

    assert_eq!(
        call(address, "/mcp/test", token, "whoami").await,
        (false, "session 7".to_owned())
    );
    let echoed = rpc(
        address,
        "/mcp/test",
        token,
        "tools/call",
        json!({ "name": "echo", "arguments": { "said": "hello" } }),
    )
    .await
    .result();
    assert_eq!(echoed["content"][0]["text"], r#"{"said":"hello"}"#);

    world.listener.stop().await;
}

#[tokio::test]
async fn a_call_to_a_tool_the_family_does_not_have_is_a_failed_call() {
    let world = two_families();
    let grant = world.grant();
    let address = world.address();

    let (failed, text) = call(address, "/mcp/test", token(&grant), "rm_rf").await;
    assert!(failed);
    assert_eq!(text, "floti-test has no tool named rm_rf.");

    world.listener.stop().await;
}

#[tokio::test]
async fn a_body_past_the_cap_is_refused_413() {
    let world = two_families();
    let grant = world.grant();
    let address = world.address();
    let auth = format!("Bearer {}", token(&grant));

    let body = vec![b' '; MAX_BODY_BYTES + 1];
    let headers = [
        ("Authorization", auth.as_str()),
        ("Accept", MCP_ACCEPT),
        ("Content-Type", "application/json"),
    ];
    let reply = exchange(
        address,
        &head("POST", address, "/mcp/test", &headers, body.len()),
        &body,
    )
    .await;
    assert_eq!(reply.status, 413);

    world.listener.stop().await;
}

#[tokio::test]
async fn a_token_is_32_fresh_random_bytes_written_as_hex() {
    let world = two_families();
    let alpha = world.grant();
    let beta = world.grant();
    for grant in [&alpha, &beta] {
        let token = token(grant);
        assert_eq!(token.len(), 64);
        assert!(
            token
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        );
    }
    assert_ne!(token(&alpha), token(&beta));

    world.listener.stop().await;
}
