use crate::db;
use crate::state::{ClientHandle, ClientMessage, OutgoingKind, OutgoingMessage, SessionHandle, TimelineEvent, WsConfig};
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::{accept_hdr_async, connect_async, tungstenite::protocol::Message as WsMessage};
use uuid::Uuid;

/// 判定握手路径是否被接受。None 配置 = accept-all（仍返回真实路径用于打标）；已配置则精确匹配，Err 表示拒绝。
fn resolve_endpoint(path: &str, endpoints: Option<&[String]>) -> Result<String, ()> {
    match endpoints {
        None => Ok(path.to_string()),
        Some(eps) => {
            if eps.iter().any(|e| e == path) { Ok(path.to_string()) } else { Err(()) }
        }
    }
}

pub async fn run_ws_server(
    app: AppHandle,
    db: db::DbConnection,
    session_id: String,
    config: WsConfig,
    handle: Arc<SessionHandle>,
    mut outbound_rx: mpsc::Receiver<OutgoingMessage>,
    mut shutdown_rx: mpsc::Receiver<()>,
) {
    let bind_addr = match config.bind_addr {
        Some(addr) => addr,
        None => {
            emit_error(&app, &session_id, "未配置监听地址，无法启动服务端");
            emit_status(&app, &session_id, "error", None, None);
            remove_session_handle(&app, &session_id).await;
            return;
        }
    };

    let listener = match TcpListener::bind(&bind_addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("ws server bind error: {}", e);
            emit_error(&app, &session_id, &format!("监听 {} 失败：端口可能被占用（{}）", bind_addr, e));
            emit_status(&app, &session_id, "error", None, None);
            remove_session_handle(&app, &session_id).await;
            return;
        }
    };

    let local_addr = listener.local_addr().ok().map(|a| a.to_string());
    db::update_session_status(
        &db,
        &session_id,
        "starting",
        local_addr.as_deref(),
        None,
    )
    .await
    .ok();
    emit_status(&app, &session_id, "starting", local_addr.clone(), None);

    // Update to running once listener is up.
    db::update_session_status(
        &db,
        &session_id,
        "running",
        local_addr.as_deref(),
        None,
    )
    .await
    .ok();
    emit_status(&app, &session_id, "running", local_addr.clone(), None);
    persist_notice(&db, &handle, &session_id, format!("服务端【{}】已启动", local_addr.as_deref().unwrap_or(":?"))).await;

    // Accept loop for multiple clients.
    let endpoints: Option<Vec<String>> = config.endpoints.filter(|v| !v.is_empty());
    loop {
        tokio::select! {
            accept_result = listener.accept() => {
                match accept_result {
                    Ok((stream, peer)) => {
                        let remote_addr = peer.to_string();
                        let path_cell = Arc::new(std::sync::Mutex::new(None::<String>));
                        let endpoints_capture = endpoints.clone();
                        let path_cell_accept = path_cell.clone();
                        let ws_stream = match accept_hdr_async(stream, move |req: &tokio_tungstenite::tungstenite::http::Request<()>, resp: tokio_tungstenite::tungstenite::http::Response<()>| {
                            let path = req.uri().path().to_string();
                            match resolve_endpoint(&path, endpoints_capture.as_deref()) {
                                Ok(p) => { *path_cell_accept.lock().unwrap() = Some(p); Ok(resp) }
                                Err(()) => Err(tokio_tungstenite::tungstenite::http::Response::builder()
                                    .status(404)
                                    .body(Some(format!("no endpoint: {}", path)))
                                    .unwrap()),
                            }
                        }).await {
                            Ok(s) => s,
                            Err(e) => {
                                eprintln!("ws server handshake error: {} for {}", e, remote_addr);
                                continue;
                            }
                        };
                        let endpoint = path_cell.lock().unwrap().take().unwrap_or_else(|| "/".to_string());

                        let client_id = match db::create_client(&db, &session_id, Some(&remote_addr), None, Some(&endpoint)).await {
                            Ok(c) => c.id,
                            Err(e) => {
                                eprintln!("create_client error: {}", e);
                                continue;
                            }
                        };

                        let (client_outbound_tx, client_outbound_rx) = mpsc::channel::<ClientMessage>(64);
                        let (client_shutdown_tx, client_shutdown_rx) = mpsc::channel::<()>(1);
                        let client_handle = ClientHandle {
                            outbound_tx: client_outbound_tx,
                            shutdown_tx: client_shutdown_tx,
                            endpoint: endpoint.clone(),
                        };

                        {
                            let mut clients = handle.clients.write().await;
                            clients.insert(client_id.clone(), client_handle);
                        }

                        // Notify UI.
                        let _ = app.emit(
                            "session:client_connected",
                            serde_json::json!({
                                "session_id": &session_id,
                                "client_id": &client_id,
                                "remote_addr": &remote_addr,
                                "endpoint": &endpoint,
                            }),
                        );
                        persist_notice(&db, &handle, &session_id, format!("客户端【{}】已连接", remote_addr)).await;

                        let app_clone = app.clone();
                        let db_clone = db.clone();
                        let session_id_clone = session_id.clone();
                        let handle_clone = handle.clone();
                        let client_id_clone = client_id.clone();
                        let remote_addr_clone = remote_addr.clone();

                        // Spawn per-client task.
                        tauri::async_runtime::spawn(async move {
                            run_client_socket_loop(
                                app_clone,
                                db_clone,
                                session_id_clone,
                                client_id_clone,
                                ws_stream,
                                handle_clone,
                                client_outbound_rx,
                                client_shutdown_rx,
                                remote_addr_clone,
                                endpoint,
                            )
                            .await;
                        });
                    }
                    Err(e) => {
                        eprintln!("ws server accept error: {}", e);
                        break;
                    }
                }
            }
            out = outbound_rx.recv() => {
                // Broadcast to all connected clients (or to a single endpoint when
                // the OutgoingMessage carries Some(path)). Persist exactly once for
                // the logical broadcast action (client_id = None means "sent to all"),
                // regardless of how many clients are currently connected.
                let (msg_endpoint, payload_type, payload_bytes, client_msg) = match out {
                    Some(OutgoingMessage { endpoint: Some(ep), kind: OutgoingKind::Text(t) }) => (Some(ep), "text", t.clone().into_bytes(), ClientMessage::Text(t)),
                    Some(OutgoingMessage { endpoint: Some(ep), kind: OutgoingKind::Binary(b) }) => (Some(ep), "binary", b.clone(), ClientMessage::Binary(b)),
                    Some(OutgoingMessage { endpoint: None, kind: OutgoingKind::Text(t) }) => (None, "text", t.clone().into_bytes(), ClientMessage::Text(t)),
                    Some(OutgoingMessage { endpoint: None, kind: OutgoingKind::Binary(b) }) => (None, "binary", b.clone(), ClientMessage::Binary(b)),
                    None => break,
                };
                persist_out_message(&db, &session_id, None, payload_type, payload_bytes, msg_endpoint.as_deref(), &handle).await;

                let clients = handle.clients.read().await;
                for c in clients.values() {
                    if let Some(ep) = &msg_endpoint {
                        if &c.endpoint != ep { continue; }
                    }
                    let _ = c.outbound_tx.send(match &client_msg {
                        ClientMessage::Text(t) => ClientMessage::Text(t.clone()),
                        ClientMessage::Binary(b) => ClientMessage::Binary(b.clone()),
                    }).await;
                }
            }
            _ = shutdown_rx.recv() => {
                // 服务端停止，通知所有已连接的客户端任务退出
                let clients = handle.clients.read().await;
                for client in clients.values() {
                    let _ = client.shutdown_tx.send(()).await;
                }
                break;
            }
        }
    }

    persist_notice(&db, &handle, &session_id, format!("服务端【{}】已断开", local_addr.as_deref().unwrap_or(":?"))).await;
    set_closed(&app, &db, &session_id, local_addr.as_deref(), None).await;
    // 任务退出，从 state.sessions 里移除自己
    let state = app.state::<crate::state::AppState>();
    let mut sessions = state.sessions.write().await;
    sessions.remove(&session_id);
}

