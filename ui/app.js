const { invoke, Channel } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const state = {
  projects: [],
  selectedSessionId: null,
  selectedMessageId: null,
  messages: new Map(),
  channels: new Map(),
  clients: new Map(),
  selectedClientId: null,
  unreadCounts: new Map(),
  endpointFilter: new Map(),
  collapsedSessions: new Set(),
  searchQuery: '',
  searchHits: [],
  activeHitIndex: -1,
  advancedFilter: { direction: 'all', payloadType: 'all', minSize: null, maxSize: null, useRegex: false, regexPattern: '', jsonPath: '' },
  truncateMessages: true,  // 长消息截断显示（工具栏"截断"切换，localStorage 持久化）
  sendKeyMode: 'enter',  // 'enter' = Enter 发送/Shift+Enter 换行；'ctrlEnter' = Ctrl+Enter 发送/Enter 换行
  sendDrafts: new Map(), // sessionId -> 发送框草稿，按会话隔离
  bulkSelectMode: false,
  bulkSelected: new Set(), // 批量选择的 message id（含 notice 临时 id）
  autoScroll: true,
  hasMoreOlder: new Map(),  // sessionId → 是否还有更早的历史可加载
  loadingOlder: new Set(),  // 正在加载更早历史的 sessionId
  endpointDraft: [],
  headerDraft: [],
  subprotocolDraft: [],
  autoReplyDraft: [],
  templates: [],
  activeTemplate: null,
  diffBaseId: null,
  statsPeak: new Map(),
  statsWindows: new Map(),
  detailSearchQuery: '',
  detailSearchIndex: -1,
};

const els = {
  projectTree: document.getElementById('project-tree'),
  timeline: document.getElementById('timeline'),
  clientListBar: document.getElementById('client-list-bar'),
  clientList: document.getElementById('client-list'),
  detailEmpty: document.getElementById('detail-empty'),
  detailContent: document.getElementById('detail-content'),
  detailEndpoint: document.getElementById('detail-endpoint'),
  detailTime: document.getElementById('detail-time'),
  detailSize: document.getElementById('detail-size'),
  detailBody: document.getElementById('detail-body'),
  sendTarget: document.getElementById('send-target'),
  sendInput: document.getElementById('send-input'),
  sendMode: document.getElementById('send-mode'),
  tplTrigger: document.getElementById('tpl-trigger'),
  tplMenu: document.getElementById('tpl-menu'),
  tplMenuGlobal: document.getElementById('tpl-menu-global'),
  dlgTemplate: document.getElementById('dlg-template'),
  dlgTemplateMessage: document.getElementById('dlg-template-message'),
  dlgTemplateName: document.getElementById('dlg-template-name'),
  dlgTemplateContent: document.getElementById('dlg-template-content'),
  btnTemplateOk: document.getElementById('btn-template-ok'),
  btnTemplateCancel: document.getElementById('btn-template-cancel'),
  settingSendKeyMode: document.getElementById('setting-send-key-mode'),
  dlgProject: document.getElementById('dlg-project'),
  dlgProjectTitle: document.getElementById('dlg-project-title'),
  editProjectId: document.getElementById('edit-project-id'),
  projectName: document.getElementById('project-name'),
  dlgSession: document.getElementById('dlg-session'),
  dlgSessionTitle: document.getElementById('dlg-session-title'),
  editSessionId: document.getElementById('edit-session-id'),
  sessionName: document.getElementById('session-name'),
  sessionProject: document.getElementById('session-project'),
  sessionProtocol: document.getElementById('session-protocol'),
  sessionRole: document.getElementById('session-role'),
  sessionServerConfig: document.getElementById('session-server-config'),
  sessionClientConfig: document.getElementById('session-client-config'),
  sessionPort: document.getElementById('session-port'),
  sessionUrl: document.getElementById('session-url'),
  sessionClientEndpoint: document.getElementById('session-client-endpoint'),
  sessionAutoReconnect: document.getElementById('session-auto-reconnect'),
  sessionHeartbeat: document.getElementById('session-heartbeat'),
  endpointList: document.getElementById('endpoint-list'),
  endpointInput: document.getElementById('endpoint-input'),
  btnEndpointAdd: document.getElementById('btn-endpoint-add'),
  autoReplyTbody: document.getElementById('autoreply-tbody'),
  autoReplyEmpty: document.getElementById('autoreply-empty'),
  autoReplyMatchType: document.getElementById('autoreply-match-type'),
  autoReplyPattern: document.getElementById('autoreply-pattern'),
  autoReplyReplyType: document.getElementById('autoreply-reply-type'),
  autoReplyReply: document.getElementById('autoreply-reply'),
  autoReplyDelay: document.getElementById('autoreply-delay'),
  btnAutoReplyNew: document.getElementById('btn-autoreply-new'),
  headerList: document.getElementById('header-list'),
  headerKeyInput: document.getElementById('header-key-input'),
  headerValueInput: document.getElementById('header-value-input'),
  btnHeaderAdd: document.getElementById('btn-header-add'),
  subprotocolList: document.getElementById('subprotocol-list'),
  subprotocolInput: document.getElementById('subprotocol-input'),
  btnSubprotocolAdd: document.getElementById('btn-subprotocol-add'),
  timelineSearch: document.getElementById('timeline-search'),
  btnSearchClear: document.getElementById('btn-search-clear'),
  btnTruncateToggle: document.getElementById('btn-truncate-toggle'),
  advancedFilterPanel: document.getElementById('advanced-filter-panel'),
  filterDirection: document.getElementById('filter-direction'),
  filterType: document.getElementById('filter-type'),
  filterMinSize: document.getElementById('filter-min-size'),
  filterMaxSize: document.getElementById('filter-max-size'),
  filterUseRegex: document.getElementById('filter-use-regex'),
  filterRegexPattern: document.getElementById('filter-regex-pattern'),
  filterJsonPath: document.getElementById('filter-jsonpath'),
  settingsView: document.getElementById('dlg-settings'),
  settingMinimizeToTray: document.getElementById('setting-minimize-to-tray'),
  themeBtn: document.getElementById('btn-theme'),
  themeMenu: document.getElementById('theme-menu'),
  dlgCloseConfirm: document.getElementById('dlg-close-confirm'),
  closeConfirmMinimizeToTray: document.getElementById('close-confirm-minimize-to-tray'),
};

let detailTab = 'text';
let jsonSubTab = localStorage.getItem('json-subtab') || 'code';

function formatTime(ts) {
  const d = new Date(ts);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hour = String(d.getHours()).padStart(2, '0');
  const minute = String(d.getMinutes()).padStart(2, '0');
  const second = String(d.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function formatBytes(bytes) {
  if (bytes.length < 1024) return bytes.length + ' B';
  return (bytes.length / 1024).toFixed(2) + ' KB';
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}

function bytesToText(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return '[binary]';
  }
}

function bytesToBase64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function bytesToEscaped(bytes) {
  return JSON.stringify(bytesToText(bytes));
}

function buildCurlCommand(session, msg) {
  // 协议自适应：WS 显示 cURL，未来 MQTT 可显示 mosquitto_pub 等
  let url = '';
  if (session) {
    if (session.role === 'client') {
      url = session.target_url || '';
      if (msg.endpoint && !url.includes(msg.endpoint)) {
        url = url.replace(/\/+$/, '') + msg.endpoint;
      }
    } else {
      const port = extractPort(session.bind_addr) || '8080';
      url = `ws://127.0.0.1:${port}`;
      if (msg.endpoint) url += msg.endpoint;
      else if (session.endpoints && session.endpoints[0]) url += session.endpoints[0];
    }
    if (url && !/^wss?:\/\//.test(url)) url = 'ws://' + url;
  }
  if (!url) url = 'ws://127.0.0.1:8080/';
  const text = bytesToText(msg.payload);
  const escaped = text.replace(/'/g, `'\\''`);
  let headerArgs = '';
  if (session && session.headers) {
    for (const [k, v] of Object.entries(session.headers)) {
      const hv = `${k}: ${v}`.replace(/'/g, `'\\''`);
      headerArgs += ` \\\n  -H '${hv}'`;
    }
  }
  if (session && session.subprotocols && session.subprotocols.length) {
    const sp = session.subprotocols.join(', ').replace(/'/g, `'\\''`);
    headerArgs += ` \\\n  -H 'Sec-WebSocket-Protocol: ${sp}'`;
  }
  const baseHeaders = `  -H 'Connection: Upgrade' \\\n  -H 'Upgrade: websocket' \\\n  -H 'Sec-WebSocket-Version: 13' \\\n  -H 'Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw=='`;
  if (msg.payload_type === 'binary') {
    const b64 = bytesToBase64(msg.payload);
    const hex = bytesToHex(msg.payload);
    return `curl -i -N \\\n${baseHeaders}${headerArgs} \\\n  '${url}' \\\n  --data-binary $'${escaped}'\n# binary base64: ${b64}\n# hex: ${hex}`;
  }
  return `curl -i -N \\\n${baseHeaders}${headerArgs} \\\n  '${url}' \\\n  --data-raw '${escaped}'`;
}

async function copyWithToast(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('已复制为 ' + label);
  } catch (e) {
    showError('复制失败: ' + e);
  }
}

function getDiffText(m) {
  if (m.payload_type === 'binary') return bytesToHex(m.payload);
  const raw = bytesToText(m.payload);
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') return JSON.stringify(parsed, null, 2);
  } catch {}
  return raw;
}

// ponytail: O(n*m) LCS, fine for typical messages (<500 lines); large payloads may be slow — switch to streaming diff if needed
function diffLines(aLines, bLines) {
  const m = aLines.length;
  const n = bLines.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (aLines[i - 1] === bLines[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = dp[i - 1][j] >= dp[i][j - 1] ? dp[i - 1][j] : dp[i][j - 1];
    }
  }
  const ops = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aLines[i - 1] === bLines[j - 1]) {
      ops.push({ type: 'equal', a: aLines[i - 1], b: bLines[j - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'insert', b: bLines[j - 1] });
      j--;
    } else {
      ops.push({ type: 'delete', a: aLines[i - 1] });
      i--;
    }
  }
  ops.reverse();
  return ops;
}

function hasJsonPath(obj, path) {
  let p = path.trim().replace(/^\$\.?/, '');
  if (!p) return true;
  p = p.replace(/\[/g, '.').replace(/\]/g, '');
  const parts = p.split('.').filter(Boolean);
  let cur = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return false;
    if (!(part in cur)) return false;
    cur = cur[part];
  }
  return true;
}

// 消息气泡显示的文本：二进制帧显示为十六进制，文本帧显示为 UTF-8 文本
function msgDisplayText(m) {
  return m.payload_type === 'binary' ? bytesToHex(m.payload) : bytesToText(m.payload);
}

// 判断字节流是否为完整 JSON（对象或数组；null 与字面量不算）
function isCompleteJson(bytes) {
  try {
    const v = JSON.parse(bytesToText(bytes));
    return v !== null && typeof v === 'object';
  } catch {
    return false;
  }
}

function findSession(id) {
  for (const p of state.projects) {
    for (const s of p.sessions) {
      if (s.id === id) return s;
    }
  }
  return null;
}

// 运行时状态缓存：记录事件推送的最新 status，防止 loadProjects 用过期 DB 快照覆盖
const runtimeStatus = new Map();

function recordRuntimeStatus(sessionId, patch) {
  const cur = runtimeStatus.get(sessionId) || {};
  runtimeStatus.set(sessionId, { ...cur, ...patch });
  const s = findSession(sessionId);
  if (s) Object.assign(s, patch);
}

async function loadProjects() {
  try {
    state.projects = await invoke('list_projects');
    // 回填运行时状态（DB 快照可能滞后于实际运行状态）
    for (const p of state.projects) {
      for (const s of p.sessions) {
        const rt = runtimeStatus.get(s.id);
        if (rt) Object.assign(s, rt);
      }
    }
    renderProjectTree();
    updateSessionDialogProjects();
  } catch (e) {
    console.error('list_projects failed', e);
  }
}

function renderProjectTree() {
  els.projectTree.innerHTML = '';

  if (state.projects.length === 0 || (state.projects.length === 1 && state.projects[0].project.id === '_ungrouped' && state.projects[0].sessions.length === 0)) {
    els.projectTree.innerHTML = '<div class="detail-empty">暂无连接，点击上方「新建连接」</div>';
    return;
  }

  for (const p of state.projects) {
    const group = document.createElement('div');
    group.className = 'project-group';

    const isUngrouped = p.project.id === '_ungrouped';

    const header = document.createElement('div');
    header.className = 'project-header';
    header.innerHTML = `
      <span class="project-toggle">▼</span>
      <span class="project-name">${escapeHtml(p.project.name)}</span>
      <span class="project-actions">
        <button data-action="add-session" data-project="${p.project.id}" data-tip="添加连接">+</button>
      </span>
    `;
    header.addEventListener('click', (ev) => {
      if (ev.target.closest('button')) return;
      const list = group.querySelector('.session-list');
      const toggle = header.querySelector('.project-toggle');
      list.classList.toggle('hidden');
      toggle.textContent = list.classList.contains('hidden') ? '▶' : '▼';
    });
    // 右键菜单：编辑（重命名）/ 删除（与连接一致的操作逻辑）
    if (!isUngrouped) {
      header.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        showProjectContextMenu(ev.clientX, ev.clientY, p.project.id);
      });
    }

    const list = document.createElement('div');
    list.className = 'session-list';

    for (const s of p.sessions) {
      // endpoint 子节点集合（配置的 + 已加载消息中出现的）；仅服务端展示
      const isServer = s.role === 'server';
      const eps = new Set(isServer ? (s.endpoints || []) : []);
      for (const m of state.messages.get(s.id) || []) if (isServer && m.endpoint) eps.add(m.endpoint);
      const hasEps = eps.size > 0;
      const collapsed = state.collapsedSessions.has(s.id);

      const item = document.createElement('div');
      item.className = 'session-item' + (s.id === state.selectedSessionId ? ' selected' : '');
      item.dataset.id = s.id;
      const label = s.role === 'server'
        ? (s.bind_addr || ':?')
        : (s.target_url || '?');
      const canEdit = s.status !== 'starting' && s.status !== 'running';
      const typeLabel = s.protocol === 'ws' ? 'WS' : s.protocol.toUpperCase();
      const roleLabel = s.role === 'server' ? 'S' : 'C';
      const roleClass = s.role === 'server' ? 'role-server' : 'role-client';
      const roleTitle = s.role === 'server' ? '服务端' : '客户端';
      const displayName = s.name || (s.role === 'server'
        ? s.bind_addr || ':?'
        : s.target_url || '?');

      const isRunning = s.status === 'running' || s.status === 'starting';
      const toggleAction = isRunning ? 'stop' : 'start';
      const toggleIcon = isRunning ? '⏹' : '▶';
      const toggleTitle = isRunning ? '停止' : '启动';
      const toggleClass = isRunning ? 'btn-stop' : 'btn-start';

      // 未读角标按 endpoint 分桶；连接的角标为各 endpoint 之和。
      const epUnread = state.unreadCounts.get(s.id) || new Map();
      const sessionUnread = [...epUnread.values()].reduce((a, b) => a + b, 0);
      const badge = sessionUnread > 0
        ? `<span class="session-badge">${sessionUnread > 99 ? '99+' : sessionUnread}</span>`
        : '';

      const expander = hasEps
        ? `<span class="session-expander" data-tip="${collapsed ? '展开' : '折叠'}">${collapsed ? '▶' : '▼'}</span>`
        : '';

      item.innerHTML = `
        ${expander}
        <span class="session-type ${s.status}">${escapeHtml(typeLabel)}</span>
        <span class="role-badge ${roleClass}" data-tip="${roleTitle}">${escapeHtml(roleLabel)}</span>
        <span class="session-name">${escapeHtml(displayName)}</span>
        ${badge}
        <span class="session-actions">
          <button data-action="${toggleAction}" data-session="${s.id}" class="${toggleClass}" data-tip="${toggleTitle}">${toggleIcon}</button>
        </span>
      `;
      item.addEventListener('click', (ev) => {
        if (ev.target.closest('button')) return;
        if (ev.target.closest('.session-expander')) {
          toggleSessionCollapse(s.id);
          return;
        }
        // 再次点击已选中的连接则取消选择
        if (state.selectedSessionId === s.id && (state.endpointFilter.get(s.id) || 'all') === 'all') {
          selectSession(null);
        } else {
          selectSession(s.id);
        }
      });
      // 右键菜单：编辑 / 删除
      item.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        showSessionContextMenu(ev.clientX, ev.clientY, s.id, canEdit, isRunning);
      });
      list.appendChild(item);

      // endpoint 子节点：每个 endpoint 一行，带自己的未读角标；点击只看该 endpoint。
      if (hasEps && !collapsed) {
        const epList = document.createElement('div');
        epList.className = 'endpoint-tree';
        for (const ep of eps) {
          const epItem = document.createElement('div');
          const isEpSelected = state.selectedSessionId === s.id && state.endpointFilter.get(s.id) === ep;
          epItem.className = 'endpoint-item-tree' + (isEpSelected ? ' selected' : '');
          const epBadge = (epUnread.get(ep) || 0) > 0
            ? `<span class="session-badge">${(epUnread.get(ep) || 0) > 99 ? '99+' : (epUnread.get(ep) || 0)}</span>`
            : '';
          epItem.innerHTML = `<span class="endpoint-path">${escapeHtml(ep)}</span>${epBadge}`;
          epItem.addEventListener('click', () => {
            // 与连接一致：再次点击已选中的 endpoint 则取消选择回欢迎页
            if (state.selectedSessionId === s.id && state.endpointFilter.get(s.id) === ep) {
              selectSession(null);
            } else {
              selectSession(s.id, ep);
            }
          });
          epList.appendChild(epItem);
        }
        list.appendChild(epList);
      }
    }

    group.appendChild(header);
    group.appendChild(list);
    els.projectTree.appendChild(group);
  }
}

els.projectTree.addEventListener('click', handleTreeAction);

function handleTreeAction(ev) {
  const btn = ev.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;

  if (action === 'add-session') {
    openSessionDialog(btn.dataset.project);
  } else if (action === 'start') {
    startSession(btn.dataset.session);
  } else if (action === 'stop') {
    stopSession(btn.dataset.session);
  }
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ===== 连接右键菜单（编辑 / 删除）=====
let contextMenuEl = null;

function ensureContextMenu() {
  if (contextMenuEl) return;
  contextMenuEl = document.createElement('div');
  contextMenuEl.className = 'context-menu hidden';
  contextMenuEl.innerHTML = `
    <div class="context-menu-item" data-ctx="edit"><span class="ctx-icon">✎</span><span class="ctx-label">编辑</span></div>
    <div class="context-menu-item" data-ctx="autoreply"><span class="ctx-icon">↻</span><span class="ctx-label">自动回复</span></div>
    <div class="context-menu-item" data-ctx="delete"><span class="ctx-icon">×</span><span class="ctx-label">删除</span></div>
  `;
  document.body.appendChild(contextMenuEl);

  contextMenuEl.addEventListener('click', (e) => {
    const item = e.target.closest('[data-ctx]');
    const kind = contextMenuEl.dataset.kind;
    const id = contextMenuEl.dataset.targetId;
    if (!item || item.classList.contains('disabled') || !kind || !id) return;
    hideContextMenu();
    if (kind === 'project') {
      if (item.dataset.ctx === 'edit') {
        const p = state.projects.find((p) => p.project.id === id);
        if (p) openEditProjectDialog(p.project);
      } else if (item.dataset.ctx === 'delete') {
        deleteProject(id);
      }
      return;
    }
    if (item.dataset.ctx === 'edit') {
      const s = findSession(id);
      if (s) openEditSessionDialog(s);
    } else if (item.dataset.ctx === 'autoreply') {
      openAutoReplyDialog(id);
    } else if (item.dataset.ctx === 'delete') {
      deleteSession(id);
    }
  });

  // 点击其他区域或滚动时关闭菜单
  document.addEventListener('click', hideContextMenu);
  document.addEventListener('scroll', hideContextMenu, true);
}

function positionContextMenu(x, y) {
  contextMenuEl.classList.remove('hidden');
  contextMenuEl.style.left = x + 'px';
  contextMenuEl.style.top = y + 'px';
  // 防止菜单超出窗口右/下边界
  const rect = contextMenuEl.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    contextMenuEl.style.left = Math.max(0, window.innerWidth - rect.width) + 'px';
  }
  if (rect.bottom > window.innerHeight) {
    contextMenuEl.style.top = Math.max(0, window.innerHeight - rect.height) + 'px';
  }
}

