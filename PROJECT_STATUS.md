# NetDebugger 项目状态归档

> 本文档用于记录 NetDebugger 的当前状态、已实现功能、待办事项及开发规则，便于后续参考和继续开发。
> 最后更新：2026-08-10

---

## 1. 项目概况

**名称**：NetDebugger  
**定位**：跨平台网络协议调试器（当前以 WebSocket 调试为主）  
**技术栈**：

- 桌面端框架：Tauri v2 + Rust
- 前端：原生 HTML / CSS / JavaScript（无前端构建工具）
- 异步运行时：Tokio
- WebSocket 库：tokio-tungstenite
- 数据库：SQLite（通过 tokio-rusqlite）
- 持久化配置：tauri-plugin-store
- 图标：自定义抽象几何图形图标（已替换默认 Tauri 图标）

---

## 2. 目录结构

```
E:\000develop\learnProject\ai\demo\serverable
├── CLAUDE.md                 # 项目开发规则
├── TASKS.md                  # 路线图与待办（历史版本）
├── PROJECT_STATUS.md         # 本文档：项目状态归档
├── src-tauri/
│   ├── Cargo.toml            # Rust 依赖与 Tauri 特性配置
│   ├── tauri.conf.json       # Tauri 应用配置（窗口、CSP、图标等）
│   ├── icons/                # 应用图标资源
│   ├── migrations/           # SQLite 数据库迁移脚本
│   └── src/
│       ├── main.rs           # 入口
│       ├── lib.rs            # Tauri Builder、托盘、关闭事件、命令注册
│       ├── commands.rs       # 所有 Tauri 命令（业务 + 设置）
│       ├── db.rs             # 数据库访问层
│       ├── state.rs          # 应用状态、SessionHandle、TimelineEvent
│       └── ws.rs             # WebSocket Server/Client 实现
└── ui/
    ├── index.html            # 主界面与设置页结构
    ├── app.js                # 前端逻辑
    └── styles.css            # 主题样式（浅色/深色/跟随系统）
```

---

## 3. 已实现功能

### 3.1 核心调试功能

- [x] WebSocket 服务端/客户端模拟
- [x] 项目分组管理（新建、删除）
- [x] 会话可独立存在，也可归入项目分组
- [x] 连接自定义命名
- [x] 连接编辑（运行中禁止编辑）
- [x] 启动/停止合并为单个切换按钮
- [x] 左侧连接类型标签 + 状态颜色标识
- [x] 聊天式消息时间线（显示完整时间 `yyyy-MM-dd HH:mm:ss`）
- [x] 消息详情面板（文本 / JSON / 十六进制）
- [x] 未读消息角标
- [x] 消息历史持久化

### 3.2 窗口与交互体验

- [x] 未选择连接时显示水印图标占位页
- [x] 未选择连接时中间和右侧面板合并为一栏
- [x] 窗口大小持久化
- [x] 发送按钮在未建立连接时禁用并置灰
- [x] 自定义抽象几何应用图标

### 3.3 系统托盘与关闭行为

- [x] 程序启动后在系统托盘显示图标
- [x] 托盘左键单击：显示并聚焦主窗口
- [x] 托盘右键菜单：显示、退出
- [x] 设置中“关闭后最小化到系统托盘”选项
- [x] 关闭窗口时弹出确认框，框内包含同样的最小化选项
- [x] 首次选择后决定后续关闭行为（勾选则后续直接隐藏，否则每次确认）

### 3.4 设置与主题

- [x] 设置页占满整个窗口（左侧分类 + 右侧设置 + 底部按钮区）
- [x] 主题设置：跟随系统 / 浅色 / 深色
- [x] 选择主题时即时预览，保存后持久化，关闭时还原
- [x] 浅色模式配色优化：统一浅蓝底 + 黑字高亮

---

## 4. 后端命令清单（`src-tauri/src/commands.rs`）

