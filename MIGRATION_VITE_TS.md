# NetDebugger 前端 Vite + TypeScript 迁移 · 实施计划

> 本文档是前端 Vite + TypeScript 迁移的详细实施计划。按章节依次执行，每完成一个任务即在第 0 节勾选并记录日期/commit。迁移完成后再归档进 [PROJECT_STATUS.md](PROJECT_STATUS.md)。

## 0. 进度跟踪表

每完成一个任务：勾选 `[x]` + 填写日期与 commit。

### 阶段 1 — 基础设施（不动业务行为）

- [ ] T1.1 新增 `ui/package.json`、`ui/vite.config.ts`、`ui/tsconfig.json`（strict）
- [ ] T1.2 新建 `ui/public/` 并移入 `app-icon.png` / `titlebar-icon.png`
- [ ] T1.3 `ui/index.html` 的 `<script src="app.js">` → `<script type="module" src="/src/main.ts">`
- [ ] T1.4 新建 `ui/src/` 最小骨架（`main.ts` + `utils.ts`），`app.js` 内容整块搬入，Vite 下原样跑通
- [ ] T1.5 `build.ps1` 输出改 `release/`；`.gitignore` 追加 `/release/`、`/ui/node_modules/`
- [ ] T1.6 `tauri.conf.json` build 段（beforeDevCommand/beforeBuildCommand/devUrl/frontendDist）
- [ ] T1.7 `release.yml` build 作业加 `setup-node` + `npm --prefix ui ci`
- [ ] T1.8 验收：`npm --prefix ui run build` 出 `dist/` + `cargo check` + `cargo tauri dev` 正常

### 阶段 2 — TypeScript 化（按模块增量，每步 `tsc --noEmit` 校验）

- [ ] T2.1 `types.ts` — 全部数据结构类型
- [ ] T2.2 `state.ts` — state + els 类型化 + 13 处隐式全局收口
- [ ] T2.3 `api.ts` — 40 命令 + 6 事件类型化封装 + `tauri.d.ts` ambient 声明
- [ ] T2.4 `utils.ts` — 纯函数工具迁移（先于依赖它的模块）
- [ ] T2.5 `timeline.ts` — 渲染/统计/详情/JSON 树/批量/客户端列表/搜索导航
- [ ] T2.6 `session.ts` — 会话弹框/生命周期/日志开关/发送/清空/Ping/心跳
- [ ] T2.7 `dialogs.ts` — 收藏/预览/Diff/批量/模板编辑/设置/确认弹框/toast/更新弹框
- [ ] T2.8 `menus.ts` — 连接菜单/消息菜单/复制为/模板菜单
- [ ] T2.9 `settings.ts` — 主题/截断/无边框窗口/分栏/initSendKeyMode
- [ ] T2.10 `main.ts` — init 装配（引用各模块 initXxx）
- [ ] T2.11 验收：`tsc --noEmit` 全绿 + `cargo tauri dev` 行为不变

### 阶段 3 — 收尾

- [ ] T3.1 三绿校验：`tsc --noEmit`、`cargo check`、`npm run build`
- [ ] T3.2 删除 `ui/app.js`（旧单文件）
- [ ] T3.3 更新 `AGENTS.md`（目录结构/命令/技术栈标注 Vite+TS）
- [ ] T3.4 更新 `PROJECT_STATUS.md`（技术债务：app.js 单文件已模块化拆分）

---

## 1. 背景与目标

### 1.1 现状痛点

- `ui/app.js` 单文件 **4159 行 / 163 个全局函数**，无模块边界、无类型检查
- `state` / `els` 两个大对象 + 大量 `document.getElementById`，隐式耦合
- DOM id 拼写、状态字段遗漏等 bug 靠运行时暴露，无法静态发现

### 1.2 目标

- 引入 Vite（构建） + TypeScript（strict 类型） + `@tauri-apps/api`（devDeps 类型辅助）
- 按 UI 区域拆成 10 个模块文件，行为完全不变
- 保持 `window.__TAURI__` 全局注入（ambient 声明），不换 npm import，最小化改动

