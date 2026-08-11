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
  autoScroll: true,
  endpointDraft: [],
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
  sendType: document.getElementById('send-type'),
  sendInput: document.getElementById('send-input'),
  dlgProject: document.getElementById('dlg-project'),
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
  sessionBind: document.getElementById('session-bind'),
  sessionUrl: document.getElementById('session-url'),
  sessionClientEndpoint: document.getElementById('session-client-endpoint'),
  endpointList: document.getElementById('endpoint-list'),
  endpointInput: document.getElementById('endpoint-input'),
  btnEndpointAdd: document.getElementById('btn-endpoint-add'),
  timelineSearch: document.getElementById('timeline-search'),
  settingsView: document.getElementById('settings-view'),
  settingMinimizeToTray: document.getElementById('setting-minimize-to-tray'),
  themeRadios: document.querySelectorAll('input[name="theme"]'),
  dlgCloseConfirm: document.getElementById('dlg-close-confirm'),
  closeConfirmMinimizeToTray: document.getElementById('close-confirm-minimize-to-tray'),
};

let detailTab = 'text';

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

function findSession(id) {
  for (const p of state.projects) {
    for (const s of p.sessions) {
      if (s.id === id) return s;
    }
  }
  return null;
}

async function loadProjects() {
  try {
    state.projects = await invoke('list_projects');
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
    const deleteBtn = isUngrouped
      ? ''
      : `<button data-action="delete-project" data-project="${p.project.id}" title="删除分组">×</button>
      `;

    const header = document.createElement('div');
    header.className = 'project-header';
    header.innerHTML = `
      <span class="project-toggle">▼</span>
      <span class="project-name">${escapeHtml(p.project.name)}</span>
      <span class="project-actions">
        <button data-action="add-session" data-project="${p.project.id}" title="添加连接">+</button>
        ${deleteBtn}
      </span>
    `;
    header.addEventListener('click', (ev) => {
      if (ev.target.closest('button')) return;
      const list = group.querySelector('.session-list');
      const toggle = header.querySelector('.project-toggle');
      list.classList.toggle('hidden');
      toggle.textContent = list.classList.contains('hidden') ? '▶' : '▼';
    });

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
      const editBtn = canEdit
        ? `<button data-action="edit-session" data-session="${s.id}" title="编辑">✎</button>`
        : '';
      const typeLabel = s.protocol === 'ws' ? 'WS' : s.protocol.toUpperCase();
      const displayName = s.name || (s.role === 'server'
        ? `WS Server ${s.bind_addr || ':?'}`
        : `WS Client ${s.target_url || '?'}`);

      const isRunning = s.status === 'running' || s.status === 'starting';
      const toggleAction = isRunning ? 'stop' : 'start';
      const toggleIcon = isRunning ? '⏹' : '▶';
      const toggleTitle = isRunning ? '停止' : '启动';

      // 未读角标按 endpoint 分桶；连接的角标为各 endpoint 之和。
      const epUnread = state.unreadCounts.get(s.id) || new Map();
      const sessionUnread = [...epUnread.values()].reduce((a, b) => a + b, 0);
      const badge = sessionUnread > 0
        ? `<span class="session-badge">${sessionUnread > 99 ? '99+' : sessionUnread}</span>`
        : '';

      const expander = hasEps
        ? `<span class="session-expander" title="${collapsed ? '展开' : '折叠'}">${collapsed ? '▶' : '▼'}</span>`
        : '';

      item.innerHTML = `
        ${expander}
        <span class="session-type ${s.status}">${escapeHtml(typeLabel)}</span>
        <span class="session-name">${escapeHtml(displayName)}</span>
        ${badge}
        <span class="session-actions">
          ${editBtn}
          <button data-action="${toggleAction}" data-session="${s.id}" title="${toggleTitle}">${toggleIcon}</button>
          <button data-action="delete-session" data-session="${s.id}" title="删除">×</button>
        </span>
      `;
      item.addEventListener('click', (ev) => {
        if (ev.target.closest('button')) return;
        if (ev.target.closest('.session-expander')) {
          toggleSessionCollapse(s.id);
          return;
        }
        selectSession(s.id);
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
            selectSession(s.id, ep);
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
  } else if (action === 'edit-session') {
    const s = findSession(btn.dataset.session);
    if (s) openEditSessionDialog(s);
  } else if (action === 'delete-project') {
    deleteProject(btn.dataset.project);
  } else if (action === 'start') {
    startSession(btn.dataset.session);
  } else if (action === 'stop') {
    stopSession(btn.dataset.session);
  } else if (action === 'delete-session') {
    deleteSession(btn.dataset.session);
  }
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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
  els.sessionBind.value = '127.0.0.1:8080';
  els.sessionUrl.value = '127.0.0.1:8080';
  els.sessionClientEndpoint.value = '';
  state.endpointDraft = [];
  renderEndpointList();
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
    els.sessionBind.value = session.bind_addr || '';
    els.sessionUrl.value = '127.0.0.1:8080';
    els.sessionClientEndpoint.value = '';
    els.sessionServerConfig.classList.remove('hidden');
    els.sessionClientConfig.classList.add('hidden');
  } else {
    els.sessionBind.value = '127.0.0.1:8080';
    // 目标地址回显：去掉 ws:// 前缀，只显示 host:port（若历史数据带前缀则剥掉）
    els.sessionUrl.value = stripWsPrefix(session.target_url || '');
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

function renderEndpointList() {
  els.endpointList.innerHTML = '';
  for (const ep of state.endpointDraft) {
    const row = document.createElement('div');
    row.className = 'endpoint-item';
    row.innerHTML = `<span class="endpoint-path">${escapeHtml(ep)}</span><button type="button" class="endpoint-remove" title="删除">×</button>`;
    row.querySelector('.endpoint-remove').addEventListener('click', () => {
      state.endpointDraft = state.endpointDraft.filter((x) => x !== ep);
      renderEndpointList();
    });
    els.endpointList.appendChild(row);
  }
}

function addEndpointFromInput() {
  const val = els.endpointInput.value.trim();
  if (!val) return;
  if (state.endpointDraft.includes(val)) return;
  state.endpointDraft.push(val);
  els.endpointInput.value = '';
  renderEndpointList();
}

async function createProject() {
  const name = els.projectName.value.trim();
  if (!name) return;
  try {
    await invoke('create_project', { name });
    els.projectName.value = '';
    await loadProjects();
  } catch (e) {
    showError('创建分组失败: ' + e);
  }
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
  const req = {
    project_id: projectId || null,
    name: name || null,
    protocol: els.sessionProtocol.value,
    role: els.sessionRole.value,
    bind_addr: isServer ? els.sessionBind.value.trim() || null : null,
    target_url: targetUrl || null,
    endpoints,
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
  if (!await showConfirm('确定删除该连接及其消息？')) return;
  try {
    await invoke('delete_session', { id });
    state.unreadCounts.delete(id);
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
  state.selectedSessionId = id;
  state.selectedMessageId = null;
  state.selectedClientId = null;
  state.messages.set(id, []);
  state.clients.set(id, []);
  state.endpointFilter.set(id, endpoint || 'all');
  state.searchQuery = '';
  state.autoScroll = true;
  if (els.timelineSearch) els.timelineSearch.value = '';
  // 清空当前选中会话（或该 endpoint）的未读角标
  if (id) {
    if (endpoint) {
      const m = state.unreadCounts.get(id);
      if (m) { m.delete(endpoint); renderProjectTree(); }
    } else {
      state.unreadCounts.delete(id);
      renderProjectTree();
    }
  }
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
    } else if (event.type === 'Status') {
      const s = findSession(event.data.session_id);
      if (s) {
        s.status = event.data.status;
        s.local_addr = event.data.local_addr;
        s.remote_addr = event.data.remote_addr;
        renderProjectTree();
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
    renderTimeline();
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

function appendMessage(sessionId, msg) {
  if (state.selectedSessionId !== sessionId) return;
  const list = state.messages.get(sessionId) || [];
  list.push(msg);
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
    msgs = msgs.filter(m => m.endpoint === filter);
  }
  const q = state.searchQuery.trim().toLowerCase();
  if (q) {
    msgs = msgs.filter(m => bytesToText(m.payload).toLowerCase().includes(q));
  }
  if (msgs.length === 0) {
    els.timeline.innerHTML = '<div class="detail-empty">暂无消息</div>';
    return;
  }

  for (const m of msgs) {
    const el = document.createElement('div');
    el.className = 'message ' + m.direction + (m.id === state.selectedMessageId ? ' selected' : '');
    el.dataset.id = m.id;
    const text = bytesToText(m.payload);
    const epBadge = m.endpoint ? `<span class="msg-endpoint">${escapeHtml(m.endpoint)}</span>` : '';
    const sender = m.direction === 'in' ? getSenderLabel(id, m) : '';
    const displayText = text.length > 200 ? text.slice(0, 200) + '…' : text;
    const body = q ? highlightText(displayText, q) : escapeHtml(displayText);
    el.innerHTML = `
      <div class="message-meta">
        <span>${formatTime(m.timestamp)}</span>
        <span>${m.direction === 'in' ? '←' : '→'}</span>
        <span>${m.payload_type}</span>
        ${epBadge}
        ${sender}
      </div>
      <div class="message-body">${body}</div>
    `;
    el.addEventListener('click', () => {
      state.selectedMessageId = m.id;
      renderTimeline();
      renderDetail();
    });
    els.timeline.appendChild(el);
  }

  // 自动滚动：只有用户停留在底部时才跟随新消息滚动到底；上滑查看历史时暂停。
  if (state.autoScroll) {
    els.timeline.scrollTop = els.timeline.scrollHeight;
  }
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
  if (detailTab === 'hex') {
    els.detailBody.textContent = bytesToHex(bytes);
  } else if (detailTab === 'json') {
    const text = bytesToText(bytes);
    try {
      els.detailBody.textContent = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      els.detailBody.textContent = '不是有效的 JSON';
    }
  } else {
    els.detailBody.textContent = bytesToText(bytes);
  }
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
  els.sendTarget.innerHTML = '';
  if (!id) {
    els.sendInput.disabled = true;
    els.sendType.disabled = true;
    els.sendTarget.disabled = true;
    document.getElementById('btn-send').disabled = true;
    return;
  }
  const s = findSession(id);
  if (!s) return;

  const isConnected = s.status === 'running';
  els.sendInput.disabled = !isConnected;
  els.sendType.disabled = !isConnected;
  els.sendTarget.disabled = !isConnected;
  document.getElementById('btn-send').disabled = !isConnected;

  if (s.role === 'server') {
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
    const opt = document.createElement('option');
    opt.value = 'server';
    opt.textContent = '服务端';
    els.sendTarget.appendChild(opt);
  }
}

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
    chip.innerHTML = `<span class="client-label">${escapeHtml(label)}</span>${ep}<span class="client-actions"><span class="rename-hint" title="重命名">✎</span><span class="disconnect-hint" title="断开连接">×</span></span>`;
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
  const payloadType = els.sendType.value;
  const s = findSession(id);
  let clientId = null, endpoint = null;
  if (s && s.role === 'server') {
    const v = els.sendTarget.value;
    if (v && v !== 'all') {
      if (v.startsWith('ep:')) endpoint = v.slice(3);
      else clientId = v;
    }
  }

  try {
    await invoke('send_message', {
      sessionId: id,
      payload: text,
      payloadType,
      clientId,
      endpoint,
    });
    els.sendInput.value = '';
  } catch (e) {
    showError('发送失败: ' + e);
  }
}

async function clearMessages() {
  const id = state.selectedSessionId;
  if (!id) return;
  if (!await showConfirm('确定清空当前会话的消息记录？')) return;
  try {
    await invoke('clear_messages', { sessionId: id });
    state.messages.set(id, []);
    state.unreadCounts.delete(id);
    renderProjectTree();
    renderTimeline();
    renderDetail();
  } catch (e) {
    showError('清空失败: ' + e);
  }
}

// Event listeners
document.getElementById('btn-new-project').addEventListener('click', () => {
  els.dlgProject.showModal();
});

document.getElementById('btn-new-session').addEventListener('click', () => {
  openSessionDialog(null);
});

document.getElementById('btn-project-ok').addEventListener('click', (ev) => {
  ev.preventDefault();
  createProject();
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
els.sendInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    sendMessage();
  }
});

els.btnEndpointAdd.addEventListener('click', addEndpointFromInput);
els.endpointInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    addEndpointFromInput();
  }
});

els.timelineSearch.addEventListener('input', () => {
  state.searchQuery = els.timelineSearch.value;
  renderTimeline();
});

// 用户上滑查看历史时暂停自动滚动；回到底部后恢复。
els.timeline.addEventListener('scroll', () => {
  const el = els.timeline;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  state.autoScroll = atBottom;
});

document.getElementById('btn-clear').addEventListener('click', clearMessages);

document.getElementById('btn-settings').addEventListener('click', openSettingsView);

document.getElementById('btn-settings-save').addEventListener('click', (ev) => {
  ev.preventDefault();
  saveSettings();
});

document.getElementById('btn-settings-close').addEventListener('click', (ev) => {
  ev.preventDefault();
  closeSettingsView();
});

for (const radio of els.themeRadios) {
  radio.addEventListener('change', () => {
    applyTheme(getSelectedTheme());
  });
}

document.getElementById('btn-close-confirm-ok').addEventListener('click', (ev) => {
  ev.preventDefault();
  confirmClose();
});

document.querySelectorAll('.detail-tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.detail-tabs button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    detailTab = btn.dataset.tab;
    renderDetail();
  });
});

