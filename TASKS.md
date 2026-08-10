# NetDebugger 任务与路线图

## 当前状态

第一版 MVP 已实现，功能包括 WebSocket 服务端/客户端模拟、项目分组、消息时间线、消息详情、历史持久化。

## 已完成

- [x] Tauri v2 + Rust 项目搭建
- [x] SQLite 持久化（项目、会话、消息）
- [x] 项目分组管理（增删）
- [x] 会话可独立存在，也可放入项目分组
- [x] 连接编辑功能（运行中禁止编辑）
- [x] 连接自定义命名
- [x] 左侧链接类型标签 + 状态颜色标识
- [x] 启动/停止合并为一个 toggle 按钮
- [x] 状态标签加粗、颜色提亮
- [x] WebSocket Server（单客户端/会话）
- [x] WebSocket Client
- [x] 聊天式消息时间线（文本/JSON/十六进制详情）
- [x] 窗口大小持久化
- [x] Windows release 构建验证

## 已修复

- 修复 `list_projects` 返回数据扁平化导致前端 `p.project` 为 undefined 的报错。
- 改造项目/会话关系：会话不再强依赖项目，允许未分组会话存在；数据库通过 migration 002 将 `sessions.project_id` 改为可空。
- 修复 `renderProjectTree` 重复注册事件监听器的问题。

## 已知限制

- WS Server 每个会话已支持多个客户端连接。
- 仅支持 WebSocket 协议；MQTT/TCP 已预留数据模型，未实现。
- 自动响应规则未实现。
- 面板宽度未持久化。
- 当前无单元测试覆盖网络逻辑。
- 停止 WS Server 后端口可能不会立即释放（依赖操作系统 TIME_WAIT）。

## 待开发功能

### 高优先级

- [ ] 修复用户后续测试中发现的 bug
- [x] WS Server 多客户端支持
- [ ] 消息发送目标选择（当前服务端只能发“所有连接”，客户端只能发服务端）
- [ ] 自动滚动策略：用户手动上滑查看历史时暂停自动滚动
- [ ] 端口占用时给 UI 友好提示

### 中优先级

- [ ] 面板宽度持久化
- [ ] 导出消息历史（JSON/文本）
- [ ] 清空历史快捷键 / 确认优化
- [ ] 连接状态图标和错误提示优化

### 低优先级 / 未来协议

- [ ] MQTT Client / Server
- [ ] TCP Client / Server
- [ ] 自动响应规则（按会话配置）
- [ ] 消息过滤 / 搜索

## 测试清单

- [ ] 创建项目
- [ ] 创建 WS Server 会话并启动
- [ ] 创建 WS Client 会话并连接到 Server
- [ ] 从 Client 发送消息，Server 时间线显示收到
- [ ] 从 Server 发送消息，Client 时间线显示收到
- [ ] 停止 Server，Client 显示 closed
- [ ] 点击消息查看 JSON / 十六进制详情
- [ ] 清空当前会话消息
- [ ] 重启应用，项目树和历史消息恢复
- [ ] 调整窗口大小，重启后恢复

## 技术债务

- `ws.rs` 中 server/client 的 `run_socket_loop` 可进一步拆分，便于后续多客户端改造。
- `app.js` 中状态和渲染耦合较紧，后续加复杂功能时可考虑引入轻量状态管理。

## 运行命令

开发：
```powershell
cd E:\000develop\learnProject\ai\demo\serverable\src-tauri
cargo tauri dev
```

Release 构建：
```powershell
cd E:\000develop\learnProject\ai\demo\serverable\src-tauri
cargo tauri build --no-bundle
```

构建产物：`src-tauri\target\release\app.exe`
