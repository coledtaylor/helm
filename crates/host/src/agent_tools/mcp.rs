//! One family as an MCP server, through `rmcp`.
//!
//! A request reaches this only after the listener's own checks passed, with
//! the [`Caller`] its token resolved to in the HTTP request's extensions.

use std::borrow::Cow;
use std::sync::Arc;

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, CancelTaskParams, ContentBlock,
    CreateTaskResult, GetTaskParams, GetTaskResult, Implementation, InitializeRequestParams,
    InitializeResult, ListToolsResult, PaginatedRequestParams, ProtocolVersion, ServerCapabilities,
    ServerConfig, Tool,
};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_server::session::never::NeverSessionManager;
use rmcp::transport::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData, RoleServer, ServerHandler};
use tokio::sync::watch;

use super::tasks::{AsTask, Tasks};
use super::{Caller, Delivery, ToolFamily};

/// Set once nobody waits on a call any more: the session cancelled it, or
/// its token was revoked. Put in the request's extensions by the listener.
#[derive(Clone)]
pub(super) struct Abandoned(pub watch::Receiver<bool>);

impl Abandoned {
    /// Resolves once the call is abandoned; never, when it is not.
    async fn wait(mut self) {
        if self.0.wait_for(|abandoned| *abandoned).await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

/// The revisions spoken, newest first. A client asking for one of them gets
/// it. 2026-07-28 has no `initialize`: a client reaches it with
/// `server/discover` or a request whose metadata names it, never by asking
/// `initialize` for it.
const SUPPORTED_VERSIONS: &[ProtocolVersion] = &[
    ProtocolVersion::V_2026_07_28,
    ProtocolVersion::V_2025_06_18,
    ProtocolVersion::V_2025_03_26,
    ProtocolVersion::V_2024_11_05,
];

/// What a client that asks `initialize` for a revision this server does not
/// speak is answered with, and what a request naming no revision gets, so a
/// client is never told its own unknown version is supported.
const FALLBACK_VERSION: ProtocolVersion = ProtocolVersion::V_2025_06_18;

/// A family's `rmcp` service.
pub(super) type FamilyService = StreamableHttpService<FamilyServer, NeverSessionManager>;

/// Stateless and answering in JSON: every tool answers its own call, so
/// there is no session to keep and nothing to stream.
pub(super) fn service(family: Arc<dyn ToolFamily>) -> FamilyService {
    let config = StreamableHttpServerConfig::default()
        .with_legacy_session_mode(false)
        .with_json_response(true)
        .with_sse_keep_alive(None);
    StreamableHttpService::new(
        move || {
            Ok(FamilyServer {
                family: Arc::clone(&family),
            })
        },
        Arc::new(NeverSessionManager::default()),
        config,
    )
}

pub(super) struct FamilyServer {
    family: Arc<dyn ToolFamily>,
}

impl ServerHandler for FamilyServer {
    /// What the family is at 2026-07-28, which is where `server/discover`
    /// answers from and where the tasks methods are checked: the tasks
    /// extension is named only by a family that offers it. The handshake of
    /// the revisions before it says no extension ([`Self::initialize`]).
    fn get_info(&self) -> ServerConfig {
        let mut capabilities = ServerCapabilities::builder().enable_tools();
        if self.family.offers_tasks() {
            capabilities = capabilities.enable_tasks();
        }
        ServerConfig::new(capabilities.build())
            .with_server_info(Implementation::new(
                self.family.name(),
                crate::version::FLOTI_VERSION,
            ))
            .with_instructions(self.family.instructions())
            .with_protocol_version(FALLBACK_VERSION)
    }

    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Borrowed(SUPPORTED_VERSIONS)
    }

    /// The handshake of the revisions that have one, answered as it always
    /// was: no extensions, so nothing in it hints at a task.
    async fn initialize(
        &self,
        request: InitializeRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<InitializeResult, ErrorData> {
        context.peer.set_peer_info(request.clone());
        let mut answer = self.negotiate_initialize(&request)?;
        answer.capabilities.extensions = None;
        Ok(answer)
    }

    /// `tasks/get`: the state of one of the caller's tasks. A task of another
    /// grant is answered exactly as one that does not exist. The completed
    /// result counts as taken once this reply has been handed over whole.
    async fn get_task(
        &self,
        request: GetTaskParams,
        context: RequestContext<RoleServer>,
    ) -> Result<GetTaskResult, ErrorData> {
        let (caller, tasks, delivery) = task_parts(&context)?;
        tasks
            .get(caller.grant, &request.task_id, &delivery)
            .ok_or_else(unknown_task)
    }

    /// `tasks/cancel`: drops one of the caller's tasks and its work, running
    /// nothing the work asked for on delivery.
    async fn cancel_task(
        &self,
        request: CancelTaskParams,
        context: RequestContext<RoleServer>,
    ) -> Result<(), ErrorData> {
        let (caller, tasks, _) = task_parts(&context)?;
        if tasks.cancel(caller.grant, &request.task_id) {
            Ok(())
        } else {
            Err(unknown_task())
        }
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let tools = match caller_of(&context) {
            Some(caller) => self.family.tools_for(caller),
            None => self.family.tools(),
        };
        Ok(ListToolsResult::with_all_items(tools))
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        self.family
            .tools()
            .into_iter()
            .find(|tool| tool.name == name)
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let parts = context.extensions.get::<http::request::Parts>();
        let caller = caller_of(&context)
            .ok_or_else(|| ErrorData::internal_error("a call arrived with no caller", None))?;
        let abandoned = parts.and_then(|parts| parts.extensions.get::<Abandoned>().cloned());
        let delivery = parts
            .and_then(|parts| parts.extensions.get::<Delivery>().cloned())
            .unwrap_or_default();
        // The tools this caller is listed: one it is not listed is one the
        // family does not have.
        if !self
            .family
            .tools_for(caller)
            .iter()
            .any(|tool| tool.name == request.name)
        {
            return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "{} has no tool named {}.",
                self.family.name(),
                request.name
            ))])
            .into());
        }
        let arguments = request.arguments.unwrap_or_default();
        // A call the listener decided to answer as a task is held by it, in
        // memory, under the caller's grant, and answered at once.
        if let Some(tasks) = parts
            .filter(|parts| parts.extensions.get::<AsTask>().is_some())
            .and_then(|parts| parts.extensions.get::<Arc<Tasks>>())
        {
            let seed = tasks.start(
                caller,
                Arc::clone(&self.family),
                request.name.to_string(),
                arguments,
            );
            return Ok(CreateTaskResult::new(seed).into());
        }
        let call = self
            .family
            .call_with(caller, &request.name, arguments, delivery);
        // Dropping the family's future is how a call learns nobody waits on
        // it: its connection closed (rmcp cancels the request), the session
        // cancelled it, or its token was revoked.
        let abandoned = async {
            match abandoned {
                Some(abandoned) => abandoned.wait().await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            result = call => Ok(result.into()),
            () = context.ct.cancelled() => Err(abandoned_error()),
            () = abandoned => Err(abandoned_error()),
        }
    }
}

