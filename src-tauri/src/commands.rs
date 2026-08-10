use crate::db;
use crate::state::{AppState, ClientMessage, OutgoingMessage, SessionHandle, TimelineEvent, WsConfig};
use crate::ws;
use std::sync::Arc;
use tauri::{ipc::Channel, AppHandle, State};

#[derive(serde::Deserialize)]
pub struct CreateSessionRequest {
    project_id: Option<String>,
    name: Option<String>,
    protocol: String,
    role: String,
    bind_addr: Option<String>,
    target_url: Option<String>,
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
    db::create_session(
        &state.db,
        req.project_id.as_deref(),
        req.name.as_deref(),
        &req.protocol,
        &req.role,
        req.bind_addr,
        req.target_url,
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

    db::update_session(
        &state.db,
        &req.id,
        req.project_id.as_deref(),
        req.name.as_deref(),
        req.bind_addr,
        req.target_url,
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
    };

    let (shutdown_tx, shutdown_rx) = tokio::sync::mpsc::channel::<()>(1);
    let (outbound_tx, outbound_rx) = tokio::sync::mpsc::channel::<OutgoingMessage>(256);
    let handle = Arc::new(SessionHandle {
        app: app.clone(),
        shutdown_tx,
        outbound_tx,
        timeline_tx: tokio::sync::Mutex::new(None),
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
        let _ = h.shutdown_tx.send(()).await;
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
        let msg = match payload_type.as_str() {
            "binary" => OutgoingMessage::Binary(payload.into_bytes()),
            _ => OutgoingMessage::Text(payload),
        };
        handle
            .outbound_tx
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
    let handle = {
        let sessions = state.sessions.read().await;
        sessions.get(&session_id).cloned()
    };

    if let Some(h) = handle {
        let mut tx = h.timeline_tx.lock().await;
        *tx = Some(channel);
    }
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
