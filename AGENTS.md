# AGENTS.md — NetDebugger 项目指南

> 本文档是任何 agent 在本仓库工作时的通用指南。项目详细状态归档见 [PROJECT_STATUS.md](PROJECT_STATUS.md)。

## 项目概况

跨平台网络协议调试器（Tauri v2 + Rust），当前以 WebSocket 调试为主。

- **桌面端框架**：Tauri v2 + Rust
- **前端**：HTML / CSS / JavaScript（原生起步，允许引入构建工具）
- **异步运行时**：Tokio
- **WebSocket 库**：tokio-tungstenite
- **数据库**：SQLite（tokio-rusqlite）
- **持久化配置**：tauri-plugin-store
- **单例运行**：tauri-plugin-single-instance
- **自动更新**：tauri-plugin-updater

### 技术选型策略

- **前端与后端均允许使用任何构建工具或框架**（如 Vite、状态管理库、ORM 等），只要能让项目架构 / 逻辑处理更清晰、性能 / 稳定性 / 安全性更好，任何工具都可以评估并使用。
- 引入新工具前先评估其收益：不为用而用，优先保持简洁；选型时应说明其解决的具体问题与带来的收益。

### 开发阶段

- 项目当前处于**内部开发阶段**，允许任何形式的破坏性更新，包括：重构整个项目代码、重建数据库、清除所有数据等。
- 破坏性变更后需同步更新 `PROJECT_STATUS.md`（迁移记录、技术债务、已实现功能），保持文档与代码一致。

## 目录结构

```
├── build.ps1              # 一键构建脚本（产物 dist\NetDebugger_v<版本>.exe）
├── dist/                  # 构建产物输出目录（git 忽略）
├── PROJECT_STATUS.md      # 项目状态归档（已实现/待办/技术债务）
├── .github/workflows/     # GitHub Actions（release.yml：推送 v* 标签触发构建发布）
├── src-tauri/
│   ├── migrations/        # SQLite 数据库迁移脚本（001~014）
│   └── src/
│       ├── main.rs        # 入口
│       ├── lib.rs         # Tauri Builder、托盘、关闭事件、命令注册
│       ├── commands.rs    # 所有 Tauri 命令（业务/设置/导出导入/自动更新，可按需拆分模块）
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
4. 引入构建工具/框架时，同样须满足上述编译与风格要求，并说明其解决的问题与收益。

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

**WebSocket 核心**

- WS 服务端/客户端模拟；Server 多客户端 + 多 endpoint 路径（按路径路由、未知路径 404、按 endpoint 定向广播）；服务端监听地址只填端口、自动绑定 0.0.0.0
- 客户端自定义请求头 / Subprotocol、自动重连、自动心跳（Ping/Pong + 超时监控）、手动 Ping 往返延迟展示
- 自动回复规则（仅服务端）：包含/精确/正则匹配 → 文本/Hex/Base64 回复 + 延迟，运行时动态更新，并发化处理不阻塞接收
- 消息发送格式：文本 / Hex / Base64；发送前完整 JSON 自动格式化；按会话隔离的发送框草稿

**消息管理**

- 消息时间线（文本 / JSON 高亮 / 十六进制详情、复制）、搜索高亮、历史持久化、上滑分页加载
- 按 endpoint 未读角标；endpoint 作为左侧连接树子节点（折叠展开、点击过滤）
- 一键复制为（Raw / Hex / Base64 / Escaped / cURL）、消息对比 Diff、批量/压测发送、流量统计面板
- 收藏/标星消息（清空保留）、详情内搜索（Ctrl+F 多视图高亮）
- 时间线批量选择（导出/清空已选）、清空消息快捷键 Ctrl+L

**交互与界面**

- 项目分组管理；连接自定义命名与编辑；分组/连接右键菜单编辑与删除；启动/停止按钮常显
- 无边框窗口 + 自定义标题栏；启动无白屏；窗口背景色随主题；系统托盘；关闭确认；单例运行
- 主题切换（系统/浅色/深色）、分栏拖拽调节、自定义弹框组件（确认/输入/toast）
- 常用消息模板 / 快捷指令（全局侧边栏入口）、高级过滤（方向/类型/大小/正则/JSONPath）、JSON 树形折叠
- 应用图标高清化（任务栏/托盘/欢迎页/关于页统一）

**持久化与工作区**

- 持续落盘日志：按会话开关（工具栏图标 + 树节点角标联动），消息实时追加写文件（`<会话名>_<日期>.log`），目录为全局设置（默认应用数据目录/logs，可自选）
- 工作区导入导出：分组 + 连接配置 JSON 一键备份与恢复
- 数据库自动瘦身（VACUUM）；版本号单点维护于 Cargo.toml

**自动更新与 CI/CD**

- GitHub Actions 自动构建：推送 `v*` 标签触发 Windows 单平台构建并发布到 GitHub Releases
- Tauri 签名更新：产物自动签名，`latest.json` 含签名信息
- 应用内自动更新：启动静默检查 + 30 分钟定时 + 手动检查（标题栏旋转加载、红点角标）、更新弹框、下载进度浮窗

> 详细的已实现功能、待办列表、技术债务见 [PROJECT_STATUS.md](PROJECT_STATUS.md)。