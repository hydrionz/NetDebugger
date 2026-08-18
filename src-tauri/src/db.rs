use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tokio_rusqlite::rusqlite::params;
use tokio_rusqlite::Connection;
use uuid::Uuid;

pub use tokio_rusqlite::Connection as DbConnection;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub project_id: Option<String>,
    pub name: Option<String>,
    pub protocol: String,
    pub role: String,
    pub status: String,
    pub bind_addr: Option<String>,
    pub target_url: Option<String>,
    pub local_addr: Option<String>,
    pub remote_addr: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub endpoints: Option<Vec<String>>,
    pub headers: Option<std::collections::HashMap<String, String>>,
    pub subprotocols: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Client {
    pub id: String,
    pub session_id: String,
    pub name: Option<String>,
    pub remote_addr: Option<String>,
    pub local_addr: Option<String>,
    pub connected_at: i64,
    pub endpoint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub session_id: String,
    pub client_id: Option<String>,
    pub direction: String,
    pub payload_type: String,
    #[serde(with = "serde_bytes")]
    pub payload: Vec<u8>,
    pub size: usize,
    pub timestamp: i64,
    pub endpoint: Option<String>,
    pub sender: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectWithSessions {
    pub project: Project,
    pub sessions: Vec<Session>,
}

const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/001_initial.sql"),
    include_str!("../migrations/002_make_project_optional.sql"),
    include_str!("../migrations/003_add_session_name.sql"),
    include_str!("../migrations/004_multi_client.sql"),
    include_str!("../migrations/005_endpoints.sql"),
    include_str!("../migrations/006_message_sender.sql"),
    include_str!("../migrations/007_notice_payload_type.sql"),
    include_str!("../migrations/008_ws_headers_subprotocols.sql"),
];

pub async fn open_db(path: &str) -> Result<Connection> {
    let conn = Connection::open(path)
        .await
        .with_context(|| format!("open db at {}", path))?;
    run_migrations(&conn).await?;
    reset_all_sessions_to_idle(&conn).await?;
    vacuum_if_needed(&conn).await?;
    Ok(conn)
}

/// 删除（如清空消息）只把数据页标记为可复用，文件停留在历史高水位。
/// 启动时若空闲页占比 > 25% 则 VACUUM 压缩，否则跳过，避免每次启动重写整库。
pub async fn vacuum_if_needed(conn: &Connection) -> Result<()> {
    let (freelist, pages) = conn
        .call(|conn| -> tokio_rusqlite::Result<(i64, i64)> {
            let freelist = conn.query_row("PRAGMA freelist_count", [], |row| row.get(0))?;
            let pages = conn.query_row("PRAGMA page_count", [], |row| row.get(0))?;
            Ok((freelist, pages))
        })
        .await?;
    if pages > 0 && freelist * 4 > pages {
        conn.call(|conn| conn.execute_batch("VACUUM").map_err(tokio_rusqlite::Error::from))
            .await?;
    }
    Ok(())
}

/// 应用启动时把所有会话状态重置为 idle，因为它们都没有在运行
pub async fn reset_all_sessions_to_idle(conn: &Connection) -> Result<()> {
    let now = chrono::Utc::now().timestamp_millis();
    conn.call(move |conn| {
        // 清空所有旧的客户端记录，因为应用重启时所有连接都已经断开
        conn.execute("DELETE FROM clients", [])?;
        // 重置所有会话状态为 idle
        conn.execute(
            "UPDATE sessions SET status = 'idle', updated_at = ?1",
            params![&now.to_string()],
        )?;
        Ok(())
    })
    .await
    .map_err(|e: tokio_rusqlite::Error| anyhow::anyhow!("reset sessions: {}", e))
}

/// 删除指定会话的所有客户端记录
pub async fn delete_clients_by_session(conn: &Connection, session_id: &str) -> Result<()> {
    let session_id = session_id.to_string();
    conn.call(move |conn| {
        conn.execute("DELETE FROM clients WHERE session_id = ?1", params![&session_id])?;
        Ok(())
    })
    .await
    .map_err(|e: tokio_rusqlite::Error| anyhow::anyhow!("delete clients: {}", e))
}