async fn run_client_socket_loop<S>(
    app: AppHandle,
    db: db::DbConnection,
    session_id: String,
    client_id: String,
    ws_stream: tokio_tungstenite::WebSocketStream<S>,
    handle: Arc<SessionHandle>,
    mut outbound_rx: mpsc::Receiver<ClientMessage>,
    mut client_shutdown_rx: mpsc::Receiver<()>,
    remote_addr: String,
    endpoint: String,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut write, mut read) = ws_stream.split();
    let remote_addr_ref = remote_addr.as_str();

    loop {
        tokio::select! {
            msg = read.next() => {
                match msg {
                    Some(Ok(WsMessage::Text(text))) => {
                        persist_in_message(&db, &session_id, Some(&client_id), "text", text.as_bytes().to_vec(), Some(&endpoint), Some(remote_addr_ref), &handle).await;
                    }
                    Some(Ok(WsMessage::Binary(bin))) => {
                        persist_in_message(&db, &session_id, Some(&client_id), "binary", bin.to_vec(), Some(&endpoint), Some(remote_addr_ref), &handle).await;
                    }
                    Some(Ok(WsMessage::Close(_))) | None => {
                        break;
                    }
                    Some(Ok(_)) => {
                        // Ping/Pong ignored.
                    }
                    Some(Err(e)) => {
                        eprintln!("ws read error: {}", e);
                        break;
                    }
                }
            }
            out = outbound_rx.recv() => {
                // Persistence for this client's message happens at the point the
                // send was initiated (commands::send_message for a targeted send,
                // or the broadcast arm above for "send to all") — this loop only
                // writes to the socket, so a broadcast doesn't get persisted once
                // per connected client.
                let result = match out {
                    Some(ClientMessage::Text(text)) => {
                        write.send(WsMessage::Text(text.into())).await
                    }
                    Some(ClientMessage::Binary(bin)) => {
                        write.send(WsMessage::Binary(bin.into())).await
                    }
                    None => break,
                };
                if let Err(e) = result {
                    eprintln!("ws write error: {}", e);
                    break;
                }
            }
            _ = client_shutdown_rx.recv() => {
                // Server requested to disconnect this client.
                break;
            }
        }
    }

    // Cleanup client resources.
    cleanup_client(&app, &db, &session_id, &client_id, &remote_addr, &handle).await;
}

