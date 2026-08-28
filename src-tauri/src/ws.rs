use crate::db;
use crate::state::{ClientHandle, ClientMessage, OutgoingKind, OutgoingMessage, SessionHandle, TimelineEvent, WsConfig};
use futures_util::{SinkExt, StreamExt};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::{accept_hdr_async, connect_async, tungstenite::protocol::Message as WsMessage};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue};
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
    mut shutdown_rx: tokio::sync::watch::Receiver<bool>,
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
                // Ping 控制帧：广播给所有已连客户端（不持久化为普通消息）
                if matches!(&out, Some(OutgoingMessage { kind: OutgoingKind::Ping, .. })) {
                    let n = handle.clients.read().await.len();
                    persist_notice(&db, &handle, &session_id, format!("→ Ping（广播 {} 个客户端）", n)).await;
                    let clients = handle.clients.read().await;
                    for c in clients.values() {
                        let _ = c.outbound_tx.send(ClientMessage::Ping).await;
                    }
                    continue;
                }
                let (msg_endpoint, payload_type, payload_bytes, client_msg) = match out {
                    Some(OutgoingMessage { endpoint: Some(ep), kind: OutgoingKind::Text(t) }) => (Some(ep), "text", t.clone().into_bytes(), ClientMessage::Text(t)),
                    Some(OutgoingMessage { endpoint: Some(ep), kind: OutgoingKind::Binary(b) }) => (Some(ep), "binary", b.clone(), ClientMessage::Binary(b)),
                    Some(OutgoingMessage { endpoint: None, kind: OutgoingKind::Text(t) }) => (None, "text", t.clone().into_bytes(), ClientMessage::Text(t)),
                    Some(OutgoingMessage { endpoint: None, kind: OutgoingKind::Binary(b) }) => (None, "binary", b.clone(), ClientMessage::Binary(b)),
                    Some(OutgoingMessage { kind: OutgoingKind::Ping, .. }) => unreachable!("ping handled above"),
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
                        ClientMessage::Ping => ClientMessage::Ping,
                    }).await;
                }
            }
            _ = shutdown_rx.changed() => {
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
    let (write_half, mut read) = ws_stream.split();
    let write = Arc::new(tokio::sync::Mutex::new(write_half));
    let remote_addr_ref = remote_addr.as_str();

    loop {
        tokio::select! {
            msg = read.next() => {
                match msg {
                    Some(Ok(WsMessage::Text(text))) => {
                        persist_in_message(&db, &session_id, Some(&client_id), "text", text.as_bytes().to_vec(), Some(&endpoint), Some(remote_addr_ref), &handle).await;
                        // 自动回复：动态读取最新规则，命中首条即回复；spawn 独立任务避免阻塞接收
                        let compiled: Vec<(crate::db::AutoReplyRule, Option<regex::Regex>)> = {
                            let guard = handle.auto_replies.lock().await;
                            guard.clone().unwrap_or_default().into_iter().filter(|r| r.enabled).map(|r| {
                                let re = if r.match_type == "regex" { regex::Regex::new(&r.pattern).ok() } else { None };
                                (r, re)
                            }).collect()
                        };
                        if !compiled.is_empty() {
                            if let Some((reply_bytes, is_text, delay_ms)) = match_auto_reply(&text, &compiled) {
                                let db_c = db.clone();
                                let handle_c = handle.clone();
                                let session_id_c = session_id.clone();
                                let client_id_c = client_id.clone();
                                let endpoint_c = endpoint.clone();
                                let remote_addr_c = remote_addr.clone();
                                let write_c = write.clone();
                                tauri::async_runtime::spawn(async move {
                                    if delay_ms > 0 { tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await; }
                                    let ts = chrono::Utc::now().timestamp_millis();
                                    persist_auto_reply_pair(&db_c, &handle_c, &session_id_c, &client_id_c, &endpoint_c, &remote_addr_c, reply_bytes.clone(), is_text, ts).await;
                                    let mut w = write_c.lock().await;
                                    let _ = if is_text {
                                        w.send(WsMessage::Text(String::from_utf8_lossy(&reply_bytes).into_owned().into())).await
                                    } else {
                                        w.send(WsMessage::Binary(reply_bytes.into())).await
                                    };
                                });
                            }
                        }
                    }
                    Some(Ok(WsMessage::Binary(bin))) => {
                        persist_in_message(&db, &session_id, Some(&client_id), "binary", bin.to_vec(), Some(&endpoint), Some(remote_addr_ref), &handle).await;
                        let compiled: Vec<(crate::db::AutoReplyRule, Option<regex::Regex>)> = {
                            let guard = handle.auto_replies.lock().await;
                            guard.clone().unwrap_or_default().into_iter().filter(|r| r.enabled).map(|r| {
                                let re = if r.match_type == "regex" { regex::Regex::new(&r.pattern).ok() } else { None };
                                (r, re)
                            }).collect()
                        };
                        if !compiled.is_empty() {
                            let txt = String::from_utf8_lossy(&bin).into_owned();
                            if let Some((reply_bytes, is_text, delay_ms)) = match_auto_reply(&txt, &compiled) {
                                let db_c = db.clone();
                                let handle_c = handle.clone();
                                let session_id_c = session_id.clone();
                                let client_id_c = client_id.clone();
                                let endpoint_c = endpoint.clone();
                                let remote_addr_c = remote_addr.clone();
                                let write_c = write.clone();
                                tauri::async_runtime::spawn(async move {
                                    if delay_ms > 0 { tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await; }
                                    let ts = chrono::Utc::now().timestamp_millis();
                                    persist_auto_reply_pair(&db_c, &handle_c, &session_id_c, &client_id_c, &endpoint_c, &remote_addr_c, reply_bytes.clone(), is_text, ts).await;
                                    let mut w = write_c.lock().await;
                                    let _ = if is_text {
                                        w.send(WsMessage::Text(String::from_utf8_lossy(&reply_bytes).into_owned().into())).await
                                    } else {
                                        w.send(WsMessage::Binary(reply_bytes.into())).await
                                    };
                                });
                            }
                        }
                    }
                    Some(Ok(WsMessage::Pong(_))) => {
                        // 客户端响应了服务端的 Ping：记录时间；手动 Ping 时在时间线展示往返延迟
                        let now = chrono::Utc::now().timestamp_millis();
                        *handle.last_pong_at.lock().await = Some(now);
                        let was_manual = { let p = *handle.manual_ping_pending.lock().await; p };
                        if was_manual {
                            if let Some(ping_at) = *handle.last_ping_at.lock().await {
                                persist_notice(&db, &handle, &session_id, format!("← Pong【{}】（{} ms）", remote_addr_ref, (now - ping_at).max(0))).await;
                            }
                            *handle.manual_ping_pending.lock().await = false;
                        }
                    }
                    Some(Ok(WsMessage::Close(_))) | None => {
                        break;
                    }
                    Some(Ok(_)) => {
                        // 对端发来的 Ping 由库自动回 Pong。
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
                let result = {
                    let mut w = write.lock().await;
                    match out {
                        Some(ClientMessage::Text(text)) => {
                            w.send(WsMessage::Text(text.into())).await
                        }
                        Some(ClientMessage::Binary(bin)) => {
                            w.send(WsMessage::Binary(bin.into())).await
                        }
                        Some(ClientMessage::Ping) => {
                            w.send(WsMessage::Ping(Vec::new().into())).await
                        }
                        None => break,
                    }
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
    mut shutdown_rx: tokio::sync::watch::Receiver<bool>,
) {
    let base_url = match config.target_url {
        Some(ref u) => u.clone(),
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
        None => base_url.clone(),
    };

    let reconnect = config.auto_reconnect.unwrap_or(0);
    let mut outbound_rx = outbound_rx;
    let mut attempt = 1u32;

    loop {
        let outcome = run_ws_client_attempt(
            &app,
            &db,
            &session_id,
            &config,
            &url,
            endpoint.clone(),
            config.heartbeat_interval.filter(|v| *v > 0),
            &handle,
            outbound_rx,
            shutdown_rx.clone(),
        )
        .await;

        // 手动停止，或未配置自动重连：彻底关闭并退出
        if matches!(outcome, AttemptOutcome::ManualStop) || reconnect <= 0 {
            set_closed(&app, &db, &session_id, None, Some(&url)).await;
            remove_session_handle(&app, &session_id).await;
            return;
        }

        // 连接已成功建立过则清零重连次数（从第 1 次重新计）
        if matches!(outcome, AttemptOutcome::Connected) {
            attempt = 1;
        }

        // 自动重连：等待间隔后重试
        let interval = reconnect as u64;
        persist_notice(&db, &handle, &session_id, format!("与服务端【{}】的连接已断开，{} 秒后自动重连（第 {} 次）", display_addr(&url), interval, attempt)).await;
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_secs(interval)) => {}
            _ = shutdown_rx.changed() => {
                set_closed(&app, &db, &session_id, None, Some(&url)).await;
                remove_session_handle(&app, &session_id).await;
                return;
            }
        }
        attempt += 1;

        // 重建 outbound channel 并更新 SessionHandle（自动重连后旧的 receiver 已失效）
        let (outbound_tx, new_outbound_rx) = tokio::sync::mpsc::channel::<OutgoingMessage>(256);
        {
            let state = app.state::<crate::state::AppState>();
            let sessions = state.sessions.read().await;
            if let Some(h) = sessions.get(&session_id) {
                *h.outbound_tx.lock().await = outbound_tx;
            }
        }
        outbound_rx = new_outbound_rx;
    }
}

#[derive(PartialEq)]
enum AttemptOutcome {
    /// 手动停止：不再重连
    ManualStop,
    /// 连接曾成功建立，之后断开：重连次数清零
    Connected,
    /// 从未连上（连接失败）：保留累计重连次数
    ConnectFailed,
}

/// 单次客户端连接尝试：连接成功则进入 socket loop，直至断开。
async fn run_ws_client_attempt(
    app: &AppHandle,
    db: &db::DbConnection,
    session_id: &str,
    config: &WsConfig,
    url: &str,
    endpoint: Option<String>,
    heartbeat_interval: Option<i64>,
    handle: &Arc<SessionHandle>,
    outbound_rx: mpsc::Receiver<OutgoingMessage>,
    shutdown_rx: tokio::sync::watch::Receiver<bool>,
) -> AttemptOutcome {
    db::update_session_status(db, session_id, "starting", None, None)
        .await
        .ok();
    emit_status(app, session_id, "starting", None, None);

    let mut request = match url.into_client_request() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("ws client build request error: {}", e);
            emit_error(app, session_id, &format!("构建连接请求失败：{}", e));
            return AttemptOutcome::ConnectFailed;
        }
    };
    let headers = request.headers_mut();
    for (k, v) in config.headers.as_ref().into_iter().flatten() {
        if let (Ok(name), Ok(val)) = (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(v)) {
            headers.append(name, val);
        }
    }
    if let Some(protos) = &config.subprotocols {
        if !protos.is_empty() {
            if let Ok(val) = HeaderValue::from_str(&protos.join(", ")) {
                headers.append(HeaderName::from_static("sec-websocket-protocol"), val);
            }
        }
    }
    let (ws_stream, _response) = match connect_async(request).await {
        Ok(x) => x,
        Err(e) => {
            eprintln!("ws client connect error: {}", e);
            emit_error(app, session_id, &format!("连接 {} 失败：{}", url, friendly_connect_error(&e)));
            return AttemptOutcome::ConnectFailed;
        }
    };

    let remote_addr = url.to_string();

    db::update_session_status(db, session_id, "running", None, Some(&remote_addr))
        .await
        .ok();
    emit_status(app, session_id, "running", None, Some(remote_addr.clone()));
    persist_notice(db, handle, session_id, format!("与服务端【{}】的连接已成功建立", display_addr(&remote_addr))).await;

    let manual_stop = run_socket_loop(
        app.clone(),
        db.clone(),
        session_id.to_string(),
        ws_stream,
        handle.clone(),
        heartbeat_interval,
        outbound_rx,
        shutdown_rx,
        remote_addr,
        endpoint,
    )
    .await;

    if manual_stop {
        AttemptOutcome::ManualStop
    } else {
        AttemptOutcome::Connected
    }
}

async fn run_socket_loop<S>(
    _app: AppHandle,
    db: db::DbConnection,
    session_id: String,
    ws_stream: tokio_tungstenite::WebSocketStream<S>,
    handle: Arc<SessionHandle>,
    heartbeat_interval: Option<i64>,
    mut outbound_rx: mpsc::Receiver<OutgoingMessage>,
    mut shutdown_rx: tokio::sync::watch::Receiver<bool>,
    remote_addr: String,
    endpoint: Option<String>,
) -> bool
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut write, mut read) = ws_stream.split();
    let endpoint_ref = endpoint.as_deref();
    let mut manually_stopped = false;

    // 心跳：自动 Ping 定时器 + 超时检测（超时阈值 10 秒）
    const HEARTBEAT_TIMEOUT_MS: i64 = 10_000;
    let mut hb_tick = match heartbeat_interval {
        Some(secs) => {
            let mut i = tokio::time::interval(std::time::Duration::from_secs(secs as u64));
            i.tick().await; // 第一次 tick 立即返回，跳过
            Some(i)
        }
        None => None,
    };
    let mut manual_ping_pending = false;
    let mut timeout_reported = false;

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
                    Some(Ok(WsMessage::Pong(_))) => {
                        // 对端响应了我们的 Ping：记录时间；手动 Ping 时在时间线展示往返延迟
                        let now = chrono::Utc::now().timestamp_millis();
                        *handle.last_pong_at.lock().await = Some(now);
                        timeout_reported = false;
                        if manual_ping_pending {
                            manual_ping_pending = false;
                            if let Some(ping_at) = *handle.last_ping_at.lock().await {
                                persist_notice(&db, &handle, &session_id, format!("← Pong（{} ms）", (now - ping_at).max(0))).await;
                            }
                        }
                    }
                    Some(Ok(WsMessage::Close(_))) | None => {
                        break;
                    }
                    Some(Ok(_)) => {
                        // 对端发来的 Ping 由库自动回 Pong。
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
                    Some(OutgoingMessage { kind: OutgoingKind::Ping, .. }) => {
                        // 手动 Ping：时间线提示，等待 Pong 展示延迟
                        *handle.last_ping_at.lock().await = Some(chrono::Utc::now().timestamp_millis());
                        manual_ping_pending = true;
                        persist_notice(&db, &handle, &session_id, "→ Ping".to_string()).await;
                        write.send(WsMessage::Ping(Vec::new().into())).await
                    }
                    None => break,
                };
                if let Err(e) = result {
                    eprintln!("ws write error: {}", e);
                    break;
                }
            }
            _ = async { match hb_tick.as_mut() { Some(t) => { t.tick().await; }, None => std::future::pending::<()>().await } }, if hb_tick.is_some() => {
                // 自动心跳：检查上次 Ping 是否超时未回，然后发下一个 Ping
                let now = chrono::Utc::now().timestamp_millis();
                let last_ping = *handle.last_ping_at.lock().await;
                let last_pong = *handle.last_pong_at.lock().await;
                let unanswered = matches!(last_ping, Some(lp) if now - lp > HEARTBEAT_TIMEOUT_MS && last_pong.map_or(true, |lo| lo < lp));
                if unanswered && !timeout_reported {
                    timeout_reported = true;
                    persist_notice(&db, &handle, &session_id, "心跳超时，连接可能已断开".to_string()).await;
                }
                // 发起新一轮 Ping；timeout_reported 保持为 true 直到收到 Pong 才复位，
                // 避免持续无响应时每个周期重复提示。
                *handle.last_ping_at.lock().await = Some(now);
                if let Err(e) = write.send(WsMessage::Ping(Vec::new().into())).await {
                    eprintln!("ws heartbeat ping error: {}", e);
                    break;
                }
            }
            _ = shutdown_rx.changed() => {
                let _ = write.send(WsMessage::Close(None)).await;
                manually_stopped = true;
                break;
            }
        }
    }

    persist_notice(&db, &handle, &session_id, format!("与服务端【{}】的连接已断开", display_addr(&remote_addr))).await;
    manually_stopped
}