| 命令 | 说明 |
|------|------|
| `create_project` | 新建分组 |
| `delete_project` | 删除分组 |
| `list_projects` | 获取分组及会话树 |
| `create_session` | 新建连接 |
| `update_session` | 编辑连接 |
| `delete_session` | 删除连接 |
| `load_messages` | 加载消息历史 |
| `clear_messages` | 清空消息历史 |
| `start_session` | 启动连接 |
| `stop_session` | 停止连接 |
| `send_message` | 发送消息 |
| `subscribe_timeline` | 订阅消息时间线 |
| `list_clients` | 列出 WS Server 客户端 |
| `update_client_name` | 重命名客户端 |
| `disconnect_client` | 断开指定客户端 |
| `get_minimize_to_tray` | 读取最小化到托盘设置 |
| `set_minimize_to_tray` | 保存最小化到托盘设置 |
| `get_theme` | 读取主题设置 |
| `set_theme` | 保存主题设置 |
| `hide_window` | 隐藏主窗口到托盘 |
| `exit_app` | 退出应用 |

---

## 5. 已知限制

- WS Server 每个会话已支持多个客户端连接。
- 仅支持 WebSocket 协议；MQTT/TCP 已预留数据模型，未实现。
- 自动响应规则未实现。
- 面板宽度未持久化。
- 单元测试覆盖范围有限（当前仅有 `resolve_endpoint` 的 4 个单测）。
- 停止 WS Server 后端口可能不会立即释放（依赖操作系统 `TIME_WAIT`）。

---

## 6. 待开发功能

### 高优先级

- [x] WS Server 多客户端完整支持
- [x] 消息发送目标选择（服务端选择客户端、客户端发服务端）
- [x] 自动滚动策略：用户手动上滑查看历史时暂停自动滚动
- [x] 前端页面禁用浏览器右键菜单
- [x] bug：聊天窗口无法滚动查看历史记录
- [x] “清空”按钮应该放置在聊天窗口的右上角，表明可清空当前聊天窗口的历史记录，而不是现在放在整个页面的右上角
- [x] 端口占用时给 UI 友好提示
- [x] 消息过滤 / 搜索

### 中优先级

- [ ] 面板宽度持久化
- [ ] 导出消息历史（JSON/文本）
- [ ] 清空历史快捷键 / 确认优化
- [ ] 连接状态图标和错误提示优化

### 低优先级 / 未来协议

- [ ] MQTT Client / Server
- [ ] TCP Client / Server
- [ ] 自动响应规则（按会话配置）


---

## 7. 开发规则

> 详见 `CLAUDE.md`，核心规则如下：

1. **提交规则**：完成功能后，**先不要提交**到 Git。必须等用户验证完成并明确说“提交”或“提交到 Git”时，再执行提交操作。
2. **验证规则**：每完成一个功能后，助手应先自行测试验证：
   - 检查相关代码是否能正常编译/运行。
   - 验证功能是否按预期工作。
   - 确认没有引入明显的问题或回归。
3. 自测没问题后，再向用户报告功能已完成，请用户验证。

---

## 8. 常用命令

### 开发调试

```powershell
cd E:\000develop\learnProject\ai\demo\serverable\src-tauri
cargo tauri dev
```

### Release 构建（不打包）

```powershell
cd E:\000develop\learnProject\ai\demo\serverable\src-tauri
cargo tauri build --no-bundle
```

构建产物：`src-tauri\target\release\app.exe`

---

## 9. 测试清单

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
- [ ] 系统托盘显示、左键显示窗口、右键退出
- [ ] 关闭确认框与最小化到托盘联动
- [ ] 主题切换、保存、重启后保持

---

## 10. 技术债务

- `ws.rs` 中 server/client 的 `run_socket_loop` 可进一步拆分，便于后续多客户端改造。
- `app.js` 中状态和渲染耦合较紧，后续加复杂功能时可考虑引入轻量状态管理。
- `ClientHandle` 中部分字段目前未被使用，存在编译警告。

---

## 11. 近期关键提交

- `ef69aad` — 优化浅色模式配色并统一选中/按钮高亮样式；新增主题、托盘最小化及全屏设置页。

---

## 12. 备注

- 主题持久化键：`theme`（值：`system` / `light` / `dark`）
- 最小化到托盘设置键：`minimize-to-tray`（布尔值）
- 窗口大小持久化键：`window-size`
- 配置文件位置：Tauri 应用本地数据目录下的 `store.bin`