async fn run_migrations(conn: &Connection) -> Result<()> {
    let current_version: i64 = conn
        .call(|conn| {
            conn.query_row("PRAGMA user_version", [], |row| row.get(0))
                .map_err(tokio_rusqlite::Error::from)
        })
        .await?;

    let start = current_version.max(0) as usize;
    for (idx, sql) in MIGRATIONS.iter().enumerate() {
        if idx < start {
            continue;
        }
        let sql = *sql;
        conn.call(move |conn| conn.execute_batch(sql).map_err(tokio_rusqlite::Error::from))
            .await?;
        let new_version = (idx + 1) as i64;
        conn.call(move |conn| {
            conn.execute_batch(&format!("PRAGMA user_version = {}", new_version))
                .map_err(tokio_rusqlite::Error::from)
        })
        .await?;
    }
    Ok(())
}

pub async fn create_project(conn: &Connection, name: &str) -> Result<Project> {
    let now = chrono::Utc::now().timestamp_millis();
    let id = Uuid::new_v4().to_string();
    let name = name.to_string();
    conn.call(move |conn| {
        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![&id, &name, &now.to_string(), &now.to_string()],
        )?;
        Ok(Project {
            id,
            name,
            created_at: now,
            updated_at: now,
        })
    })
    .await
    .map_err(|e: tokio_rusqlite::Error| anyhow::anyhow!("create project: {}", e))
}

pub async fn delete_project(conn: &Connection, id: &str) -> Result<()> {
    let id = id.to_string();
    conn.call(move |conn| {
        conn.execute("DELETE FROM projects WHERE id = ?1", params![&id,
        ])?;
        Ok(())
    })
    .await
    .map_err(|e: tokio_rusqlite::Error| anyhow::anyhow!("delete project: {}", e))
}

pub async fn update_project(conn: &Connection, id: &str, name: &str) -> Result<()> {
    let id = id.to_string();
    let name = name.to_string();
    let now = chrono::Utc::now().timestamp_millis().to_string();
    conn.call(move |conn| {
        conn.execute(
            "UPDATE projects SET name = ?1, updated_at = ?2 WHERE id = ?3",
            params![&name, &now, &id],
        )?;
        Ok(())
    })
    .await
    .map_err(|e: tokio_rusqlite::Error| anyhow::anyhow!("update project: {}", e))
}

