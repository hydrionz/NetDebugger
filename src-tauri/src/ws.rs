use crate::db;
use crate::state::{ClientHandle, ClientMessage, OutgoingMessage, SessionHandle, TimelineEvent, WsConfig};
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::{accept_async, connect_async, tungstenite::protocol::Message as WsMessage};
use uuid::Uuid;

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
            emit_status(&app, &session_id, "error", None, None);
            return;
        }
    };

    let listener = match TcpListener::bind(&bind_addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("ws server bind error: {}", e);
            emit_status(&app, &session_id, "error", None, None);
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

    // Accept loop for multiple clients.
    loop {
        tokio::select! {
            accept_result = listener.accept() => {
                match accept_result {
                    Ok((stream, peer)) => {
                        let remote_addr = peer.to_string();
                        let ws_stream = match accept_async(stream).await {
                            Ok(s) => s,
                            Err(e) => {
                                eprintln!("ws server handshake error: {} for {}", e, remote_addr);
                                continue;
                            }
                        };

                        let client_id = match db::create_client(&db, &session_id, Some(&remote_addr), None).await {
                            Ok(c) => c.id,
                            Err(e) => {
                                eprintln!("create_client error: {}", e);
                                continue;
                            }
                        };

                        let (client_outbound_tx, client_outbound_rx) = mpsc::channel::<ClientMessage>(64);
                        let client_handle = ClientHandle {
                            id: client_id.clone(),
                            remote_addr: remote_addr.clone(),
                            outbound_tx: client_outbound_tx,
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
                            }),
                        );

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
                                remote_addr_clone,
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
                // Broadcast to all connected clients.
                let msg = match out {
                    Some(OutgoingMessage::Text(t)) => ClientMessage::Text(t),
                    Some(OutgoingMessage::Binary(b)) => ClientMessage::Binary(b),
                    None => break,
                };
                let clients = handle.clients.read().await;
                for c in clients.values() {
                    let _ = c.outbound_tx.send(match &msg {
                        ClientMessage::Text(t) => ClientMessage::Text(t.clone()),
                        ClientMessage::Binary(b) => ClientMessage::Binary(b.clone()),
                    }).await;
                }
            }
            _ = shutdown_rx.recv() => {
                break;
            }
        }
    }

    set_closed(&app, &db, &session_id, local_addr.as_deref(), None).await;
}

async fn run_client_socket_loop<S>(
    app: AppHandle,
    db: db::DbConnection,
    session_id: String,
    client_id: String,
    ws_stream: tokio_tungstenite::WebSocketStream<S>,
    handle: Arc<SessionHandle>,
    mut outbound_rx: mpsc::Receiver<ClientMessage>,
    _remote_addr: String,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut write, mut read) = ws_stream.split();

    loop {
        tokio::select! {
            msg = read.next() => {
                match msg {
                    Some(Ok(WsMessage::Text(text))) => {
                        persist_in_message(&db, &session_id, Some(&client_id), "text", text.as_bytes().to_vec(), &handle).await;
                    }
                    Some(Ok(WsMessage::Binary(bin))) => {
                        persist_in_message(&db, &session_id, Some(&client_id), "binary", bin.to_vec(), &handle).await;
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
                    Some(ClientMessage::Text(text)) => {
                        persist_out_message(&db, &session_id, Some(&client_id), "text", text.clone().into_bytes(), &handle).await;
                        write.send(WsMessage::Text(text.into())).await
                    }
                    Some(ClientMessage::Binary(bin)) => {
                        persist_out_message(&db, &session_id, Some(&client_id), "binary", bin.clone(), &handle).await;
                        write.send(WsMessage::Binary(bin.into())).await
                    }
                    None => break,
                };
                if let Err(e) = result {
                    eprintln!("ws write error: {}", e);
                    break;
                }
            }
        }
    }

    // Remove client.
    {
        let mut clients = handle.clients.write().await;
        clients.remove(&client_id);
    }
    // Delete from DB.
    let _ = db::delete_client(&db, &client_id).await;
    // Notify UI.
    let _ = app.emit(
        "session:client_disconnected",
        serde_json::json!({
            "session_id": &session_id,
            "client_id": &client_id,
        }),
    );
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
    let url = match config.target_url {
        Some(u) => u,
        None => {
            emit_status(&app, &session_id, "error", None, None);
            return;
        }
    };

    db::update_session_status(&db, &session_id, "starting", None, None)
        .await
        .ok();
    emit_status(&app, &session_id, "starting", None, None);

    let (ws_stream, _response) = match connect_async(&url).await {
        Ok(x) => x,
        Err(e) => {
            eprintln!("ws client connect error: {}", e);
            set_closed(&app, &db, &session_id, None, None).await;
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
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut write, mut read) = ws_stream.split();

    loop {
        tokio::select! {
            msg = read.next() => {
                match msg {
                    Some(Ok(WsMessage::Text(text))) => {
                        persist_in_message(&db, &session_id, None, "text", text.as_bytes().to_vec(), &handle).await;
                    }
                    Some(Ok(WsMessage::Binary(bin))) => {
                        persist_in_message(&db, &session_id, None, "binary", bin.to_vec(), &handle).await;
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
                    Some(OutgoingMessage::Text(text)) => {
                        persist_out_message(&db, &session_id, None, "text", text.clone().into_bytes(), &handle).await;
                        write.send(WsMessage::Text(text.into())).await
                    }
                    Some(OutgoingMessage::Binary(bin)) => {
                        persist_out_message(&db, &session_id, None, "binary", bin.clone(), &handle).await;
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

    set_closed(&app, &db, &session_id, local_addr.as_deref(), Some(&remote_addr)).await;
}

async fn persist_in_message(
    db: &db::DbConnection,
    session_id: &str,
    client_id: Option<&str>,
    payload_type: &str,
    payload: Vec<u8>,
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
    };
    db::insert_message(db, &msg).await.ok();
    send_timeline_event(handle, TimelineEvent::Message {
        id: msg.id,
        session_id: msg.session_id,
        client_id: msg.client_id,
        direction: msg.direction,
        payload_type: msg.payload_type,
        payload,
        size: msg.size,
        timestamp: msg.timestamp,
    }).await;
}

async fn persist_out_message(
    db: &db::DbConnection,
    session_id: &str,
    client_id: Option<&str>,
    payload_type: &str,
    payload: Vec<u8>,
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
    };
    db::insert_message(db, &msg).await.ok();
    send_timeline_event(handle, TimelineEvent::Message {
        id: msg.id,
        session_id: msg.session_id,
        client_id: msg.client_id,
        direction: msg.direction,
        payload_type: msg.payload_type,
        payload,
        size: msg.size,
        timestamp: msg.timestamp,
    }).await;
}

async fn send_timeline_event(handle: &Arc<SessionHandle>, event: TimelineEvent) {
    let tx = handle.timeline_tx.lock().await;
    if let Some(ch) = tx.as_ref() {
        let _ = ch.send(event);
    }
}

async fn set_closed(
    app: &AppHandle,
    db: &db::DbConnection,
    session_id: &str,
    local_addr: Option<&str>,
    remote_addr: Option<&str>,
) {
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
