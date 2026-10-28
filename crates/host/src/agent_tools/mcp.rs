//! One family as an MCP server, through `rmcp`.
//!
//! A request reaches this only after the listener's own checks passed, with
//! the [`Caller`] its token resolved to in the HTTP request's extensions.

use std::borrow::Cow;
use std::sync::Arc;

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
    ListToolsResult, PaginatedRequestParams, ProtocolVersion, ServerCapabilities, ServerConfig,
    Tool,
};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_server::session::never::NeverSessionManager;
use rmcp::transport::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData, RoleServer, ServerHandler};

use super::{Caller, ToolFamily};

/// The revisions spoken, newest first. A client asking for one of them gets
/// it; any other gets the first, so a client is never told its own unknown
/// version is supported.
const SUPPORTED_VERSIONS: &[ProtocolVersion] = &[
    ProtocolVersion::V_2025_06_18,
    ProtocolVersion::V_2025_03_26,
    ProtocolVersion::V_2024_11_05,
];

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
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(
                self.family.name(),
                env!("CARGO_PKG_VERSION"),
            ))
            .with_instructions(self.family.instructions())
            .with_protocol_version(SUPPORTED_VERSIONS[0].clone())
    }

    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Borrowed(SUPPORTED_VERSIONS)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(self.family.tools()))
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
        let caller = context
            .extensions
            .get::<http::request::Parts>()
            .and_then(|parts| parts.extensions.get::<Caller>())
            .copied()
            .ok_or_else(|| ErrorData::internal_error("a call arrived with no caller", None))?;
        if self.get_tool(&request.name).is_none() {
            return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "{} has no tool named {}.",
                self.family.name(),
                request.name
            ))])
            .into());
        }
        let arguments = request.arguments.unwrap_or_default();
        Ok(self
            .family
            .call(caller, &request.name, arguments)
            .await
            .into())
    }
}
