const state = { upstreams: [], credentials: [], history: [] };
let pendingConfirmation = null;
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(path, { ...options, headers });
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || body?.message || '请求失败');
  return body;
}

function showMessage(selector, message, success = false) {
  const node = $(selector);
  if (!node) return;
  node.textContent = message;
  node.classList.toggle('success', success);
}

function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' })[char]); }

function renderUpstreams() {
  const list = $('#upstream-list');
  list.innerHTML = state.upstreams.length ? state.upstreams.map(item => `<div class="data-row"><div><h5>${escapeHtml(item.name)}</h5><p>${escapeHtml(item.apiKeyPreview)}</p></div><button class="delete" data-delete-upstream="${item.id}" type="button">删除</button></div>`).join('') : '<p class="empty-list">尚未添加上游通道。</p>';
  $('#binding-options').innerHTML = state.upstreams.length ? state.upstreams.map(item => `<label class="check-option"><input type="checkbox" name="upstreamIds" value="${item.id}" /><span>${escapeHtml(item.name)}<br /><small>${escapeHtml(item.apiKeyPreview)}</small></span></label>`).join('') : '<p class="empty-list">请先新增并验证一个上游通道。</p>';
  $('#manual-upstream-options').innerHTML = state.upstreams.length ? state.upstreams.map(item => `<label class="check-option"><input type="checkbox" name="manualUpstreamIds" value="${item.id}" /><span>${escapeHtml(item.name)}<br /><small>${escapeHtml(item.apiKeyPreview)}</small></span></label>`).join('') : '<p class="empty-list">请先新增并验证一个上游通道。</p>';
  $('#credential-submit').disabled = state.upstreams.length === 0;
  $('#push-submit').disabled = state.upstreams.length === 0;
  $('#upstream-count').textContent = state.upstreams.length;
}

function renderCredentials() {
  const names = new Map(state.upstreams.map(item => [item.id, item.name]));
  $('#credential-list').innerHTML = state.credentials.length ? state.credentials.map(item => `<div class="data-row"><div><h5>${escapeHtml(item.name)} <span class="badge ${item.kind === 'gotify' ? 'success' : 'failed'}">${item.kind === 'gotify' ? 'Gotify' : 'Webhook'}</span></h5><p>${escapeHtml(item.secretPreview)} · ${item.upstreamIds.map(id => escapeHtml(names.get(id) || `#${id}`)).join('、')}</p></div><button class="delete" data-delete-credential="${item.id}" type="button">删除</button></div>`).join('') : '<p class="empty-list">尚未配置接口凭据。</p>';
  $('#credential-count').textContent = state.credentials.length;
}

function renderHistory() {
  const rows = state.history;
  $('#history-list').innerHTML = rows.map(item => `<tr><td>${new Date(item.createdAt).toLocaleString()}</td><td>${escapeHtml(item.credentialName || (item.source === 'manual' ? '手动推送' : item.source))}</td><td>${escapeHtml(item.upstreamName || '-')}</td><td class="content-cell">${escapeHtml(item.title ? `${item.title}\n${item.content || ''}` : item.content || item.mediaType || '-')}</td><td><span class="badge ${item.status}">${item.status === 'success' ? '成功' : '失败'}</span></td><td class="result">${escapeHtml(item.messageId || item.error || '-')}</td></tr>`).join('');
  $('#history-empty').hidden = rows.length > 0;
  $('#success-count').textContent = rows.filter(item => item.status === 'success').length;
  $('#failure-count').textContent = rows.filter(item => item.status === 'failed').length;
}

async function refreshAll() {
  const [upstreams, credentials, history] = await Promise.all([api('/admin/api/upstreams'), api('/admin/api/credentials'), api('/admin/api/history')]);
  state.upstreams = upstreams; state.credentials = credentials; state.history = history;
  renderUpstreams(); renderCredentials(); renderHistory();
}

async function loadAndPopulateSettings() {
  try {
    const settings = await api('/admin/api/settings');
    const form = $('#settings-form');
    form.elements.adminUsername.value = settings.adminUsername || '';
    form.elements.adminPassword.value = '';
    form.elements.adminLoginFailLimit.value = settings.adminLoginFailLimit;
    form.elements.adminLoginFailWindowMin.value = settings.adminLoginFailWindowMin ?? Math.round((settings.adminLoginFailWindowMs || 900000) / 60000);
    form.elements.adminLoginBanDurationMin.value = settings.adminLoginBanDurationMin ?? Math.round((settings.adminLoginBanDurationMs || 1800000) / 60000);
    form.elements.wsUrl.value = settings.wsUrl;
    form.elements.wsVersion.value = settings.wsVersion;
    form.elements.uploadUrl.value = settings.uploadUrl;
    form.elements.sendTimeoutMs.value = settings.sendTimeoutMs;
    form.elements.uploadTimeoutMs.value = settings.uploadTimeoutMs;
  } catch (error) {
    showMessage('#settings-message', '加载系统参数失败：' + error.message);
  }
}

function activateView(name) {
  $$('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === name));
  $$('.view').forEach(view => view.classList.toggle('active', view.id === name));
  $('#page-title').textContent = ({ overview:'概览', upstreams:'上游通道', credentials:'接口鉴权', manual:'手动推送', history:'发送记录', settings:'系统设置' })[name];
  if (name === 'settings') {
    loadAndPopulateSettings();
  }
}

async function authenticate() {
  try {
    const user = await api('/admin/api/me');
    $('#operator-name').textContent = user.username;
    $('#login-view').hidden = true; $('#app-view').hidden = false;
    await refreshAll();
  } catch { $('#login-view').hidden = false; $('#app-view').hidden = true; }
}

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const username = form.elements.username?.value?.trim() ?? '';
  const password = form.elements.password?.value ?? '';
  if (!username) {
    showMessage('#login-error', '请输入用户名。');
    form.elements.username?.focus();
    return;
  }
  if (!password) {
    showMessage('#login-error', '请输入密码。');
    form.elements.password?.focus();
    return;
  }
  try {
    const user = await api('/admin/api/login', { method:'POST', body:JSON.stringify({ username, password }) });
    $('#operator-name').textContent = user.username;
    $('#login-error').textContent = '';
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    await refreshAll();
  } catch (error) {
    showMessage('#login-error', error.message);
  }
});