function showSessionContextMenu(x, y, sessionId, canEdit, isRunning) {
  ensureContextMenu();
  contextMenuEl.dataset.kind = 'session';
  contextMenuEl.dataset.targetId = sessionId;
  // 运行中的连接不可编辑、不可删除/改自动回复
  contextMenuEl.querySelector('[data-ctx="edit"]').classList.toggle('disabled', !canEdit);
  contextMenuEl.querySelector('[data-ctx="delete"]').classList.toggle('disabled', isRunning);
  const s = findSession(sessionId);
  const isServer = s && s.role === 'server';
  const arItem = contextMenuEl.querySelector('[data-ctx="autoreply"]');
  arItem.classList.toggle('hidden', !isServer);
  arItem.classList.remove('disabled');
  positionContextMenu(x, y);
}

function showProjectContextMenu(x, y, projectId) {
  ensureContextMenu();
  contextMenuEl.dataset.kind = 'project';
  contextMenuEl.dataset.targetId = projectId;
  contextMenuEl.querySelector('[data-ctx="edit"]').classList.remove('disabled');
  contextMenuEl.querySelector('[data-ctx="delete"]').classList.remove('disabled');
  contextMenuEl.querySelector('[data-ctx="autoreply"]').classList.add('hidden');
  positionContextMenu(x, y);
}

function hideContextMenu() {
  if (contextMenuEl) {
    contextMenuEl.classList.add('hidden');
    contextMenuEl.dataset.kind = '';
    contextMenuEl.dataset.targetId = '';
  }
}

// ===== 消息气泡右键菜单（独立组件，样式与连接右键菜单一致）=====
let msgMenuEl = null;

function ensureMsgMenu() {
  if (msgMenuEl) return;
  msgMenuEl = document.createElement('div');
  msgMenuEl.className = 'context-menu hidden';
  msgMenuEl.innerHTML = `
    <div class="context-menu-item" data-msg-ctx="resend"><span class="ctx-icon">↻</span><span class="ctx-label">再次发送</span></div>
    <div class="context-menu-item has-submenu" data-msg-ctx="copy-parent"><span class="ctx-icon">⧉</span><span class="ctx-label">复制为 ...</span><span class="ctx-arrow">▶</span>
      <div class="context-submenu">
        <div class="context-menu-item" data-msg-ctx="copy-raw"><span class="ctx-icon">⧉</span><span class="ctx-label">Raw</span></div>
        <div class="context-menu-item" data-msg-ctx="copy-hex"><span class="ctx-icon">⬡</span><span class="ctx-label">Hex</span></div>
        <div class="context-menu-item" data-msg-ctx="copy-base64"><span class="ctx-icon">⬢</span><span class="ctx-label">Base64</span></div>
        <div class="context-menu-item" data-msg-ctx="copy-escaped"><span class="ctx-icon">❞</span><span class="ctx-label">Escaped</span></div>
        <div class="context-menu-item" data-msg-ctx="copy-curl"><span class="ctx-icon">⎘</span><span class="ctx-label">cURL</span></div>
      </div>
    </div>
    <div class="context-menu-item" data-msg-ctx="diff"><span class="ctx-icon">◨</span><span class="ctx-label" id="msg-diff-label">对比...</span></div>
    <div class="context-menu-item" data-msg-ctx="batch"><span class="ctx-icon">⚡</span><span class="ctx-label">批量发送...</span></div>
    <div class="context-menu-item" data-msg-ctx="pin"><span class="ctx-icon">★</span><span class="ctx-label" id="msg-pin-label">收藏</span></div>
    <div class="context-menu-separator"></div>
    <div class="context-menu-item" data-msg-ctx="delete"><span class="ctx-icon">×</span><span class="ctx-label">删除</span></div>
  `;
  document.body.appendChild(msgMenuEl);

  msgMenuEl.addEventListener('click', async (e) => {
    const item = e.target.closest('[data-msg-ctx]');
    const messageId = msgMenuEl.dataset.targetId;
    if (!item || item.classList.contains('disabled') || !messageId) return;
    const ctx = item.dataset.msgCtx;
    if (ctx === 'copy-parent') return;
    hideMsgMenu();
    if (ctx === 'resend') {
      resendMessage(messageId);
    } else if (ctx === 'delete') {
      await deleteMessage(messageId);
    } else if (ctx.startsWith('copy-')) {
      copyMessageAs(messageId, ctx.slice(5));
    } else if (ctx === 'diff') {
      handleDiffSelection(messageId);
    } else if (ctx === 'batch') {
      openBatchDialog(messageId);
    } else if (ctx === 'pin') {
      togglePin(messageId);
    }
  });

  document.addEventListener('click', hideMsgMenu);
  document.addEventListener('scroll', hideMsgMenu, true);
}

function copyMessageAs(messageId, format) {
  const id = state.selectedSessionId;
  if (!id) return;
  const msgs = state.messages.get(id) || [];
  const m = msgs.find((x) => x.id === messageId);
  if (!m) return;
  if (m.payload_type === 'notice') return;
  const session = findSession(id);
  let text = '';
  let label = format;
  switch (format) {
    case 'raw': text = bytesToText(m.payload); label = 'Raw'; break;
    case 'hex': text = bytesToHex(m.payload); label = 'Hex'; break;
    case 'base64': text = bytesToBase64(m.payload); label = 'Base64'; break;
    case 'escaped': text = bytesToEscaped(m.payload); label = 'Escaped'; break;
    case 'curl': text = buildCurlCommand(session, m); label = 'cURL'; break;
    default: return;
  }
  copyWithToast(text, label);
}

function handleDiffSelection(messageId) {
  const msgs = state.messages.get(state.selectedSessionId) || [];
  const m = msgs.find((x) => x.id === messageId);
  if (!m || m.payload_type === 'notice') { showError('该消息不可对比'); return; }
  if (state.diffBaseId === null) {
    state.diffBaseId = messageId;
    showToast('已选择基准消息，再选一条进行对比');
    renderTimeline();
  } else if (state.diffBaseId === messageId) {
    state.diffBaseId = null;
    showToast('已取消对比选择');
    renderTimeline();
  } else {
    const a = state.diffBaseId;
    const b = messageId;
    state.diffBaseId = null;
    renderTimeline();
    openDiffDialog(a, b);
  }
}

async function togglePin(messageId) {
  const id = state.selectedSessionId;
  if (!id) return;
  const msgs = state.messages.get(id) || [];
  let m = msgs.find((x) => x.id === messageId);
  // 收藏列表按 DB 全量展示，时间线可能未加载该消息，此时 m 可能不存在，需兜底查询
  let next;
  if (m) {
    if (m.payload_type === 'notice') return;
    next = !m.pinned;
  } else {
    try {
      const fetched = await invoke('get_message_by_id', { messageId });
      if (!fetched || fetched.payload_type === 'notice') return;
      next = !fetched.pinned;
    } catch { return; }
  }
  try {
    await invoke('set_message_pinned', { messageId, pinned: next });
    if (m) m.pinned = next ? 1 : 0;
    else {
      // 若内存中没有，尝试按需插入以保持时间线 ★ 角标一致（失败也不阻塞）
      try {
        const fetched = await invoke('get_message_by_id', { messageId });
        if (fetched) {
          const arr = state.messages.get(id) || [];
          // 按时间戳插入保持有序
          let idx = arr.findIndex(x => x.timestamp > fetched.timestamp);
          if (idx === -1) arr.push(fetched); else arr.splice(idx, 0, fetched);
          state.messages.set(id, arr);
        }
      } catch {}
      if (next === false) {
        // 取消收藏：若已插入则更新 pinned
        const arr = state.messages.get(id) || [];
        const nm = arr.find(x => x.id === messageId);
        if (nm) nm.pinned = 0;
      }
    }
    showToast(next ? '已收藏' : '已取消收藏');
    renderTimeline();
    renderDetail();
    // 刷新收藏弹窗（DB 全量）
    if (document.getElementById('dlg-favorites')?.open) await renderFavorites();
  } catch (e) {
    showError('收藏失败: ' + e);
  }
}

async function renderFavorites() {
  const list = document.getElementById('favorites-list');
  const empty = document.getElementById('favorites-empty');
  const noMatch = document.getElementById('favorites-no-match');
  if (!list) return;
  const id = state.selectedSessionId;
  let all = [];
  try {
    all = await invoke('load_pinned_messages', { sessionId: id });
  } catch {
    // 降级：内存过滤（兼容旧逻辑）
    all = (state.messages.get(id) || []).filter(m => m.pinned && m.payload_type !== 'notice');
  }
  const rawQ = (document.getElementById('favorites-search')?.value || '').trim();
  const q = rawQ.toLowerCase();
  let msgs = all;
  if (q) {
    msgs = all.filter(m => {
      const text = msgDisplayText(m).toLowerCase();
      const ep = (m.endpoint || '').toLowerCase();
      const dir = m.direction === 'in' ? 'in 接收 ↓' : 'out 发送 ↑';
      return text.includes(q) || ep.toLowerCase().includes(q) || dir.includes(q);
    });
  }
  list.innerHTML = '';
  if (empty) empty.style.display = all.length ? 'none' : 'block';
  if (noMatch) noMatch.style.display = all.length && !msgs.length ? 'block' : 'none';
  if (!all.length) { return; }
  if (!msgs.length) { return; }
  for (const m of msgs) {
    const item = document.createElement('div');
    item.style.cssText = 'display:flex; align-items:center; gap:8px; padding:8px; border-bottom:1px solid var(--border)';
    const preview = msgDisplayText(m);
    const short = preview.length > 80 ? preview.slice(0, 80) + '…' : preview;
    const shortHtml = rawQ ? highlightText(short, rawQ) : escapeHtml(short);
    item.innerHTML = `
      <div class="fav-main" style="flex:1; min-width:0; cursor:pointer">
        <div style="font-size:11px; color:var(--text-muted)">${formatTime(m.timestamp)} · ${m.direction === 'in' ? '↓' : '↑'} ${escapeHtml(m.endpoint || '—')} · ${m.size} B</div>
        <div style="font-family:monospace; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis">${shortHtml}</div>
      </div>
      <div style="display:flex; gap:4px; flex-shrink:0">
        <button class="icon-btn" data-tip="定位到消息位置" aria-label="定位" data-locate="${m.id}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg></button>
        <button class="icon-btn" data-tip="取消收藏" aria-label="取消收藏" data-unfav="${m.id}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></button>
      </div>
    `;
    item.querySelector('.fav-main').addEventListener('click', () => openFavoritePreview(m.id));
    item.querySelector('[data-locate]').addEventListener('click', async (e) => {
      e.stopPropagation();
      document.getElementById('dlg-favorites')?.close();
      // 若时间线未加载该收藏消息，需先从 DB 拉回并插入内存，否则 scrollIntoView 找不到元素
      let inMem = (state.messages.get(id) || []).some(x => x.id === m.id);
      if (!inMem) {
        try {
          const fetched = await invoke('get_message_by_id', { messageId: m.id });
          if (fetched) {
            const arr = state.messages.get(id) || [];
            let idx = arr.findIndex(x => x.timestamp > fetched.timestamp);
            if (idx === -1) arr.push(fetched); else arr.splice(idx, 0, fetched);
            state.messages.set(id, arr);
          }
        } catch {}
      }
      state.selectedMessageId = m.id;
      renderTimeline();
      renderDetail();
      setTimeout(() => {
        const el = els.timeline.querySelector(`.message[data-id="${CSS.escape(m.id)}"]`);
        if (el) el.scrollIntoView({ block: 'center' });
      }, 50);
    });
    item.querySelector('[data-unfav]').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!await showConfirm('确定取消收藏？')) return;
      await togglePin(m.id);
    });
    list.appendChild(item);
  }
}

async function openFavoritesDialog() {
  const id = state.selectedSessionId;
  if (!id) { showError('请先选择会话'); return; }
  await renderFavorites();
  document.getElementById('dlg-favorites')?.showModal();
}

async function openFavoritePreview(messageId) {
  const id = state.selectedSessionId;
  let m = (state.messages.get(id) || []).find(x => x.id === messageId);
  if (!m) {
    try { m = await invoke('get_message_by_id', { messageId }); } catch {}
  }
  if (!m) { showError('消息不存在'); return; }
  const dlg = document.getElementById('dlg-favorite-preview');
  if (!dlg) return;
  dlg.dataset.messageId = messageId;
  const meta = document.getElementById('preview-meta');
  const body = document.getElementById('preview-body');
  if (meta) meta.textContent = `${m.direction === 'in' ? '↓ 接收' : '↑ 发送'} · ${formatTime(m.timestamp)} · ${m.endpoint || '—'} · ${m.payload_type} · ${formatBytes(m.payload)}`;
  if (body) {
    const rawQ = (document.getElementById('favorites-search')?.value || '').trim();
    let content;
    if (m.payload_type === 'binary') content = bytesToHex(m.payload);
    else {
      const txt = bytesToText(m.payload);
      try { const p = JSON.parse(txt); if (p !== null && typeof p === 'object') content = JSON.stringify(p, null, 2); else content = txt; } catch { content = txt; }
    }
    if (rawQ) body.innerHTML = highlightText(content, rawQ);
    else body.textContent = content;
  }
  dlg.showModal();
}

function openDiffDialog(aId, bId) {
  const msgs = state.messages.get(state.selectedSessionId) || [];
  const ma = msgs.find((x) => x.id === aId);
  const mb = msgs.find((x) => x.id === bId);
  if (!ma || !mb) { showError('消息不存在'); return; }
  const dlg = document.getElementById('dlg-diff');
  if (!dlg) return;
  dlg.dataset.aId = aId;
  dlg.dataset.bId = bId;
  renderDiff(aId, bId);
  dlg.showModal();
}

function renderDiff(aId, bId) {
  const msgs = state.messages.get(state.selectedSessionId) || [];
  const ma = msgs.find((x) => x.id === aId);
  const mb = msgs.find((x) => x.id === bId);
  if (!ma || !mb) return;
  const metaA = document.getElementById('diff-meta-a');
  const metaB = document.getElementById('diff-meta-b');
  const body = document.getElementById('diff-body');
  if (!metaA || !metaB || !body) return;
  const fmtMeta = (m) => `${m.direction === 'in' ? '↓ 接收' : '↑ 发送'} · ${formatTime(m.timestamp)} · ${m.endpoint || '—'} · ${escapeHtml(m.payload_type)} · ${formatBytes(m.payload)}`;
  metaA.textContent = 'A: ' + fmtMeta(ma);
  metaB.textContent = 'B: ' + fmtMeta(mb);
  const aText = getDiffText(ma);
  const bText = getDiffText(mb);
  const aLines = aText.split('\n');
  const bLines = bText.split('\n');
  const ops = diffLines(aLines, bLines);
  if (ops.length === 0) {
    body.innerHTML = '<div class="diff-empty-hint">两条消息完全相同</div>';
    return;
  }
  let html = '';
  for (const op of ops) {
    if (op.type === 'equal') {
      html += `<div class="diff-row"><div class="diff-cell equal">${escapeHtml(op.a)}</div><div class="diff-cell equal">${escapeHtml(op.b)}</div></div>`;
    } else if (op.type === 'delete') {
      html += `<div class="diff-row"><div class="diff-cell delete">${escapeHtml(op.a)}</div><div class="diff-cell empty"></div></div>`;
    } else {
      html += `<div class="diff-row"><div class="diff-cell empty"></div><div class="diff-cell insert">${escapeHtml(op.b)}</div></div>`;
    }
  }
  body.innerHTML = html;
  body.scrollTop = 0;
}

function closeDiffDialog() {
  const dlg = document.getElementById('dlg-diff');
  if (dlg) dlg.close();
}

document.getElementById('btn-diff-close')?.addEventListener('click', closeDiffDialog);
document.getElementById('btn-diff-close2')?.addEventListener('click', closeDiffDialog);
document.getElementById('btn-diff-swap')?.addEventListener('click', () => {
  const dlg = document.getElementById('dlg-diff');
  if (!dlg) return;
  const a = dlg.dataset.aId, b = dlg.dataset.bId;
  if (!a || !b) return;
  dlg.dataset.aId = b;
  dlg.dataset.bId = a;
  renderDiff(b, a);
});
document.getElementById('dlg-diff')?.addEventListener('click', (e) => {
  if (e.target.id === 'dlg-diff') closeDiffDialog();
});

// ===== 批量/压测发送 =====
let batchAbort = false;
let batchRunning = false;

function openBatchDialog(messageId) {
  const id = state.selectedSessionId;
  if (!id) return;
  const msgs = state.messages.get(id) || [];
  const m = msgs.find((x) => x.id === messageId);
  if (!m || m.payload_type === 'notice') return;
  const s = findSession(id);
  if (s && s.status !== 'running') { showError('连接未运行'); return; }
  const dlg = document.getElementById('dlg-batch');
  if (!dlg) return;
  dlg.dataset.messageId = messageId;
  const preview = document.getElementById('batch-preview');
  if (preview) {
    const text = m.payload_type === 'binary' ? bytesToHex(m.payload) : bytesToText(m.payload);
    preview.textContent = text.length > 500 ? text.slice(0, 500) + '…' : text;
  }
  const countEl = document.getElementById('batch-count');
  const intervalEl = document.getElementById('batch-interval');
  const prog = document.getElementById('batch-progress');
  if (prog) { prog.style.display = 'none'; prog.textContent = ''; }
  const btnStart = document.getElementById('btn-batch-start');
  const btnStop = document.getElementById('btn-batch-stop');
  const btnCancel = document.getElementById('btn-batch-cancel');
  if (btnStart) btnStart.classList.remove('hidden');
  if (btnStop) btnStop.classList.add('hidden');
  if (btnCancel) btnCancel.classList.remove('hidden');
  batchAbort = false;
  batchRunning = false;
  dlg.showModal();
}

async function startBatchSend() {
  const dlg = document.getElementById('dlg-batch');
  const id = state.selectedSessionId;
  if (!dlg || !id) return;
  const messageId = dlg.dataset.messageId;
  const msgs = state.messages.get(id) || [];
  const m = msgs.find((x) => x.id === messageId);
  if (!m) { showError('消息不存在'); return; }
  const count = Math.max(1, Math.min(100000, parseInt(document.getElementById('batch-count').value, 10) || 0));
  const interval = Math.max(0, parseInt(document.getElementById('batch-interval').value, 10) || 0);
  if (!count) { showError('次数不能为空'); return; }
  const s = findSession(id);
  if (!s || s.status !== 'running') { showError('连接未运行'); return; }
  // snapshot target
  let clientId = null, endpoint = null;
  if (s.role === 'server') {
    const v = els.sendTarget.value;
    if (v && v !== 'all') {
      if (v.startsWith('ep:')) endpoint = v.slice(3);
      else clientId = v;
    }
    if (!clientId && (state.clients.get(id) || []).length === 0) { showError('服务端无客户端'); return; }
  }
  const btnStart = document.getElementById('btn-batch-start');
  const btnStop = document.getElementById('btn-batch-stop');
  const btnCancel = document.getElementById('btn-batch-cancel');
  const prog = document.getElementById('batch-progress');
  batchRunning = true;
  batchAbort = false;
  if (btnStart) btnStart.classList.add('hidden');
  if (btnCancel) btnCancel.classList.add('hidden');
  if (btnStop) btnStop.classList.remove('hidden');
  if (prog) { prog.style.display = 'block'; prog.textContent = `发送中 0/${count}`; }
  for (let i = 0; i < count; i++) {
    if (batchAbort) break;
    const cur = findSession(id);
    if (!cur || cur.status !== 'running') { showError('连接已断开，已停止'); break; }
    try {
      await invoke('send_message', { sessionId: id, payload: Array.from(m.payload), payloadType: m.payload_type, clientId, endpoint });
    } catch (e) {
      showError('批量发送第 ' + (i + 1) + ' 条失败: ' + e);
      // continue to next
    }
    if (prog) prog.textContent = `发送中 ${i + 1}/${count}`;
    if (interval > 0 && i < count - 1) {
      await new Promise((r) => setTimeout(r, interval));
      if (batchAbort) break;
    }
  }
  batchRunning = false;
  if (prog) prog.textContent = batchAbort ? `已停止` : `已完成 ${count} 次`;
  showToast(batchAbort ? '批量发送已停止' : `批量发送完成 ${count} 次`);
  setTimeout(() => {
    if (dlg.open) dlg.close();
  }, 400);
}

