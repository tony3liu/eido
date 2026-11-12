//! Direct MCP keeps reading cancellation while an admitted native call runs.
//! Mutations retain their ordinary serial ordering; cancellation is keyed by
//! the transport's request ID and never ends another task's session.

use cua_driver_core::{
    input_cancellation::{InputCancellation, REQUEST_INPUT},
    mcp_wire::{self, ProtocolSession},
    protocol::{Request, Response},
};
use std::{collections::HashMap, sync::Arc};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt};

struct Pending(InputCancellation);
impl Drop for Pending {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
struct Cleanup(Arc<crate::sdk_adapter::SdkAdapter>, String);
impl Drop for Cleanup {
    fn drop(&mut self) {
        self.0.end_transport_sessions(&self.1);
    }
}

async fn write<W: AsyncWrite + Unpin>(
    writer: &Arc<tokio::sync::Mutex<W>>,
    response: Response,
) -> anyhow::Result<()> {
    let bytes = serde_json::to_vec(&response)?;
    let mut writer = writer.lock().await;
    writer.write_all(&bytes).await?;
    writer.write_all(b"\n").await?;
    writer.flush().await?;
    Ok(())
}

pub(super) async fn run<R, W>(
    sdk: Arc<crate::sdk_adapter::SdkAdapter>,
    mut reader: R,
    writer: W,
) -> anyhow::Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let transport = format!("mcp-{}", uuid::Uuid::new_v4());
    let mut tasks = tokio::task::JoinSet::new();
    let cleanup = Cleanup(sdk.clone(), transport.clone());
    let mut pending: HashMap<String, Pending> = HashMap::new();
    let serial = Arc::new(tokio::sync::Mutex::new(()));
    let writer = Arc::new(tokio::sync::Mutex::new(writer));
    let mut protocol = ProtocolSession::default();
    let mut line = Vec::new();
    let mut observed = false;
    loop {
        let mut bounded = (&mut reader).take((1024 * 1024 + 1 - line.len()) as u64);
        tokio::select! {
            done = tasks.join_next(), if !tasks.is_empty() => {
                let (key, result) = done.expect("nonempty task set")?;
                pending.remove(&key); result?; continue;
            }
            count = bounded.read_until(b'\n', &mut line) => { if count? == 0 { break; } }
        }
        anyhow::ensure!(line.len() <= 1024 * 1024, "MCP request exceeds size limit");
        if line.iter().all(u8::is_ascii_whitespace) {
            line.clear();
            continue;
        }
        let parsed = serde_json::from_slice::<Request>(&line);
        line.clear();
        let mut request = match parsed {
            Ok(request) => request,
            Err(_) => {
                write(&writer, Response::parse_error()).await?;
                continue;
            }
        };
        if request.is_notification() {
            if request.method == "notifications/cancelled" {
                if let Some(id) = request.params.as_ref().and_then(|p| p.get("requestId")) {
                    if let Some(owned) = pending.get(&id.to_string()) {
                        owned.0.cancel();
                    }
                }
            }
            continue;
        }
        let id = request.id.clone().unwrap_or_default();
        let key = id.to_string();
        anyhow::ensure!(
            !pending.contains_key(&key),
            "duplicate active MCP request ID"
        );
        let admission = protocol.validate(&request).and_then(|era| {
            if request.method == "tools/call" {
                mcp_wire::validate_tool_call(&request, id.clone(), era, &sdk.tools_list())?;
            }
            Ok(era)
        });
        if let Err(response) = admission {
            write(&writer, response).await?;
            continue;
        }
        if pending.len() >= 32 {
            write(&writer, Response::error(id, -32029, "in_flight_limit")).await?;
            continue;
        }
        if !observed {
            if let Some(metadata) = request.initialize_metadata() {
                cua_driver_core::server::observe_proxy_session_started(metadata);
                observed = true;
            }
        }
        super::apply_direct_session_identity(&mut request, &transport);
        let ending = request
            .tool_call()
            .ok()
            .is_some_and(|call| call.name == "end_session");
        let input = InputCancellation::default();
        pending.insert(key.clone(), Pending(input.clone()));
        let sdk = sdk.clone();
        let transport = transport.clone();
        let serial = serial.clone();
        let writer = writer.clone();
        tasks.spawn(REQUEST_INPUT.scope(input.clone(), async move {
            let result = async {
                // Session end must reach core's pending-end signal without
                // waiting behind the input it is trying to stop.
                let _serial = if ending {
                    None
                } else {
                    Some(serial.lock().await)
                };
                let response = if input.is_cancelled() {
                    Response::error(id, -32800, "request_cancelled")
                } else {
                    let context = request.tool_call().ok().and_then(|call| {
                        sdk.begin_tool_call(
                            &call.name,
                            &call.args,
                            cua_driver_core::session::SessionTransport::McpStdio,
                            cua_driver_core::session::SessionClientKind::Mcp,
                        )
                    });
                    let timer = cua_driver_core::server::tool_observation_timer(
                        &request,
                        |name| sdk.is_known_tool(name),
                        cua_driver_core::server::StdioExecutionPath::DirectDaemon,
                    );
                    let response = cua_driver_core::server::handle_request_with_transport_session(
                        request,
                        id,
                        sdk.as_ref(),
                        &transport,
                    )
                    .await;
                    if let Some(timer) = timer {
                        let outcome = timer.finish(&response);
                        if let Some(context) = context {
                            context.complete(&outcome);
                        }
                        cua_driver_core::server::observe_proxy_tool_completed(outcome);
                    }
                    response
                };
                write(&writer, response).await
            }
            .await;
            (key, result)
        }));
    }
    for owned in pending.values() {
        owned.0.cancel();
    }
    drop(cleanup);
    // Do not abort spawn_blocking's parent and release focus ownership while
    // its key emitter is still alive. Cooperatively stop and drain first.
    while let Some(done) = tasks.join_next().await {
        let _ = done?;
    }
    Ok(())
}
