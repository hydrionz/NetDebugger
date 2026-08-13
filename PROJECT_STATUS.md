# NetDebugger 项目状态归档

> 本文档记录 NetDebugger 的当前状态、已实现功能、待办事项及技术债务。开发规则见 [AGENTS.md](AGENTS.md)。
> 最后更新：2026-08-13（实现"发送框换行 + 发送键可配置"，从待办移除）

---

## 1. 项目概况

**名称**：NetDebugger
**定位**：跨平台网络协议调试器（Tauri v2 + Rust + 原生 HTML/CSS/JS），当前以 WebSocket 调试为主

**技术栈**：Tauri v2 · Tokio · tokio-tungstenite · SQLite (tokio-rusqlite) · tauri-plugin-store · tauri-plugin-single-instance

**版本**：单点维护于 `src-tauri/Cargo.toml`（`version` 字段）；标题栏 / 欢迎页 / 关于页 / 构建产物名（`NetDebugger_v<版本>.exe`）统一读取

---

## 2. 已实现功能

### 2.1 核心调试

- [x] WS 服务端 / 客户端模拟；WS Server 多客户端 + 多 endpoint 路径（握手按路径路由、未知路径 404、按 endpoint 定向广播）
- [x] 消息发送目标：全体广播 / 某 endpoint 全体广播 / 指定客户端（当前仅支持发送文本）
- [x] 项目分组管理；会话可独立或归组；连接自定义命名、编辑（运行中禁止编辑，协议/角色创建后锁定）
- [x] 客户端一个连接对应一个 endpoint（目标地址只填 host:port，endpoint 拼接到 URL）
- [x] 服务端监听地址只填端口，自动绑定 `0.0.0.0:端口`（连接树显示 `WS Server 0.0.0.0:port`）
- [x] 消息时间线（文本 / JSON 高亮 / 十六进制详情）、复制按钮、消息搜索与高亮、历史持久化
- [x] 未读角标按 endpoint 分桶；endpoint 作为左侧连接树子节点（折叠/展开、点击只看该路径、连接角标为各 endpoint 之和）
- [x] 服务端收到的消息气泡显示发送者（重命名客户端后显示名称，否则显示 IP 端口，重启后仍保留）

### 2.2 交互体验

- [x] 无边框窗口 + 自定义标题栏（拖拽、双击最大化、最小化/最大化/关闭按钮）
- [x] 左侧连接 S/C 角色徽标 + WS 协议标签；启动/停止按钮常显（绿/红）
- [x] 连接编辑/删除改为右键菜单（删除红色、运行中禁用）；运行中禁止删除
- [x] 点击已选中的连接/endpoint 再次点击取消选择回到欢迎页
- [x] 分栏拖拽调节宽度/高度并持久化（localStorage）
- [x] 主题下拉切换（系统/浅色/深色），设置弹框（通用 / 关于 左右两栏）
- [x] 自定义弹框组件（确认/输入/toast），危险操作确认按钮红色；无浏览器默认弹框
- [x] 端口占用 / 连接失败 toast 友好提示；禁用浏览器右键菜单
- [x] 系统托盘（左键单击显示/隐藏窗口、无白块）、关闭确认、窗口大小持久化
- [x] 单例运行：只允许一个进程，再次启动直接激活（显示 + 聚焦）已有窗口
- [x] 启动无白屏（窗口初始隐藏 `visible:false`，前端就绪后 `show()`），窗口背景色随主题
- [x] 关闭按钮遵循"关闭后最小化到系统托盘"设置（勾选则直接隐藏，否则弹确认框）

---

## 3. 已知限制

- 仅支持 WebSocket 协议；仅发送文本（二进制仅查看）
- 单元测试覆盖有限（仅 `resolve_endpoint` 的 4 个单测）
- 停止 WS Server 后端口可能不立即释放（依赖操作系统 `TIME_WAIT`）

---

## 4. 待开发功能

### 高优先级

- （当前无未完成的高优先级任务）

### 中优先级

- [ ] 导出消息历史（JSON/文本）
- [ ] 清空消息记录的键盘快捷键（如 `Ctrl+L` / `Delete`）
- [ ] 消息列表截断开关：聊天框工具栏（垃圾桶图标左侧）加切换按钮，控制长消息是否截断显示；关闭时显示完整消息

### 低优先级 / 未来协议

- [ ] MQTT Client / Server
- [ ] TCP Client / Server
- [ ] 自动响应规则（按会话配置）

---

## 5. 技术债务

- `app.js` 状态与渲染耦合较紧，后续加复杂功能可考虑引入轻量状态管理。
- `ws.rs` 中 server/client 的 socket loop 可进一步拆分。

---

## 6. 备注

- 主题持久化键：`theme`（`system` / `light` / `dark`）
- 最小化到托盘键：`minimize-to-tray`（布尔）
- 窗口大小键：`window-size`；分栏布局键：`netdebugger.layout`（localStorage）
- 配置 / 数据库位置：Tauri 应用本地数据目录（identifier 为 `top.imzz.netdebugger`）