/// 将消息追加写入磁盘日志（仅当会话开启 log_to_disk 时）。
/// 文件：<log_dir 或 app_local_data_dir/logs>/<会话名>_<YYYY-MM-DD>.log
async fn append_disk_log(handle: &Arc<SessionHandle>, msg: &db::Message) {
    if !*handle.log_to_disk.lock().await {
        return;
    }
    let ts = msg.timestamp;
    let time = chrono::DateTime::from_timestamp_millis(ts)
        .map(|d| d.format("%Y-%m-%d %H:%M:%S%.3f").to_string())
        .unwrap_or_default();
    let date = chrono::DateTime::from_timestamp_millis(ts)
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_default();
    let file_name = format!("{}_{}.log", handle.log_file_base, date);

    // 全局日志目录（设置-通用），空时回退 app_local_data_dir/logs
    let dir = tauri_plugin_store::StoreExt::store(&handle.app, "store.bin")
        .ok()
        .and_then(|s| s.get("log-dir").and_then(|v| v.as_str().map(String::from)))
        .filter(|d| !d.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| handle.app.path().app_local_data_dir().map(|p| p.join("logs")).unwrap_or_default());
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join(&file_name);

    let arrow = if msg.direction == "in" { "← 收" } else { "→ 发" };
    let ep = msg.endpoint.as_deref().unwrap_or("-");
    let sender = msg.sender.as_deref().unwrap_or("");
    let sender_part = if sender.is_empty() { String::new() } else { format!(" [{}]", sender) };
    let body = if msg.payload_type == "binary" {
        hex_encode(&msg.payload)
    } else {
        String::from_utf8_lossy(&msg.payload).into_owned()
    };
    let line = format!(
        "[{}] {} {} ep={}{} size={}\n{}\n\n",
        time, arrow, msg.payload_type, ep, sender_part, msg.size, body
    );

    use tokio::io::AsyncWriteExt;
    let mut file = match tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .await
    {
        Ok(f) => f,
        Err(e) => { eprintln!("disk log open error: {}", e); return; }
    };
    if let Err(e) = file.write_all(line.as_bytes()).await {
        eprintln!("disk log write error: {}", e);
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect::<Vec<_>>().join(" ")
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
        pinned: 0,
    };
    db::insert_message(db, &msg).await.ok();
    append_disk_log(handle, &msg).await;
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
        pinned: 0,
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
        pinned: 0,
    };
    db::insert_message(db, &msg).await.ok();
    append_disk_log(handle, &msg).await;
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
        pinned: 0,
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
        pinned: 0,
    };
    if let Err(e) = db::insert_message(db, &msg).await {
        eprintln!("insert notice error: {}", e);
    }
    append_disk_log(handle, &msg).await;
    send_timeline_event(handle, TimelineEvent::Notice {
        session_id: session_id.to_string(),
        text,
        timestamp,
    })
    .await;
}