async fn cleanup_client(
    app: &AppHandle,
    db: &db::DbConnection,
    session_id: &str,
    client_id: &str,
    remote_addr: &str,
    handle: &Arc<SessionHandle>,
) {
    // Remove from session's client map.
    {
        let mut clients = handle.clients.write().await;
        clients.remove(client_id);
    }
    // Delete from DB.
    let _ = db::delete_client(db, client_id).await;
    // Notify UI.
    let _ = app.emit(
        "session:client_disconnected",
        serde_json::json!({
            "session_id": session_id,
            "client_id": client_id,
        }),
    );
    persist_notice(db, handle, session_id, format!("客户端【{}】已断开连接", remote_addr)).await;
}

pub async fn run_ws_client(
    app: AppHandle,
    db: db::DbConnection,
    session_id: String,
    config: WsConfig,
    handle: Arc<SessionHandle>,
    outbound_rx: mpsc::Receiver<OutgoingMessage>,
    shutdown_rx: mpsc::Receiver<()>,
) {
    let base_url = match config.target_url {
        Some(u) => u,
        None => {
            emit_error(&app, &session_id, "未配置目标地址，无法启动客户端");
            emit_status(&app, &session_id, "error", None, None);
            remove_session_handle(&app, &session_id).await;
            return;
        }
    };

    // 客户端配置了 endpoint 时，把第一个路径拼到目标地址后（如 ws://host:port/echo）。
    let endpoint = config.endpoints.as_ref().and_then(|eps| eps.first()).cloned();
    let url = match &endpoint {
        Some(path) => {
            let trimmed = base_url.trim_end_matches('/');
            format!("{}{}", trimmed, path)
        }
        None => base_url,
    };

    db::update_session_status(&db, &session_id, "starting", None, None)
        .await
        .ok();
    emit_status(&app, &session_id, "starting", None, None);

    let (ws_stream, _response) = match connect_async(&url).await {
        Ok(x) => x,
        Err(e) => {
            eprintln!("ws client connect error: {}", e);
            emit_error(&app, &session_id, &format!("连接 {} 失败：{}", url, friendly_connect_error(&e)));
            set_closed(&app, &db, &session_id, None, None).await;
            remove_session_handle(&app, &session_id).await;
            return;
        }
    };

    let remote_addr = url.clone();
    let local_addr: Option<String> = None;

    db::update_session_status(
        &db,
        &session_id,
        "running",
        None,
        Some(&remote_addr),
    )
    .await
    .ok();
    emit_status(
        &app,
        &session_id,
        "running",
        None,
        Some(remote_addr.clone()),
    );
    persist_notice(&db, &handle, &session_id, format!("与服务端【{}】的连接已成功建立", display_addr(&remote_addr))).await;

    run_socket_loop(
        app,
        db,
        session_id,
        ws_stream,
        handle,
        outbound_rx,
        shutdown_rx,
        local_addr,
        remote_addr,
        endpoint,
    )
    .await;
}