$('#upstream-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const name = form.elements.name?.value?.trim() ?? '';
  const apiKey = form.elements.apiKey?.value?.trim() ?? '';
  if (!name) {
    showMessage('#upstream-message', '请输入通道名称。');
    form.elements.name?.focus();
    return;
  }
  if (!apiKey) {
    showMessage('#upstream-message', '请输入上游 API Key。');
    form.elements.apiKey?.focus();
    return;
  }
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  showMessage('#upstream-message', '正在验证上游 API Key…');
  try {
    await api('/admin/api/upstreams', { method:'POST', body:JSON.stringify({ name, apiKey }) });
    form.reset();
    showMessage('#upstream-message', '验证通过，已保存。', true);
    await refreshAll();
  } catch (error) {
    showMessage('#upstream-message', error.message);
  } finally {
    button.disabled = false;
  }
});

$('#credential-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const name = form.elements.name?.value?.trim() ?? '';
  const kind = form.elements.kind?.value;
  const secret = form.elements.secret?.value?.trim();
  const upstreamIds = $$('input[name="upstreamIds"]:checked').map(input => Number(input.value));
  if (!name) {
    showMessage('#credential-message', '请输入凭据名称。');
    form.elements.name?.focus();
    return;
  }
  if (!upstreamIds.length) {
    showMessage('#credential-message', '请至少绑定一个上游通道。');
    return;
  }
  try {
    const payload = { name, kind, upstreamIds };
    if (secret) payload.secret = secret;
    const result = await api('/admin/api/credentials', { method:'POST', body:JSON.stringify(payload) });
    form.reset();
    showMessage('#credential-message', '接口凭据已保存。', true);
    $('#created-secret').textContent = result.secret;
    $('#secret-dialog').showModal();
    await refreshAll();
  } catch (error) {
    showMessage('#credential-message', error.message);
  }
});

function syncPushMode() {
  const form = $('#push-form');
  const mediaMode = form.elements.pushMode?.value === 'media';
  $('#manual-media-fields').hidden = !mediaMode;
  form.elements.message.required = !mediaMode;
  $('#message-required').textContent = mediaMode ? '可选' : '*';
  $('#message-required').className = mediaMode ? 'optional' : 'required';
}

