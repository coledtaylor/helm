//! Protocol revision 2026-07-28 and calls answered as tasks, over real
//! loopback HTTP with families made here.

use rmcp::model::TaskStatus;
use tokio::sync::Notify;

use super::super::tasks::Tasks;
use super::*;

/// A family that offers the tasks extension. `later` is answered as a task
/// when the client asks for one: it runs until the test releases it, and
/// says whether it was dropped before that or its result was delivered.
/// `plain` is answered at once and is never a task.
struct TaskFamily {
    release: Notify,
    started: Notify,
    dropped: AtomicBool,
    delivered: Arc<AtomicBool>,
}

impl TaskFamily {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            release: Notify::new(),
            started: Notify::new(),
            dropped: AtomicBool::new(false),
            delivered: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Resolves once `later` is running.
    async fn running(&self) {
        tokio::time::timeout(PATIENCE, self.started.notified())
            .await
            .expect("the call started within the patience");
    }

    /// Whether the call was dropped, waiting for it as long as the patience.
    async fn dropped_soon(&self) -> bool {
        flag_soon(&self.dropped).await
    }
}

/// Waits for `flag` to be set, bounded by the shared patience.
async fn flag_soon(flag: &AtomicBool) -> bool {
    let deadline = Instant::now() + PATIENCE;
    while Instant::now() < deadline {
        if flag.load(Ordering::SeqCst) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    false
}

/// Notes that the call it lives in was dropped.
struct DropNote<'a>(&'a AtomicBool);

impl Drop for DropNote<'_> {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

impl ToolFamily for TaskFamily {
    fn name(&self) -> &str {
        "floti-tasks"
    }

    fn route(&self) -> &str {
        "/mcp/tasks"
    }

    fn instructions(&self) -> &str {
        "Tools that can answer as tasks."
    }

    fn is_on(&self) -> bool {
        true
    }

    fn tools(&self) -> Vec<Tool> {
        let Value::Object(schema) = json!({ "type": "object", "properties": {} }) else {
            unreachable!("a schema is an object")
        };
        vec![
            Tool::new("later", "Runs until released.", schema.clone()),
            Tool::new("plain", "Answers at once.", schema),
        ]
    }

    fn offers_tasks(&self) -> bool {
        true
    }

    fn answers_as_task(&self, _caller: Caller, name: &str, _arguments: &JsonObject) -> bool {
        name == "later"
    }