async fn run_socket_loop<S>(
    app: AppHandle,
    db: db::DbConnection,
    session_id: String,
    ws_stream: tokio_tungstenite::WebSocketStream<S>,
    handle: Arc<SessionHandle>,
    mut outbound_rx: mpsc::Receiver<OutgoingMessage>,
    mut shutdown_rx: mpsc::Receiver<()>,
    local_addr: Option<String>,
    remote_addr: String,
    endpoint: Option<String>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut write, mut read) = ws_stream.split();
    let endpoint_ref = endpoint.as_deref();

    loop {
        tokio::select! {
            msg = read.next() => {
                match msg {
                    Some(Ok(WsMessage::Text(text))) => {
                        persist_in_message(&db, &session_id, None, "text", text.as_bytes().to_vec(), endpoint_ref, None, &handle).await;
                    }
                    Some(Ok(WsMessage::Binary(bin))) => {
                        persist_in_message(&db, &session_id, None, "binary", bin.to_vec(), endpoint_ref, None, &handle).await;
                    }
                    Some(Ok(WsMessage::Close(_))) | None => {
                        break;
                    }
                    Some(Ok(_)) => {
                        // Ping/Pong ignored.
                    }
                    Some(Err(e)) => {
                        eprintln!("ws read error: {}", e);
                        break;
                    }
                }
            }
            out = outbound_rx.recv() => {
                let result = match out {
                    Some(OutgoingMessage { endpoint: _, kind: OutgoingKind::Text(text) }) => {
                        persist_out_message(&db, &session_id, None, "text", text.clone().into_bytes(), endpoint_ref, &handle).await;
                        write.send(WsMessage::Text(text.into())).await
                    }
                    Some(OutgoingMessage { endpoint: _, kind: OutgoingKind::Binary(bin) }) => {
                        persist_out_message(&db, &session_id, None, "binary", bin.clone(), endpoint_ref, &handle).await;
                        write.send(WsMessage::Binary(bin.into())).await
                    }
                    None => break,
                };
                if let Err(e) = result {
                    eprintln!("ws write error: {}", e);
                    break;
                }
            }
            _ = shutdown_rx.recv() => {
                let _ = write.send(WsMessage::Close(None)).await;
                break;
            }
        }
    }

    persist_notice(&db, &handle, &session_id, format!("与服务端【{}】的连接已断开", display_addr(&remote_addr))).await;
    set_closed(&app, &db, &session_id, local_addr.as_deref(), Some(&remote_addr)).await;
    // 任务退出，从 state.sessions 里移除自己
    let state = app.state::<crate::state::AppState>();
    let mut sessions = state.sessions.write().await;
    sessions.remove(&session_id);
}