function stopBatchSend() {
  batchAbort = true;
  const prog = document.getElementById('batch-progress');
  if (prog) prog.textContent = '正在停止...';
}

document.getElementById('btn-batch-start')?.addEventListener('click', (e) => { e.preventDefault(); startBatchSend(); });
document.getElementById('btn-batch-stop')?.addEventListener('click', (e) => { e.preventDefault(); stopBatchSend(); });
document.getElementById('btn-batch-cancel')?.addEventListener('click', (e) => { e.preventDefault(); if (batchRunning) stopBatchSend(); document.getElementById('dlg-batch')?.close(); });
document.getElementById('dlg-batch')?.addEventListener('close', () => { if (batchRunning) batchAbort = true; });

document.getElementById('btn-favorites')?.addEventListener('click', (e) => { e.preventDefault(); openFavoritesDialog(); });
document.getElementById('btn-favorites-close')?.addEventListener('click', () => document.getElementById('dlg-favorites')?.close());
document.getElementById('btn-favorites-close2')?.addEventListener('click', () => document.getElementById('dlg-favorites')?.close());
document.getElementById('dlg-favorites')?.addEventListener('click', (e) => { if (e.target.id === 'dlg-favorites') e.target.close(); });
document.getElementById('favorites-search')?.addEventListener('input', () => renderFavorites());
document.getElementById('btn-favorites-clear-search')?.addEventListener('click', (e) => { e.preventDefault(); const inp = document.getElementById('favorites-search'); if (inp) { inp.value = ''; inp.focus(); } renderFavorites(); });

document.getElementById('btn-preview-close')?.addEventListener('click', () => document.getElementById('dlg-favorite-preview')?.close());
document.getElementById('btn-preview-close2')?.addEventListener('click', () => document.getElementById('dlg-favorite-preview')?.close());
document.getElementById('dlg-favorite-preview')?.addEventListener('click', (e) => { if (e.target.id === 'dlg-favorite-preview') e.target.close(); });

function showMsgMenu(x, y, messageId) {
  ensureMsgMenu();
  if (typeof hideCopyAsMenu === 'function') hideCopyAsMenu();
  msgMenuEl.dataset.targetId = messageId;
  // 仅文本消息可再次发送
  const msgs = state.messages.get(state.selectedSessionId) || [];
  const m = msgs.find((m) => m.id === messageId);
  msgMenuEl.querySelector('[data-msg-ctx="resend"]').classList.toggle('disabled', !(m && m.payload_type === 'text'));
  const diffItem = msgMenuEl.querySelector('[data-msg-ctx="diff"]');
  if (diffItem) {
    const label = diffItem.querySelector('#msg-diff-label');
    if (state.diffBaseId === null) {
      if (label) label.textContent = '选择为对比基准';
    } else if (state.diffBaseId === messageId) {
      if (label) label.textContent = '取消对比选择';
    } else {
      if (label) label.textContent = '与基准对比';
    }
    diffItem.classList.toggle('disabled', !m || m.payload_type === 'notice');
  }
  const batchItem = msgMenuEl.querySelector('[data-msg-ctx="batch"]');
  if (batchItem) batchItem.classList.toggle('disabled', !m || m.payload_type === 'notice');
  const pinItem = msgMenuEl.querySelector('[data-msg-ctx="pin"]');
  if (pinItem) {
    const label = pinItem.querySelector('#msg-pin-label');
    if (label) label.textContent = m && m.pinned ? '取消收藏' : '收藏';
    pinItem.classList.toggle('disabled', !m || m.payload_type === 'notice');
  }
  msgMenuEl.classList.remove('hidden');
  msgMenuEl.style.left = x + 'px';
  msgMenuEl.style.top = y + 'px';
  const rect = msgMenuEl.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    msgMenuEl.style.left = Math.max(0, window.innerWidth - rect.width) + 'px';
  }
  if (rect.bottom > window.innerHeight) {
    msgMenuEl.style.top = Math.max(0, window.innerHeight - rect.height) + 'px';
  }
  const sub = msgMenuEl.querySelector('.context-submenu');
  if (sub) {
    const needFlip = rect.right + 130 > window.innerWidth;
    sub.classList.toggle('flip', needFlip);
  }
}

function hideMsgMenu() {
  if (msgMenuEl) {
    msgMenuEl.classList.add('hidden');
    msgMenuEl.dataset.targetId = '';
  }
}

function resendMessage(messageId) {
  const id = state.selectedSessionId;
  if (!id) return;
  const msgs = state.messages.get(id) || [];
  const m = msgs.find((m) => m.id === messageId);
  if (!m || m.payload_type !== 'text') return;
  els.sendInput.value = bytesToText(m.payload);
  els.sendInput.focus();
  sendMessage();
}

async function deleteMessage(messageId) {
  const id = state.selectedSessionId;
  if (!id) return;
  if (!await showConfirm('确定删除这条消息？')) return;
  try {
    await invoke('delete_message', { messageId });
    state.messages.set(id, (state.messages.get(id) || []).filter((m) => m.id !== messageId));
    if (state.selectedMessageId === messageId) {
      state.selectedMessageId = null;
      renderDetail();
    }
    if (state.diffBaseId === messageId) {
      state.diffBaseId = null;
    }
    renderTimeline();
  } catch (e) {
    showError('删除消息失败: ' + e);
  }
}

// ===== 快速悬浮提示：原生 title 的延迟由系统控制（较慢），改用 data-tip 自定义提示，悬停立即显示 =====
const tipEl = document.createElement('div');
tipEl.className = 'tooltip hidden';
document.body.appendChild(tipEl);

function showTooltip(target) {
  const text = target.dataset.tip;
  if (!text) return;
  // dialog 为顶层 top-layer，body 里的 fixed 会被遮挡，需把 tip 移入当前 dialog 才能即时可见
  const dlg = target.closest('dialog[open]');
  if (dlg && tipEl.parentElement !== dlg) dlg.appendChild(tipEl);
  else if (!dlg && tipEl.parentElement !== document.body) document.body.appendChild(tipEl);
  tipEl.textContent = text;
  tipEl.classList.remove('hidden');
  const rect = target.getBoundingClientRect();
  const w = tipEl.offsetWidth;
  const h = tipEl.offsetHeight;
  const cx = rect.left + rect.width / 2;
  // 水平贴边夹紧；上方空间不足时翻到按钮下方
  tipEl.style.left = Math.max(4 + w / 2, Math.min(cx, window.innerWidth - w / 2 - 4)) + 'px';
  tipEl.style.top = (rect.top - h - 8 >= 4 ? rect.top - h - 8 : rect.bottom + 8) + 'px';
  tipEl.style.transform = 'translate(-50%, 0)';
}

function hideTooltip() {
  tipEl.classList.add('hidden');
}

document.addEventListener('mouseover', (e) => {
  const target = e.target.closest('[data-tip]');
  if (target) showTooltip(target);
});
document.addEventListener('mouseout', (e) => {
  const tip = e.target.closest('[data-tip]');
  if (!tip) return;
  if (tip.contains(e.relatedTarget)) return; // 仍在同一元素内（子节点间移动）不隐藏
  hideTooltip();
});
document.addEventListener('scroll', hideTooltip, true);

// 转义后对命中的搜索词包裹 <mark> 高亮（大小写不敏感）。
function highlightText(text, query) {
  const escaped = escapeHtml(text);
  if (!query) return escaped;
  let re;
  try {
    re = new RegExp(escapeRegExp(query), 'gi');
  } catch {
    return escaped;
  }
  return escaped.replace(re, (m) => `<mark>${m}</mark>`);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function updateSessionDialogProjects() {
  els.sessionProject.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '未分组';
  els.sessionProject.appendChild(none);
  for (const p of state.projects) {
    if (p.project.id === '_ungrouped') continue;
    const opt = document.createElement('option');
    opt.value = p.project.id;
    opt.textContent = p.project.name;
    els.sessionProject.appendChild(opt);
  }
}

function openSessionDialog(projectId) {
  els.dlgSessionTitle.textContent = '新建连接';
  els.editSessionId.value = '';
  els.sessionName.value = '';
  els.sessionProject.value = projectId || '';
  els.sessionRole.value = 'server';
  els.sessionRole.disabled = false;
  els.sessionProtocol.disabled = false;
  els.sessionPort.value = '8080';
  els.sessionUrl.value = '127.0.0.1:8080';
  els.sessionClientEndpoint.value = '';
  els.sessionAutoReconnect.value = '30';
  els.sessionHeartbeat.value = '0';
  state.endpointDraft = [];
  renderEndpointList();
  state.headerDraft = [];
  renderHeaderList();
  state.subprotocolDraft = [];
  renderSubprotocolList();
  els.sessionServerConfig.classList.remove('hidden');
  els.sessionClientConfig.classList.add('hidden');
  els.dlgSession.showModal();
}

function openEditSessionDialog(session) {
  els.dlgSessionTitle.textContent = '编辑连接';
  els.editSessionId.value = session.id;
  els.sessionName.value = session.name || '';
  els.sessionProject.value = session.project_id || '';
  els.sessionRole.value = session.role;
  // 连接创建后协议、角色不允许修改
  els.sessionRole.disabled = true;
  els.sessionProtocol.disabled = true;
  state.endpointDraft = (session.endpoints || []).slice();
  els.sessionClientEndpoint.value = (session.endpoints || [])[0] || '';
  renderEndpointList();
  if (session.role === 'server') {
    els.sessionPort.value = extractPort(session.bind_addr);
    els.sessionUrl.value = '127.0.0.1:8080';
    els.sessionClientEndpoint.value = '';
    els.sessionServerConfig.classList.remove('hidden');
    els.sessionClientConfig.classList.add('hidden');
  } else {
    els.sessionPort.value = '8080';
    // 目标地址回显：去掉 ws:// 前缀，只显示 host:port（若历史数据带前缀则剥掉）
    els.sessionUrl.value = stripWsPrefix(session.target_url || '');
    els.sessionAutoReconnect.value = session.auto_reconnect != null ? String(session.auto_reconnect) : '30';
    els.sessionHeartbeat.value = session.heartbeat_interval != null ? String(session.heartbeat_interval) : '0';
    state.headerDraft = Object.entries(session.headers || {}).map(([key, value]) => ({ key, value }));
    renderHeaderList();
    state.subprotocolDraft = (session.subprotocols || []).slice();
    renderSubprotocolList();
    els.sessionServerConfig.classList.add('hidden');
    els.sessionClientConfig.classList.remove('hidden');
  }
  els.dlgSession.showModal();
}

// 剥掉 ws:// 或 wss:// 前缀，只留 host:port 部分
function stripWsPrefix(url) {
  const m = /^(wss?:\/\/)?(.*)$/.exec(url);
  return m ? m[2] : url;
}

// 从监听地址（如 0.0.0.0:8080）中提取端口
function extractPort(bindAddr) {
  const m = /:(\d+)\s*$/.exec(bindAddr || '');
  return m ? m[1] : '';
}

function renderEndpointList() {
  els.endpointList.innerHTML = '';
  state.endpointDraft.forEach((ep, idx) => {
    const row = document.createElement('div');
    row.className = 'endpoint-item';
    row.innerHTML = `<span class="endpoint-path" data-tip="点击编辑">${escapeHtml(ep)}</span><button type="button" class="endpoint-remove" data-tip="删除">×</button>`;
    row.querySelector('.endpoint-path').addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'endpoint-edit';
      input.value = ep;
      input.dataset.idx = idx;
      row.querySelector('.endpoint-path').replaceWith(input);
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); commitEndpointEdit(input); }
        else if (ev.key === 'Escape') { ev.preventDefault(); renderEndpointList(); }
      });
      input.addEventListener('blur', () => commitEndpointEdit(input));
    });
    row.querySelector('.endpoint-remove').addEventListener('click', async () => {
      const sessionId = els.editSessionId.value.trim();
      if (sessionId) {
        try {
          const n = await invoke('count_messages_by_endpoint', { sessionId, endpoint: ep });
          if (n > 0) {
            const ok = await showConfirm(`Endpoint ${ep} 有 ${n} 条历史消息，删除后将一并删除这些消息，确定删除？`);
            if (!ok) return;
            await invoke('delete_messages_by_endpoint', { sessionId, endpoint: ep });
            if (state.selectedSessionId === sessionId) {
              state.messages.set(sessionId, (state.messages.get(sessionId) || []).filter((m) => m.endpoint !== ep));
              renderTimeline();
            }
          }
        } catch (e) {
          showError('删除 endpoint 消息失败: ' + e);
          return;
        }
      }
      state.endpointDraft = state.endpointDraft.filter((x) => x !== ep);
      renderEndpointList();
    });
    els.endpointList.appendChild(row);
  });
}

function commitEndpointEdit(input) {
  const idx = parseInt(input.dataset.idx, 10);
  let val = input.value.trim();
  if (!val) { renderEndpointList(); return; }
  if (!val.startsWith('/')) val = '/' + val;
  if (state.endpointDraft.includes(val)) { renderEndpointList(); return; }
  state.endpointDraft[idx] = val;
  renderEndpointList();
}

function addEndpointFromInput() {
  let val = els.endpointInput.value.trim();
  if (!val) return;
  if (!val.startsWith('/')) val = '/' + val;
  if (state.endpointDraft.includes(val)) return;
  state.endpointDraft.push(val);
  els.endpointInput.value = '';
  renderEndpointList();
}

function renderHeaderList() {
  els.headerList.innerHTML = '';
  for (const h of state.headerDraft) {
    const row = document.createElement('div');
    row.className = 'header-item';
    row.innerHTML = `<span class="header-key">${escapeHtml(h.key)}</span><span class="header-value">${escapeHtml(h.value)}</span><button type="button" class="endpoint-remove" data-tip="删除">×</button>`;
    row.querySelector('.endpoint-remove').addEventListener('click', () => {
      state.headerDraft = state.headerDraft.filter((x) => x !== h);
      renderHeaderList();
    });
    els.headerList.appendChild(row);
  }
}

function addHeaderFromInput() {
  const key = els.headerKeyInput.value.trim();
  const value = els.headerValueInput.value.trim();
  if (!key) return;
  if (key.includes(':') || /\s/.test(key) || /[\x00-\x1f]/.test(key)) {
    showError('Header 名含非法字符（不能含 :、空白或控制字符）');
    return;
  }
  if (state.headerDraft.some((h) => h.key === key)) return;
  state.headerDraft.push({ key, value });
  els.headerKeyInput.value = '';
  els.headerValueInput.value = '';
  renderHeaderList();
}

function renderSubprotocolList() {
  els.subprotocolList.innerHTML = '';
  for (const p of state.subprotocolDraft) {
    const row = document.createElement('div');
    row.className = 'endpoint-item';
    row.innerHTML = `<span class="endpoint-path">${escapeHtml(p)}</span><button type="button" class="endpoint-remove" data-tip="删除">×</button>`;
    row.querySelector('.endpoint-remove').addEventListener('click', () => {
      state.subprotocolDraft = state.subprotocolDraft.filter((x) => x !== p);
      renderSubprotocolList();
    });
    els.subprotocolList.appendChild(row);
  }
}

function addSubprotocolFromInput() {
  const val = els.subprotocolInput.value.trim();
  if (!val) return;
  if (val.includes(',') || /\s/.test(val) || /[\x00-\x1f]/.test(val)) {
    showError('Subprotocol 含非法字符（不能含 ,、空白或控制字符）');
    return;
  }
  if (state.subprotocolDraft.includes(val)) return;
  state.subprotocolDraft.push(val);
  els.subprotocolInput.value = '';
  renderSubprotocolList();
}

let editingAutoReplyRuleId = null;

function renderAutoReplyList() {
  const tbody = els.autoReplyTbody;
  if (!tbody) return;
  tbody.innerHTML = '';
  const emptyEl = els.autoReplyEmpty;
  if (emptyEl) emptyEl.style.display = state.autoReplyDraft.length ? 'none' : 'block';
  for (const r of state.autoReplyDraft) {
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid var(--border)';
    tr.innerHTML = `
      <td style="padding:6px 8px; text-align:center"><input type="checkbox" ${r.enabled ? 'checked' : ''} data-ar="enabled"></td>
      <td style="padding:6px 8px">${escapeHtml(r.match_type)}</td>
      <td style="padding:6px 8px; max-width:120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap" title="${escapeHtml(r.pattern)}">${escapeHtml(r.pattern)}</td>
      <td style="padding:6px 8px">${escapeHtml(r.reply_type)}</td>
      <td style="padding:6px 8px; max-width:120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap" title="${escapeHtml(r.reply)}">${escapeHtml(r.reply)}</td>
      <td style="padding:6px 8px">${r.delay_ms}</td>
      <td style="padding:6px 8px; white-space:nowrap">
        <button type="button" data-ar="edit" style="font-size:11px; padding:2px 6px">编辑</button>
        <button type="button" data-ar="delete" style="font-size:11px; padding:2px 6px; color:var(--error)">删除</button>
      </td>
    `;
    tr.querySelector('[data-ar="enabled"]').addEventListener('change', (e) => { r.enabled = e.target.checked; });
    tr.querySelector('[data-ar="edit"]').addEventListener('click', () => openAutoReplyEditDialog(r.id));
    tr.querySelector('[data-ar="delete"]').addEventListener('click', async () => {
      if (!await showConfirm(`确定删除该自动回复规则？\n匹配: ${r.pattern}`)) return;
      state.autoReplyDraft = state.autoReplyDraft.filter((x) => x !== r);
      renderAutoReplyList();
    });
    tbody.appendChild(tr);
  }
}

function openAutoReplyEditDialog(ruleId) {
  editingAutoReplyRuleId = ruleId;
  const isEdit = !!ruleId;
  document.getElementById('dlg-autoreply-edit-title').textContent = isEdit ? '编辑规则' : '新增规则';
  if (isEdit) {
    const r = state.autoReplyDraft.find((x) => x.id === ruleId);
    if (!r) return;
    els.autoReplyMatchType.value = r.match_type;
    els.autoReplyPattern.value = r.pattern;
    els.autoReplyReplyType.value = r.reply_type;
    els.autoReplyReply.value = r.reply;
    els.autoReplyDelay.value = String(r.delay_ms);
  } else {
    els.autoReplyMatchType.value = 'contains';
    els.autoReplyPattern.value = '';
    els.autoReplyReplyType.value = 'text';
    els.autoReplyReply.value = '';
    els.autoReplyDelay.value = '0';
  }
  document.getElementById('dlg-autoreply-edit').showModal();
}