listen('session:status', (ev) => {
  // TimelineEvent 是用 tag=data 序列化的，所以读 data 字段
  const data = ev.payload.data || ev.payload;
  const s = findSession(data.session_id);
  if (s) {
    s.status = data.status;
    s.local_addr = data.local_addr;
    s.remote_addr = data.remote_addr;
    renderProjectTree();
    // 如果当前选中的是这个会话，更新发送区域状态
    if (state.selectedSessionId === data.session_id) {
      updateSendArea();
    }
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

let savedTheme = 'system';

function applyTheme(theme) {
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

function getSelectedTheme() {
  for (const radio of els.themeRadios) {
    if (radio.checked) return radio.value;
  }
  return 'system';
}

function setSelectedTheme(theme) {
  for (const radio of els.themeRadios) {
    radio.checked = radio.value === theme;
  }
}

async function openSettingsView() {
  try {
    const minimize = await invoke('get_minimize_to_tray');
    const theme = await invoke('get_theme');
    els.settingMinimizeToTray.checked = minimize;
    savedTheme = theme;
    setSelectedTheme(theme);
    applyTheme(theme);
    els.settingsView.classList.remove('hidden');
  } catch (e) {
    console.error('openSettingsView failed', e);
  }
}

function closeSettingsView() {
  applyTheme(savedTheme);
  els.settingsView.classList.add('hidden');
}

async function saveSettings() {
  const minimize = els.settingMinimizeToTray.checked;
  const theme = getSelectedTheme();
  try {
    await invoke('set_minimize_to_tray', { value: minimize });
    await invoke('set_theme', { theme });
    savedTheme = theme;
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

function showErrorToast(message) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  container.classList.remove('hidden');
  const toast = document.createElement('div');
  toast.className = 'toast toast-error';
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

// 错误提示统一走 toast，替代浏览器默认 alert。
function showError(message) {
  showErrorToast(String(message));
}

// 自定义确认对话框，替代浏览器默认 confirm。resolve(true/false)。
function showConfirm(message) {
  const dlg = document.getElementById('dlg-confirm');
  const msgEl = document.getElementById('dlg-confirm-message');
  msgEl.textContent = message;
  return new Promise((resolve) => {
    const ok = document.getElementById('btn-confirm-ok');
    const cancel = document.getElementById('btn-confirm-cancel');
    const done = (val) => {
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      dlg.close();
      resolve(val);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
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

// Init
updateContentArea();
loadProjects();
initSplitters();

// Load theme setting on startup.
(async function initTheme() {
  try {
    const theme = await invoke('get_theme');
    savedTheme = theme;
    applyTheme(theme);
  } catch (e) {
    console.error('initTheme failed', e);
  }
})();