async fn persist_in_message(
    db: &db::DbConnection,
    session_id: &str,
    client_id: Option<&str>,
    payload_type: &str,
    payload: Vec<u8>,
    endpoint: Option<&str>,
    sender: Option<&str>,
    handle: &Arc<SessionHandle>,
) {
    let size = payload.len();
    let msg = db::Message {
        id: Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        client_id: client_id.map(|s| s.to_string()),
        direction: "in".to_string(),
        payload_type: payload_type.to_string(),
        payload: payload.clone(),
        size,
        timestamp: chrono::Utc::now().timestamp_millis(),
        endpoint: endpoint.map(|s| s.to_string()),
        sender: sender.map(|s| s.to_string()),
    };
    db::insert_message(db, &msg).await.ok();
    let event = TimelineEvent::Message {
        id: msg.id.clone(),
        session_id: msg.session_id.clone(),
        client_id: msg.client_id.clone(),
        direction: msg.direction.clone(),
        payload_type: msg.payload_type.clone(),
        endpoint: endpoint.map(|s| s.to_string()),
        sender: sender.map(|s| s.to_string()),
        payload: payload.clone(),
        size: msg.size,
        timestamp: msg.timestamp,
    };
    send_timeline_event(handle, event.clone()).await;
    let _ = handle.app.emit("session:message", event);
}

pub(crate) async fn persist_out_message(
    db: &db::DbConnection,
    session_id: &str,
    client_id: Option<&str>,
    payload_type: &str,
    payload: Vec<u8>,
    endpoint: Option<&str>,
    handle: &Arc<SessionHandle>,
) {
    let size = payload.len();
    let msg = db::Message {
        id: Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        client_id: client_id.map(|s| s.to_string()),
        direction: "out".to_string(),
        payload_type: payload_type.to_string(),
        payload: payload.clone(),
        size,
        timestamp: chrono::Utc::now().timestamp_millis(),
        endpoint: endpoint.map(|s| s.to_string()),
        sender: None,
    };
    db::insert_message(db, &msg).await.ok();
    let event = TimelineEvent::Message {
        id: msg.id.clone(),
        session_id: msg.session_id.clone(),
        client_id: msg.client_id.clone(),
        direction: msg.direction.clone(),
        payload_type: msg.payload_type.clone(),
        endpoint: endpoint.map(|s| s.to_string()),
        sender: None,
        payload: payload.clone(),
        size: msg.size,
        timestamp: msg.timestamp,
    };
    send_timeline_event(handle, event.clone()).await;
    let _ = handle.app.emit("session:message", event);
}

async fn send_timeline_event(handle: &Arc<SessionHandle>, event: TimelineEvent) {
    let session_id = match &event {
        TimelineEvent::Message { session_id, .. }
        | TimelineEvent::Notice { session_id, .. }
        | TimelineEvent::Status { session_id, .. } => session_id,
    };
    let state = handle.app.state::<crate::state::AppState>();
    let channels = state.timeline_channels.lock().await;
    if let Some(ch) = channels.get(session_id) {
        let _ = ch.send(event);
    }
}