function addAutoReplyFromInput() {
  const pattern = els.autoReplyPattern.value.trim();
  const reply = els.autoReplyReply.value.trim();
  if (!pattern) { showError('匹配内容不能为空'); return; }
  if (!reply) { showError('回复内容不能为空'); return; }
  const match_type = els.autoReplyMatchType.value;
  const reply_type = els.autoReplyReplyType.value;
  const delay_ms = Math.max(0, parseInt(els.autoReplyDelay.value.trim() || '0', 10) || 0);
  if (match_type === 'regex') { try { new RegExp(pattern); } catch (e) { showError('正则错误: ' + e.message); return; } }
  if (reply_type === 'hex') {
    const c = reply.replace(/\s+/g, '').replace(/0x/gi, '');
    if (c.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(c)) { showError('Hex 回复含非法字符或长度为奇数'); return; }
  } else if (reply_type === 'base64') {
    try { atob(reply.trim()); } catch { showError('Base64 回复错误'); return; }
  }
  if (editingAutoReplyRuleId) {
    const r = state.autoReplyDraft.find((x) => x.id === editingAutoReplyRuleId);
    if (r) {
      r.match_type = match_type;
      r.pattern = pattern;
      r.reply = reply;
      r.reply_type = reply_type;
      r.delay_ms = delay_ms;
    }
    editingAutoReplyRuleId = null;
  } else {
    state.autoReplyDraft.push({ id: crypto.randomUUID(), enabled: true, match_type, pattern, reply, reply_type, delay_ms });
  }
  document.getElementById('dlg-autoreply-edit').close();
  renderAutoReplyList();
}

let editingAutoReplySessionId = null;
function openAutoReplyDialog(sessionId) {
  const s = findSession(sessionId);
  if (!s) return;
  editingAutoReplySessionId = sessionId;
  state.autoReplyDraft = (s.auto_replies || []).map((r) => ({ ...r }));
  renderAutoReplyList();
  document.getElementById('dlg-autoreply').showModal();
}

async function saveAutoReplies() {
  if (!editingAutoReplySessionId) return;
  try {
    await invoke('update_auto_replies', { id: editingAutoReplySessionId, autoReplies: state.autoReplyDraft.length ? state.autoReplyDraft : null });
    await loadProjects();
    document.getElementById('dlg-autoreply').close();
  } catch (e) {
    showError('保存自动回复失败: ' + e);
  }
}

async function saveProject() {
  const name = els.projectName.value.trim();
  if (!name) return;
  const editId = els.editProjectId.value.trim();
  try {
    if (editId) {
      await invoke('update_project', { id: editId, name });
    } else {
      await invoke('create_project', { name });
    }
    els.projectName.value = '';
    els.editProjectId.value = '';
    await loadProjects();
  } catch (e) {
    showError(editId ? '重命名分组失败: ' + e : '创建分组失败: ' + e);
  }
}

async function openEditProjectDialog(project) {
  els.dlgProjectTitle.textContent = '重命名分组';
  els.editProjectId.value = project.id;
  els.projectName.value = project.name;
  els.dlgProject.showModal();
}

async function deleteProject(id) {
  if (id === '_ungrouped') return;
  if (!await showConfirm('确定删除该分组及其所有会话和消息？')) return;
  try {
    await invoke('delete_project', { id });
    if (state.selectedSessionId && !findSession(state.selectedSessionId)) {
      selectSession(null);
    }
    await loadProjects();
  } catch (e) {
    showError('删除分组失败: ' + e);
  }
}

async function saveSession() {
  const editId = els.editSessionId.value.trim();
  const projectId = els.sessionProject.value.trim();
  const name = els.sessionName.value.trim();
  const isServer = els.sessionRole.value === 'server';
  // 服务端支持多 endpoint（动态列表）；客户端一个连接只对应一个 endpoint（单输入框）。
  const endpoints = isServer
    ? (state.endpointDraft.length ? state.endpointDraft.slice() : null)
    : (els.sessionClientEndpoint.value.trim() ? [els.sessionClientEndpoint.value.trim()] : null);
  const targetUrl = isServer
    ? null
    : ensureWsScheme(els.sessionUrl.value.trim());
  const port = isServer ? els.sessionPort.value.trim() : '';
  const autoReconnect = isServer
    ? null
    : (els.sessionAutoReconnect.value.trim() === '' ? 0 : Math.max(0, parseInt(els.sessionAutoReconnect.value.trim(), 10) || 0));
  const heartbeatInterval = isServer
    ? null
    : (els.sessionHeartbeat.value.trim() === '' ? 0 : Math.max(0, parseInt(els.sessionHeartbeat.value.trim(), 10) || 0));
  const req = {
    project_id: projectId || null,
    name: name || null,
    protocol: els.sessionProtocol.value,
    role: els.sessionRole.value,
    bind_addr: isServer ? (port ? '0.0.0.0:' + port : null) : null,
    target_url: targetUrl || null,
    endpoints,
    headers: isServer || !state.headerDraft.length ? null : Object.fromEntries(state.headerDraft.map((h) => [h.key, h.value])),
    subprotocols: isServer || !state.subprotocolDraft.length ? null : state.subprotocolDraft.slice(),
    auto_reconnect: autoReconnect,
    heartbeat_interval: heartbeatInterval,
    // 自动回复由独立弹框维护，此处不覆盖：新建为 null，编辑时保留原值
    auto_replies: (() => {
      if (!isServer) return null;
      if (editId) { const cur = findSession(editId); return cur?.auto_replies ?? null; }
      return null;
    })(),
  };
  try {
    if (editId) {
      await invoke('update_session', { req: { id: editId, ...req } });
    } else {
      await invoke('create_session', { req });
    }
    await loadProjects();
    els.dlgSession.close();
  } catch (e) {
    showError(editId ? '修改连接失败: ' + e : '创建连接失败: ' + e);
  }
}

// 目标地址若未带协议前缀则补 ws://
function ensureWsScheme(url) {
  if (!url) return url;
  return /^wss?:\/\//.test(url) ? url : 'ws://' + url;
}

async function deleteSession(id) {
  const s = findSession(id);
  if (s && (s.status === 'running' || s.status === 'starting')) {
    showError('正在运行的连接不允许删除，请先停止');
    return;
  }
  if (!await showConfirm('确定删除该连接及其消息？')) return;
  try {
    await invoke('delete_session', { id });
    state.unreadCounts.delete(id);
    state.statsPeak.delete(id);
    state.statsWindows.delete(id);
    state.messages.delete(id);
    state.sendDrafts.delete(id);
    if (state.selectedSessionId === id) selectSession(null);
    await loadProjects();
  } catch (e) {
    showError('删除连接失败: ' + e);
  }
}

async function startSession(id) {
  try {
    await invoke('start_session', { id });
    await loadProjects();
  } catch (e) {
    showError('启动失败: ' + e);
  }
}

async function stopSession(id) {
  const s = findSession(id);
  if (!s) return;
  if (!await showStopConfirm(s)) return;
  try {
    await invoke('stop_session', { id });
    await loadProjects();
  } catch (e) {
    showError('停止失败: ' + e);
  }
}

function toggleSessionCollapse(id) {
  if (state.collapsedSessions.has(id)) {
    state.collapsedSessions.delete(id);
  } else {
    state.collapsedSessions.add(id);
  }
  renderProjectTree();
}

async function selectSession(id, endpoint) {
  // 按会话隔离发送框草稿：切出前保存，切入后恢复
  const prevId = state.selectedSessionId;
  if (prevId && els.sendInput) {
    state.sendDrafts.set(prevId, els.sendInput.value);
  }
  state.selectedSessionId = id;
  state.selectedMessageId = null;
  state.diffBaseId = null;
  state.selectedClientId = null;
  if (id) state.clients.set(id, []);
  if (id) state.endpointFilter.set(id, endpoint || 'all');
  state.searchQuery = '';
  state.searchHits = [];
  state.activeHitIndex = -1;
  state.autoScroll = true;
  if (els.timelineSearch) els.timelineSearch.value = '';
  // 恢复目标会话的草稿
  if (els.sendInput) {
    if (id && state.sendDrafts.has(id)) els.sendInput.value = state.sendDrafts.get(id);
    else if (id) els.sendInput.value = '';
    else els.sendInput.value = '';
  }
  // 切换会话时清空批量选择（按会话隔离）
  if (prevId !== id) {
    state.bulkSelected.clear();
    updateBulkBar();
    updateBulkButtonTips();
  }
  // 清空当前选中会话（或该 endpoint）的未读角标
  if (id) {
    if (endpoint) {
      const m = state.unreadCounts.get(id);
      if (m) m.delete(endpoint);
    } else {
      state.unreadCounts.delete(id);
    }
  }
  // 刷新左侧树：endpoint 选中高亮 / 连接选中态 / 未读角标
  renderProjectTree();
  updateContentArea();
  renderTimeline();
  renderDetail();
  renderClientList();
  updateSendArea();

  if (!id) {
    els.clientListBar.classList.add('hidden');
    return;
  }

  // Close previous channel for this session if any.
  const old = state.channels.get(id);
  if (old) old.close?.();

  // Subscribe to timeline channel.
  const channel = new Channel((event) => {
    if (event.type === 'Message') {
      appendMessage(id, event.data);
    } else if (event.type === 'Notice') {
      appendNotice(id, event.data);
    } else if (event.type === 'Status') {
      recordRuntimeStatus(event.data.session_id, {
        status: event.data.status,
        local_addr: event.data.local_addr,
        remote_addr: event.data.remote_addr,
      });
      renderProjectTree();
      if (state.selectedSessionId === event.data.session_id) {
        updateSendArea();
      }
    }
  });
  state.channels.set(id, channel);
  try {
    await invoke('subscribe_timeline', { sessionId: id, channel });
  } catch (e) {
    console.error('subscribe_timeline failed', e);
  }

  // Load history.
  try {
    const msgs = await invoke('load_messages', { sessionId: id, limit: 100, before: null });
    state.messages.set(id, msgs.reverse());
    state.hasMoreOlder.set(id, msgs.length >= 100);
    state.loadingOlder.delete(id);
    renderTimeline();
    renderProjectTree();
  } catch (e) {
    console.error('load_messages failed', e);
  }

  // Load clients (for server sessions).
  const sess = findSession(id);
  if (sess && sess.role === 'server') {
    try {
      const list = await invoke('list_clients', { sessionId: id });
      state.clients.set(id, list);
      renderClientList();
    } catch (e) {
      console.error('list_clients failed', e);
    }
  } else {
    state.clients.set(id, []);
    renderClientList();
  }
}

// 上滑到顶部附近时加载更早的历史；用当前最旧消息的 timestamp 作为分页游标。
// 内容在顶部插入，加载完成后把滚动位置往下补回新增的高度，保持视口内容不变。
async function loadEarlierMessages(id) {
  if (state.hasMoreOlder.get(id) === false) return;
  if (state.loadingOlder.has(id)) return;
  const list = state.messages.get(id);
  if (!list || list.length === 0) return;
  state.loadingOlder.add(id);
  const el = els.timeline;
  const prevHeight = el.scrollHeight;
  const prevScroll = el.scrollTop;
  try {
    const before = list[0].timestamp;
    const msgs = await invoke('load_messages', { sessionId: id, limit: 100, before });
    if (msgs.length === 0) {
      state.hasMoreOlder.set(id, false);
      return;
    }
    list.unshift(...msgs.reverse());
    state.hasMoreOlder.set(id, msgs.length >= 100);
    renderTimeline();
    renderProjectTree();
    el.scrollTop = el.scrollHeight - prevHeight + prevScroll;
  } catch (e) {
    console.error('load earlier messages failed', e);
  } finally {
    state.loadingOlder.delete(id);
  }
}

function appendMessage(sessionId, msg) {
  if (state.selectedSessionId !== sessionId) return;
  const list = state.messages.get(sessionId) || [];
  list.push(msg);
  renderTimeline();
}

// 连接状态提示：与消息共用同一条时间线，形态与历史消息一致（payload_type='notice'），可随 load_messages 一起加载。
function appendNotice(sessionId, notice) {
  if (state.selectedSessionId !== sessionId) return;
  const list = state.messages.get(sessionId) || [];
  list.push({
    id: `notice-${notice.timestamp}-${Math.random().toString(36).slice(2, 8)}`,
    session_id: sessionId,
    payload_type: 'notice',
    payload: new TextEncoder().encode(notice.text),
    timestamp: notice.timestamp,
    size: new TextEncoder().encode(notice.text).length,
    direction: 'in',
    pinned: 0,
  });
  renderTimeline();
}

function incrementUnread(sessionId, endpoint) {
  // 当前选中的会话（且未按 endpoint 筛选或正好筛的是该 endpoint）不累计未读
  if (state.selectedSessionId === sessionId) {
    const cur = state.endpointFilter.get(sessionId) || 'all';
    if (cur === 'all' || cur === endpoint) return;
  }
  let map = state.unreadCounts.get(sessionId);
  if (!map) { map = new Map(); state.unreadCounts.set(sessionId, map); }
  map.set(endpoint || '', (map.get(endpoint || '') || 0) + 1);
  renderProjectTree();
}

// 服务端收到的消息：显示发送者。已重命名的客户端显示名称，否则显示 IP 端口。
// sender 字段已随消息持久化，重启后历史消息仍能显示发送者地址。
function getSenderLabel(sessionId, msg) {
  const clients = state.clients.get(sessionId) || [];
  const c = msg.client_id ? clients.find((x) => x.id === msg.client_id) : null;
  if (c && c.name) return `<span class="msg-sender">${escapeHtml(c.name)}</span>`;
  if (msg.sender) return `<span class="msg-sender">${escapeHtml(msg.sender)}</span>`;
  return '';
}

function renderTimeline() {
  els.timeline.innerHTML = '';
  const id = state.selectedSessionId;
  if (!id) {
    els.timeline.classList.add('empty');
    const toolbar = document.querySelector('.timeline-toolbar');
    if (toolbar) toolbar.classList.add('hidden');
    return;
  }
  els.timeline.classList.remove('empty');
  const toolbar = document.querySelector('.timeline-toolbar');
  if (toolbar) toolbar.classList.remove('hidden');

  let msgs = state.messages.get(id) || [];
  const filter = state.endpointFilter.get(id) || 'all';
  if (filter !== 'all') {
    // 连接提示属于会话级事件，不随 endpoint 筛选隐藏；只按 endpoint 过滤真正的消息
    msgs = msgs.filter(m => m.payload_type === 'notice' || m.endpoint === filter);
  }
  // 高级过滤
  const af = state.advancedFilter;
  if (af.direction !== 'all') msgs = msgs.filter(m => m.direction === af.direction);
  if (af.payloadType !== 'all') msgs = msgs.filter(m => m.payload_type === af.payloadType);
  if (af.minSize != null) msgs = msgs.filter(m => m.size >= af.minSize);
  if (af.maxSize != null) msgs = msgs.filter(m => m.size <= af.maxSize);
  if (af.jsonPath.trim()) {
    const path = af.jsonPath.trim();
    msgs = msgs.filter(m => {
      if (m.payload_type === 'notice') return false;
      try { const obj = JSON.parse(bytesToText(m.payload)); return hasJsonPath(obj, path); } catch { return false; }
    });
  }
  const q = state.searchQuery.trim();
  const qLower = q.toLowerCase();
  let regexRe = null;
  const regexPattern = af.regexPattern.trim();
  if (af.useRegex && regexPattern) { try { regexRe = new RegExp(regexPattern, 'i'); } catch { regexRe = null; } }
  if (regexRe) {
    msgs = msgs.filter(m => m.payload_type !== 'notice' && regexRe.test(msgDisplayText(m)));
  }
  if (q) {
    const lower = q.toLowerCase();
    msgs = msgs.filter(m => m.payload_type !== 'notice' && msgDisplayText(m).toLowerCase().includes(lower));
  }

  // 重建搜索命中列表（仅在搜索激活时填充），供 ↑/↓ 导航使用
  state.searchHits = [];
  if (q || regexRe) {
    for (const m of msgs) {
      const text = msgDisplayText(m);
      let count = 0;
      if (regexRe) {
        const matches = text.match(new RegExp(regexRe.source, 'gi'));
        count = matches ? matches.length : 0;
      } else {
        const lower = text.toLowerCase();
        let pos = 0;
        while ((pos = lower.indexOf(qLower, pos)) !== -1) { count++; pos += qLower.length; }
      }
      state.searchHits.push({ messageId: m.id, matchCount: count });
    }
    if (state.activeHitIndex >= state.searchHits.length) {
      state.activeHitIndex = -1;
    }
  } else {
    state.activeHitIndex = -1;
  }
  const hitCountById = new Map(state.searchHits.map((h) => [h.messageId, h.matchCount]));

  // 批量选择：同步全选框与计数
  if (state.bulkSelectMode) {
    const visibleIds = msgs.map(m => m.id).filter(Boolean);
    const bulkAll = document.getElementById('bulk-select-all');
    if (bulkAll) {
      const allSelected = visibleIds.length > 0 && visibleIds.every(id => state.bulkSelected.has(id));
      bulkAll.checked = allSelected;
      bulkAll.indeterminate = !allSelected && visibleIds.some(id => state.bulkSelected.has(id));
    }
    const countEl = document.getElementById('bulk-count');
    if (countEl) countEl.textContent = `已选 ${state.bulkSelected.size}`;
    updateBulkButtonTips();
    const bar = document.getElementById('bulk-bar');
    if (bar) { bar.classList.remove('hidden'); bar.style.display = 'flex'; }
  } else {
    const bar = document.getElementById('bulk-bar');
    if (bar) { bar.classList.add('hidden'); bar.style.display = 'none'; }
  }

  if (msgs.length === 0) {
    els.timeline.innerHTML = '<div class="detail-empty">暂无消息</div>';
    return;
  }

  for (const m of msgs) {
    if (m.payload_type === 'notice') {
      const n = document.createElement('div');
      n.className = 'timeline-notice';
      if (state.bulkSelectMode && m.id) {
        const checked = state.bulkSelected.has(m.id) ? 'checked' : '';
        n.innerHTML = `<input type="checkbox" class="bulk-check" data-bulk-id="${m.id}" ${checked} style="margin-right:8px"><span>${formatTime(m.timestamp)}</span> ${escapeHtml(bytesToText(m.payload))}`;
        n.style.display = 'flex';
        n.style.alignItems = 'center';
        n.style.cursor = 'pointer';
        n.addEventListener('click', (e) => {
          if (e.target.closest('.bulk-check')) return;
          if (state.bulkSelected.has(m.id)) state.bulkSelected.delete(m.id); else state.bulkSelected.add(m.id);
          updateBulkBar(); updateBulkButtonTips(); renderTimeline();
        });
        const chk = n.querySelector('.bulk-check');
        if (chk) chk.addEventListener('click', (e) => {
          e.stopPropagation();
          if (chk.checked) state.bulkSelected.add(m.id); else state.bulkSelected.delete(m.id);
          updateBulkBar(); updateBulkButtonTips();
        });
      } else {
        n.innerHTML = `<span>${formatTime(m.timestamp)}</span> ${escapeHtml(bytesToText(m.payload))}`;
      }
      els.timeline.appendChild(n);
      continue;
    }
    const el = document.createElement('div');
    el.className = 'message ' + m.direction + (m.id === state.selectedMessageId ? ' selected' : '') + (m.id === state.diffBaseId ? ' diff-base' : '') + (m.pinned ? ' pinned' : '');
    el.dataset.id = m.id;
    const text = msgDisplayText(m);
    const epBadge = m.endpoint ? `<span class="msg-endpoint">${escapeHtml(m.endpoint)}</span>` : '';
    const sender = m.direction === 'in' ? getSenderLabel(id, m) : '';
    const favBadge = m.pinned ? `<span class="msg-hit-count" style="background:var(--warning-soft); color:#b58900; border-color:#e6a700" data-tip="已收藏">★</span>` : '';
    const diffBadge = m.id === state.diffBaseId ? `<span class="msg-hit-count" style="background:var(--selected-bg); color:var(--accent); border-color:var(--accent)">基准</span>` : '';
    const matchCount = hitCountById.get(m.id) || 0;
    const hitBadge = matchCount > 1
      ? `<span class="msg-hit-count" data-tip="本条消息共 ${matchCount} 处匹配">${matchCount} matches</span>`
      : '';
    // 搜索时把窗口锚定到首个命中段，让高亮落在可视区域内；
    // 无搜索或消息短于预算时保持原行为。
    const budget = 200;
    let displayText;
    if (!state.truncateMessages) {
      displayText = text;
    } else if (q) {
      const lower = text.toLowerCase();
      const idx = lower.indexOf(q);
      if (idx === -1) {
        displayText = text;
      } else {
        const half = Math.floor((budget - q.length) / 2);
        const left = Math.max(0, idx - half);
        const right = Math.min(text.length, left + budget);
        const finalLeft = Math.max(0, right - budget);
        const prefix = finalLeft > 0 ? '…' : '';
        const suffix = right < text.length ? '…' : '';
        displayText = prefix + text.slice(finalLeft, right) + suffix;
      }
    } else {
      displayText = text.length > budget ? text.slice(0, budget) + '…' : text;
    }
    const body = q ? highlightText(displayText, q) : escapeHtml(displayText);
    const bulkCheck = state.bulkSelectMode ? `<input type="checkbox" class="bulk-check" data-bulk-id="${m.id}" ${state.bulkSelected.has(m.id) ? 'checked' : ''} style="margin:6px; flex-shrink:0">` : '';
    const inner = `
      <div class="message-meta">
        <span>${formatTime(m.timestamp)}</span>
        <span class="msg-type ${m.payload_type === 'binary' ? 'binary' : 'txt'}">${m.payload_type === 'binary' ? 'BIN' : 'TXT'}</span>
        ${epBadge}
        ${sender}
        ${favBadge}
        ${diffBadge}
        ${hitBadge}
      </div>
      <div class="message-body">${body}</div>
    `;
    if (state.bulkSelectMode) {
      el.innerHTML = `<div style="display:flex; align-items:flex-start; gap:6px">${bulkCheck}<div style="flex:1; min-width:0">${inner}</div></div>`;
      el.style.cursor = 'pointer';
      const chk = el.querySelector('.bulk-check');
      if (chk) chk.addEventListener('click', (e) => {
        e.stopPropagation();
        if (chk.checked) state.bulkSelected.add(m.id); else state.bulkSelected.delete(m.id);
        updateBulkBar(); updateBulkButtonTips();
      });
      el.addEventListener('click', (e) => {
        if (e.target.closest('.bulk-check')) return;
        if (state.bulkSelected.has(m.id)) state.bulkSelected.delete(m.id); else state.bulkSelected.add(m.id);
        updateBulkBar(); updateBulkButtonTips(); renderTimeline();
      });
      el.addEventListener('contextmenu', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        // 批量模式下右键不弹消息菜单
      });
    } else {
      el.innerHTML = inner;
      el.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        showMsgMenu(ev.clientX, ev.clientY, m.id);
      });
      el.addEventListener('click', () => {
        state.selectedMessageId = m.id;
        // 点击的是搜索命中时，同步活动索引，让 ↑/↓ 从此处继续
        const idx = state.searchHits.findIndex((h) => h.messageId === m.id);
        if (idx >= 0) state.activeHitIndex = idx;
        // 完整 JSON 自动切到 JSON tab；二进制帧默认切到 Hex tab；其余走文本 tab
        if (m.payload_type === 'binary') setDetailTab('hex');
        else setDetailTab(isCompleteJson(m.payload) ? 'json' : 'text');
        renderTimeline();
        renderDetail();
      });
    }
    els.timeline.appendChild(el);
  }

  // 自动滚动：只有用户停留在底部时才跟随新消息滚动到底；上滑查看历史时暂停。
  if (state.autoScroll) {
    els.timeline.scrollTop = els.timeline.scrollHeight;
  }
  renderStats();
}

