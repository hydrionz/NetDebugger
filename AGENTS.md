# AGENTS.md — NetDebugger 项目指南

> 本文档是任何 agent 在本仓库工作时的通用指南。项目详细状态归档见 [PROJECT_STATUS.md](PROJECT_STATUS.md)。

## 项目概况

跨平台网络协议调试器（Tauri v2 + Rust + 原生 HTML/CSS/JS），当前以 WebSocket 调试为主。

- **桌面端框架**：Tauri v2 + Rust
- **前端**：原生 HTML / CSS / JavaScript（无前端构建工具）
- **异步运行时**：Tokio
- **WebSocket 库**：tokio-tungstenite
- **数据库**：SQLite（tokio-rusqlite）
- **持久化配置**：tauri-plugin-store
- **单例运行**：tauri-plugin-single-instance

## 目录结构

```
├── build.ps1              # 一键构建脚本（产物 dist\NetDebugger_v<版本>.exe）
├── dist/                  # 构建产物输出目录（git 忽略）
├── PROJECT_STATUS.md      # 项目状态归档（已实现/待办/技术债务）
├── src-tauri/
│   ├── migrations/        # SQLite 数据库迁移脚本（001~006）
│   └── src/
│       ├── main.rs        # 入口
│       ├── lib.rs         # Tauri Builder、托盘、关闭事件、命令注册
│       ├── commands.rs    # 所有 Tauri 命令（业务 + 设置 + get_app_version）
│       ├── db.rs          # 数据库访问层
│       ├── state.rs       # 应用状态、SessionHandle、TimelineEvent
│       └── ws.rs          # WebSocket Server/Client 实现
└── ui/
    ├── index.html         # 主界面与设置弹框结构
    ├── app.js             # 前端逻辑
    └── styles.css         # 主题样式（浅色/深色/跟随系统）
```

## 开发规则

### 提交规则

完成功能后，**先不要提交**到 Git。必须等用户验证完成并明确说"提交"或"提交到 Git"时，再执行提交操作。

### 开发与审核规则

开发过程中持续做好代码审核：

1. 确保代码能正常编译/通过类型检查，无新增编译警告。
2. 尽量保持代码简洁明了、逻辑正确，遵循现有代码风格与既有模式，不做过度设计。
3. 写完后对改动做一次自查（编译通过 + 逻辑走查），确认没有明显问题或回归。

### 验证规则

开发完成后**不需要 agent 做任何测试验证操作**（包括但不限于：冒烟测试、E2E、UI 自动化、CDP/浏览器验证、协议连通性测试等）。直接向用户报告功能已完成，由用户自行测试验证；用户反馈问题后再修改。

## 常用命令

开发调试：

```powershell
cd src-tauri
cargo tauri dev
```

编译检查 / 单元测试：

```powershell
cd src-tauri
cargo check
cargo test
```

Release 构建（一键脚本，产物带版本号）：

```powershell
.\build.ps1
```

构建产物：`dist\NetDebugger_v<版本号>.exe`

## 已实现功能摘要

- WebSocket 服务端/客户端模拟；WS Server 多客户端 + 多 endpoint 路径（按路径路由、未知路径 404、按 endpoint 定向广播）；服务端监听地址只填端口、自动绑定 0.0.0.0
- 项目分组管理；会话可独立或归组；连接自定义命名与编辑
- 消息时间线（文本/JSON 高亮/十六进制详情、复制）、按 endpoint 未读角标、历史持久化、搜索高亮
- endpoint 作为左侧连接树子节点（折叠展开、未读角标、点击过滤）；连接右键菜单编辑/删除；启动/停止按钮常显
- 无边框窗口 + 自定义标题栏（拖拽、双击最大化、最小化/最大化/关闭）；启动无白屏（窗口初始隐藏、前端就绪后显示），窗口背景色随主题
- 系统托盘（左键单击显示/隐藏、无白块）；关闭按钮遵循"关闭后最小化到系统托盘"设置（勾选直接隐藏、否则弹确认框）
- 单例运行：只允许一个进程，再次启动直接激活已有窗口
- 主题下拉切换（系统/浅色/深色）、分栏拖拽调节、自定义弹框组件（确认/输入/toast）、设置弹框（通用/关于）
- 版本号单点维护于 Cargo.toml，标题栏/欢迎页/关于页统一显示

> 详细的已实现功能、待办列表、技术债务见 [PROJECT_STATUS.md](PROJECT_STATUS.md)。
