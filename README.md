# NetDebugger

Cross-platform network protocol debugger (Tauri v2 + Rust + vanilla HTML/CSS/JS). Currently focused on WebSocket debugging.

## Features

### Core Debugging

- WS server / client simulation; server supports multiple clients + multiple endpoint paths (path-based routing, 404 for unknown paths, targeted broadcast per endpoint)
- Message targets: broadcast to all / broadcast per endpoint / specific client
- Custom request headers and Subprotocols for clients (sent at handshake, e.g. Authorization, Origin, multi-subprotocol negotiation)
- Project grouping; sessions can be standalone or grouped; connections can be named and edited
- Message timeline (text / JSON highlighting / hex details), copy, search highlighting, persistent history, load-more on scroll up
- Unread badges bucketed by endpoint; endpoints shown as child nodes in the left connection tree (collapse/expand, click to filter)
- Connection status events (connect/disconnect) shown as centered gray text and persisted
- Automatic DB compaction on startup (VACUUM when free pages exceed 25%)

### UX

- Frameless window + custom titlebar (drag, double-click maximize, minimize/maximize/close), system tray, single-instance
- Theme switching (system / light / dark), draggable column splitters with persistence
- Custom dialog components (confirm / input / toast), custom scrollbar styling
- Long-message truncation toggle, instant hover tooltips
- Message templates / quick commands (Notion-style dropdown, localStorage persistence)
- Settings dialog (General / Shortcuts / About)

## Tech Stack

Tauri v2 · Rust (Tokio) · tokio-tungstenite · SQLite (tokio-rusqlite) · tauri-plugin-store · tauri-plugin-single-instance · tauri-plugin-updater · vanilla HTML/CSS/JS (no frontend build tool)

## Requirements

- Rust (edition 2021, rust-version ≥ 1.77.2)
- Tauri v2 system dependencies: WebView2 on Windows; Xcode Command Line Tools on macOS; `webkit2gtk-4.1` etc. on Linux

## Build & Run

Development:

```powershell
cd src-tauri
cargo tauri dev
```

Check / tests:

```powershell
cd src-tauri
cargo check
cargo test
```

Release build (one-click script, versioned artifact output to `dist\`):

```powershell
.\build.ps1
```

## Releases & Auto-Update

Pushing a `v*` tag triggers GitHub Actions to build Windows and macOS bundles, sign them, and publish a GitHub Release with a `latest.json` manifest. The app checks for updates on startup and every 30 minutes, showing a badge when a new version is available.

## Data Storage

Config and database are stored in the system app data directory (identifier `top.imzz.netdebugger`). The actual path depends on the platform:

| Platform | Path |
| -------- | ---- |
| Windows | `%APPDATA%\top.imzz.netdebugger` (e.g. `C:\Users\<User>\AppData\Roaming\top.imzz.netdebugger`) |
| macOS | `~/Library/Application Support/top.imzz.netdebugger` |
| Linux | `$XDG_DATA_HOME/top.imzz.netdebugger` or `~/.local/share/top.imzz.netdebugger` |

The main files in this directory:

- `debugger.db` — SQLite database (sessions, clients, message history)
- `store.bin` — persisted settings (theme, window size, minimize-to-tray)

## Translation

[简体中文](README.zh-CN.md)

## License

[Apache-2.0](LICENSE)