function formatBytesShort(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function renderStats() {
  const panel = document.getElementById('stats-panel');
  if (!panel) return;
  const id = state.selectedSessionId;
  if (!id) { panel.classList.add('hidden'); return; }
  const msgs = state.messages.get(id) || [];
  let total = 0, upCount = 0, downCount = 0, upBytes = 0, downBytes = 0;
  for (const m of msgs) {
    if (m.payload_type === 'notice') continue;
    total++;
    if (m.direction === 'out') { upCount++; upBytes += m.size; }
    else if (m.direction === 'in') { downCount++; downBytes += m.size; }
  }
  const now = Date.now();
  let winCount = 0, winBytes = 0, winUp = 0, winDown = 0, winUpBytes = 0, winDownBytes = 0;
  for (const m of msgs) {
    if (m.payload_type === 'notice') continue;
    if (now - m.timestamp < 1000) {
      winCount++; winBytes += m.size;
      if (m.direction === 'out') { winUp++; winUpBytes += m.size; }
      else if (m.direction === 'in') { winDown++; winDownBytes += m.size; }
    }
  }
  let peak = state.statsPeak.get(id);
  if (!peak) { peak = { msg: 0, bytes: 0, upMsg: 0, downMsg: 0, upBytes: 0, downBytes: 0 }; state.statsPeak.set(id, peak); }
  if (winCount > peak.msg) peak.msg = winCount;
  if (winBytes > peak.bytes) peak.bytes = winBytes;
  if (winUp > (peak.upMsg || 0)) peak.upMsg = winUp;
  if (winDown > (peak.downMsg || 0)) peak.downMsg = winDown;
  if (winUpBytes > (peak.upBytes || 0)) peak.upBytes = winUpBytes;
  if (winDownBytes > (peak.downBytes || 0)) peak.downBytes = winDownBytes;
  if (panel.classList.contains('hidden')) return;
  const totalEl = document.getElementById('stats-total');
  const upEl = document.getElementById('stats-up');
  const downEl = document.getElementById('stats-down');
  const rateEl = document.getElementById('stats-rate');
  const peakUpEl = document.getElementById('stats-peak-up');
  const peakDownEl = document.getElementById('stats-peak-down');
  const iconUp = '<svg class="stats-icon stats-up-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>';
  const iconDown = '<svg class="stats-icon stats-down-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></svg>';
  if (totalEl) totalEl.textContent = `总计 ${total}`;
  if (upEl) upEl.innerHTML = iconUp + ` ${upCount} · ${formatBytesShort(upBytes)}`;
  if (downEl) downEl.innerHTML = iconDown + ` ${downCount} · ${formatBytesShort(downBytes)}`;
  if (rateEl) rateEl.textContent = `${winCount} msg/s · ${formatBytesShort(winBytes)}/s`;
  if (peakUpEl) peakUpEl.innerHTML = iconUp + `峰值 ${peak.upMsg} msg/s · ${formatBytesShort(peak.upBytes || 0)}/s`;
  if (peakDownEl) peakDownEl.innerHTML = iconDown + `峰值 ${peak.downMsg} msg/s · ${formatBytesShort(peak.downBytes || 0)}/s`;
}

function initStats() {
  const btn = document.getElementById('btn-stats');
  const panel = document.getElementById('stats-panel');
  if (!btn || !panel) return;
  btn.addEventListener('click', () => {
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) renderStats();
  });
  setInterval(() => renderStats(), 1000);
}

function renderDetail() {
  const id = state.selectedMessageId;
  if (!id) {
    els.detailEmpty.classList.remove('hidden');
    els.detailContent.classList.add('hidden');
    return;
  }
  const msgs = state.messages.get(state.selectedSessionId) || [];
  const m = msgs.find((x) => x.id === id);
  if (!m) {
    els.detailEmpty.classList.remove('hidden');
    els.detailContent.classList.add('hidden');
    return;
  }

  els.detailEmpty.classList.add('hidden');
  els.detailContent.classList.remove('hidden');

  els.detailEndpoint.textContent = m.endpoint || '—';
  els.detailTime.textContent = new Date(m.timestamp).toLocaleString('zh-CN');
  els.detailSize.textContent = formatBytes(m.payload);

  renderDetailBody(m);
}

function renderDetailBody(m) {
  const bytes = m.payload;
  const dq = state.detailSearchQuery.trim();
  const tq = state.searchQuery.trim();
  const q = dq || tq;
  if (detailTab === 'hex') {
    const hex = bytesToHex(bytes);
    if (q) els.detailBody.innerHTML = highlightText(hex, q);
    else els.detailBody.textContent = hex;
  } else if (detailTab === 'json') {
    const text = bytesToText(bytes);
    try {
      const parsed = JSON.parse(text);
      if (jsonSubTab === 'tree') {
        els.detailBody.innerHTML = `<div class="j-tree">${buildJsonTree(parsed, q, 0)}</div>`;
      } else {
        const pretty = JSON.stringify(parsed, null, 2);
        els.detailBody.innerHTML = q ? highlightJson(pretty, q) : escapeHtml(pretty);
      }
    } catch {
      const fallback = bytesToText(bytes);
      if (q) els.detailBody.innerHTML = highlightText(fallback, q);
      else els.detailBody.textContent = fallback;
    }
  } else {
    const text = bytesToText(bytes);
    els.detailBody.innerHTML = q ? highlightText(text, q) : escapeHtml(text);
  }
  if (dq) updateDetailSearchNav();
  else clearDetailSearchNav();
}

function buildJsonTree(value, query, depth) {
  const searchRe = query ? new RegExp(escapeRegExp(query), 'gi') : null;
  const hl = (s) => searchRe ? escapeHtml(s).replace(searchRe, (m) => `<mark>${m}</mark>`) : escapeHtml(s);
  const isObj = value !== null && typeof value === 'object';
  if (!isObj) {
    let cls = 'j-num';
    let txt;
    if (typeof value === 'string') { cls = 'j-str'; txt = `"${value}"`; }
    else if (typeof value === 'boolean') { cls = 'j-bool'; txt = String(value); }
    else if (value === null) { cls = 'j-null'; txt = 'null'; }
    else { txt = String(value); }
    return `<span class="${cls}">${hl(txt)}</span>`;
  }
  const isArray = Array.isArray(value);
  const entries = isArray ? value.map((v, i) => [i, v]) : Object.entries(value);
  if (entries.length === 0) return isArray ? '[]' : '{}';
  const collapsed = depth >= 2 && !query ? ' j-collapsed' : '';
  const summary = isArray ? `Array(${entries.length})` : `Object{${entries.length}}`;
  const open = isArray ? '[' : '{';
  const close = isArray ? ']' : '}';
  let html = `<div class="j-node${collapsed}">`;
  html += `<span class="j-toggle">${collapsed ? '▶' : '▼'}</span>`;
  html += `<span class="j-summary${collapsed ? '' : ' hidden'}">${hl(summary)}</span>`;
  html += `<span class="j-bracket">${open}</span>`;
  html += `<div class="j-children">`;
  entries.forEach(([k, v], idx) => {
    html += `<div class="j-line">`;
    if (!isArray) html += `<span class="j-key">"${hl(String(k))}"</span>: `;
    html += buildJsonTree(v, query, depth + 1);
    if (idx < entries.length - 1) html += `,`;
    html += `</div>`;
  });
  html += `</div><span class="j-bracket">${close}</span></div>`;
  return html;
}

// JSON 语法高亮（先转义 HTML，再按 token 类型包裹 span）。
// 可选 query：对每个 token 内部再包 <mark>，保持外层 span 不被截断。
function highlightJson(json, query) {
  const escaped = escapeHtml(json);
  const searchRe = query
    ? new RegExp(escapeRegExp(query), 'gi')
    : null;
  return escaped
    .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g, (match) => {
      let cls = 'j-num';
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? 'j-key' : 'j-str';
      } else if (/true|false/.test(match)) {
        cls = 'j-bool';
      } else if (/null/.test(match)) {
        cls = 'j-null';
      }
      const inner = searchRe
        ? match.replace(searchRe, (m) => `<mark>${m}</mark>`)
        : match;
      return `<span class="${cls}">${inner}</span>`;
    });
}

function showDetailSearch() {
  const bar = document.getElementById('detail-search-bar');
  const inp = document.getElementById('detail-search-input');
  if (!bar || !inp) return;
  if (els.detailContent.classList.contains('hidden')) return;
  bar.classList.remove('hidden');
  bar.style.display = 'flex';
  setTimeout(() => inp.focus(), 0);
  if (state.detailSearchQuery) {
    // 已有查询则重绘以高亮
    const id = state.selectedMessageId;
    if (id) { const m = (state.messages.get(state.selectedSessionId)||[]).find(x=>x.id===id); if (m) renderDetailBody(m); }
  }
}

function hideDetailSearch() {
  const bar = document.getElementById('detail-search-bar');
  const inp = document.getElementById('detail-search-input');
  if (bar) { bar.classList.add('hidden'); bar.style.display = 'none'; }
  if (state.detailSearchQuery) {
    state.detailSearchQuery = '';
    state.detailSearchIndex = -1;
    const id = state.selectedMessageId;
    if (id) { const m = (state.messages.get(state.selectedSessionId)||[]).find(x=>x.id===id); if (m) renderDetailBody(m); }
    else clearDetailSearchNav();
  } else {
    clearDetailSearchNav();
  }
  if (inp) inp.value = '';
}

function updateDetailSearchNav() {
  const marks = els.detailBody.querySelectorAll('mark');
  const count = marks.length;
  const counter = document.getElementById('detail-search-count');
  if (count === 0) {
    state.detailSearchIndex = -1;
    if (counter) counter.textContent = '0/0';
    return;
  }
  if (state.detailSearchIndex < 0 || state.detailSearchIndex >= count) state.detailSearchIndex = 0;
  if (counter) counter.textContent = `${state.detailSearchIndex + 1}/${count}`;
  marks.forEach((m,i) => m.classList.toggle('current', i === state.detailSearchIndex));
  // 已在可视区则不强制滚动，避免每次输入抖动；仅当前高亮不在视口时滚动
  const cur = marks[state.detailSearchIndex];
  if (cur) {
    const rect = cur.getBoundingClientRect();
    const bodyRect = els.detailBody.getBoundingClientRect();
    if (rect.top < bodyRect.top || rect.bottom > bodyRect.bottom) cur.scrollIntoView({ block: 'center' });
  }
}

function clearDetailSearchNav() {
  const counter = document.getElementById('detail-search-count');
  if (counter) counter.textContent = '';
  els.detailBody.querySelectorAll('mark.current').forEach(m => m.classList.remove('current'));
}

function stepDetailSearch(dir) {
  const marks = els.detailBody.querySelectorAll('mark');
  const count = marks.length;
  if (!count) return;
  state.detailSearchIndex = (state.detailSearchIndex + dir + count) % count;
  updateDetailSearchNav();
}

function updateContentArea() {
  const contentArea = document.getElementById('content-area');
  if (state.selectedSessionId) {
    contentArea.classList.remove('no-selection');
  } else {
    contentArea.classList.add('no-selection');
  }
}

function updateSendArea() {
  const id = state.selectedSessionId;
  const targetLabel = els.sendTarget.closest('label');
  els.sendTarget.innerHTML = '';
  if (!id) {
    els.sendInput.disabled = true;
    els.sendTarget.disabled = true;
    if (targetLabel) targetLabel.style.display = 'none';
    document.getElementById('btn-send').disabled = true;
    return;
  }
  const s = findSession(id);
  if (!s) return;

  const isConnected = s.status === 'running';
  els.sendInput.disabled = false;
  els.sendTarget.disabled = !isConnected;
  const noClient = s.role === 'server' && (state.clients.get(id) || []).length === 0;
  document.getElementById('btn-send').disabled = !isConnected;
  document.getElementById('btn-send-ping').disabled = !isConnected || noClient;
  if (!isConnected) document.getElementById('heartbeat-status')?.classList.add('hidden');

  if (s.role === 'server') {
    if (targetLabel) targetLabel.style.display = '';
    const allOpt = document.createElement('option');
    allOpt.value = 'all';
    allOpt.textContent = '所有客户端';
    els.sendTarget.appendChild(allOpt);
    for (const path of (s.endpoints || [])) {
      const opt = document.createElement('option');
      opt.value = 'ep:' + path;
      opt.textContent = `所有客户端 (${path})`;
      els.sendTarget.appendChild(opt);
    }
    const clients = state.clients.get(id) || [];
    for (const c of clients) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = (c.name || c.remote_addr || c.id.slice(0, 8)) + (c.endpoint ? ' (' + c.endpoint + ')' : '');
      if (c.id === state.selectedClientId) opt.selected = true;
      els.sendTarget.appendChild(opt);
    }
    if (state.selectedClientId) {
      els.sendTarget.value = state.selectedClientId;
    }
  } else {
    if (targetLabel) targetLabel.style.display = 'none';
  }
}

function toggleBulkSelectMode() {
  state.bulkSelectMode = !state.bulkSelectMode;
  if (!state.bulkSelectMode) state.bulkSelected.clear();
  updateBulkBar();
  updateBulkButtonTips();
  renderTimeline();
}

function updateBulkBar() {
  const bar = document.getElementById('bulk-bar');
  const countEl = document.getElementById('bulk-count');
  const selectAll = document.getElementById('bulk-select-all');
  const btn = document.getElementById('btn-bulk-select');
  if (!bar) return;
  if (state.bulkSelectMode) {
    bar.classList.remove('hidden');
    bar.style.display = 'flex';
    if (btn) btn.classList.add('active');
  } else {
    bar.classList.add('hidden');
    bar.style.display = 'none';
    if (btn) btn.classList.remove('active');
  }
  if (countEl) countEl.textContent = `已选 ${state.bulkSelected.size}`;
  if (selectAll) {
    // 全选状态由 renderTimeline 按可见条目更新
    const id = state.selectedSessionId;
    const msgs = state.messages.get(id) || [];
    // 简化：若已选数等于当前会话总可见数则勾选，否则不勾
    // 实际在 render 后会校正，这里仅不干扰
  }
}

function updateBulkButtonTips() {
  const exp = document.getElementById('btn-export');
  const clr = document.getElementById('btn-clear');
  const inBulk = state.bulkSelectMode && state.bulkSelected.size > 0;
  if (exp) exp.dataset.tip = inBulk ? `导出已选 (${state.bulkSelected.size})` : '导出消息历史（JSON/文本）';
  if (clr) clr.dataset.tip = inBulk ? `清空已选 (${state.bulkSelected.size})` : '清空当前会话的消息记录';
}

document.getElementById('btn-bulk-select')?.addEventListener('click', () => toggleBulkSelectMode());
document.getElementById('btn-bulk-exit')?.addEventListener('click', () => { if (state.bulkSelectMode) toggleBulkSelectMode(); });
document.getElementById('bulk-select-all')?.addEventListener('change', (e) => {
  const id = state.selectedSessionId;
  if (!id) return;
  const checked = e.target.checked;
  // 按当前可见的过滤结果全选/全不选（通过 DOM 收集可见 bulk-check）
  const visibleIds = Array.from(document.querySelectorAll('.bulk-check')).map(el => el.dataset.bulkId).filter(Boolean);
  if (checked) visibleIds.forEach(mid => state.bulkSelected.add(mid));
  else visibleIds.forEach(mid => state.bulkSelected.delete(mid));
  updateBulkBar(); updateBulkButtonTips(); renderTimeline();
});
document.getElementById('btn-export-workspace')?.addEventListener('click', async () => {
  try {
    const res = await invoke('export_workspace');
    if (res) showToast('已导出到 ' + res);
  } catch (e) { showError('导出失败: ' + e); }
});
document.getElementById('btn-import-workspace')?.addEventListener('click', async () => {
  try {
    const res = await invoke('import_workspace');
    if (res) { showToast(res); await loadProjects(); }
  } catch (e) { showError('导入失败: ' + e); }
});