$$('input[name="pushMode"]').forEach(input => input.addEventListener('change', syncPushMode));

$('#push-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const title = form.elements.title?.value?.trim() ?? '';
  const message = form.elements.message?.value?.trim() ?? '';
  const mediaMode = form.elements.pushMode?.value === 'media';
  const mediaType = form.elements.mediaType?.value;
  const mediaFile = form.elements.mediaFile?.files?.[0];
  const mediaUrl = form.elements.mediaUrl?.value?.trim() ?? '';
  const upstreamIds = $$('input[name="manualUpstreamIds"]:checked').map(input => Number(input.value));
  if (!mediaMode && !message) {
    showMessage('#push-message', '请输入消息内容。');
    form.elements.message?.focus();
    return;
  }
  if (mediaMode && !mediaFile && !mediaUrl) {
    showMessage('#push-message', '请选择本地文件或填写远程媒体 URL。');
    form.elements.mediaFile?.focus();
    return;
  }
  if (mediaFile && mediaUrl) {
    showMessage('#push-message', '本地文件与远程媒体 URL 只能选择一项。');
    return;
  }
  if (mediaFile && mediaFile.size > 200 * 1024 * 1024) {
    showMessage('#push-message', '文件不能超过 200MB。');
    return;
  }
  if (!upstreamIds.length) {
    showMessage('#push-message', '请至少选择一个投递上游。');
    return;
  }
  const button = $('#push-submit');
  button.disabled = true;
  showMessage('#push-message', mediaFile ? '正在上传并提交消息…' : '正在提交消息…');
  try {
    let body;
    if (mediaFile) {
      body = new FormData();
      body.append('upstreamIds', JSON.stringify(upstreamIds));
      body.append('mediaType', mediaType);
      body.append('file', mediaFile, mediaFile.name);
      if (title) body.append('title', title);
      if (message) body.append('message', message);
    } else {
      const payload = { message, upstreamIds };
      if (title) payload.title = title;
      if (mediaMode) {
        payload.mediaType = mediaType;
        payload.mediaUrl = mediaUrl;
      }
      body = JSON.stringify(payload);
    }
    const result = await api('/admin/api/push', { method:'POST', body });
    form.reset();
    syncPushMode();
    showMessage('#push-message', `已向 ${result.results.length} 个上游提交 ${result.messageIds.length} 条消息。`, true);
    await refreshAll();
  } catch (error) {
    showMessage('#push-message', error.message);
  } finally {
    button.disabled = false;
  }
});

function confirmAction(title, message, action, messageSelector) {
  pendingConfirmation = { action, messageSelector };
  $('#confirm-dialog-title').textContent = title;
  $('#confirm-dialog-message').textContent = message;
  $('#confirm-dialog').showModal();
}

document.addEventListener('click', async event => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const upstreamId = target.dataset.deleteUpstream;
  const credentialId = target.dataset.deleteCredential;
  if (upstreamId) {
    confirmAction(
      '删除上游通道',
      '删除后将自动解除关联接口凭据的绑定，已配置凭据不会被删除。',
      async () => {
        await api(`/admin/api/upstreams/${upstreamId}`, { method:'DELETE' });
        showMessage('#upstream-message', '上游通道已删除。', true);
        await refreshAll();
      },
      '#upstream-message'
    );
  }
  if (credentialId) {
    confirmAction(
      '删除接口凭据',
      '删除后使用该 Token 或 Bearer Secret 的调用会立即失效。',
      async () => {
        await api(`/admin/api/credentials/${credentialId}`, { method:'DELETE' });
        showMessage('#credential-message', '接口凭据已删除。', true);
        await refreshAll();
      },
      '#credential-message'
    );
  }
});