async fn persist_auto_reply_pair(
    db: &db::DbConnection,
    handle: &Arc<SessionHandle>,
    session_id: &str,
    client_id: &str,
    endpoint: &str,
    remote_addr: &str,
    reply_bytes: Vec<u8>,
    is_text: bool,
    ts: i64,
) {
    // 提示与气泡共用同一时间戳，以气泡时间为准
    let notice_text = format!("↻ 自动回复【{}】", remote_addr);
    let notice_msg = db::Message {
        id: Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        client_id: None,
        direction: "in".to_string(),
        payload_type: "notice".to_string(),
        payload: notice_text.clone().into_bytes(),
        size: notice_text.len(),
        timestamp: ts,
        endpoint: None,
        sender: None,
        pinned: 0,
    };
    let _ = db::insert_message(db, &notice_msg).await;
    append_disk_log(handle, &notice_msg).await;
    send_timeline_event(handle, TimelineEvent::Notice {
        session_id: session_id.to_string(),
        text: notice_text,
        timestamp: ts,
    })
    .await;

    let ptype = if is_text { "text" } else { "binary" };
    let size = reply_bytes.len();
    let out_msg = db::Message {
        id: Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        client_id: Some(client_id.to_string()),
        direction: "out".to_string(),
        payload_type: ptype.to_string(),
        payload: reply_bytes.clone(),
        size,
        timestamp: ts,
        endpoint: Some(endpoint.to_string()),
        sender: None,
        pinned: 0,
    };
    let _ = db::insert_message(db, &out_msg).await;
    append_disk_log(handle, &out_msg).await;
    let event = TimelineEvent::Message {
        id: out_msg.id.clone(),
        session_id: out_msg.session_id.clone(),
        client_id: out_msg.client_id.clone(),
        direction: out_msg.direction.clone(),
        payload_type: out_msg.payload_type.clone(),
        endpoint: out_msg.endpoint.clone(),
        sender: None,
        payload: reply_bytes.clone(),
        size,
        timestamp: ts,
        pinned: 0,
    };
    send_timeline_event(handle, event.clone()).await;
    let _ = handle.app.emit("session:message", event);
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

fn match_auto_reply(
    text: &str,
    rules: &[(crate::db::AutoReplyRule, Option<regex::Regex>)],
) -> Option<(Vec<u8>, bool, u64)> {
    for (rule, re) in rules {
        let hit = match rule.match_type.as_str() {
            "exact" => text.trim() == rule.pattern.trim(),
            "regex" => re.as_ref().map_or(false, |r| r.is_match(text)),
            _ => text.contains(&rule.pattern), // contains (default)
        };
        if !hit { continue; }
        let is_text = rule.reply_type == "text";
        let bytes = if is_text {
            rule.reply.clone().into_bytes()
        } else if rule.reply_type == "hex" {
            let c = rule.reply.replace(char::is_whitespace, "").replace("0x", "").replace("0X", "");
            (0..c.len()).step_by(2).map(|i| u8::from_str_radix(&c[i..i+2], 16).unwrap_or(0)).collect()
        } else {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.decode(rule.reply.trim()).unwrap_or_default()
        };
        return Some((bytes, is_text, rule.delay_ms));
    }
    None
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
