const state = { upstreams: [], credentials: [], history: [] };
let pendingConfirmation = null;
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) {
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

function activateView(name) {
  $$('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === name));
  $$('.view').forEach(view => view.classList.toggle('active', view.id === name));
  $('#page-title').textContent = ({ overview:'概览', upstreams:'上游通道', credentials:'接口鉴权', manual:'手动推送', history:'发送记录' })[name];
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

$('#push-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const title = form.elements.title?.value?.trim() ?? '';
  const message = form.elements.message?.value?.trim() ?? '';
  const upstreamIds = $$('input[name="manualUpstreamIds"]:checked').map(input => Number(input.value));
  if (!message) {
    showMessage('#push-message', '请输入消息内容。');
    form.elements.message?.focus();
    return;
  }
  if (!upstreamIds.length) {
    showMessage('#push-message', '请至少选择一个投递上游。');
    return;
  }
  const button = $('#push-submit');
  button.disabled = true;
  showMessage('#push-message', '正在投递通知…');
  try {
    const payload = { message, upstreamIds };
    if (title) payload.title = title;
    const result = await api('/admin/api/push', { method:'POST', body:JSON.stringify(payload) });
    form.reset();
    showMessage('#push-message', `通知已发送至 ${result.results.length} 个上游。`, true);
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
authenticate();