$$('.nav-item').forEach(button => button.addEventListener('click', () => activateView(button.dataset.view)));
$('#refresh-history').addEventListener('click', async () => { state.history = await api('/admin/api/history'); renderHistory(); });
$('#copy-secret').addEventListener('click', async () => { await navigator.clipboard.writeText($('#created-secret').textContent); $('#copy-secret').textContent = '已复制'; setTimeout(() => { $('#copy-secret').textContent = '复制密钥'; }, 1500); });
$('#close-secret').addEventListener('click', () => $('#secret-dialog').close());
$('#secret-dialog').addEventListener('close', () => { $('#created-secret').textContent = ''; $('#copy-secret').textContent = '复制密钥'; });
$('#cancel-confirm').addEventListener('click', () => $('#confirm-dialog').close());
$('#approve-confirm').addEventListener('click', async () => {
  const pending = pendingConfirmation;
  pendingConfirmation = null;
  $('#confirm-dialog').close();
  if (!pending?.action) return;
  try {
    await pending.action();
  } catch (error) {
    if (pending.messageSelector) {
      showMessage(pending.messageSelector, error.message);
    }
  }
});
$('#confirm-dialog').addEventListener('close', () => { pendingConfirmation = null; });
$('#logout-button').addEventListener('click', async () => { await api('/admin/api/logout', { method:'POST' }); location.reload(); });

$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const adminUsername = form.elements.adminUsername.value.trim();
  const adminPassword = form.elements.adminPassword.value;
  const adminLoginFailLimit = Number(form.elements.adminLoginFailLimit.value);
  const adminLoginFailWindowMin = Number(form.elements.adminLoginFailWindowMin.value);
  const adminLoginBanDurationMin = Number(form.elements.adminLoginBanDurationMin.value);
  const wsUrl = form.elements.wsUrl.value.trim();
  const wsVersion = form.elements.wsVersion.value.trim();
  const uploadUrl = form.elements.uploadUrl.value.trim();
  const sendTimeoutMs = Number(form.elements.sendTimeoutMs.value);
  const uploadTimeoutMs = Number(form.elements.uploadTimeoutMs.value);

  if (!adminUsername) {
    showMessage('#settings-message', '管理员用户名不能为空。');
    return;
  }
  if (!adminLoginFailLimit || adminLoginFailLimit < 1) {
    showMessage('#settings-message', '登录失败次数必须是正整数。');
    return;
  }
  if (!adminLoginFailWindowMin || adminLoginFailWindowMin < 1) {
    showMessage('#settings-message', '统计观测窗口必须至少为 1 分钟。');
    return;
  }
  if (!adminLoginBanDurationMin || adminLoginBanDurationMin < 1) {
    showMessage('#settings-message', '封禁时长必须至少为 1 分钟。');
    return;
  }
  if (!wsUrl || !/^wss?:\/\//.test(wsUrl)) {
    showMessage('#settings-message', 'WebSocket 接入 URL 必须是有效的 ws 或 wss 地址。');
    return;
  }
  if (!wsVersion) {
    showMessage('#settings-message', '请输入协议版本。');
    return;
  }
  if (!uploadUrl || !/^https?:\/\//.test(uploadUrl)) {
    showMessage('#settings-message', '富媒体上传 URL 必须是有效的 http 或 https 地址。');
    return;
  }
  if (!sendTimeoutMs || sendTimeoutMs < 1000 || sendTimeoutMs > 120000) {
    showMessage('#settings-message', '发送超时必须在 1000 至 120000 毫秒之间。');
    return;
  }
  if (!uploadTimeoutMs || uploadTimeoutMs < 1000 || uploadTimeoutMs > 600000) {
    showMessage('#settings-message', '上传超时必须在 1000 至 600000 毫秒之间。');
    return;
  }

  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  showMessage('#settings-message', '正在保存系统参数…');
  try {
    const payload = {
      adminUsername,
      adminLoginFailLimit,
      adminLoginFailWindowMin,
      adminLoginBanDurationMin,
      wsUrl,
      wsVersion,
      sendTimeoutMs,
      uploadUrl,
      uploadTimeoutMs
    };
    if (adminPassword) {
      payload.adminPassword = adminPassword;
    }
    await api('/admin/api/settings', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    $('#operator-name').textContent = adminUsername;
    form.elements.adminPassword.value = '';
    showMessage('#settings-message', '系统参数设置已成功保存并生效！', true);
  } catch (error) {
    showMessage('#settings-message', error.message);
  } finally {
    button.disabled = false;
  }
});

syncPushMode();
authenticate();