/// Who is calling, as the listener put it in the request's extensions.
fn caller_of(context: &RequestContext<RoleServer>) -> Option<Caller> {
    context
        .extensions
        .get::<http::request::Parts>()
        .and_then(|parts| parts.extensions.get::<Caller>())
        .copied()
}

/// Who is calling, the listener's tasks and this request's own delivery, for
/// a tasks method.
fn task_parts(
    context: &RequestContext<RoleServer>,
) -> Result<(Caller, Arc<Tasks>, Delivery), ErrorData> {
    let parts = context.extensions.get::<http::request::Parts>();
    let caller = caller_of(context)
        .ok_or_else(|| ErrorData::internal_error("a request arrived with no caller", None))?;
    let tasks = parts
        .and_then(|parts| parts.extensions.get::<Arc<Tasks>>().cloned())
        .ok_or_else(|| ErrorData::internal_error("a request arrived with no tasks", None))?;
    let delivery = parts
        .and_then(|parts| parts.extensions.get::<Delivery>().cloned())
        .unwrap_or_default();
    Ok((caller, tasks, delivery))
}

/// What a task that is not the caller's, never was or is gone is answered
/// with: the same for each, so a task id says nothing about another grant.
fn unknown_task() -> ErrorData {
    ErrorData::invalid_params("There is no such task.", None)
}

/// What a call nobody waits on is answered with, should the answer still
/// reach anyone.
fn abandoned_error() -> ErrorData {
    ErrorData::internal_error("The call was cancelled before it was answered.", None)
}
