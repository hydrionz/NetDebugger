use std::collections::HashMap;
use std::sync::Arc;
use tauri::ipc::Channel;
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio_rusqlite::Connection;

#[derive(Debug, Clone)]
pub struct WsConfig {
    pub bind_addr: Option<String>,
    pub target_url: Option<String>,
    pub endpoints: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
pub struct OutgoingMessage {
    pub endpoint: Option<String>, // None = 全体广播; Some(path) = 该 endpoint 全体广播
    pub kind: OutgoingKind,
}

#[derive(Debug, Clone)]
pub enum OutgoingKind {
    Text(String),
    Binary(Vec<u8>),
}

#[derive(Debug, Clone)]
pub enum ClientMessage {
    Text(String),
    Binary(Vec<u8>),
}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", content = "data")]
pub enum TimelineEvent {
    Message {
        id: String,
        session_id: String,
        client_id: Option<String>,
        direction: String,
        payload_type: String,
        endpoint: Option<String>,
        sender: Option<String>,
        #[serde(with = "serde_bytes")]
        payload: Vec<u8>,
        size: usize,
        timestamp: i64,
    },
    Status {
        session_id: String,
        status: String,
        local_addr: Option<String>,
        remote_addr: Option<String>,
    },
    Notice {
        session_id: String,
        text: String,
        timestamp: i64,
    },
}

#[derive(Debug)]
pub struct ClientHandle {
    pub outbound_tx: mpsc::Sender<ClientMessage>,
    pub shutdown_tx: mpsc::Sender<()>,
    pub endpoint: String,
}

pub struct SessionHandle {
    pub app: tauri::AppHandle,
    pub shutdown_tx: mpsc::Sender<()>,
    pub outbound_tx: mpsc::Sender<OutgoingMessage>,
    pub clients: Arc<RwLock<HashMap<String, ClientHandle>>>,
}

pub struct AppState {
    pub db: Connection,
    pub sessions: Arc<RwLock<HashMap<String, Arc<SessionHandle>>>>,
    // 时间线订阅 channel 放在 AppState（不随会话运行状态消失），
    // 这样会话未运行时也能订阅，启动瞬间的连接提示可以实时送达。
    pub timeline_channels: Arc<Mutex<HashMap<String, Channel<TimelineEvent>>>>,
}

impl AppState {
    pub fn new(db: Connection) -> Self {
        Self {
            db,
            sessions: Arc::new(RwLock::new(HashMap::new())),
            timeline_channels: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}
