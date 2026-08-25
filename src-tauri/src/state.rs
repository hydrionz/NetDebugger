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
    pub headers: Option<HashMap<String, String>>,
    pub subprotocols: Option<Vec<String>>,
    pub auto_reconnect: Option<i64>,
    pub heartbeat_interval: Option<i64>,
    pub auto_replies: Option<Vec<crate::db::AutoReplyRule>>,
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
    /// 手动 Ping（时间线记录 Pong 往返）；自动心跳不走此通道
    Ping,
}

#[derive(Debug, Clone)]
pub enum ClientMessage {
    Text(String),
    Binary(Vec<u8>),
    /// 服务端手动 Ping 某客户端
    Ping,
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
    pub shutdown_tx: tokio::sync::watch::Sender<bool>,
    // 可变（自动重连时会重建 outbound channel），故用 Mutex 包裹以便经 Arc 共享更新
    pub outbound_tx: Arc<Mutex<mpsc::Sender<OutgoingMessage>>>,
    pub clients: Arc<RwLock<HashMap<String, ClientHandle>>>,
    /// 心跳监控：最近一次发出 Ping 的时间（毫秒时间戳）
    pub last_ping_at: Arc<Mutex<Option<i64>>>,
    /// 心跳监控：最近一次收到 Pong 的时间
    pub last_pong_at: Arc<Mutex<Option<i64>>>,
    /// 最近一次 Ping 是否为手动触发（用于时间线展示往返延迟）
    pub manual_ping_pending: Arc<Mutex<bool>>,
    /// 自动回复规则（运行时可动态更新，无需重启）
    pub auto_replies: Arc<Mutex<Option<Vec<crate::db::AutoReplyRule>>>>,
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