function renderClientList() {
  const id = state.selectedSessionId;
  const sess = id ? findSession(id) : null;
  if (!id || !sess || sess.role !== 'server') {
    els.clientListBar.classList.add('hidden');
    els.clientList.innerHTML = '';
    return;
  }
  const clients = state.clients.get(id) || [];
  if (clients.length === 0) {
    els.clientListBar.classList.add('hidden');
    els.clientList.innerHTML = '';
    return;
  }
  els.clientListBar.classList.remove('hidden');
  els.clientList.innerHTML = '';
  for (const c of clients) {
    const chip = document.createElement('span');
    chip.className = 'client-chip' + (c.id === state.selectedClientId ? ' selected' : '');
    const label = c.name || c.remote_addr || c.id.slice(0, 8);
    const ep = c.endpoint ? `<span class="client-ep">${escapeHtml(c.endpoint)}</span>` : '';
    chip.innerHTML = `<span class="client-label">${escapeHtml(label)}</span>${ep}<span class="client-actions"><span class="rename-hint" data-tip="重命名">✎</span><span class="disconnect-hint" data-tip="断开连接">×</span></span>`;
    chip.querySelector('.client-label').addEventListener('click', (ev) => {
      ev.stopPropagation();
      state.selectedClientId = c.id;
      renderClientList();
      updateSendArea();
    });
    chip.querySelector('.rename-hint').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const newName = await showPrompt('重命名客户端（留空清除）', c.name || '');
      if (newName === null) return;
      const trimmed = newName.trim();
      try {
        await invoke('update_client_name', { id: c.id, name: trimmed || null });
        c.name = trimmed || null;
        renderClientList();
        updateSendArea();
        // 时间线气泡的发送者标签同步更新
        renderTimeline();
      } catch (e) {
        showError('重命名失败: ' + e);
      }
    });
    chip.querySelector('.disconnect-hint').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!await showConfirm('确定断开此客户端连接？')) return;
      try {
        await invoke('disconnect_client', { sessionId: id, clientId: c.id });
      } catch (e) {
        showError('断开失败: ' + e);
      }
    });
    els.clientList.appendChild(chip);
  }
}

async function sendMessage() {
  const id = state.selectedSessionId;
  if (!id) return;
  const text = els.sendInput.value;
  if (!text) return;
  const s = findSession(id);
  let clientId = null, endpoint = null;
  if (s && s.role === 'server') {
    const v = els.sendTarget.value;
    if (v && v !== 'all') {
      if (v.startsWith('ep:')) endpoint = v.slice(3);
      else clientId = v;
    }
  }

  // 根据发送格式把输入转成字节
  let payload;
  let payloadType = 'text';
  const mode = els.sendMode.value;
  try {
    if (mode === 'hex') {
      payload = hexToBytes(text);
      payloadType = 'binary';
    } else if (mode === 'base64') {
      payload = base64ToBytes(text);
      payloadType = 'binary';
    } else {
      // 文本模式：若内容为完整 JSON（对象/数组）则自动缩进格式化后再发送
      const formatted = tryFormatJson(text);
      payload = new TextEncoder().encode(formatted);
    }
  } catch (e) {
    showError('格式解析失败: ' + e);
    return;
  }

  try {
    await invoke('send_message', {
      sessionId: id,
      payload: Array.from(payload),
      payloadType,
      clientId,
      endpoint,
    });
    els.sendInput.value = '';
    if (state.selectedSessionId) state.sendDrafts.set(state.selectedSessionId, '');
  } catch (e) {
    showError('发送失败: ' + e);
  }
}

function hexToBytes(hex) {
  const clean = hex.replace(/\s+/g, '').replace(/0x/gi, '');
  if (clean.length % 2 !== 0) throw new Error('Hex 长度必须为偶数');
  if (!/^[0-9a-fA-F]*$/.test(clean)) throw new Error('Hex 包含非法字符');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

function base64ToBytes(b64) {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// 若内容是完整 JSON（对象/数组）则返回格式化后的缩进文本，否则返回原文本
function tryFormatJson(text) {
  const trimmed = text.trim();
  if (!trimmed) return text;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === 'object') {
      return JSON.stringify(parsed, null, 2);
    }
  } catch { /* 非 JSON，原样发送 */ }
  return text;
}

async function clearMessages() {
  const id = state.selectedSessionId;
  if (!id) return;
  const isBulk = state.bulkSelectMode && state.bulkSelected.size > 0;
  if (isBulk) {
    if (!await showConfirm(`确定删除已选的 ${state.bulkSelected.size} 条记录？`)) return;
    try {
      const ids = Array.from(state.bulkSelected);
      for (const mid of ids) {
        try { await invoke('delete_message', { messageId: mid }); } catch {}
      }
      const remaining = (state.messages.get(id) || []).filter(m => !state.bulkSelected.has(m.id));
      state.messages.set(id, remaining);
      state.bulkSelected.clear();
      if (!remaining.some(m => m.id === state.selectedMessageId)) { state.selectedMessageId = null; renderDetail(); }
      if (!remaining.some(m => m.id === state.diffBaseId)) state.diffBaseId = null;
      updateBulkBar(); updateBulkButtonTips(); renderTimeline();
      showToast('已删除已选');
    } catch (e) { showError('删除失败: ' + e); }
    return;
  }
  if (!await showConfirm('确定清空当前会话的消息记录？')) return;
  try {
    await invoke('clear_messages', { sessionId: id });
    // 固定消息保留
    const kept = (state.messages.get(id) || []).filter(m => m.pinned);
    state.messages.set(id, kept);
    if (!kept.some(m => m.id === state.selectedMessageId)) {
      state.selectedMessageId = null;
      renderDetail();
    }
    if (!kept.some(m => m.id === state.diffBaseId)) state.diffBaseId = null;
    state.bulkSelected.clear();
    state.statsPeak.delete(id);
    state.statsWindows.delete(id);
    state.unreadCounts.delete(id);
    renderProjectTree();
    renderTimeline();
  } catch (e) {
    showError('清空失败: ' + e);
  }
}

// Event listeners
document.getElementById('btn-new-project').addEventListener('click', () => {
  els.dlgProjectTitle.textContent = '新建分组';
  els.editProjectId.value = '';
  els.projectName.value = '';
  els.dlgProject.showModal();
});

document.getElementById('btn-new-session').addEventListener('click', () => {
  openSessionDialog(null);
});

document.getElementById('btn-project-ok').addEventListener('click', (ev) => {
  ev.preventDefault();
  saveProject();
  els.dlgProject.close();
});

document.getElementById('btn-session-ok').addEventListener('click', (ev) => {
  ev.preventDefault();
  saveSession();
});

els.sessionRole.addEventListener('change', () => {
  if (els.sessionRole.value === 'server') {
    els.sessionServerConfig.classList.remove('hidden');
    els.sessionClientConfig.classList.add('hidden');
  } else {
    els.sessionServerConfig.classList.add('hidden');
    els.sessionClientConfig.classList.remove('hidden');
  }
});

document.getElementById('btn-send').addEventListener('click', sendMessage);
document.getElementById('btn-clear-input').addEventListener('click', () => { els.sendInput.value = ''; if (state.selectedSessionId) state.sendDrafts.set(state.selectedSessionId, ''); els.sendInput.focus(); });

