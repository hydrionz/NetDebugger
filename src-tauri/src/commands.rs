use crate::db;
use crate::state::{AppState, ClientMessage, OutgoingKind, OutgoingMessage, SessionHandle, TimelineEvent, WsConfig};
use crate::ws;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_store::StoreExt;

#[derive(serde::Deserialize)]
pub struct CreateSessionRequest {
    project_id: Option<String>,
    name: Option<String>,
    protocol: String,
    role: String,
    bind_addr: Option<String>,
    target_url: Option<String>,
    endpoints: Option<Vec<String>>,
    headers: Option<HashMap<String, String>>,
    subprotocols: Option<Vec<String>>,
    auto_reconnect: Option<i64>,
    heartbeat_interval: Option<i64>,
    auto_replies: Option<Vec<db::AutoReplyRule>>,
}

#[tauri::command]
pub async fn create_project(state: State<'_ , AppState>, name: String) -> Result<db::Project, String> {
    db::create_project(&state.db, &name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_project(state: State<'_ , AppState>, id: String) -> Result<(), String> {
    db::delete_project(&state.db, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_project(state: State<'_ , AppState>, id: String, name: String) -> Result<(), String> {
    db::update_project(&state.db, &id, &name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_projects(state: State<'_ , AppState>) -> Result<Vec<db::ProjectWithSessions>, String> {
    db::list_projects_with_sessions(&state.db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_session(
    state: State<'_ , AppState>,
    req: CreateSessionRequest,
) -> Result<db::Session, String> {
    let endpoints = normalize_endpoints(req.endpoints)?;
    let headers = normalize_headers(req.headers)?;
    let subprotocols = normalize_subprotocols(req.subprotocols)?;
    let auto_replies = normalize_auto_replies(req.auto_replies)?;
    db::create_session(
        &state.db,
        req.project_id.as_deref(),
        req.name.as_deref(),
        &req.protocol,
        &req.role,
        req.bind_addr,
        req.target_url,
        endpoints,
        headers,
        subprotocols,
        req.auto_reconnect,
        req.heartbeat_interval,
        auto_replies,
    )
    .await
    .map_err(|e| e.to_string())
}

#[derive(serde::Deserialize)]
pub struct UpdateSessionRequest {
    id: String,
    project_id: Option<String>,
    name: Option<String>,
    bind_addr: Option<String>,
    target_url: Option<String>,
    endpoints: Option<Vec<String>>,
    headers: Option<HashMap<String, String>>,
    subprotocols: Option<Vec<String>>,
    auto_reconnect: Option<i64>,
    heartbeat_interval: Option<i64>,
    auto_replies: Option<Vec<db::AutoReplyRule>>,
}

/// 校验并规范化 endpoint 路径列表：trim、跳过空串、必须 / 开头、无空白与 ?#、去重保序；全空 → None。
fn normalize_endpoints(eps: Option<Vec<String>>) -> Result<Option<Vec<String>>, String> {
    let Some(list) = eps else { return Ok(None) };
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for raw in list {
        let p = raw.trim().to_string();
        if p.is_empty() { continue; }
        if !p.starts_with('/') { return Err(format!("endpoint 路径必须以 / 开头: {}", p)); }
        if p.contains(char::is_whitespace) || p.contains('?') || p.contains('#') {
            return Err(format!("endpoint 路径含非法字符: {}", p));
        }
        if seen.insert(p.clone()) { out.push(p); }
    }
    Ok(if out.is_empty() { None } else { Some(out) })
}

/// 校验并规范化请求头：key trim 跳过空；key 不含 :/空白/控制字符；value trim 保留可空。
fn normalize_headers(hdrs: Option<HashMap<String, String>>) -> Result<Option<HashMap<String, String>>, String> {
    let Some(map) = hdrs else { return Ok(None) };
    let mut out = HashMap::new();
    for (mut k, v) in map {
        k = k.trim().to_string();
        if k.is_empty() { continue; }
        if k.contains(':') || k.contains(char::is_whitespace) || k.contains(char::is_control) {
            return Err(format!("header 名含非法字符: {}", k));
        }
        out.insert(k, v.trim().to_string());
    }
    Ok(if out.is_empty() { None } else { Some(out) })
}

/// 校验并规范化 subprotocol 列表：trim 跳过空；不含 ,/空白/控制字符；按序去重。
fn normalize_subprotocols(protos: Option<Vec<String>>) -> Result<Option<Vec<String>>, String> {
    let Some(list) = protos else { return Ok(None) };
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for raw in list {
        let p = raw.trim().to_string();
        if p.is_empty() { continue; }
        if p.contains(',') || p.contains(char::is_whitespace) || p.contains(char::is_control) {
            return Err(format!("subprotocol 含非法字符: {}", p));
        }
        if seen.insert(p.clone()) { out.push(p); }
    }
    Ok(if out.is_empty() { None } else { Some(out) })
}

/// 校验并规范化自动回复规则：服务端专用，校验正则与回复编码；空/全禁用的去重处理在前端，服务端只做强校验
fn normalize_auto_replies(rules: Option<Vec<db::AutoReplyRule>>) -> Result<Option<Vec<db::AutoReplyRule>>, String> {
    let Some(list) = rules else { return Ok(None) };
    if list.is_empty() { return Ok(None) };
    for r in &list {
        if r.pattern.trim().is_empty() { return Err("自动回复匹配内容不能为空".to_string()); }
        if !["contains", "exact", "regex"].contains(&r.match_type.as_str()) {
            return Err(format!("未知的匹配类型: {}", r.match_type));
        }
        if !["text", "hex", "base64"].contains(&r.reply_type.as_str()) {
            return Err(format!("未知的回复类型: {}", r.reply_type));
        }
        if r.match_type == "regex" {
            regex::Regex::new(&r.pattern).map_err(|e| format!("正则错误 '{}': {}", r.pattern, e))?;
        }
        if r.reply_type == "hex" {
            let c = r.reply.replace(char::is_whitespace, "").replace("0x", "").replace("0X", "");
            if c.len() % 2 != 0 { return Err(format!("Hex 回复长度必须为偶数: {}", r.reply)); }
            if !c.chars().all(|ch| ch.is_ascii_hexdigit()) { return Err(format!("Hex 回复含非法字符: {}", r.reply)); }
        } else if r.reply_type == "base64" {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.decode(r.reply.trim()).map_err(|e| format!("Base64 回复错误: {}", e))?;
        }
    }
    Ok(Some(list))
}

#[tauri::command]
pub async fn update_session(
    state: State<'_, AppState>,
    req: UpdateSessionRequest,
) -> Result<(), String> {
    let sessions = db::list_projects_with_sessions(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    let session = sessions
        .into_iter()
        .flat_map(|p| p.sessions)
        .find(|s| s.id == req.id)
        .ok_or_else(|| "session not found".to_string())?;

    if session.status == "starting" || session.status == "running" {
        return Err("请先停止连接再修改".to_string());
    }

    let endpoints = normalize_endpoints(req.endpoints)?;
    let headers = normalize_headers(req.headers)?;
    let subprotocols = normalize_subprotocols(req.subprotocols)?;
    let auto_replies = normalize_auto_replies(req.auto_replies)?;
    db::update_session(
        &state.db,
        &req.id,
        req.project_id.as_deref(),
        req.name.as_deref(),
        req.bind_addr,
        req.target_url,
        endpoints,
        headers,
        subprotocols,
        req.auto_reconnect,
        req.heartbeat_interval,
        auto_replies,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_auto_replies(
    state: State<'_ , AppState>,
    id: String,
    auto_replies: Option<Vec<db::AutoReplyRule>>,
) -> Result<(), String> {
    let sessions = db::list_projects_with_sessions(&state.db).await.map_err(|e| e.to_string())?;
    let session = sessions.into_iter().flat_map(|p| p.sessions).find(|s| s.id == id).ok_or_else(|| "session not found".to_string())?;
    if session.role != "server" {
        return Err("仅服务端支持自动回复".to_string());
    }
    let auto_replies = normalize_auto_replies(auto_replies)?;
    db::update_auto_replies(&state.db, &id, auto_replies.clone()).await.map_err(|e| e.to_string())?;
    // 运行时动态生效：同步更新内存中的规则
    if let Some(h) = state.sessions.read().await.get(&id).cloned() {
        *h.auto_replies.lock().await = auto_replies;
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_session(state: State<'_ , AppState>, id: String) -> Result<(), String> {
    db::delete_session(&state.db, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn load_messages(
    state: State<'_ , AppState>,
    session_id: String,
    limit: usize,
    before: Option<i64>,
) -> Result<Vec<db::Message>, String> {
    db::load_messages(&state.db, &session_id, limit, before)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clear_messages(state: State<'_ , AppState>, session_id: String) -> Result<(), String> {
    db::clear_messages(&state.db, &session_id)
        .await
        .map_err(|e| e.to_string())
}

/// 导出会话全部消息历史：弹出系统保存对话框，按 JSON 或文本格式写入。
/// 返回保存的文件路径；用户取消时返回 None。
#[tauri::command]
pub async fn export_messages(
    state: State<'_ , AppState>,
    session_id: String,
    format: String,
) -> Result<Option<String>, String> {
    use base64::Engine;

    // 数据库为数据源（包含前端未加载的更早历史）
    let messages = db::load_all_messages(&state.db, &session_id)
        .await
        .map_err(|e| e.to_string())?;
    if messages.is_empty() {
        return Err("当前会话没有可导出的消息".to_string());
    }

    let is_json = format == "json";
    let (filter_name, exts) = if is_json {
        ("JSON 文件", vec!["json"])
    } else {
        ("文本文件", vec!["txt"])
    };

    let file = rfd::AsyncFileDialog::new()
        .set_file_name(if is_json { "messages.json" } else { "messages.txt" })
        .add_filter(filter_name, &exts)
        .save_file()
        .await;
    let Some(file) = file else { return Ok(None) };
    let path = file.path().to_path_buf();

    // 序列化放在阻塞线程，避免大历史卡住 async 运行时
    let fmt = format.clone();
    let serialized = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        if fmt == "json" {
            #[derive(serde::Serialize)]
            struct ExportMessage<'a> {
                timestamp: i64,
                time: String,
                direction: &'a str,
                payload_type: &'a str,
                endpoint: Option<&'a str>,
                sender: Option<&'a str>,
                size: usize,
                text: String,
                #[serde(skip_serializing_if = "Option::is_none")]
                payload_base64: Option<String>,
            }
            let b64 = base64::engine::general_purpose::STANDARD;
            let items: Vec<ExportMessage> = messages
                .iter()
                .map(|m| {
                    // 按 payload_type 区分：binary 一律十六进制展示（含合法 UTF-8 的控制字节）；
                    // text 按文本展示。base64 保留二进制原始字节。
                    let is_binary = m.payload_type == "binary";
                    let text = if is_binary {
                        hex_encode(&m.payload)
                    } else {
                        String::from_utf8_lossy(&m.payload).into_owned()
                    };
                    ExportMessage {
                        timestamp: m.timestamp,
                        time: chrono::DateTime::from_timestamp_millis(m.timestamp)
                            .map(|d| d.format("%Y-%m-%d %H:%M:%S%.3f").to_string())
                            .unwrap_or_default(),
                        direction: &m.direction,
                        payload_type: &m.payload_type,
                        endpoint: m.endpoint.as_deref(),
                        sender: m.sender.as_deref(),
                        size: m.size,
                        text,
                        payload_base64: if is_binary {
                            Some(b64.encode(&m.payload))
                        } else {
                            None
                        },
                    }
                })
                .collect();
            serde_json::to_vec_pretty(&items).map_err(|e| e.to_string())
        } else {
            let mut out = String::new();
            for m in &messages {
                let time = chrono::DateTime::from_timestamp_millis(m.timestamp)
                    .map(|d| d.format("%Y-%m-%d %H:%M:%S%.3f").to_string())
                    .unwrap_or_default();
                let arrow = if m.direction == "in" { "← 收" } else { "→ 发" };
                let ep = m.endpoint.as_deref().unwrap_or("-");
                let sender = m.sender.as_deref().unwrap_or("");
                let sender_part = if sender.is_empty() { String::new() } else { format!(" [{}]", sender) };
                let body = if m.payload_type == "binary" {
                    hex_encode(&m.payload)
                } else {
                    String::from_utf8_lossy(&m.payload).into_owned()
                };
                out.push_str(&format!(
                    "[{}] {} {} ep={}{} size={}\n{}\n\n",
                    time, arrow, m.payload_type, ep, sender_part, m.size, body
                ));
            }
            Ok(out.into_bytes())
        }
    })
    .await
    .map_err(|e| e.to_string())??;

    file.write(&serialized).await.map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect::<Vec<_>>().join(" ")
}

#[tauri::command]
pub async fn count_messages_by_endpoint(
    state: State<'_ , AppState>,
    session_id: String,
    endpoint: String,
) -> Result<i64, String> {
    db::count_messages_by_endpoint(&state.db, &session_id, &endpoint)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_messages_by_endpoint(
    state: State<'_ , AppState>,
    session_id: String,
    endpoint: String,
) -> Result<(), String> {
    db::delete_messages_by_endpoint(&state.db, &session_id, &endpoint)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_message(state: State<'_ , AppState>, message_id: String) -> Result<(), String> {
    db::delete_message(&state.db, &message_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_message_pinned(state: State<'_ , AppState>, message_id: String, pinned: bool) -> Result<(), String> {
    db::set_message_pinned(&state.db, &message_id, pinned)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn load_pinned_messages(state: State<'_ , AppState>, session_id: String) -> Result<Vec<db::Message>, String> {
    db::load_pinned_messages(&state.db, &session_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_message_by_id(state: State<'_ , AppState>, message_id: String) -> Result<Option<db::Message>, String> {
    db::get_message_by_id(&state.db, &message_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_session(
    app: AppHandle,
    state: State<'_ , AppState>,
    id: String,
) -> Result<(), String> {
    // Load session config.
    let sessions = db::list_projects_with_sessions(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    let session = sessions
        .into_iter()
        .flat_map(|p| p.sessions)
        .find(|s| s.id == id)
        .ok_or_else(|| "session not found".to_string())?;

    if session.protocol != "ws" {
        return Err("unsupported protocol".to_string());
    }

    let config = WsConfig {
        bind_addr: session.bind_addr.clone(),
        target_url: session.target_url.clone(),
        endpoints: session.endpoints.clone(),
        headers: session.headers.clone(),
        subprotocols: session.subprotocols.clone(),
        auto_reconnect: session.auto_reconnect,
        heartbeat_interval: session.heartbeat_interval,
        auto_replies: session.auto_replies.clone(),
    };

    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let (outbound_tx, outbound_rx) = tokio::sync::mpsc::channel::<OutgoingMessage>(256);
    let handle = Arc::new(SessionHandle {
        app: app.clone(),
        shutdown_tx,
        outbound_tx: Arc::new(tokio::sync::Mutex::new(outbound_tx)),
        clients: Arc::new(tokio::sync::RwLock::new(std::collections::HashMap::new())),
        last_ping_at: Arc::new(tokio::sync::Mutex::new(None)),
        last_pong_at: Arc::new(tokio::sync::Mutex::new(None)),
        manual_ping_pending: Arc::new(tokio::sync::Mutex::new(false)),
        auto_replies: Arc::new(tokio::sync::Mutex::new(session.auto_replies.clone())),
    });

    {
        let mut sessions = state.sessions.write().await;
        if sessions.contains_key(&id) {
            return Err("session already running".to_string());
        }
        sessions.insert(id.clone(), handle.clone());
    }

    let db = state.db.clone();
    if session.role == "server" {
        tauri::async_runtime::spawn(ws::run_ws_server(
            app, db, id, config, handle, outbound_rx, shutdown_rx,
        ));
    } else {
        tauri::async_runtime::spawn(ws::run_ws_client(
            app, db, id, config, handle, outbound_rx, shutdown_rx,
        ));
    }

    Ok(())
}

#[tauri::command]
pub async fn stop_session(state: State<'_ , AppState>, id: String) -> Result<(), String> {
    let handle = {
        let mut sessions = state.sessions.write().await;
        sessions.remove(&id)
    };

    if let Some(h) = handle {
        let _ = h.shutdown_tx.send(true);
    } else {
        db::update_session_status(&state.db, &id, "closed", None, None)
            .await
            .map_err(|e| e.to_string())?;
        db::delete_clients_by_session(&state.db, &id)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn disconnect_client(
    state: State<'_ , AppState>,
    session_id: String,
    client_id: String,
) -> Result<(), String> {
    let handle = {
        let sessions = state.sessions.read().await;
        sessions.get(&session_id).cloned()
    };

    let handle = handle.ok_or_else(|| "session not running".to_string())?;

    let client_shutdown_tx = {
        let clients = handle.clients.read().await;
        clients
            .get(&client_id)
            .map(|c| c.shutdown_tx.clone())
            .ok_or_else(|| "client not found".to_string())?
    };

    let _ = client_shutdown_tx.send(()).await;

    Ok(())
}

#[tauri::command]
pub async fn send_message(
    state: State<'_ , AppState>,
    session_id: String,
    payload: Vec<u8>,
    payload_type: String,
    client_id: Option<String>,
    endpoint: Option<String>,
) -> Result<(), String> {
    let handle = {
        let sessions = state.sessions.read().await;
        sessions.get(&session_id).cloned()
    };

    let handle = handle.ok_or_else(|| "session not running".to_string())?;

    if let Some(client_id) = client_id {
        // Send to a specific client (server only). Persist exactly once here,
        // at the point the send is initiated, then hand off a raw write to the
        // client's socket task (it no longer persists on its own).
        let clients = handle.clients.read().await;
        let client = clients
            .get(&client_id)
            .ok_or_else(|| "client not found".to_string())?;

        let payload_type_owned = payload_type.clone();
        ws::persist_out_message(
            &state.db,
            &session_id,
            Some(&client_id),
            &payload_type_owned,
            payload.clone(),
            None,
            &handle,
        )
        .await;

        let msg = match payload_type.as_str() {
            "binary" => ClientMessage::Binary(payload),
            _ => ClientMessage::Text(String::from_utf8_lossy(&payload).into_owned()),
        };
        client
            .outbound_tx
            .send(msg)
            .await
            .map_err(|_| "client channel closed".to_string())
    } else {
        // Send to all (server) or to remote (client).
        let kind = match payload_type.as_str() {
            "binary" => OutgoingKind::Binary(payload),
            _ => OutgoingKind::Text(String::from_utf8_lossy(&payload).into_owned()),
        };
        let msg = OutgoingMessage { endpoint, kind };
        handle
            .outbound_tx
            .lock()
            .await
            .send(msg)
            .await
            .map_err(|_| "outbound channel closed".to_string())
    }
}

#[tauri::command]
pub async fn subscribe_timeline(
    state: State<'_ , AppState>,
    session_id: String,
    channel: Channel<TimelineEvent>,
) -> Result<(), String> {
    // channel 存在 AppState，会话未运行时也可订阅，start 瞬间的提示不会丢
    state
        .timeline_channels
        .lock()
        .await
        .insert(session_id, channel);
    Ok(())
}

/// 手动发送 Ping 控制帧：客户端会话 ping 服务端；服务端会话广播给所有已连客户端。
#[tauri::command]
pub async fn send_ping(state: State<'_ , AppState>, session_id: String) -> Result<(), String> {
    let handle = {
        let sessions = state.sessions.read().await;
        sessions.get(&session_id).cloned()
    };
    let handle = handle.ok_or_else(|| "session not running".to_string())?;

    *handle.last_ping_at.lock().await = Some(chrono::Utc::now().timestamp_millis());
    *handle.manual_ping_pending.lock().await = true;
    let msg = OutgoingMessage { endpoint: None, kind: OutgoingKind::Ping };
    let result = handle
        .outbound_tx
        .lock()
        .await
        .send(msg)
        .await;
    result.map_err(|_| "outbound channel closed".to_string())
}

/// 查询心跳状态（供前端轮询展示）。
#[tauri::command]
pub async fn get_heartbeat_status(
    state: State<'_ , AppState>,
    session_id: String,
) -> Result<serde_json::Value, String> {
    let handle = {
        let sessions = state.sessions.read().await;
        sessions.get(&session_id).cloned()
    };
    let Some(handle) = handle else {
        return Ok(serde_json::json!({ "running": false }));
    };
    let last_ping_at = *handle.last_ping_at.lock().await;
    let last_pong_at = *handle.last_pong_at.lock().await;
    let rtt_ms = match (last_ping_at, last_pong_at) {
        (Some(ping), Some(pong)) if pong >= ping => Some(pong - ping),
        _ => None,
    };
    Ok(serde_json::json!({
        "running": true,
        "last_ping_at": last_ping_at,
        "last_pong_at": last_pong_at,
        "rtt_ms": rtt_ms,
    }))
}

#[tauri::command]
pub async fn list_clients(
    state: State<'_ , AppState>,
    session_id: String,
) -> Result<Vec<db::Client>, String> {
    db::list_clients(&state.db, &session_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_client_name(
    state: State<'_ , AppState>,
    id: String,
    name: Option<String>,
) -> Result<(), String> {
    db::update_client_name(&state.db, &id, name.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_app_version(app: tauri::AppHandle) -> Result<String, String> {
    Ok(app.package_info().version.to_string())
}

#[tauri::command]
pub fn get_minimize_to_tray(app: AppHandle) -> Result<bool, String> {
    let store = app.store("store.bin").map_err(|e| e.to_string())?;
    Ok(store
        .get("minimize-to-tray")
        .and_then(|v| v.as_bool())
        .unwrap_or(false))
}

#[tauri::command]
pub fn set_minimize_to_tray(app: AppHandle, value: bool) -> Result<(), String> {
    let store = app.store("store.bin").map_err(|e| e.to_string())?;
    store.set("minimize-to-tray", json!(value));
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_theme(app: AppHandle) -> Result<String, String> {
    let store = app.store("store.bin").map_err(|e| e.to_string())?;
    Ok(store
        .get("theme")
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "system".to_string()))
}

#[tauri::command]
pub fn set_theme(app: AppHandle, theme: String) -> Result<(), String> {
    let store = app.store("store.bin").map_err(|e| e.to_string())?;
    store.set("theme", json!(theme));
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn hide_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn exit_app(app: AppHandle) {
    app.exit(0);
}
