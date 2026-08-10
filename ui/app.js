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
};

const els = {
  projectTree: document.getElementById('project-tree'),
  timeline: document.getElementById('timeline'),
  clientListBar: document.getElementById('client-list-bar'),
  clientList: document.getElementById('client-list'),
  detailEmpty: document.getElementById('detail-empty'),
  detailContent: document.getElementById('detail-content'),
  detailDirection: document.getElementById('detail-direction'),
  detailTime: document.getElementById('detail-time'),
  detailSize: document.getElementById('detail-size'),
  detailType: document.getElementById('detail-type'),
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

      const unreadCount = state.unreadCounts.get(s.id) || 0;
      const badge = unreadCount > 0
        ? `<span class="session-badge">${unreadCount > 99 ? '99+' : unreadCount}</span>`
        : '';

      item.innerHTML = `
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
        selectSession(s.id);
      });
      list.appendChild(item);
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
  els.sessionBind.value = '127.0.0.1:8080';
  els.sessionUrl.value = 'ws://127.0.0.1:8080';
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
  if (session.role === 'server') {
    els.sessionBind.value = session.bind_addr || '';
    els.sessionUrl.value = 'ws://127.0.0.1:8080';
    els.sessionServerConfig.classList.remove('hidden');
    els.sessionClientConfig.classList.add('hidden');
  } else {
    els.sessionBind.value = '127.0.0.1:8080';
    els.sessionUrl.value = session.target_url || '';
    els.sessionServerConfig.classList.add('hidden');
    els.sessionClientConfig.classList.remove('hidden');
  }
  els.dlgSession.showModal();
}

async function createProject() {
  const name = els.projectName.value.trim();
  if (!name) return;
  try {
    await invoke('create_project', { name });
    els.projectName.value = '';
    await loadProjects();
  } catch (e) {
    alert('创建分组失败: ' + e);
  }
}

async function deleteProject(id) {
  if (id === '_ungrouped') return;
  if (!confirm('确定删除该分组及其所有会话和消息？')) return;
  try {
    await invoke('delete_project', { id });
    if (state.selectedSessionId && !findSession(state.selectedSessionId)) {
      selectSession(null);
    }
    await loadProjects();
  } catch (e) {
    alert('删除分组失败: ' + e);
  }
}

async function saveSession() {
  const editId = els.editSessionId.value.trim();
  const projectId = els.sessionProject.value.trim();
  const name = els.sessionName.value.trim();
  const req = {
    project_id: projectId || null,
    name: name || null,
    protocol: els.sessionProtocol.value,
    role: els.sessionRole.value,
    bind_addr: els.sessionRole.value === 'server' ? els.sessionBind.value.trim() || null : null,
    target_url: els.sessionRole.value === 'client' ? els.sessionUrl.value.trim() || null : null,
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
    alert(editId ? '修改连接失败: ' + e : '创建连接失败: ' + e);
  }
}

async function deleteSession(id) {
  if (!confirm('确定删除该连接及其消息？')) return;
  try {
    await invoke('delete_session', { id });
    state.unreadCounts.delete(id);
    if (state.selectedSessionId === id) selectSession(null);
    await loadProjects();
  } catch (e) {
    alert('删除连接失败: ' + e);
  }
}

async function startSession(id) {
  try {
    await invoke('start_session', { id });
    await loadProjects();
  } catch (e) {
    alert('启动失败: ' + e);
  }
}

async function stopSession(id) {
  try {
    await invoke('stop_session', { id });
    await loadProjects();
  } catch (e) {
    alert('停止失败: ' + e);
  }
}

async function selectSession(id) {
  state.selectedSessionId = id;
  state.selectedMessageId = null;
  state.selectedClientId = null;
  state.messages.set(id, []);
  state.clients.set(id, []);
  // 清空当前选中会话的未读角标
  if (id) {
    state.unreadCounts.delete(id);
    renderProjectTree();
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

function incrementUnread(sessionId) {
  if (state.selectedSessionId === sessionId) return;
  const current = state.unreadCounts.get(sessionId) || 0;
  state.unreadCounts.set(sessionId, current + 1);
  renderProjectTree();
}

function renderTimeline() {
  els.timeline.innerHTML = '';
  const id = state.selectedSessionId;
  if (!id) {
    els.timeline.classList.add('empty');
    return;
  }
  els.timeline.classList.remove('empty');

  const msgs = state.messages.get(id) || [];
  if (msgs.length === 0) {
    els.timeline.innerHTML = '<div class="detail-empty">暂无消息</div>';
    return;
  }

  for (const m of msgs) {
    const el = document.createElement('div');
    el.className = 'message ' + m.direction + (m.id === state.selectedMessageId ? ' selected' : '');
    el.dataset.id = m.id;
    const text = bytesToText(m.payload);
    el.innerHTML = `
      <div class="message-meta">
        <span>${formatTime(m.timestamp)}</span>
        <span>${m.direction === 'in' ? '←' : '→'}</span>
        <span>${m.payload_type}</span>
      </div>
      <div class="message-body">${escapeHtml(text.slice(0, 200))}${text.length > 200 ? '…' : ''}</div>
    `;
    el.addEventListener('click', () => {
      state.selectedMessageId = m.id;
      renderTimeline();
      renderDetail();
    });
    els.timeline.appendChild(el);
  }

  els.timeline.scrollTop = els.timeline.scrollHeight;
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

  els.detailDirection.textContent = m.direction === 'in' ? '收到' : '发送';
  els.detailTime.textContent = new Date(m.timestamp).toLocaleString('zh-CN');
  els.detailSize.textContent = formatBytes(m.payload);
  els.detailType.textContent = m.payload_type;

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
    const clients = state.clients.get(id) || [];
    for (const c of clients) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name || c.remote_addr || c.id.slice(0, 8);
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
    chip.innerHTML = `<span class="client-label">${escapeHtml(label)}</span><span class="client-actions"><span class="rename-hint" title="重命名">✎</span><span class="disconnect-hint" title="断开连接">×</span></span>`;
    chip.querySelector('.client-label').addEventListener('click', (ev) => {
      ev.stopPropagation();
      state.selectedClientId = c.id;
      renderClientList();
      updateSendArea();
    });
    chip.querySelector('.rename-hint').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const newName = prompt('重命名客户端（留空清除）', c.name || '');
      if (newName === null) return;
      const trimmed = newName.trim();
      try {
        await invoke('update_client_name', { id: c.id, name: trimmed || null });
        c.name = trimmed || null;
        renderClientList();
        updateSendArea();
      } catch (e) {
        alert('重命名失败: ' + e);
      }
    });
    chip.querySelector('.disconnect-hint').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!confirm('确定断开此客户端连接？')) return;
      try {
        await invoke('disconnect_client', { sessionId: id, clientId: c.id });
      } catch (e) {
        alert('断开失败: ' + e);
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
  let clientId = null;
  if (s && s.role === 'server') {
    const v = els.sendTarget.value;
    if (v && v !== 'all') clientId = v;
  }

  try {
    await invoke('send_message', {
      sessionId: id,
      payload: text,
      payloadType,
      clientId,
    });
    els.sendInput.value = '';
  } catch (e) {
    alert('发送失败: ' + e);
  }
}

async function clearMessages() {
  const id = state.selectedSessionId;
  if (!id) return;
  if (!confirm('确定清空当前会话的消息记录？')) return;
  try {
    await invoke('clear_messages', { sessionId: id });
    state.messages.set(id, []);
    renderTimeline();
    renderDetail();
  } catch (e) {
    alert('清空失败: ' + e);
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

document.getElementById('btn-clear').addEventListener('click', clearMessages);

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

listen('session:message', (ev) => {
  // 全局消息事件，用于非选中会话的未读角标计数
  const data = ev.payload.data || ev.payload;
  if (data && data.session_id) {
    incrementUnread(data.session_id);
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

// Init
updateContentArea();
loadProjects();