pub async fn list_projects_with_sessions(conn: &Connection) -> Result<Vec<ProjectWithSessions>> {
    conn.call(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, created_at, updated_at FROM projects ORDER BY created_at",
        )?;
        let projects = stmt
            .query_map([], |row| {
                Ok(Project {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut result = Vec::with_capacity(projects.len());
        for project in projects {
            let mut stmt = conn.prepare(
                "SELECT id, project_id, name, protocol, role, status, bind_addr, target_url, local_addr, remote_addr, created_at, updated_at, endpoints, headers, subprotocols \
                 FROM sessions WHERE project_id = ?1 ORDER BY created_at",
            )?;
            let sessions = stmt
                .query_map(params![&project.id,
                ], |row| {
                    let endpoints_raw: Option<String> = row.get(12)?;
                    let headers_raw: Option<String> = row.get(13)?;
                    let subprotocols_raw: Option<String> = row.get(14)?;
                    Ok(Session {
                        id: row.get(0)?,
                        project_id: row.get(1)?,
                        name: row.get(2)?,
                        protocol: row.get(3)?,
                        role: row.get(4)?,
                        status: row.get(5)?,
                        bind_addr: row.get(6)?,
                        target_url: row.get(7)?,
                        local_addr: row.get(8)?,
                        remote_addr: row.get(9)?,
                        created_at: row.get(10)?,
                        updated_at: row.get(11)?,
                        endpoints: endpoints_raw.and_then(|s| serde_json::from_str(&s).ok()),
                        headers: headers_raw.and_then(|s| serde_json::from_str(&s).ok()),
                        subprotocols: subprotocols_raw.and_then(|s| serde_json::from_str(&s).ok()),
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            result.push(ProjectWithSessions { project, sessions });
        }

        // Ungrouped sessions
        let mut stmt = conn.prepare(
            "SELECT id, project_id, name, protocol, role, status, bind_addr, target_url, local_addr, remote_addr, created_at, updated_at, endpoints, headers, subprotocols \
             FROM sessions WHERE project_id IS NULL ORDER BY created_at",
        )?;
        let ungrouped = stmt
            .query_map([], |row| {
                let endpoints_raw: Option<String> = row.get(12)?;
                let headers_raw: Option<String> = row.get(13)?;
                let subprotocols_raw: Option<String> = row.get(14)?;
                Ok(Session {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    name: row.get(2)?,
                    protocol: row.get(3)?,
                    role: row.get(4)?,
                    status: row.get(5)?,
                    bind_addr: row.get(6)?,
                    target_url: row.get(7)?,
                    local_addr: row.get(8)?,
                    remote_addr: row.get(9)?,
                    created_at: row.get(10)?,
                    updated_at: row.get(11)?,
                    endpoints: endpoints_raw.and_then(|s| serde_json::from_str(&s).ok()),
                    headers: headers_raw.and_then(|s| serde_json::from_str(&s).ok()),
                    subprotocols: subprotocols_raw.and_then(|s| serde_json::from_str(&s).ok()),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if !ungrouped.is_empty() {
            result.push(ProjectWithSessions {
                project: Project {
                    id: "_ungrouped".to_string(),
                    name: "未分组".to_string(),
                    created_at: 0,
                    updated_at: 0,
                },
                sessions: ungrouped,
            });
        }

        Ok(result)
    })
    .await
    .map_err(|e: tokio_rusqlite::Error| anyhow::anyhow!("list projects: {}", e))
}

pub async fn create_session(
    conn: &Connection,
    project_id: Option<&str>,
    name: Option<&str>,
    protocol: &str,
    role: &str,
    bind_addr: Option<String>,
    target_url: Option<String>,
    endpoints: Option<Vec<String>>,
    headers: Option<std::collections::HashMap<String, String>>,
    subprotocols: Option<Vec<String>>,
) -> Result<Session> {
    let now = chrono::Utc::now().timestamp_millis();
    let id = Uuid::new_v4().to_string();
    let project_id = project_id.map(|s| s.to_string());
    let name = name.map(|s| s.to_string());
    let protocol = protocol.to_string();
    let role = role.to_string();
    let status = "idle".to_string();
    let endpoints_json = endpoints.as_ref().map(|v| serde_json::to_string(v).expect("endpoints json"));
    let headers_json = headers.as_ref().map(|v| serde_json::to_string(v).expect("headers json"));
    let subprotocols_json = subprotocols.as_ref().map(|v| serde_json::to_string(v).expect("subprotocols json"));

    conn.call(move |conn| {
        conn.execute(
            "INSERT INTO sessions (id, project_id, name, protocol, role, status, bind_addr, target_url, endpoints, headers, subprotocols, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                &id,
                &project_id,
                &name,
                &protocol,
                &role,
                &status,
                &bind_addr,
                &target_url,
                &endpoints_json,
                &headers_json,
                &subprotocols_json,
                &now.to_string(),
                &now.to_string(),
            ],
        )?;
        Ok(Session {
            id,
            project_id,
            name,
            protocol,
            role,
            status,
            bind_addr,
            target_url,
            local_addr: None,
            remote_addr: None,
            created_at: now,
            updated_at: now,
            endpoints,
            headers,
            subprotocols,
        })
    })
    .await
    .map_err(|e: tokio_rusqlite::Error| anyhow::anyhow!("create session: {}", e))
}

pub async fn update_session(
    conn: &Connection,
    id: &str,
    project_id: Option<&str>,
    name: Option<&str>,
    bind_addr: Option<String>,
    target_url: Option<String>,
    endpoints: Option<Vec<String>>,
    headers: Option<std::collections::HashMap<String, String>>,
    subprotocols: Option<Vec<String>>,
) -> Result<()> {
    let id = id.to_string();
    let project_id = project_id.map(|s| s.to_string());
    let name = name.map(|s| s.to_string());
    let now = chrono::Utc::now().timestamp_millis();
    let endpoints_json = endpoints.as_ref().map(|v| serde_json::to_string(v).expect("endpoints json"));
    let headers_json = headers.as_ref().map(|v| serde_json::to_string(v).expect("headers json"));
    let subprotocols_json = subprotocols.as_ref().map(|v| serde_json::to_string(v).expect("subprotocols json"));

    conn.call(move |conn| {
        conn.execute(
            "UPDATE sessions SET project_id = ?2, name = ?3, bind_addr = ?4, target_url = ?5, endpoints = ?6, headers = ?7, subprotocols = ?8, updated_at = ?9 WHERE id = ?1",
            params![
                &id,
                &project_id,
                &name,
                &bind_addr,
                &target_url,
                &endpoints_json,
                &headers_json,
                &subprotocols_json,
                &now.to_string(),
            ],
        )?;
        Ok(())
    })
    .await
    .map_err(|e: tokio_rusqlite::Error| anyhow::anyhow!("update session: {}", e))
}

pub async fn update_session_status(
    conn: &Connection,
    id: &str,
    status: &str,
    local_addr: Option<&str>,
    remote_addr: Option<&str>,
) -> Result<()> {
    let id = id.to_string();
    let status = status.to_string();
    let local_addr = local_addr.map(|s| s.to_string());
    let remote_addr = remote_addr.map(|s| s.to_string());
    let now = chrono::Utc::now().timestamp_millis();

    conn.call(move |conn| {
        conn.execute(
            "UPDATE sessions SET status = ?2, local_addr = ?3, remote_addr = ?4, updated_at = ?5 WHERE id = ?1",
            params![
                &id,
                &status,
                &local_addr,
                &remote_addr,
                &now.to_string(),
            ],
        )?;
        Ok(())
    })
    .await
    .map_err(|e: tokio_rusqlite::Error| anyhow::anyhow!("update session status: {}", e))
}

pub async fn delete_session(conn: &Connection, id: &str) -> Result<()> {
    let id = id.to_string();
    conn.call(move |conn| {
        conn.execute("DELETE FROM sessions WHERE id = ?1", params![
            &id,
        ])?;
        Ok(())
    })
    .await
    .map_err(|e: tokio_rusqlite::Error| anyhow::anyhow!("delete session: {}", e))
}

pub async fn create_client(
    conn: &Connection,
    session_id: &str,
    remote_addr: Option<&str>,
    local_addr: Option<&str>,
    endpoint: Option<&str>,
) -> Result<Client> {
    let now = chrono::Utc::now().timestamp_millis();
    let id = Uuid::new_v4().to_string();
    let session_id = session_id.to_string();
    let remote_addr = remote_addr.map(|s| s.to_string());
    let local_addr = local_addr.map(|s| s.to_string());
    let endpoint = endpoint.map(|s| s.to_string());

    conn.call(move |conn| {
        conn.execute(
            "INSERT INTO clients (id, session_id, remote_addr, local_addr, endpoint, connected_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                &id,
                &session_id,
                &remote_addr,
                &local_addr,
                &endpoint,
                &now.to_string(),
            ],
        )?;
        Ok(Client {
            id,
            session_id,
            name: None,
            remote_addr,
            local_addr,
            connected_at: now,
            endpoint,
        })
    })
    .await
    .map_err(|e: tokio_rusqlite::Error| anyhow::anyhow!("create client: {}", e))
}

pub async fn list_clients(conn: &Connection, session_id: &str) -> Result<Vec<Client>> {
    let session_id = session_id.to_string();
    conn.call(move |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, session_id, name, remote_addr, local_addr, connected_at, endpoint \
             FROM clients WHERE session_id = ?1 ORDER BY connected_at",
        )?;
        let clients = stmt
            .query_map(params![&session_id,
            ], |row| {
                Ok(Client {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    name: row.get(2)?,
                    remote_addr: row.get(3)?,
                    local_addr: row.get(4)?,
                    connected_at: row.get(5)?,
                    endpoint: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(clients)
    })
    .await
    .map_err(|e: tokio_rusqlite::Error| anyhow::anyhow!("list clients: {}", e))
}

pub async fn update_client_name(conn: &Connection, id: &str, name: Option<&str>) -> Result<()> {
    let id = id.to_string();
    let name = name.map(|s| s.to_string());
    conn.call(move |conn| {
        conn.execute(
            "UPDATE clients SET name = ?2 WHERE id = ?1",
            params![&id, &name],
        )?;
        Ok(())
    })
    .await
    .map_err(|e: tokio_rusqlite::Error| anyhow::anyhow!("update client name: {}", e))
}

pub async fn delete_client(conn: &Connection, id: &str) -> Result<()> {
    let id = id.to_string();
    conn.call(move |conn| {
        conn.execute("DELETE FROM clients WHERE id = ?1", params![&id,
        ])?;
        Ok(())
    })
    .await
    .map_err(|e: tokio_rusqlite::Error| anyhow::anyhow!("delete client: {}", e))
}

pub async fn insert_message(conn: &Connection, msg: &Message) -> Result<()> {
    let msg = msg.clone();
    conn.call(move |conn| {
        conn.execute(
            "INSERT INTO messages (id, session_id, client_id, direction, payload_type, payload, size, timestamp, endpoint, sender) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                &msg.id,
                &msg.session_id,
                &msg.client_id,
                &msg.direction,
                &msg.payload_type,
                &msg.payload[..],
                &msg.size.to_string(),
                &msg.timestamp.to_string(),
                &msg.endpoint,
                &msg.sender,
            ],
        )?;
        Ok(())
    })
    .await
    .map_err(|e: tokio_rusqlite::Error| anyhow::anyhow!("insert message: {}", e))
}

pub async fn load_messages(
    conn: &Connection,
    session_id: &str,
    limit: usize,
    before: Option<i64>,
) -> Result<Vec<Message>> {
    let session_id = session_id.to_string();
    conn.call(move |conn| {
        let messages = if let Some(before) = before {
            conn.prepare(
                "SELECT id, session_id, client_id, direction, payload_type, payload, size, timestamp, endpoint, sender \
                 FROM messages WHERE session_id = ?1 AND timestamp < ?2 ORDER BY timestamp DESC LIMIT ?3",
            )?
            .query_map(params![
                &session_id, &before.to_string(), &limit.to_string(),
            ], |row| {
                Ok(Message {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    client_id: row.get(2)?,
                    direction: row.get(3)?,
                    payload_type: row.get(4)?,
                    payload: row.get(5)?,
                    size: row.get::<_, usize>(6)?,
                    timestamp: row.get(7)?,
                    endpoint: row.get(8)?,
                    sender: row.get(9)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?
        } else {
            conn.prepare(
                "SELECT id, session_id, client_id, direction, payload_type, payload, size, timestamp, endpoint, sender \
                 FROM messages WHERE session_id = ?1 ORDER BY timestamp DESC LIMIT ?2",
            )?
            .query_map(params![
                &session_id, &limit.to_string(),
            ], |row| {
                Ok(Message {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    client_id: row.get(2)?,
                    direction: row.get(3)?,
                    payload_type: row.get(4)?,
                    payload: row.get(5)?,
                    size: row.get::<_, usize>(6)?,
                    timestamp: row.get(7)?,
                    endpoint: row.get(8)?,
                    sender: row.get(9)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?
        };
        Ok(messages)
    })
    .await
    .map_err(|e: tokio_rusqlite::Error| anyhow::anyhow!("load messages: {}", e))
}

pub async fn clear_messages(conn: &Connection, session_id: &str) -> Result<()> {
    let session_id = session_id.to_string();
    conn.call(move |conn| {
        conn.execute("DELETE FROM messages WHERE session_id = ?1", params![
            &session_id,
        ])?;
        Ok(())
    })
    .await
    .map_err(|e: tokio_rusqlite::Error| anyhow::anyhow!("clear messages: {}", e))
}