### 1.3 非目标（本次不做）

- 后端模块化重构（`commands.rs`/`db.rs`/`ws.rs` 拆分）
- MQTT / TCP 协议开发
- 状态管理库引入

---

## 2. 现状分析（关键事实）

### 2.1 后端命令（前端 `invoke` 共 40 个）

`clear_messages, count_messages_by_endpoint, create_project, create_session, delete_message, delete_messages_by_endpoint, delete_project, delete_session, disconnect_client, exit_app, export_messages, export_workspace, get_app_version, get_heartbeat_status, get_log_dir, get_message_by_id, get_minimize_to_tray, get_theme, hide_window, import_workspace, list_clients, list_projects, load_messages, load_pinned_messages, pick_log_dir, send_message, send_ping, set_log_dir, set_message_pinned, set_minimize_to_tray, set_session_logging, set_theme, start_session, stop_session, subscribe_timeline, update_auto_replies, update_client_name, update_project, update_session`

### 2.2 前端 listen 事件（6 个）

`session:status, session:error, session:message, session:client_connected, session:client_disconnected, window:close-requested`

### 2.3 模块级隐式全局（13 处，迁移时收进 state.ts）

`runtimeStatus(Map), contextMenuEl, msgMenuEl, batchAbort, batchRunning, tipEl, editingAutoReplyRuleId, editingAutoReplySessionId, TPL_MIN_W, TPL_MIN_H, copyAsMenuEl, layout, hasUpdate`（另含 `updateDownloaded/updateContentLength/updateProgressVisible`）

### 2.4 全文件共享工具函数（进 utils.ts）

`escapeHtml(482), findSession(281), formatBytesShort(2024), bytesToHex/bytesToText/bytesToBase64/bytesToEscaped, formatTime, formatBytes, highlightText, escapeRegExp, stripWsPrefix, extractPort, ensureWsScheme, hexToBytes, base64ToBytes, tryFormatJson, diffLines, getDiffText, hasJsonPath, msgDisplayText, isCompleteJson`

### 2.5 兼容性结论

- CSP `script-src 'self'`：Vite 产物为外部文件，兼容；dev 模式 CSP 不生效，正常
- `withGlobalTauri: true`：保持开启，用 ambient 声明类型化 `window.__TAURI__`
- Vite dev server 端口固定 5173（strictPort）

---

## 3. 目标目录结构

```
├── dist/                 # Vite 构建产物（tauri frontendDist 指向，git 忽略）
├── release/              # build.ps1 的 exe 产物（git 忽略，替代原 dist 用途）
├── ui/                   # Vite 项目根（index.html 就地保留）
│   ├── index.html        # script 改为 /src/main.ts
│   ├── vite.config.ts    # root=ui，outDir=../dist
│   ├── package.json      # vite / typescript / @tauri-apps/api
│   ├── tsconfig.json     # strict
│   ├── public/           # app-icon.png / titlebar-icon.png
│   └── src/
│       ├── main.ts       # 入口 + init 编排（块 36 + Tauri 导入）
│       ├── types.ts      # AppState/Session/Project/Client/TimelineMsg/AdvancedFilter/AutoReplyRule/Template/Layout
│       ├── state.ts      # state 全局 + els DOM 引用 + 隐式全局
│       ├── api.ts        # 40 命令 invoke 封装 + 6 事件注册（块 27）
│       ├── utils.ts      # 纯函数工具
│       ├── timeline.ts   # 渲染/统计/详情/JSON 树/批量/客户端列表/搜索导航
│       ├── session.ts    # 会话弹框/生命周期/日志开关/发送/清空/Ping/心跳
│       ├── dialogs.ts    # 收藏/预览/Diff/批量/模板编辑/设置/确认弹框/toast/更新弹框
│       ├── menus.ts      # 连接菜单/消息菜单/复制为/模板菜单
│       └── settings.ts   # 主题/截断/无边框窗口/分栏/initSendKeyMode
```