/// 连接状态提示：持久化为 payload_type='notice' 的消息（历史可见），同时实时推送到时间线。
async fn persist_notice(
    db: &db::DbConnection,
    handle: &Arc<SessionHandle>,
    session_id: &str,
    text: String,
) {
    let timestamp = chrono::Utc::now().timestamp_millis();
    let msg = db::Message {
        id: Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        client_id: None,
        direction: "in".to_string(),
        payload_type: "notice".to_string(),
        payload: text.clone().into_bytes(),
        size: text.len(),
        timestamp,
        endpoint: None,
        sender: None,
    };
    if let Err(e) = db::insert_message(db, &msg).await {
        eprintln!("insert notice error: {}", e);
    }
    send_timeline_event(handle, TimelineEvent::Notice {
        session_id: session_id.to_string(),
        text,
        timestamp,
    })
    .await;
}

/// 客户端展示的地址：去掉 ws:// / wss:// 前缀，只保留 host:port（可能带路径）。
fn display_addr(url: &str) -> &str {
    url.strip_prefix("ws://")
        .or_else(|| url.strip_prefix("wss://"))
        .unwrap_or(url)
}

async fn set_closed(
    app: &AppHandle,
    db: &db::DbConnection,
    session_id: &str,
    local_addr: Option<&str>,
    remote_addr: Option<&str>,
) {
    // Clean up all clients for this session in DB.
    let _ = db::delete_clients_by_session(db, session_id).await;
    db::update_session_status(db, session_id, "closed", local_addr, remote_addr)
        .await
        .ok();
    emit_status(app, session_id, "closed", local_addr.map(|s| s.to_string()), remote_addr.map(|s| s.to_string()));
}

fn emit_status(
    app: &AppHandle,
    session_id: &str,
    status: &str,
    local_addr: Option<String>,
    remote_addr: Option<String>,
) {
    let _ = app.emit(
        "session:status",
        &TimelineEvent::Status {
            session_id: session_id.to_string(),
            status: status.to_string(),
            local_addr,
            remote_addr,
        },
    );
}

fn emit_error(app: &AppHandle, session_id: &str, message: &str) {
    let _ = app.emit(
        "session:error",
        serde_json::json!({
            "session_id": session_id,
            "message": message,
        }),
    );
}

/// 任务提前退出（启动失败等）时，从 state.sessions 移除自己的 handle，
/// 否则该会话会被认为仍在运行，无法再次启动。
async fn remove_session_handle(app: &AppHandle, session_id: &str) {
    let state = app.state::<crate::state::AppState>();
    let mut sessions = state.sessions.write().await;
    sessions.remove(session_id);
}

/// 把常见的连接错误转成更友好的中文提示（补充端口被占用/拒绝/超时的可能原因）。
fn friendly_connect_error(e: &tokio_tungstenite::tungstenite::Error) -> String {    let msg = e.to_string();
    let lower = msg.to_lowercase();
    if lower.contains("refused") {
        return format!("{}（可能原因：服务端未启动或端口错误）", msg);
    }
    if lower.contains("timed out") {
        return format!("{}（可能原因：目标不可达或防火墙拦截）", msg);
    }
    if lower.contains("404") || lower.contains("no endpoint") {
        return "服务端拒绝了该路径（endpoint 未配置或不存在）".to_string();
    }
    msg
}

#[cfg(test)]
mod tests {
    use super::resolve_endpoint;

    #[test]
    fn accepts_all_when_none_configured() {
        assert_eq!(resolve_endpoint("/echo", None).unwrap(), "/echo");
    }

    #[test]
    fn accepts_configured_path() {
        let eps = vec!["/echo".to_string(), "/chat".to_string()];
        assert_eq!(resolve_endpoint("/chat", Some(&eps)).unwrap(), "/chat");
    }

    #[test]
    fn rejects_unknown_path() {
        let eps = vec!["/echo".to_string()];
        assert!(resolve_endpoint("/nope", Some(&eps)).is_err());
    }

    #[test]
    fn root_path_matches_root() {
        let eps = vec!["/".to_string()];
        assert_eq!(resolve_endpoint("/", Some(&eps)).unwrap(), "/");
    }
}
