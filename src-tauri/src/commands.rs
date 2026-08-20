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
    )
    .await
    .map_err(|e| e.to_string())
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
    };

    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let (outbound_tx, outbound_rx) = tokio::sync::mpsc::channel::<OutgoingMessage>(256);
    let handle = Arc::new(SessionHandle {
        app: app.clone(),
        shutdown_tx,
        outbound_tx: Arc::new(tokio::sync::Mutex::new(outbound_tx)),
        clients: Arc::new(tokio::sync::RwLock::new(std::collections::HashMap::new())),
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
    payload: String,
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
            payload.clone().into_bytes(),
            None,
            &handle,
        )
        .await;

        let msg = match payload_type.as_str() {
            "binary" => ClientMessage::Binary(payload.into_bytes()),
            _ => ClientMessage::Text(payload),
        };
        client
            .outbound_tx
            .send(msg)
            .await
            .map_err(|_| "client channel closed".to_string())
    } else {
        // Send to all (server) or to remote (client).
        let kind = match payload_type.as_str() {
            "binary" => OutgoingKind::Binary(payload.into_bytes()),
            _ => OutgoingKind::Text(payload),
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