---

## 4. 关键配置

### 4.1 `ui/vite.config.ts`

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  root: __dirname,               // ui/
  base: './',
  build: { outDir: '../dist', emptyOutDir: true },
  server: { port: 5173, strictPort: true },
});
```

### 4.2 `ui/package.json`

```json
{
  "name": "netdebugger-ui",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@tauri-apps/api": "^2",
    "typescript": "^5",
    "vite": "^7"
  }
}
```

### 4.3 `ui/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": []
  },
  "include": ["src"]
}
```

### 4.4 `src-tauri/tauri.conf.json` build 段

```json
"build": {
  "beforeDevCommand": "npm --prefix ui run dev",
  "beforeBuildCommand": "npm --prefix ui run build",
  "devUrl": "http://localhost:5173",
  "frontendDist": "../dist"
}
```

### 4.5 `build.ps1`（输出改 release/）

```powershell
$distDir = Join-Path $repoRoot "release"        # 替代原 dist
$outExe   = Join-Path $distDir "NetDebugger_v${version}.exe"
```
（`cargo tauri build` 会自动触发 `beforeBuildCommand` 前端构建，无需手动调 npm）

### 4.6 `.gitignore` 追加

```
/release/
/ui/node_modules/
```
（`/dist/` 已忽略，现在含义变为前端产物）

### 4.7 `release.yml`（build 作业，Checkout 后）

```yaml
- name: Setup Node
  uses: actions/setup-node@v4
  with:
    node-version: lts/*

- name: Install frontend deps
  run: npm --prefix ui ci
```
（release 作业不改；tauri-action 会自动触发 beforeBuildCommand）

---

## 5. 分阶段实施

### 阶段 1 — 基础设施（不动业务行为）

按第 0 节 T1.1~T1.8 顺序执行，每步保持 `cargo tauri dev` 可跑。核心思路：`app.js` 先整块搬入 `ui/src/main.ts`（同行为、JS 语义），Vite 跑通后再加类型。

### 阶段 2 — TypeScript 化（按模块增量）

**迁移顺序**：`types.ts` → `state.ts` → `api.ts` → `utils.ts` → `timeline` → `session` → `dialogs` → `menus` → `settings` → `main.ts`。

每迁移一个模块：从 `main.ts` 剪切对应块到新文件，补类型，`npx tsc --noEmit` 校验，行为不变。模块间通过 `import { ... }` 引用，`state`/`els` 从 `state.ts` 导出。

### 阶段 3 — 收尾

三绿校验后删除旧 `app.js`，更新 AGENTS.md / PROJECT_STATUS.md。

---

## 6. 模块映射明细（36 块 → 目标模块）

> 行号基于 `ui/app.js`（4159 行）。迁移时以块为单位剪切。

| 目标模块 | 包含块（行号） | 说明 |
|---|---|---|
| **types** | 无独立区间 | 由 state 对象形状 + Session/Project/Client/Message 使用点推导 |
| **state** | 1~122（state/els/detailTab/jsonSubTab）+ 散落隐式全局（§2.3） | 拆 state + els 两处导出 |
| **utils** | 124~299、482~484(escapeHtml)、1138~1153(highlightText/escapeRegExp)、1228~1238(stripWsPrefix/extractPort)、1567~1571(ensureWsScheme)、2024~2028(formatBytesShort)、2547~2576(hexToBytes/base64ToBytes/tryFormatJson) | 纯函数 |
| **api** | 300~315(loadProjects)、3465~3541(listen 事件) | 命令封装 + 事件订阅 |
| **timeline** | 1762~1806、1808~2022、2024~2087、2130~2311、2313~2437、2439~2494、3164~3198、3201~3229、3272~3395 | 渲染/统计/详情/搜索 |
| **session** | 1155~1565、1567~1760、2089~2128、2496~2619、2644~2661、2748~2816、3129~3162 | 会话生命周期/发送 |
| **dialogs** | 671~831、833~899、901~1002、1004~1013、2992~3118、3593~3671、3673~3804、3990~4039、4050~4080 | 业务弹框 + 通用组件 |
| **menus** | 486~575、577~628、1015~1096、2827~2990、3397~3463 | 右键菜单/复制为 |
| **settings** | 3233~3253、3543~3591、2818~2825、3809~3859、3861~3969、4122~4130 | 主题/布局/窗口 |
| **main** | 1~2、4132~4159 | init 编排 |

**拆分歧义处理**：
- 块 7（901~1097）内部混有收藏/预览弹框监听（1004~1013）→ 归 dialogs
- `getDiffText`(213) 与 `diffLines`(224) 跨无注释边界 → 均进 utils
- 13 处隐式全局是拆分最易漏项，统一收进 state.ts

---

## 7. 对后续 TCP / MQTT 开发的影响

**总体结论**：本次迁移是后续多协议开发的必要前提且是利好——先把「协议无关通用能力」模块化固化，后续加协议主要是「新增协议适配模块 + 扩展类型/命令」，而非重写 UI。

### 7.1 可直接复用的通用能力（协议无关）

消息时间线（text/binary/notice 渲染、JSON 高亮、搜索、Diff、批量、收藏、统计、落盘、复制为）、`TimelineMsg` 数据模型（payload/direction/timestamp/endpoint/sender/pinned 已足够通用）、api.ts 中 create/update/send/load/export 等命令、通用弹框/toast/主题/模板/设置。

### 7.2 需预留的协议边界（迁移时留意，避免二次重构）

| 区域 | WS 特有 | 迁移时应做的事 |
|---|---|---|
| session.ts 会话表单 | endpoint/header/subprotocol/heartbeat/自动回复 | 表单字段**配置驱动**或按 `protocol` 分支，勿写死 WS 字段 |
| session.ts 发送/停止 | broadcast/指定客户端/定向 ep | 发送目标选择抽成协议可插拔（MQTT→topic，TCP→raw） |
| menus.ts 复制为 | 已有 cURL 文案自适应 | 协议文案表继续扩展（MQTT→Publish 命令） |
| timeline.ts endpoint 语义 | endpoint=路径 | endpoint 已是 `Option`：MQTT 映射 topic、TCP 置空，天然适配 |
| api.ts 命令 | send_ping/get_heartbeat_status/auto_replies | 命令按「通用/协议特有」分组标注，新协议只加特有命令 |

### 7.3 对后端的间接影响

前端迁移不改后端命令接口。建议在 api.ts 中按协议标注命令归属，为将来后端 ws.rs→protocol 目录拆分留好对齐点。本次不做后端改动。

---

## 8. 验收标准

1. `npm --prefix ui run typecheck`（`tsc --noEmit`）无错误
2. `cargo check` 无新增警告
3. `npm --prefix ui run build` 成功产出 `dist/`
4. `cargo tauri dev` 正常启动，既有功能行为不变
5. `.\build.ps1` 产出 `release\NetDebugger_v<版本>.exe`

---

## 9. 风险与注意事项

- **隐式全局**（§2.3 13 处）是拆分最易漏项，统一收口 state.ts
- **共享工具函数**（§2.4）先入 utils.ts，后续模块统一 import，避免重复定义
- **块 7 混区**（收藏/预览监听混在批量发送块）按 §6 处理
- **CSP / withGlobalTauri**：保持现状，ambient 声明类型化 `window.__TAURI__`
- **dist 目录**：根 `dist/` 完全让给前端产物；exe 产物改 `release/`，二者互不干扰
- **`base: './'`**：保证 Tauri 从本地文件加载资源路径正确
- 阶段 1 是「同行为搬移」，阶段 2 才逐步加类型；**每步必须保持可运行**，禁止大爆炸式一次重写