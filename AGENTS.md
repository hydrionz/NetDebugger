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

## 目录结构

```
├── PROJECT_STATUS.md        # 项目状态归档（已实现/待办/命令清单/测试清单）
├── src-tauri/
│   ├── migrations/          # SQLite 数据库迁移脚本（001~005）
│   └── src/
│       ├── main.rs          # 入口
│       ├── lib.rs           # Tauri Builder、托盘、关闭事件、命令注册
│       ├── commands.rs      # 所有 Tauri 命令（业务 + 设置）
│       ├── db.rs            # 数据库访问层
│       ├── state.rs         # 应用状态、SessionHandle、TimelineEvent
│       └── ws.rs            # WebSocket Server/Client 实现
└── ui/
    ├── index.html           # 主界面与设置页结构
    ├── app.js               # 前端逻辑
    └── styles.css           # 主题样式（浅色/深色/跟随系统）
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

Release 构建（不打包）：

```powershell
cd src-tauri
cargo tauri build --no-bundle
```

构建产物：`src-tauri\target\release\app.exe`

## 已实现功能摘要

- WebSocket 服务端/客户端模拟；WS Server 多客户端 + 多 endpoint 路径（按路径路由、未知路径 404、按 endpoint 定向广播）
- 项目分组管理；会话可独立或归组；连接自定义命名与编辑
- 消息时间线（文本/JSON/十六进制详情）、未读角标（按 endpoint 分桶）、消息历史持久化、消息搜索与高亮
- endpoint 作为左侧连接树子节点展示，带折叠展开与未读角标，点击过滤该路径消息
- 自定义弹框组件（确认/输入/toast），无浏览器默认弹框
- 系统托盘、关闭确认、主题（系统/浅色/深色）、窗口大小持久化

> 详细的已实现功能、待办列表、后端命令清单、测试清单见 [PROJECT_STATUS.md](PROJECT_STATUS.md)。