// 导出消息历史：弹框选择 JSON / 文本格式，调用后端保存（用户取消则不提示）
async function exportMessages(format) {
  const id = state.selectedSessionId;
  if (!id) return;
  const isBulk = state.bulkSelectMode && state.bulkSelected.size > 0;
  if (isBulk) {
    const all = state.messages.get(id) || [];
    const selected = all.filter(m => state.bulkSelected.has(m.id));
    if (!selected.length) { showError('未选择消息'); return; }
    try {
      let content, mime, ext;
      if (format === 'json') {
        const items = selected.map(m => {
          const isBinary = m.payload_type === 'binary';
          const text = isBinary ? bytesToHex(m.payload) : bytesToText(m.payload);
          let b64;
          if (isBinary) {
            try { b64 = btoa(String.fromCharCode(...m.payload)); } catch { b64 = ''; }
          }
          return {
            timestamp: m.timestamp,
            time: new Date(m.timestamp).toLocaleString('zh-CN'),
            direction: m.direction,
            payload_type: m.payload_type,
            endpoint: m.endpoint,
            sender: m.sender,
            size: m.size,
            text,
            payload_base64: b64 || undefined,
          };
        });
        content = JSON.stringify(items, null, 2);
        mime = 'application/json';
        ext = 'json';
      } else {
        let out = '';
        for (const m of selected) {
          const time = new Date(m.timestamp).toLocaleString('zh-CN');
          const arrow = m.direction === 'in' ? '← 收' : '→ 发';
          const ep = m.endpoint || '-';
          const body = m.payload_type === 'binary' ? bytesToHex(m.payload) : bytesToText(m.payload);
          out += `[${time}] ${arrow} ${m.payload_type} ep=${ep} size=${m.size}\n${body}\n\n`;
        }
        content = out;
        mime = 'text/plain';
        ext = 'txt';
      }
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `messages-selected.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast('已导出已选');
    } catch (e) { showError('导出失败: ' + e); }
    return;
  }
  try {
    const path = await invoke('export_messages', { sessionId: id, format });
    if (path) showToast('已导出到 ' + path);
  } catch (e) {
    showError('导出失败: ' + e);
  }
}

const dlgExport = document.getElementById('dlg-export');
document.getElementById('btn-export').addEventListener('click', () => dlgExport.showModal());
document.getElementById('btn-export-cancel').addEventListener('click', () => dlgExport.close());
document.getElementById('btn-export-json').addEventListener('click', () => { dlgExport.close(); exportMessages('json'); });
document.getElementById('btn-export-text').addEventListener('click', () => { dlgExport.close(); exportMessages('text'); });

// 全局快捷键：Ctrl+L 清空当前会话消息记录
document.addEventListener('keydown', (e) => {
  if (e.key === 'l' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    clearMessages();
  }
});

// ===== Ping / 心跳监控 =====
const btnSendPing = document.getElementById('btn-send-ping');
btnSendPing.addEventListener('click', async () => {
  const id = state.selectedSessionId;
  if (!id) return;
  try {
    await invoke('send_ping', { sessionId: id });
  } catch (e) {
    showError('Ping 发送失败: ' + e);
  }
});

// 心跳状态轮询（1 秒）：显示最近 Ping/Pong 与往返延迟，超时标红
function renderHeartbeatStatus(st, sessionStatus) {
  const el = document.getElementById('heartbeat-status');
  if (!el) return;
  const active = st && st.running && sessionStatus === 'running';
  if (!active || (!st.last_ping_at && !st.last_pong_at)) {
    el.classList.add('hidden');
    return;
  }
  const now = Date.now();
  const ago = (ts) => ts ? Math.round((now - ts) / 1000) : null;
  const pongAgo = ago(st.last_pong_at);
  // 超时判定：有 Ping 无 Pong 且已超过 10 秒
  const timedOut = st.last_ping_at && (!st.last_pong_at || st.last_pong_at < st.last_ping_at) && (now - st.last_ping_at > 10000);
  let text;
  if (st.rtt_ms != null) {
    text = `延迟 ${st.rtt_ms} ms · Pong ${pongAgo}s 前`;
  } else if (timedOut) {
    text = '心跳超时';
  } else {
    text = `等待 Pong…`;
  }
  el.textContent = text;
  el.classList.toggle('heartbeat-timeout', !!timedOut);
}

setInterval(async () => {
  const id = state.selectedSessionId;
  const s = id ? findSession(id) : null;
  if (!id || !s || s.status !== 'running') return;
  try {
    const st = await invoke('get_heartbeat_status', { sessionId: id });
    renderHeartbeatStatus(st, s.status);
  } catch { /* ignore */ }
}, 1000);

// 发送键模式：'enter' = Enter 发送、Shift+Enter 换行（聊天风格，默认）；
// 'ctrlEnter' = Ctrl+Enter 发送、Enter 换行（编辑器风格）。
// 任何修饰键组合下都显式处理：匹配发送则发，否则插入换行（不依赖浏览器默认行为，
// 因为 Tauri WebView 对 Ctrl+Enter 等的默认 newline 不可靠）。
els.sendInput.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter' || ev.isComposing) return;
  const isSend = state.sendKeyMode === 'ctrlEnter'
    ? ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey
    : !ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey;
  ev.preventDefault();
  if (isSend) {
    sendMessage();
  } else {
    const t = ev.target;
    t.setRangeText('\n', t.selectionStart, t.selectionEnd, 'end');
    if (state.selectedSessionId) state.sendDrafts.set(state.selectedSessionId, t.value);
  }
});
els.sendInput.addEventListener('input', () => {
  if (state.selectedSessionId) state.sendDrafts.set(state.selectedSessionId, els.sendInput.value);
});

function initSendKeyMode() {
  try {
    const saved = localStorage.getItem('send-key-mode');
    if (saved === 'enter' || saved === 'ctrlEnter') {
      state.sendKeyMode = saved;
    }
  } catch { /* ignore */ }
}

function loadTemplates() {
  try {
    const saved = JSON.parse(localStorage.getItem('netdebugger.templates') || '[]');
    state.templates = Array.isArray(saved)
      ? saved.filter((t) => t && typeof t.name === 'string' && typeof t.content === 'string')
      : [];
  } catch {
    state.templates = [];
  }
}

function saveTemplates() {
  try { localStorage.setItem('netdebugger.templates', JSON.stringify(state.templates)); } catch { /* ignore */ }
}

function fillTplMenu(menu) {
  if (!menu) return;
  menu.innerHTML = '';
  if (!state.templates.length) {
    const empty = document.createElement('div');
    empty.className = 'tpl-menu-item';
    empty.style.color = 'var(--text-muted)';
    empty.style.cursor = 'default';
    empty.textContent = '暂无快捷指令';
    menu.appendChild(empty);
  }
  for (const t of state.templates) {
    const item = document.createElement('div');
    item.className = 'tpl-menu-item';
    item.dataset.name = t.name;
    const nameSpan = document.createElement('span');
    nameSpan.className = 'tpl-item-name';
    nameSpan.textContent = t.name;
    const actions = document.createElement('span');
    actions.className = 'tpl-item-actions';
    const btnEdit = document.createElement('button');
    btnEdit.type = 'button';
    btnEdit.className = 'tpl-act';
    btnEdit.dataset.act = 'edit';
    btnEdit.dataset.tip = '编辑';
    btnEdit.textContent = '✎';
    const btnDel = document.createElement('button');
    btnDel.type = 'button';
    btnDel.className = 'tpl-act tpl-del';
    btnDel.dataset.act = 'del';
    btnDel.dataset.tip = '删除';
    btnDel.textContent = '✕';
    actions.append(btnEdit, btnDel);
    item.append(nameSpan, actions);
    menu.appendChild(item);
  }
  const newItem = document.createElement('div');
  newItem.className = 'tpl-menu-item tpl-menu-new';
  newItem.dataset.act = 'new';
  newItem.textContent = '＋ 新建快捷指令';
  menu.appendChild(newItem);
}

function renderTemplateMenu() {
  fillTplMenu(els.tplMenu);
  fillTplMenu(els.tplMenuGlobal);
  updateTplTrigger();
}

function updateTplTrigger() {
  const label = document.getElementById('tpl-trigger-label');
  if (label) label.textContent = state.activeTemplate || '选择快捷指令…';
}

function toggleTemplateMenu() {
  if (!els.tplMenu) return;
  if (els.tplMenu.classList.contains('hidden')) {
    renderTemplateMenu();
    els.tplMenu.classList.remove('hidden');
    els.tplMenuGlobal?.classList.add('hidden');
  } else {
    els.tplMenu.classList.add('hidden');
  }
}

function toggleGlobalTemplateMenu() {
  if (!els.tplMenuGlobal) return;
  if (els.tplMenuGlobal.classList.contains('hidden')) {
    renderTemplateMenu();
    els.tplMenuGlobal.classList.remove('hidden');
    els.tplMenu?.classList.add('hidden');
  } else {
    els.tplMenuGlobal.classList.add('hidden');
  }
}

function closeTemplateMenu() {
  els.tplMenu?.classList.add('hidden');
  els.tplMenuGlobal?.classList.add('hidden');
}

async function onTemplateMenuClick(e) {
  const act = e.target.closest('.tpl-act');
  const item = e.target.closest('.tpl-menu-item');
  if (!item) return;
  // 点击来自哪个菜单都关闭两个
  closeTemplateMenu();
  if (item.dataset.act === 'new') { createTemplate(); return; }
  const name = item.dataset.name;
  if (act) {
    if (act.dataset.act === 'edit') editTemplate(name);
    else if (act.dataset.act === 'del') deleteTemplate(name);
    return;
  }
  selectTemplate(name);
}

function selectTemplate(name) {
  const t = state.templates.find((x) => x.name === name);
  if (!t) return;
  state.activeTemplate = name;
  updateTplTrigger();
  els.sendInput.value = t.content;
  if (state.selectedSessionId) state.sendDrafts.set(state.selectedSessionId, t.content);
  els.sendInput.focus();
  els.sendInput.setSelectionRange(t.content.length, t.content.length);
}

function upsertTemplate(name, content) {
  const idx = state.templates.findIndex((x) => x.name === name);
  if (idx >= 0) state.templates[idx].content = content;
  else state.templates.push({ name, content });
}

async function createTemplate() {
  const res = await showTemplateEditor({ name: '', content: els.sendInput.value });
  if (!res) return;
  const name = res.name.trim();
  if (!name) { showError('快捷指令名称不能为空'); return; }
  upsertTemplate(name, res.content);
  state.activeTemplate = name;
  saveTemplates();
  renderTemplateMenu();
  showToast('已保存快捷指令');
}

async function editTemplate(name) {
  const t = state.templates.find((x) => x.name === name);
  if (!t) return;
  const res = await showTemplateEditor({ name: t.name, content: t.content });
  if (!res) return;
  const newName = res.name.trim();
  if (!newName) { showError('快捷指令名称不能为空'); return; }
  state.templates = state.templates.filter((x) => x.name !== name);
  upsertTemplate(newName, res.content);
  state.activeTemplate = newName;
  saveTemplates();
  renderTemplateMenu();
  showToast('已保存快捷指令');
}

async function deleteTemplate(name) {
  if (!await showConfirm(`删除快捷指令「${name}」？`)) return;
  state.templates = state.templates.filter((x) => x.name !== name);
  if (state.activeTemplate === name) state.activeTemplate = null;
  saveTemplates();
  renderTemplateMenu();
  showToast('已删除快捷指令');
}

// 快捷指令编辑框（新建 / 编辑共用）。resolve({name, content})；取消 resolve(null)。
function showTemplateEditor(initial) {
  els.dlgTemplateName.value = (initial && initial.name) || '';
  els.dlgTemplateContent.value = (initial && initial.content) || '';
  els.dlgTemplateMessage.textContent = (initial && initial.name) ? '编辑快捷指令' : '新建快捷指令';
  return new Promise((resolve) => {
    const done = (val) => {
      els.btnTemplateOk.removeEventListener('click', onOk);
      els.btnTemplateCancel.removeEventListener('click', onCancel);
      els.dlgTemplateName.removeEventListener('keydown', onKey);
      els.dlgTemplateContent.removeEventListener('keydown', onKey);
      els.dlgTemplate.close();
      resolve(val);
    };
    const onOk = () => done({ name: els.dlgTemplateName.value, content: els.dlgTemplateContent.value });
    const onCancel = () => done(null);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
    };
    els.btnTemplateOk.addEventListener('click', onOk);
    els.btnTemplateCancel.addEventListener('click', onCancel);
    els.dlgTemplateName.addEventListener('keydown', onKey);
    els.dlgTemplateContent.addEventListener('keydown', onKey);
    els.dlgTemplate.showModal();
    positionTemplateDialog();
    els.dlgTemplateName.focus();
  });
}

// 把居中显示的 dialog 固化为显式 left/top 定位，供 8 方向 resize 以对边为锚。
function positionTemplateDialog() {
  const dlg = els.dlgTemplate;
  const rect = dlg.getBoundingClientRect();
  dlg.style.margin = '0';
  dlg.style.left = Math.round(rect.left) + 'px';
  dlg.style.top = Math.round(rect.top) + 'px';
  dlg.style.width = rect.width + 'px';
  dlg.style.height = rect.height + 'px';
}

const TPL_MIN_W = 320;
const TPL_MIN_H = 240;

// 8 方向窗口式 resize：拖哪条边/角，只扩展那个方向，对边固定。
function initTemplateResize() {
  const dlg = els.dlgTemplate;
  let drag = null;

  function onMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    let { left, top, width, height } = drag.rect;
    const dir = drag.dir;
    if (dir.includes('e')) width += dx;
    if (dir.includes('s')) height += dy;
    if (dir.includes('w')) { left += dx; width -= dx; }
    if (dir.includes('n')) { top += dy; height -= dy; }
    if (width < TPL_MIN_W) {
      if (dir.includes('w')) left -= TPL_MIN_W - width;
      width = TPL_MIN_W;
    }
    if (height < TPL_MIN_H) {
      if (dir.includes('n')) top -= TPL_MIN_H - height;
      height = TPL_MIN_H;
    }
    dlg.style.left = left + 'px';
    dlg.style.top = top + 'px';
    dlg.style.width = width + 'px';
    dlg.style.height = height + 'px';
  }

  function onUp() {
    drag = null;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }

  dlg.querySelectorAll('.tpl-resize').forEach((h) => {
    h.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      drag = { dir: h.dataset.dir, startX: e.clientX, startY: e.clientY, rect: dlg.getBoundingClientRect() };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

els.tplTrigger?.addEventListener('click', (e) => { e.stopPropagation(); toggleTemplateMenu(); });
document.getElementById('btn-global-templates')?.addEventListener('click', (e) => { e.stopPropagation(); toggleGlobalTemplateMenu(); });

// 按住弹框标题区拖动移动整个弹框
function initTemplateDrag() {
  const dlg = els.dlgTemplate;
  const handle = dlg.querySelector('.tpl-drag');
  if (!handle) return;
  let startX = 0, startY = 0, origLeft = 0, origTop = 0, dragging = false;

  function onMove(e) {
    if (!dragging) return;
    const x = origLeft + (e.clientX - startX);
    const y = origTop + (e.clientY - startY);
    dlg.style.left = x + 'px';
    dlg.style.top = y + 'px';
  }

  function onUp() {
    dragging = false;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }

  handle.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return; // 标题区内的按钮不被拖动
    e.preventDefault();
    e.stopPropagation();
    const r = dlg.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    origLeft = parseFloat(dlg.style.left) || r.left;
    origTop = parseFloat(dlg.style.top) || r.top;
    dragging = true;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

els.tplMenu?.addEventListener('click', onTemplateMenuClick);
els.tplMenuGlobal?.addEventListener('click', onTemplateMenuClick);
document.addEventListener('click', (e) => {
  // 全局菜单为 .tpl-menu，统一关闭
  if (e.target.closest('.tpl-menu')) return;
  if (e.target.closest('#btn-global-templates') || e.target.closest('#tpl-trigger')) return;
  closeTemplateMenu();
});

els.btnEndpointAdd.addEventListener('click', addEndpointFromInput);
els.endpointInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    addEndpointFromInput();
  }
});
els.btnAutoReplyNew?.addEventListener('click', () => openAutoReplyEditDialog(null));
document.getElementById('btn-autoreply-edit-ok')?.addEventListener('click', (e) => { e.preventDefault(); addAutoReplyFromInput(); });
document.getElementById('btn-autoreply-edit-cancel')?.addEventListener('click', (e) => { e.preventDefault(); editingAutoReplyRuleId = null; document.getElementById('dlg-autoreply-edit').close(); });
document.getElementById('btn-autoreply-ok')?.addEventListener('click', (e) => { e.preventDefault(); saveAutoReplies(); });
document.getElementById('btn-autoreply-cancel')?.addEventListener('click', (e) => { e.preventDefault(); document.getElementById('dlg-autoreply').close(); });

els.btnHeaderAdd.addEventListener('click', addHeaderFromInput);
els.headerKeyInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    els.headerValueInput.focus();
  }
});
els.headerValueInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    addHeaderFromInput();
  }
});

els.btnSubprotocolAdd.addEventListener('click', addSubprotocolFromInput);
els.subprotocolInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    addSubprotocolFromInput();
  }
});

els.timelineSearch.addEventListener('input', () => {
  state.searchQuery = els.timelineSearch.value;
  state.activeHitIndex = -1;
  renderTimeline();
});

if (els.btnSearchClear) {
  els.btnSearchClear.addEventListener('click', () => {
    els.timelineSearch.value = '';
    els.timelineSearch.focus();
    els.timelineSearch.dispatchEvent(new Event('input'));
  });
}

document.getElementById('btn-advanced-filter')?.addEventListener('click', () => {
  els.advancedFilterPanel?.classList.toggle('hidden');
});
if (els.filterDirection) els.filterDirection.addEventListener('change', () => { state.advancedFilter.direction = els.filterDirection.value; renderTimeline(); });
if (els.filterType) els.filterType.addEventListener('change', () => { state.advancedFilter.payloadType = els.filterType.value; renderTimeline(); });
if (els.filterMinSize) els.filterMinSize.addEventListener('input', () => { const v = els.filterMinSize.value.trim(); state.advancedFilter.minSize = v === '' ? null : Math.max(0, parseInt(v, 10) || 0); renderTimeline(); });
if (els.filterMaxSize) els.filterMaxSize.addEventListener('input', () => { const v = els.filterMaxSize.value.trim(); state.advancedFilter.maxSize = v === '' ? null : Math.max(0, parseInt(v, 10) || 0); renderTimeline(); });
if (els.filterUseRegex) els.filterUseRegex.addEventListener('change', () => { state.advancedFilter.useRegex = els.filterUseRegex.checked; if (els.filterRegexPattern) els.filterRegexPattern.disabled = !els.filterUseRegex.checked; renderTimeline(); });
if (els.filterRegexPattern) els.filterRegexPattern.addEventListener('input', () => { state.advancedFilter.regexPattern = els.filterRegexPattern.value; renderTimeline(); });
if (els.filterJsonPath) els.filterJsonPath.addEventListener('input', () => { state.advancedFilter.jsonPath = els.filterJsonPath.value; renderTimeline(); });
document.getElementById('btn-clear-advanced-filter')?.addEventListener('click', () => {
  state.advancedFilter = { direction: 'all', payloadType: 'all', minSize: null, maxSize: null, useRegex: false, regexPattern: '', jsonPath: '' };
  if (els.filterDirection) els.filterDirection.value = 'all';
  if (els.filterType) els.filterType.value = 'all';
  if (els.filterMinSize) els.filterMinSize.value = '';
  if (els.filterMaxSize) els.filterMaxSize.value = '';
  if (els.filterUseRegex) els.filterUseRegex.checked = false;
  if (els.filterRegexPattern) { els.filterRegexPattern.value = ''; els.filterRegexPattern.disabled = true; }
  if (els.filterJsonPath) els.filterJsonPath.value = '';
  renderTimeline();
});

// 搜索框内 ↑/↓ 在命中间循环跳转，同时选中并把消息滚到可视区
els.timelineSearch.addEventListener('keydown', (ev) => {
  if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
  const hits = state.searchHits;
  if (hits.length === 0) return;
  ev.preventDefault();
  let idx = state.activeHitIndex;
  if (ev.key === 'ArrowDown') {
    idx = idx < 0 ? 0 : (idx + 1) % hits.length;
  } else {
    idx = idx < 0 ? hits.length - 1 : (idx - 1 + hits.length) % hits.length;
  }
  state.activeHitIndex = idx;
  const hit = hits[idx];
  state.selectedMessageId = hit.messageId;
  renderTimeline();
  renderDetail();
  const el = els.timeline.querySelector(`.message[data-id="${CSS.escape(hit.messageId)}"]`);
  if (el) el.scrollIntoView({ block: 'nearest' });
});

// 用户上滑查看历史时暂停自动滚动；回到底部后恢复。上滑到顶部附近时加载更早的消息。
els.timeline.addEventListener('scroll', () => {
  const el = els.timeline;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  state.autoScroll = atBottom;
  if (!atBottom && el.scrollTop <= 40 && state.selectedSessionId) {
    loadEarlierMessages(state.selectedSessionId);
  }
});

document.getElementById('btn-clear').addEventListener('click', clearMessages);

function initTruncateToggle() {
  try {
    const saved = localStorage.getItem('truncate-messages');
    if (saved === 'false') state.truncateMessages = false;
  } catch { /* ignore */ }
  updateTruncateToggleUI();
  els.btnTruncateToggle.addEventListener('click', () => {
    state.truncateMessages = !state.truncateMessages;
    try { localStorage.setItem('truncate-messages', String(state.truncateMessages)); } catch { /* ignore */ }
    updateTruncateToggleUI();
    renderTimeline();
  });
}

function updateTruncateToggleUI() {
  els.btnTruncateToggle.classList.toggle('active', state.truncateMessages);
  els.btnTruncateToggle.setAttribute('aria-pressed', String(state.truncateMessages));
  els.btnTruncateToggle.dataset.tip = state.truncateMessages
    ? '长消息截断显示（点击显示完整消息）'
    : '显示完整消息（点击截断长消息）';
}

document.getElementById('btn-settings').addEventListener('click', openSettingsView);

document.getElementById('btn-settings-save').addEventListener('click', (ev) => {
  ev.preventDefault();
  saveSettings();
});

document.getElementById('btn-settings-close').addEventListener('click', (ev) => {
  ev.preventDefault();
  closeSettingsView();
});

document.getElementById('btn-close-confirm-ok').addEventListener('click', (ev) => {
  ev.preventDefault();
  confirmClose();
});

// 切换详情 tab 并同步按钮的 active 态
function setDetailTab(tab) {
  if (detailTab === tab) return;
  detailTab = tab;
  document.querySelectorAll('.detail-tabs button[data-tab]').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.getElementById('json-subtabs')?.classList.toggle('hidden', tab !== 'json');
}

function setJsonSubTab(tab) {
  if (jsonSubTab === tab) return;
  jsonSubTab = tab;
  try { localStorage.setItem('json-subtab', tab); } catch {}
  document.querySelectorAll('#json-subtabs button[data-json-subtab]').forEach((b) => {
    b.classList.toggle('active', b.dataset.jsonSubtab === tab);
  });
  renderDetail();
}

document.querySelectorAll('.detail-tabs button[data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    setDetailTab(btn.dataset.tab);
    renderDetail();
  });
});

// JSON 子标签切换
document.querySelectorAll('#json-subtabs button[data-json-subtab]').forEach((btn) => {
  btn.classList.toggle('active', btn.dataset.jsonSubtab === jsonSubTab);
  btn.addEventListener('click', () => setJsonSubTab(btn.dataset.jsonSubtab));
});
document.getElementById('json-subtabs')?.classList.toggle('hidden', detailTab !== 'json');

// 树形折叠：点击箭头或 ... 切换
document.getElementById('detail-body')?.addEventListener('click', (e) => {
  const t = e.target.closest('.j-toggle, .j-summary');
  if (!t) return;
  const node = t.closest('.j-node');
  if (!node) return;
  const collapsed = node.classList.toggle('j-collapsed');
  const toggle = node.querySelector(':scope > .j-toggle');
  if (toggle) toggle.textContent = collapsed ? '▶' : '▼';
  const summary = node.querySelector(':scope > .j-summary');
  if (summary) summary.classList.toggle('hidden', !collapsed);
});

// 详情内搜索：Ctrl/Cmd+F 呼出，Esc 关闭，↑↓/Enter 导航
document.getElementById('detail-search-input')?.addEventListener('input', (e) => {
  state.detailSearchQuery = e.target.value;
  state.detailSearchIndex = 0;
  const id = state.selectedMessageId;
  if (!id) { clearDetailSearchNav(); return; }
  const m = (state.messages.get(state.selectedSessionId) || []).find(x => x.id === id);
  if (m) renderDetailBody(m);
});
document.getElementById('detail-search-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) stepDetailSearch(-1); else stepDetailSearch(1);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    hideDetailSearch();
  }
});
document.getElementById('btn-detail-search-prev')?.addEventListener('click', () => stepDetailSearch(-1));
document.getElementById('btn-detail-search-next')?.addEventListener('click', () => stepDetailSearch(1));
document.getElementById('btn-detail-search-close')?.addEventListener('click', () => hideDetailSearch());
document.addEventListener('keydown', (e) => {
  const isF = e.key.toLowerCase() === 'f' && (e.ctrlKey || e.metaKey);
  if (!isF) return;
  const bar = document.getElementById('detail-search-bar');
  const detailVisible = !els.detailContent.classList.contains('hidden');
  if (!detailVisible) return;
  // 若焦点在发送框等输入区，不劫持
  const tag = document.activeElement?.tagName;
  const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable;
  // 详情搜索优先：若已在详情输入则不重复
  if (document.activeElement?.id === 'detail-search-input') return;
  // 仅当详情面板为焦点上下文时劫持，避免影响时间线搜索
  // 若详情面板内有选中消息，则优先详情搜索
  if (detailVisible) {
    e.preventDefault();
    showDetailSearch();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const bar = document.getElementById('detail-search-bar');
    if (bar && !bar.classList.contains('hidden')) {
      // 若详情搜索打开则先关它
      const active = document.activeElement?.id === 'detail-search-input';
      if (active || !bar.classList.contains('hidden')) {
        hideDetailSearch();
        // 不阻止冒泡，让其他 Esc 逻辑也可执行
      }
    }
  }
});

document.getElementById('btn-copy-message').addEventListener('click', async () => {
  const msgs = state.messages.get(state.selectedSessionId) || [];
  const m = msgs.find((x) => x.id === state.selectedMessageId);
  if (!m) return;
  // 复制当前查看方式（文本/JSON/十六进制）下的内容
  let text;
  if (detailTab === 'hex') {
    text = bytesToHex(m.payload);
  } else if (detailTab === 'json') {
    try {
      text = JSON.stringify(JSON.parse(bytesToText(m.payload)), null, 2);
    } catch {
      text = '不是有效的 JSON';
    }
  } else {
    text = bytesToText(m.payload);
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast('已复制');
  } catch (e) {
    showError('复制失败: ' + e);
  }
});

// 详情面板「复制为 ...」下拉（协议自适应：WS 显示 cURL）
let copyAsMenuEl = null;
function ensureCopyAsMenu() {
  if (copyAsMenuEl) return;
  copyAsMenuEl = document.createElement('div');
  copyAsMenuEl.className = 'context-menu hidden';
  copyAsMenuEl.innerHTML = `
    <div class="context-menu-item" data-copy-as="raw"><span class="ctx-icon">⧉</span><span class="ctx-label">Raw</span></div>
    <div class="context-menu-item" data-copy-as="hex"><span class="ctx-icon">⬡</span><span class="ctx-label">Hex</span></div>
    <div class="context-menu-item" data-copy-as="base64"><span class="ctx-icon">⬢</span><span class="ctx-label">Base64</span></div>
    <div class="context-menu-item" data-copy-as="escaped"><span class="ctx-icon">❞</span><span class="ctx-label">Escaped</span></div>
    <div class="context-menu-item" data-copy-as="curl"><span class="ctx-icon">⎘</span><span class="ctx-label">cURL</span></div>
  `;
  document.body.appendChild(copyAsMenuEl);
  copyAsMenuEl.addEventListener('click', (e) => {
    const item = e.target.closest('[data-copy-as]');
    if (!item) return;
    hideCopyAsMenu();
    copySelectedAs(item.dataset.copyAs);
  });
  document.addEventListener('click', hideCopyAsMenu);
  document.addEventListener('scroll', hideCopyAsMenu, true);
}
function showCopyAsMenu(x, y) {
  ensureCopyAsMenu();
  hideMsgMenu();
  copyAsMenuEl.classList.remove('hidden');
  copyAsMenuEl.style.left = x + 'px';
  copyAsMenuEl.style.top = y + 'px';
  const rect = copyAsMenuEl.getBoundingClientRect();
  if (rect.right > window.innerWidth) copyAsMenuEl.style.left = Math.max(0, window.innerWidth - rect.width) + 'px';
  if (rect.bottom > window.innerHeight) copyAsMenuEl.style.top = Math.max(0, window.innerHeight - rect.height) + 'px';
}
function hideCopyAsMenu() {
  if (copyAsMenuEl) copyAsMenuEl.classList.add('hidden');
}
function copySelectedAs(format) {
  const msgs = state.messages.get(state.selectedSessionId) || [];
  const m = msgs.find((x) => x.id === state.selectedMessageId);
  if (!m) { showError('请先选择一条消息'); return; }
  if (m.payload_type === 'notice') return;
  const session = findSession(state.selectedSessionId);
  let text = '';
  let label = format;
  switch (format) {
    case 'raw': text = bytesToText(m.payload); label = 'Raw'; break;
    case 'hex': text = bytesToHex(m.payload); label = 'Hex'; break;
    case 'base64': text = bytesToBase64(m.payload); label = 'Base64'; break;
    case 'escaped': text = bytesToEscaped(m.payload); label = 'Escaped'; break;
    case 'curl': text = buildCurlCommand(session, m); label = 'cURL'; break;
    default: return;
  }
  copyWithToast(text, label);
}
document.getElementById('btn-copy-as')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const msgs = state.messages.get(state.selectedSessionId) || [];
  const m = msgs.find((x) => x.id === state.selectedMessageId);
  if (!m) { showError('请先选择一条消息'); return; }
  const rect = e.currentTarget.getBoundingClientRect();
  const x = rect.left;
  const y = rect.bottom + 4;
  // 切换显示
  ensureCopyAsMenu();
  if (!copyAsMenuEl.classList.contains('hidden')) { hideCopyAsMenu(); return; }
  showCopyAsMenu(x, y);
});

listen('session:status', (ev) => {
  // TimelineEvent 是用 tag=data 序列化的，所以读 data 字段
  const data = ev.payload.data || ev.payload;
  recordRuntimeStatus(data.session_id, {
    status: data.status,
    local_addr: data.local_addr,
    remote_addr: data.remote_addr,
  });
  renderProjectTree();
  // 如果当前选中的是这个会话，更新发送区域状态
  if (state.selectedSessionId === data.session_id) {
    updateSendArea();
  }
}).catch((e) => console.error('listen session:status failed', e));

// 连接失败等错误提示（端口占用、无法连接等）
listen('session:error', (ev) => {
  const data = ev.payload.data || ev.payload;
  if (data && data.message) {
    showErrorToast(data.message);
  }
}).catch((e) => console.error('listen session:error failed', e));

listen('session:message', (ev) => {
  // 全局消息事件，用于非选中会话（或未命中当前 endpoint 筛选）的未读角标计数。
  // 只统计收到的消息（in）；自己发出的消息（out）不计入未读。
  const data = ev.payload.data || ev.payload;
  if (data && data.session_id && data.direction === 'in') {
    incrementUnread(data.session_id, data.endpoint || null);
  }
  // 流量统计峰值：后台按会话维护 1s 滑窗，及时刷新 peak，即使面板隐藏或会话未选中
  if (data && data.session_id && data.payload_type !== 'notice') {
    const sid = data.session_id;
    let win = state.statsWindows.get(sid);
    if (!win) { win = []; state.statsWindows.set(sid, win); }
    win.push({ ts: data.timestamp, size: data.size, dir: data.direction });
    const cutoff = data.timestamp - 1000;
    while (win.length && win[0].ts < cutoff) win.shift();
    let cnt = win.length, bytes = 0, up = 0, down = 0, upB = 0, downB = 0;
    for (const e of win) { bytes += e.size; if (e.dir === 'out') { up++; upB += e.size; } else if (e.dir === 'in') { down++; downB += e.size; } }
    let peak = state.statsPeak.get(sid);
    if (!peak) { peak = { msg: 0, bytes: 0, upMsg: 0, downMsg: 0, upBytes: 0, downBytes: 0 }; state.statsPeak.set(sid, peak); }
    if (cnt > peak.msg) peak.msg = cnt;
    if (bytes > peak.bytes) peak.bytes = bytes;
    if (up > peak.upMsg) peak.upMsg = up;
    if (down > peak.downMsg) peak.downMsg = down;
    if (upB > peak.upBytes) peak.upBytes = upB;
    if (downB > peak.downBytes) peak.downBytes = downB;
  }
}).catch((e) => console.error('listen session:message failed', e));

listen('session:client_connected', async (ev) => {
  const { session_id, client_id, remote_addr } = ev.payload;
  // 强制从后端重新加载客户端列表，确保状态一致
  const list = await invoke('list_clients', { sessionId: session_id }).catch(() => []);
  state.clients.set(session_id, list);
  if (state.selectedSessionId === session_id) {
    renderClientList();
    updateSendArea();
  }
}).catch((e) => console.error('listen client_connected failed', e));

listen('session:client_disconnected', async (ev) => {
  const { session_id, client_id } = ev.payload;
  // 强制从后端重新加载客户端列表，确保状态一致
  const list = await invoke('list_clients', { sessionId: session_id }).catch(() => []);
  state.clients.set(session_id, list);
  if (state.selectedClientId === client_id) state.selectedClientId = null;
  if (state.selectedSessionId === session_id) {
    renderClientList();
    updateSendArea();
  }
}).catch((e) => console.error('listen client_disconnected failed', e));

listen('window:close-requested', () => {
  els.dlgCloseConfirm.showModal();
}).catch((e) => console.error('listen window:close-requested failed', e));

function applyTheme(theme) {
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
  updateThemeButtonIcon(theme);
}

// 主题下拉菜单
function initThemePicker() {
  if (!els.themeBtn || !els.themeMenu) return;

  els.themeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    els.themeMenu.classList.toggle('hidden');
  });

  els.themeMenu.addEventListener('click', async (e) => {
    const item = e.target.closest('.theme-menu-item');
    if (!item) return;
    const theme = item.dataset.theme;
    applyTheme(theme);
    try {
      await invoke('set_theme', { theme });
    } catch (err) {
      console.error('set_theme failed', err);
    }
    hideThemeMenu();
  });

  document.addEventListener('click', hideThemeMenu);
}

function hideThemeMenu() {
  if (els.themeMenu) els.themeMenu.classList.add('hidden');
}

function updateThemeButtonIcon(theme) {
  const svg = document.getElementById('theme-icon-current');
  if (!svg) return;
  if (theme === 'dark') {
    svg.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
  } else if (theme === 'light') {
    svg.innerHTML = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>';
  } else {
    svg.innerHTML = '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>';
  }
}

async function openSettingsView() {
  try {
    const minimize = await invoke('get_minimize_to_tray');
    els.settingMinimizeToTray.checked = minimize;
    if (els.settingSendKeyMode) {
      els.settingSendKeyMode.value = state.sendKeyMode;
    }
    // 每次打开默认回到【通用】页，保存按钮可见
    document.querySelectorAll('[data-settings-cat]').forEach((c) => {
      c.classList.toggle('active', c.dataset.settingsCat === 'general');
    });
    document.querySelectorAll('[data-settings-pane]').forEach((p) => {
      p.classList.toggle('hidden', p.dataset.settingsPane !== 'general');
    });
    const saveBtn = document.getElementById('btn-settings-save');
    if (saveBtn) saveBtn.classList.remove('hidden');
    els.settingsView.showModal();
  } catch (e) {
    console.error('openSettingsView failed', e);
  }
}

// 设置弹框左侧菜单切换
function initSettingsMenu() {
  const cats = document.querySelectorAll('[data-settings-cat]');
  const saveBtn = document.getElementById('btn-settings-save');
  cats.forEach((cat) => {
    cat.addEventListener('click', () => {
      cats.forEach((c) => c.classList.remove('active'));
      cat.classList.add('active');
      const name = cat.dataset.settingsCat;
      document.querySelectorAll('[data-settings-pane]').forEach((p) => {
        p.classList.toggle('hidden', p.dataset.settingsPane !== name);
      });
      // 保存按钮在有可保存设置的页面显示（通用 / 快捷键）
      if (saveBtn) saveBtn.classList.toggle('hidden', name === 'about');
    });
  });
}

function closeSettingsView() {
  els.settingsView.close();
}

async function saveSettings() {
  const minimize = els.settingMinimizeToTray.checked;
  if (els.settingSendKeyMode) {
    const v = els.settingSendKeyMode.value === 'ctrlEnter' ? 'ctrlEnter' : 'enter';
    state.sendKeyMode = v;
    try { localStorage.setItem('send-key-mode', v); } catch { /* ignore */ }
  }
  try {
    await invoke('set_minimize_to_tray', { value: minimize });
    closeSettingsView();
  } catch (e) {
    showError('保存设置失败: ' + e);
  }
}

async function confirmClose() {
  const minimizeToTray = els.closeConfirmMinimizeToTray.checked;
  try {
    await invoke('set_minimize_to_tray', { value: minimizeToTray });
    els.dlgCloseConfirm.close();
    if (minimizeToTray) {
      await invoke('hide_window');
    } else {
      await invoke('exit_app');
    }
  } catch (e) {
    showError('关闭失败: ' + e);
  }
}

function showToast(message, type) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  container.classList.remove('hidden');
  const toast = document.createElement('div');
  toast.className = 'toast' + (type ? ' ' + type : '');
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('toast-hide');
    setTimeout(() => {
      toast.remove();
      if (container.children.length === 0) container.classList.add('hidden');
    }, 300);
  }, 5000);
}

function showErrorToast(message) {
  showToast(message, 'toast-error');
}

// 错误提示统一走 toast，替代浏览器默认 alert。
function showError(message) {
  showErrorToast(String(message));
}

// 自定义确认对话框，替代浏览器默认 confirm。resolve(true/false)。
function showConfirm(message, html) {
  const dlg = document.getElementById('dlg-confirm');
  const msgEl = document.getElementById('dlg-confirm-message');
  if (html) {
    msgEl.innerHTML = html;
  } else {
    msgEl.textContent = message;
  }
  return new Promise((resolve) => {
    const ok = document.getElementById('btn-confirm-ok');
    const cancel = document.getElementById('btn-confirm-cancel');
    const done = (val) => {
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      dlg.removeEventListener('keydown', onKey);
      dlg.close();
      resolve(val);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    // Enter 确认，Esc 取消
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(true); }
      else if (e.key === 'Escape') { e.preventDefault(); done(false); }
    };
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    dlg.addEventListener('keydown', onKey);
    dlg.showModal();
  });
}

function showStopConfirm(session) {
  const dlg = document.getElementById('dlg-stop-session');
  const typeEl = document.getElementById('dlg-stop-type');
  const roleEl = document.getElementById('dlg-stop-role');
  const nameEl = document.getElementById('dlg-stop-name');
  const typeLabel = session.protocol === 'ws' ? 'WS' : session.protocol.toUpperCase();
  const roleLabel = session.role === 'server' ? 'S' : 'C';
  const roleClass = session.role === 'server' ? 'role-server' : 'role-client';
  const roleTitle = session.role === 'server' ? '服务端' : '客户端';
  const displayName = session.name || (session.role === 'server' ? session.bind_addr || ':?' : session.target_url || '?');
  typeEl.textContent = typeLabel;
  typeEl.className = 'session-type ' + roleClass;
  roleEl.textContent = roleLabel;
  roleEl.className = 'role-badge ' + roleClass;
  roleEl.dataset.tip = roleTitle;
  nameEl.textContent = displayName;
  return new Promise((resolve) => {
    const ok = document.getElementById('btn-stop-ok');
    const cancel = document.getElementById('btn-stop-cancel');
    const done = (val) => {
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      dlg.removeEventListener('keydown', onKey);
      dlg.removeEventListener('click', onBackdrop);
      dlg.close();
      resolve(val);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(true); }
      else if (e.key === 'Escape') { e.preventDefault(); done(false); }
    };
    const onBackdrop = (e) => { if (e.target === dlg) done(false); };
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    dlg.addEventListener('keydown', onKey);
    dlg.addEventListener('click', onBackdrop);
    dlg.showModal();
  });
}

// 自定义输入对话框，替代浏览器默认 prompt。resolve(输入值)；取消 resolve(null)。
function showPrompt(message, initialValue) {
  const dlg = document.getElementById('dlg-prompt');
  const msgEl = document.getElementById('dlg-prompt-message');
  const inputEl = document.getElementById('dlg-prompt-input');
  msgEl.textContent = message;
  inputEl.value = initialValue || '';
  return new Promise((resolve) => {
    const ok = document.getElementById('btn-prompt-ok');
    const cancel = document.getElementById('btn-prompt-cancel');
    const done = (val) => {
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      inputEl.removeEventListener('keydown', onKey);
      dlg.close();
      resolve(val);
    };
    const onOk = () => done(inputEl.value);
    const onCancel = () => done(null);
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(inputEl.value); }
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
    };
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    inputEl.addEventListener('keydown', onKey);
    dlg.showModal();
    inputEl.focus();
    inputEl.select();
  });
}

// 禁用浏览器默认右键菜单
document.addEventListener('contextmenu', (e) => e.preventDefault());

// ===== 无边框窗口控制按钮 + 拖拽 =====
(function initWindowControls() {
  const win = window.__TAURI__ && window.__TAURI__.window
    ? window.__TAURI__.window.getCurrentWindow()
    : null;
  const min = document.getElementById('btn-win-min');
  const max = document.getElementById('btn-win-max');
  const close = document.getElementById('btn-win-close');
  if (!win || !min || !max || !close) return;

  min.addEventListener('click', () => { win.minimize().catch(() => {}); });

  const updateMaxIcon = async () => {
    try {
      const isMax = await win.isMaximized();
      max.textContent = isMax ? '❐' : '□';
    } catch { /* ignore */ }
  };
  max.addEventListener('click', () => {
    win.toggleMaximize().then(updateMaxIcon).catch(() => {});
  });

  // 关闭：勾选「最小化到托盘」则直接隐藏窗口，否则弹确认框（与原生关闭一致）
  close.addEventListener('click', async () => {
    try {
      const minimize = await invoke('get_minimize_to_tray');
      if (minimize) {
        await invoke('hide_window');
        return;
      }
    } catch (e) {
      console.error('get_minimize_to_tray failed', e);
    }
    els.dlgCloseConfirm.showModal();
  });

  // 标题栏拖拽 + 双击最大化/还原：用 e.detail 区分单击拖拽与双击，
  // 避免 startDragging 与 toggleMaximize 同时触发（否则双击会先最大化又还原）。
  const dragBar = document.querySelector('.titlebar');
  if (dragBar) {
    dragBar.addEventListener('mousedown', (e) => {
      if (e.buttons !== 1) return;
      if (e.target.closest('button, .theme-menu, .tpl-menu, input, select, textarea')) return;
      if (e.detail === 2) {
        win.toggleMaximize().catch(() => {});
      } else {
        win.startDragging().catch(() => {});
      }
    });
  }
})();

// ===== 分栏拖拽调节 =====
const layout = {
  sidebarW: 220,
  detailW: 320,
  sendH: 150,
  minSidebarW: 160,
  maxSidebarW: 500,
  minDetailW: 200,
  maxDetailW: 600,
  minSendH: 90,
};

function loadLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem('netdebugger.layout') || '{}');
    if (saved.sidebarW) layout.sidebarW = saved.sidebarW;
    if (saved.detailW) layout.detailW = saved.detailW;
    if (saved.sendH) layout.sendH = saved.sendH;
  } catch (e) { /* ignore */ }
}

function saveLayout() {
  localStorage.setItem('netdebugger.layout', JSON.stringify({
    sidebarW: layout.sidebarW,
    detailW: layout.detailW,
    sendH: layout.sendH,
  }));
}

function applyLayout() {
  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.style.width = layout.sidebarW + 'px';
  const detail = document.getElementById('detail-pane');
  if (detail) detail.style.width = layout.detailW + 'px';
  const sendArea = document.getElementById('send-area');
  if (sendArea) sendArea.style.height = layout.sendH + 'px';
}

// vertical splitter: 拖拽调整 handle 左侧(prev)元素的宽度
// invert=true 时方向取反（调整的是分隔条右侧区域时，跟随鼠标移动方向变化）
function initVSplitter(handleId, get, set, min, max, invert) {
  const handle = document.getElementById(handleId);
  if (!handle) return;
  let startX = 0, startVal = 0;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startVal = get();
    document.body.classList.add('resizing');
    const onMove = (ev) => {
      const delta = ev.clientX - startX;
      const val = startVal + (invert ? -delta : delta);
      set(Math.max(min, Math.min(max, val)));
      applyLayout();
    };
    const onUp = () => {
      document.body.classList.remove('resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      saveLayout();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// horizontal splitter: 拖拽调整 handle 下方(next)元素的高度
function initHSplitter(handleId, get, set, min, max, invert) {
  const handle = document.getElementById(handleId);
  if (!handle) return;
  let startY = 0, startVal = 0;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startY = e.clientY;
    startVal = get();
    document.body.classList.add('resizing-h');
    const onMove = (ev) => {
      const delta = ev.clientY - startY;
      const val = startVal + (invert ? -delta : delta);
      set(Math.max(min, Math.min(max, val)));
      applyLayout();
    };
    const onUp = () => {
      document.body.classList.remove('resizing-h');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      saveLayout();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function initSplitters() {
  loadLayout();
  applyLayout();
  initVSplitter('splitter-sidebar',
    () => layout.sidebarW,
    (v) => { layout.sidebarW = v; },
    layout.minSidebarW, layout.maxSidebarW, false);
  initVSplitter('splitter-detail',
    () => layout.detailW,
    (v) => { layout.detailW = v; },
    layout.minDetailW, layout.maxDetailW, true);
  initHSplitter('splitter-send',
    () => layout.sendH,
    (v) => { layout.sendH = v; },
    layout.minSendH, Math.round(window.innerHeight * 0.5), true);
}

const ICON_UPDATE = `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>`;
const ICON_SPINNING = `<path d="M21 12a9 9 0 1 1-6.219-8.56"/>`;

function setUpdateIcon(spinning) {
  const svg = document.getElementById('icon-update');
  if (!svg) return;
  svg.classList.toggle('spinning', spinning);
  svg.innerHTML = spinning ? ICON_SPINNING : ICON_UPDATE;
}

function setAboutUpdateChecking(checking) {
  const btn = document.getElementById('btn-check-update');
  if (!btn) return;
  btn.classList.toggle('is-checking', checking);
  btn.disabled = checking;
  const spinner = btn.querySelector('.btn-check-spinner');
  if (spinner) spinner.classList.toggle('hidden', !checking);
}

// ─── 更新下载进度浮窗 ───
let updateDownloaded = 0;
let updateContentLength = 0;
let updateProgressVisible = false;

function showUpdateProgress(visible) {
  updateProgressVisible = visible;
  const el = document.getElementById('update-progress');
  if (!el) return;
  el.classList.toggle('hidden', !visible);
  if (visible) {
    updateDownloaded = 0;
    updateContentLength = 0;
    const fill = document.getElementById('update-progress-fill');
    const text = document.getElementById('update-progress-text');
    if (fill) { fill.classList.remove('indeterminate'); fill.style.width = '0%'; }
    if (text) text.textContent = '准备中…';
  }
}

function onUpdateDownloadEvent(event) {
  const fill = document.getElementById('update-progress-fill');
  const text = document.getElementById('update-progress-text');
  if (!fill || !text) return;
  switch (event.event) {
    case 'Started': {
      updateContentLength = event.data.contentLength || 0;
      if (!updateContentLength) fill.classList.add('indeterminate');
      break;
    }
    case 'Progress': {
      updateDownloaded += event.data.chunkLength;
      if (updateContentLength > 0) {
        fill.classList.remove('indeterminate');
        const pct = Math.min(100, Math.round(updateDownloaded / updateContentLength * 100));
        fill.style.width = pct + '%';
        text.textContent = `${formatBytesShort(updateDownloaded)} / ${formatBytesShort(updateContentLength)} · ${pct}%`;
      } else {
        text.textContent = `已下载 ${formatBytesShort(updateDownloaded)}`;
      }
      break;
    }
    case 'Finished': {
      fill.classList.remove('indeterminate');
      fill.style.width = '100%';
      text.textContent = '下载完成，正在安装…';
      break;
    }
  }
}

// ─── 自动更新 ───
let hasUpdate = false;

function showUpdateBadge(visible) {
  hasUpdate = visible;
  const badge = document.getElementById('update-badge');
  if (badge) badge.classList.toggle('hidden', !visible);
}

function showUpdateDialog(currentVersion, newVersion) {
  const dlg = document.getElementById('dlg-update');
  const msgEl = document.getElementById('dlg-update-message');
  const btnClose = document.getElementById('btn-update-close');
  const btnApply = document.getElementById('btn-update-apply');

  if (newVersion) {
    msgEl.innerHTML = `发现新版本\n\n当前版本：v${currentVersion}\n最新版本：v${newVersion}`;
    btnApply.classList.remove('hidden');
  } else {
    msgEl.innerHTML = `当前已是最新版本\n\nv${currentVersion}`;
    btnApply.classList.add('hidden');
  }

  return new Promise((resolve) => {
    const cleanup = () => {
      btnClose.removeEventListener('click', onClose);
      btnApply.removeEventListener('click', onApply);
      dlg.removeEventListener('click', onBackdrop);
      dlg.close();
    };
    const onClose = () => { cleanup(); resolve(); };
    const onApply = () => { cleanup(); resolve('update'); };
    const onBackdrop = (e) => { if (e.target === dlg) onClose(); };

    btnClose.addEventListener('click', onClose);
    btnApply.addEventListener('click', onApply);
    dlg.addEventListener('click', onBackdrop);
    dlg.showModal();
  });
}

async function checkForUpdates(silent = false) {
  if (!silent) { setUpdateIcon(true); setAboutUpdateChecking(true); }

  let currentVersion = '';
  try {
    currentVersion = await invoke('get_app_version');
  } catch (_) {}

  try {
    const { check } = window.__TAURI__.updater;
    const update = await check();
    if (!silent) { setUpdateIcon(false); setAboutUpdateChecking(false); }
    if (update) {
      showUpdateBadge(true);
      if (!silent) {
        const action = await showUpdateDialog(currentVersion, update.version);
        if (action === 'update') {
          showUpdateProgress(true);
          try {
            await update.downloadAndInstall(onUpdateDownloadEvent);
          } catch (e) {
            showUpdateProgress(false);
            throw e;
          }
        }
      }
    } else {
      showUpdateBadge(false);
      if (!silent) await showUpdateDialog(currentVersion, null);
    }
  } catch (e) {
    if (!silent) { setUpdateIcon(false); setAboutUpdateChecking(false); }
    if (!silent) showError('检查更新失败：' + e);
    console.error('checkForUpdates failed', e);
  }
}

document.getElementById('btn-win-update')?.addEventListener('click', () => checkForUpdates(false));
document.getElementById('btn-check-update')?.addEventListener('click', () => checkForUpdates(false));

// 加载主题设置
async function initTheme() {
  try {
    const theme = await invoke('get_theme');
    applyTheme(theme);
  } catch (e) {
    console.error('initTheme failed', e);
  }
}

// 首屏初始化完成后显示窗口，跳过 WebView2 冷启动白屏阶段
(async function init() {
  updateContentArea();
  await Promise.all([loadProjects(), initTheme()]);
  initSplitters();
  initThemePicker();
  initSettingsMenu();
  initSendKeyMode();
  initTruncateToggle();
  initStats();
  initTemplateResize();
  initTemplateDrag();
  loadTemplates();
  renderTemplateMenu();
  // 加载版本号并填充标题栏与关于页（版本号单点维护于 Cargo.toml）
  try {
    const v = await invoke('get_app_version');
    const verEls = document.querySelectorAll('#app-version, #about-version, #welcome-version');
    verEls.forEach((el) => { el.textContent = 'v' + v; });
  } catch (e) {
    console.error('get_app_version failed', e);
  }
  window.__TAURI__.window.getCurrentWindow().show();
  // 启动后静默检查更新，之后每 30 分钟检查一次
  checkForUpdates(true);
  setInterval(() => checkForUpdates(true), 30 * 60 * 1000);
})();