    fn call<'a>(
        &'a self,
        _caller: Caller,
        name: &'a str,
        _arguments: JsonObject,
    ) -> ToolFuture<'a> {
        Box::pin(async move {
            if name == "plain" {
                return CallToolResult::success(vec![ContentBlock::text("plain")]);
            }
            let _note = DropNote(&self.dropped);
            self.started.notify_one();
            self.release.notified().await;
            CallToolResult::success(vec![ContentBlock::text("done")])
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

/// A listener serving `floti-tasks` at `/mcp/tasks`, which offers the tasks
/// extension, and `floti-plain` at `/mcp/plain`, which does not.
struct TaskWorld {
    listener: AgentToolsListener,
    family: Arc<TaskFamily>,
}

fn task_world() -> TaskWorld {
    let family = TaskFamily::new();
    let plain = TestFamily::new("floti-plain", "/mcp/plain");
    let families: Vec<Arc<dyn ToolFamily>> = vec![family.clone(), plain];
    TaskWorld {
        listener: AgentToolsListener::new(families),
        family,
    }
}

impl TaskWorld {
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

const TASKS: &str = "io.modelcontextprotocol/tasks";

/// A request at 2026-07-28: its metadata names the revision and carries the
/// client's capabilities, declaring the tasks extension when `tasks`, and the
/// headers that revision asks for. `name` is the tool or task id it names.
async fn modern(
    address: SocketAddr,
    path: &str,
    token: &str,
    method: &str,
    mut params: Value,
    tasks: bool,
    name: Option<&str>,
) -> Reply {
    let capabilities = if tasks {
        json!({ "extensions": { TASKS: {} } })
    } else {
        json!({})
    };
    params["_meta"] = json!({
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": capabilities,
        "io.modelcontextprotocol/clientInfo": { "name": "test client", "version": "1" },
    });
    let mut headers = vec![
        ("MCP-Protocol-Version", "2026-07-28"),
        ("Mcp-Method", method),
    ];
    if let Some(name) = name {
        headers.push(("Mcp-Name", name));
    }
    rpc_from(address, path, token, method, params, &headers).await
}

/// `later` called at 2026-07-28, declaring the tasks extension.
async fn call_later(address: SocketAddr, token: &str) -> Reply {
    modern(
        address,
        "/mcp/tasks",
        token,
        "tools/call",
        json!({ "name": "later", "arguments": {} }),
        true,
        Some("later"),
    )
    .await
}

/// A task started by `later`, as the id its token holds it by.
async fn started_task(address: SocketAddr, token: &str) -> String {
    call_later(address, token).await.result()["taskId"]
        .as_str()
        .expect("a task id")
        .to_owned()
}

async fn task_get(address: SocketAddr, token: &str, id: &str) -> Reply {
    modern(
        address,
        "/mcp/tasks",
        token,
        "tasks/get",
        json!({ "taskId": id }),
        true,
        Some(id),
    )
    .await
}

async fn task_cancel(address: SocketAddr, token: &str, id: &str) -> Reply {
    modern(
        address,
        "/mcp/tasks",
        token,
        "tasks/cancel",
        json!({ "taskId": id }),
        true,
        Some(id),
    )
    .await
}

/// Polls `tasks/get` until the task is completed, as a client does.
async fn completed_task(address: SocketAddr, token: &str, id: &str) -> Value {
    let deadline = Instant::now() + PATIENCE;
    loop {
        let result = task_get(address, token, id).await.result();
        if result["status"] == "completed" {
            return result;
        }
        assert!(
            Instant::now() < deadline,
            "still {} at the deadline",
            result["status"]
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn discover_and_request_metadata_get_2026_07_28_and_only_a_family_that_offers_tasks_names_the_extension()
 {
    let world = task_world();
    let grant = world.grant();
    let (address, token) = (world.address(), token(&grant));

    for (path, offers) in [("/mcp/tasks", true), ("/mcp/plain", false)] {
        let discovered = modern(
            address,
            path,
            token,
            "server/discover",
            json!({}),
            false,
            None,
        )
        .await
        .result();
        assert_eq!(discovered["resultType"], "complete", "{discovered}");
        let versions = discovered["supportedVersions"]
            .as_array()
            .expect("versions");
        assert!(versions.contains(&json!("2026-07-28")), "{discovered}");
        assert!(versions.contains(&json!("2025-06-18")), "{discovered}");
        assert_eq!(
            discovered["capabilities"]["extensions"]
                .get(TASKS)
                .is_some_and(Value::is_object),
            offers,
            "{path}: {discovered}"
        );
        assert!(
            discovered["capabilities"]["tools"].is_object(),
            "{discovered}"
        );

        // A request whose metadata names 2026-07-28 is answered in it, where
        // an earlier revision's answer carries no result type.
        let listed = modern(address, path, token, "tools/list", json!({}), false, None)
            .await
            .result();
        assert_eq!(listed["resultType"], "complete", "{path}: {listed}");
        let earlier = rpc(address, path, token, "tools/list", json!({}))
            .await
            .result();
        assert!(earlier.get("resultType").is_none(), "{path}: {earlier}");
    }

    world.listener.stop().await;
}

#[tokio::test]
async fn initialize_keeps_2025_06_18_for_the_revision_asked_or_an_unknown_one_and_names_no_extension()
 {
    let world = task_world();
    let grant = world.grant();
    let (address, token) = (world.address(), token(&grant));

    // 2026-07-28 has no handshake, so asking `initialize` for it, like asking
    // for a revision nobody knows, is answered in 2025-06-18.
    for (asked, agreed) in [
        ("2026-07-28", "2025-06-18"),
        ("2025-06-18", "2025-06-18"),
        ("2025-03-26", "2025-03-26"),
        ("1999-01-01", "2025-06-18"),
    ] {
        for path in ["/mcp/tasks", "/mcp/plain"] {
            let result = rpc(address, path, token, "initialize", initialize(asked))
                .await
                .result();
            assert_eq!(result["protocolVersion"], agreed, "{path} asked {asked}");
            assert!(
                result["capabilities"].get("extensions").is_none(),
                "{path} asked {asked}: {result}"
            );
        }
    }

    world.listener.stop().await;
}

#[tokio::test]
async fn no_call_is_a_task_at_2025_06_18_without_a_revision_or_without_the_extension() {
    let world = task_world();
    let grant = world.grant();
    let (address, token) = (world.address(), token(&grant));
    let later = json!({ "name": "later", "arguments": {} });

    // Each of these would run until released, so it is released beforehand.
    // At 2025-06-18, which the request names in its header.
    world.family.release.notify_one();
    let at_2025 = rpc_from(
        address,
        "/mcp/tasks",
        token,
        "tools/call",
        later.clone(),
        &[("MCP-Protocol-Version", "2025-06-18")],
    )
    .await
    .result();
    // Naming no revision at all.
    world.family.release.notify_one();
    let unnamed = rpc(address, "/mcp/tasks", token, "tools/call", later.clone())
        .await
        .result();
    // At 2026-07-28 but without declaring the extension.
    world.family.release.notify_one();
    let undeclared = modern(
        address,
        "/mcp/tasks",
        token,
        "tools/call",
        later,
        false,
        Some("later"),
    )
    .await
    .result();
    for result in [&at_2025, &unnamed, &undeclared] {
        assert!(result.get("taskId").is_none(), "{result}");
        assert_ne!(result["resultType"], "task", "{result}");
        assert_eq!(result["content"][0]["text"], "done", "{result}");
    }
    // The family that offers none never answers one as a task, whatever the
    // client declares.
    let plain = modern(
        address,
        "/mcp/plain",
        token,
        "tools/call",
        json!({ "name": "echo", "arguments": {} }),
        true,
        Some("echo"),
    )
    .await
    .result();
    assert!(plain.get("taskId").is_none(), "{plain}");

    world.listener.stop().await;
}

#[tokio::test]
async fn a_call_declaring_the_extension_is_answered_with_a_working_task_that_completes_with_its_result()
 {
    let world = task_world();
    let grant = world.grant();
    let (address, token) = (world.address(), token(&grant));

    let created = call_later(address, token).await;
    assert!(
        created
            .header("content-type")
            .is_some_and(|kind| kind.starts_with("application/json")),
        "{created:?}"
    );
    let created = created.result();
    assert_eq!(created["resultType"], "task", "{created}");
    assert_eq!(created["status"], "working", "{created}");
    assert!(created["pollIntervalMs"].as_u64().is_some_and(|ms| ms > 0));
    let id = created["taskId"].as_str().expect("a task id").to_owned();

    world.family.running().await;
    let working = task_get(address, token, &id).await.result();
    assert_eq!(working["status"], "working", "{working}");
    assert_eq!(working["taskId"], id.as_str());
    assert!(!world.family.delivered.load(Ordering::SeqCst));

    world.family.release.notify_one();
    let done = completed_task(address, token, &id).await;
    assert_eq!(done["result"]["content"][0]["text"], "done", "{done}");
    assert_eq!(done["result"]["isError"], false, "{done}");
    // The reply was handed over whole, so the family heard it arrive, and the
    // task is gone.
    assert!(world.family.delivered.load(Ordering::SeqCst));
    let gone = task_get(address, token, &id).await.json();
    assert_eq!(gone["error"]["code"], -32602, "{gone}");

    world.listener.stop().await;
}

#[tokio::test]
async fn tasks_update_is_a_method_not_found_and_a_family_without_tasks_has_no_tasks_methods() {
    let world = task_world();
    let grant = world.grant();
    let (address, token) = (world.address(), token(&grant));

    let update = modern(
        address,
        "/mcp/tasks",
        token,
        "tasks/update",
        json!({ "taskId": "any", "inputResponses": {} }),
        true,
        Some("any"),
    )
    .await
    .json();
    assert_eq!(update["error"]["code"], -32601, "{update}");

    for method in ["tasks/get", "tasks/cancel"] {
        let asked = modern(
            address,
            "/mcp/plain",
            token,
            method,
            json!({ "taskId": "any" }),
            true,
            Some("any"),
        )
        .await
        .json();
        assert_eq!(asked["error"]["code"], -32601, "{method}: {asked}");
    }

    world.listener.stop().await;
}

#[tokio::test]
async fn cancelling_a_task_drops_its_call_and_runs_nothing_on_delivery() {
    let world = task_world();
    let grant = world.grant();
    let (address, token) = (world.address(), token(&grant));

    let id = started_task(address, token).await;
    world.family.running().await;

    let cancelled = task_cancel(address, token, &id).await.result();
    assert_eq!(cancelled["resultType"], "complete", "{cancelled}");
    assert!(world.family.dropped_soon().await);
    let gone = task_get(address, token, &id).await.json();
    assert_eq!(gone["error"]["code"], -32602, "{gone}");
    let again = task_cancel(address, token, &id).await.json();
    assert_eq!(again["error"], gone["error"]);
    assert!(!world.family.delivered.load(Ordering::SeqCst));

    world.listener.stop().await;
}

#[tokio::test]
async fn a_revoked_token_and_a_stopped_listener_drop_every_task_without_running_its_hook() {
    let world = task_world();
    let (first, second) = (world.grant(), world.grant());
    let address = world.address();

    let id = started_task(address, token(&first)).await;
    world.family.running().await;
    // Another session's token ending leaves this one's task alone.
    world.listener.revoke(second.id);
    let still = task_get(address, token(&first), &id).await.result();
    assert_eq!(still["status"], "working", "{still}");
    assert!(!world.family.dropped.load(Ordering::SeqCst));

    world.listener.revoke(first.id);
    assert!(world.family.dropped_soon().await);
    assert!(!world.family.delivered.load(Ordering::SeqCst));

    // A listener that stops drops the tasks of the grants still held.
    let third = world.grant();
    world.family.dropped.store(false, Ordering::SeqCst);
    started_task(world.address(), token(&third)).await;
    world.family.running().await;
    world.listener.stop().await;
    assert!(world.family.dropped_soon().await);
    assert!(!world.family.delivered.load(Ordering::SeqCst));
}

#[tokio::test]
async fn another_tokens_task_is_not_found_exactly_as_an_unknown_one_is() {
    let world = task_world();
    let (mine, other) = (world.grant(), world.grant());
    let address = world.address();

    let id = started_task(address, token(&mine)).await;
    world.family.running().await;

    let unknown = task_get(address, token(&other), "0123456789abcdef0123456789abcdef")
        .await
        .json();
    let foreign_get = task_get(address, token(&other), &id).await.json();
    let foreign_cancel = task_cancel(address, token(&other), &id).await.json();
    assert_eq!(unknown["error"]["code"], -32602, "{unknown}");
    assert_eq!(foreign_get["error"], unknown["error"]);
    assert_eq!(foreign_cancel["error"], unknown["error"]);

    // It is still the first token's, working and uncancelled.
    let working = task_get(address, token(&mine), &id).await.result();
    assert_eq!(working["status"], "working", "{working}");
    assert!(!world.family.dropped.load(Ordering::SeqCst));

    world.listener.stop().await;
}

/// A caller for the tasks of a listener-less test.
fn caller() -> Caller {
    Caller {
        grant: GrantId::for_tests(1),
        session: None,
        shell: false,
    }
}

/// Gets task `id` until it is completed, with the reply that fetched it.
async fn fetch_when_completed(tasks: &Arc<Tasks>, id: &str) -> Delivery {
    let deadline = Instant::now() + PATIENCE;
    loop {
        let reply = Delivery::default();
        let got = tasks.get(caller().grant, id, &reply).expect("held");
        if got.task.status() == TaskStatus::Completed {
            return reply;
        }
        assert!(Instant::now() < deadline, "the call did not finish");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn a_completed_result_is_taken_only_by_a_reply_that_was_delivered_whole() {
    let family = TaskFamily::new();
    let tasks = Arc::new(Tasks::default());
    let seed = tasks.start(
        caller(),
        family.clone(),
        "later".to_owned(),
        JsonObject::new(),
    );
    family.running().await;

    // Working: a reply carries no result, so there is nothing to deliver.
    let reply = Delivery::default();
    let working = tasks
        .get(caller().grant, &seed.task_id, &reply)
        .expect("held");
    assert_eq!(working.task.status(), TaskStatus::Working);
    assert!(reply.take().is_none());

    family.release.notify_one();
    let reply = fetch_when_completed(&tasks, &seed.task_id).await;

    // A reply that never reached the connection whole: dropped, not run. The
    // result is still there, and the family has heard nothing.
    drop(reply);
    assert!(!family.delivered.load(Ordering::SeqCst));
    let reply = fetch_when_completed(&tasks, &seed.task_id).await;

    // One that did: the family hears it once and the task is gone.
    reply
        .take()
        .expect("a reply carrying the result asks to be heard")();
    assert!(family.delivered.load(Ordering::SeqCst));
    assert!(
        tasks
            .get(caller().grant, &seed.task_id, &Delivery::default())
            .is_none()
    );
}

#[tokio::test]
async fn a_grant_abandoned_before_its_reply_was_delivered_runs_no_hook() {
    let family = TaskFamily::new();
    let tasks = Arc::new(Tasks::default());
    let seed = tasks.start(
        caller(),
        family.clone(),
        "later".to_owned(),
        JsonObject::new(),
    );
    family.running().await;
    family.release.notify_one();
    let reply = fetch_when_completed(&tasks, &seed.task_id).await;

    tasks.abandon_grant(caller().grant);
    reply.take().expect("a hook")();
    assert!(!family.delivered.load(Ordering::SeqCst));
    assert!(
        tasks
            .get(caller().grant, &seed.task_id, &Delivery::default())
            .is_none()
    );
}
