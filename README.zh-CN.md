# NetDebugger

跨平台网络协议调试器（Tauri v2 + Rust + 原生 HTML/CSS/JS）。当前以 WebSocket 调试为主。

## 功能特性

### 核心调试

- WS 服务端 / 客户端模拟；服务端多客户端 + 多 endpoint 路径（按路径路由、未知路径 404、按 endpoint 定向广播）
- 消息发送目标：全体广播 / 某 endpoint 全体广播 / 指定客户端
- 客户端自定义请求头与 Subprotocol（握手时发送，如 Authorization / Origin / 多子协议协商）
- 项目分组管理；会话可独立或归组；连接自定义命名与编辑
- 消息时间线（文本 / JSON 高亮 / 十六进制详情）、复制、搜索高亮、历史持久化、上滑加载更早历史
- 未读角标按 endpoint 分桶；endpoint 作为左侧连接树子节点（折叠/展开、点击只看该路径）
- 连接状态提示：连接/断开事件以灰色小字居中显示并持久化
- 数据库启动时自动瘦身（空闲页占比 > 25% 时 VACUUM）

### 交互体验

- 无边框窗口 + 自定义标题栏（拖拽、双击最大化、最小化/最大化/关闭）、系统托盘、单例运行
- 主题切换（系统 / 浅色 / 深色）、分栏拖拽调节并持久化
- 自定义弹框组件（确认 / 输入 / toast）、自定义滚动条样式
- 消息长消息截断开关、即时悬浮提示
- 常用消息模板 / 快捷指令（Notion 式下拉，localStorage 持久化）
- 设置弹框（通用 / 快捷键 / 关于）

### 发布与自动更新

- 推送 `v*` 标签自动触发 GitHub Actions 构建 Windows / macOS 安装包、签名并发布到 GitHub Releases
- 应用内自动更新：启动时与每 30 分钟静默检查更新，发现新版本时标题栏按钮显示红点角标

## 技术栈

Tauri v2 · Rust (Tokio) · tokio-tungstenite · SQLite (tokio-rusqlite) · tauri-plugin-store · tauri-plugin-single-instance · tauri-plugin-updater · 原生 HTML/CSS/JS（无前端构建工具）

## 环境要求

- Rust（edition 2021，rust-version ≥ 1.77.2）
- Tauri v2 系统依赖：Windows 需 WebView2；macOS 需 Xcode Command Line Tools；Linux 需 `webkit2gtk-4.1` 等

## 构建与运行

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

Release 构建（一键脚本，产物带版本号，输出到 `dist\`）：

```powershell
.\build.ps1
```

## 数据存储

配置与数据库保存在系统应用数据目录（identifier `top.imzz.netdebugger`），不同平台路径如下：

| 平台 | 路径 |
| ---- | ---- |
| Windows | `%APPDATA%\top.imzz.netdebugger`（如 `C:\Users\<用户名>\AppData\Roaming\top.imzz.netdebugger`） |
| macOS | `~/Library/Application Support/top.imzz.netdebugger` |
| Linux | `$XDG_DATA_HOME/top.imzz.netdebugger` 或 `~/.local/share/top.imzz.netdebugger` |

该目录下主要文件：

- `debugger.db`：SQLite 数据库（会话、客户端、消息历史）
- `store.bin`：持久化设置（主题、窗口大小、最小化到托盘）

## 开源许可

[Apache-2.0](LICENSE)