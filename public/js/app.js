import { state, $, $$, showMessage, escapeHtml } from './state.js';
import { api } from './api.js';
import { initTheme } from './theme.js';
import { renderUpstreams } from './views/upstreams.js';
import { renderCredentials } from './views/credentials.js';
import { renderHistory, fetchHistory, initHistoryView } from './views/history.js';
import { fetchLogDates, initLogsView } from './views/logs.js';
import { loadAndPopulateSettings, initSettingsView } from './views/settings.js';

import { initModalListeners } from './modal.js';

let pendingConfirmation = null;

function confirmAction(message, action, messageSelector = '') {
  pendingConfirmation = { action, messageSelector };
  $('#confirm-dialog-message').textContent = message;
  $('#confirm-dialog').showModal();
}

async function refreshAll() {
  const [upstreams, credentials, history] = await Promise.all([
    api('/admin/api/upstreams'),
    api('/admin/api/credentials'),
    api(`/admin/api/history?page=1&pageSize=${state.historyPageSize}`)
  ]);
  state.upstreams = upstreams;
  state.credentials = credentials;
  renderUpstreams();
  renderCredentials();
  renderHistory(history);
  import('./views/risks.js').then(m => m.updateRiskSummaryAndBanner());
}

function activateView(name) {
  $$('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === name));
  $$('.view').forEach(view => view.classList.toggle('active', view.id === name));
  $('#page-title').textContent = ({
    overview: '概览',
    upstreams: '上游通道',
    credentials: '接口鉴权',
    manual: '手动推送',
    history: '发送记录',
    logs: '访问日志',
    risks: '异常风险',
    settings: '系统设置'
  })[name] || '概览';

  const ws = $('.workspace');
  if (ws) ws.scrollTop = 0;
  window.scrollTo({ top: 0, behavior: 'instant' });
  const activeBtn = $(`.nav-item[data-view="${name}"]`);
  if (activeBtn?.scrollIntoView) {
    activeBtn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }

  if (name === 'logs') {
    fetchLogDates().then(() => {
      import('./views/logs.js').then(m => m.refreshLogs(1));
    });
  } else if (name === 'risks') {
    import('./views/risks.js').then(m => m.loadAndRenderRisks());
  } else if (name === 'settings') {
    loadAndPopulateSettings();
  } else if (name === 'history') {
    fetchHistory(state.historyPage);
  }
}

async function authenticate() {
  try {
    const session = await api('/admin/api/me');
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    $('#operator-name').textContent = session.username;
    await refreshAll();
  } catch (err) {
    $('#login-view').hidden = false;
    $('#app-view').hidden = true;
    if (err?.body?.blocked || err?.status === 429) {
      showMessage('#login-error', err?.body?.error || '当前客户端 IP 已被系统封禁，拒绝访问', 'failed');
    }
  }
}

window.addEventListener('session-terminated', event => {
  $('#login-view').hidden = false;
  $('#app-view').hidden = true;
  const detail = event.detail;
  if (detail?.body?.blocked || detail?.status === 429) {
    showMessage('#login-error', detail?.body?.error || '当前客户端 IP 已被系统封禁，会话已强制下线', 'failed');
  }
});

function syncPushMode() {
  const mode = $('input[name="pushMode"]:checked')?.value || 'text';
  const isMedia = mode === 'media';
  $('#manual-media-fields').hidden = !isMedia;
  $('#message-required').hidden = isMedia;
  $('textarea[name="message"]').required = !isMedia;
}

// 登录表单
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const username = form.elements.username.value.trim();
  const password = form.elements.password.value;
  showMessage('#login-error', '');
  try {
    await api('/admin/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    form.reset();
    await authenticate();
  } catch (error) {
    showMessage('#login-error', error.message);
  }
});

// 上游通道创建
$('#upstream-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const name = form.elements.name.value.trim();
  const apiKey = form.elements.apiKey.value.trim();
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  showMessage('#upstream-message', '正在通过 WebSocket 验活通道…');
  try {
    const upstream = await api('/admin/api/upstreams', { method: 'POST', body: JSON.stringify({ name, apiKey }) });
    state.upstreams.unshift(upstream);
    renderUpstreams();
    form.reset();
    showMessage('#upstream-message', '通道鉴权成功并已添加！', true);
  } catch (error) {
    showMessage('#upstream-message', error.message);
  } finally {
    button.disabled = false;
  }
});

// 接口凭据创建
$('#credential-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submitBtn = $('#credential-submit');
  const name = form.elements.name.value.trim();
  const kind = form.elements.kind.value;
  const secret = form.elements.secret?.value?.trim() || undefined;
  const upstreamIds = $$('input[name="upstreamIds"]:checked').map(input => Number(input.value));
  showMessage('#credential-message', '');
  if (!upstreamIds.length) {
    showMessage('#credential-message', '请至少勾选一个绑定的上游通道。');
    return;
  }
  if (submitBtn) submitBtn.disabled = true;
  try {
    const result = await api('/admin/api/credentials', { method: 'POST', body: JSON.stringify({ name, kind, secret, upstreamIds }) });
    const credential = result.credential || result;
    if (credential && typeof credential === 'object') {
      state.credentials = [credential, ...(state.credentials || []).filter(Boolean)];
    }
    renderCredentials();
    form.reset();
    renderUpstreams();
    $('#created-secret').textContent = result.secret;
    $('#secret-dialog').showModal();
  } catch (error) {
    showMessage('#credential-message', error.message);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
});

// 手动推送
$('input[name="pushMode"]')?.closest('fieldset')?.addEventListener('change', syncPushMode);

$('#push-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const mode = form.elements.pushMode.value;
  const title = form.elements.title.value.trim();
  const message = form.elements.message.value.trim();
  const upstreamIds = $$('input[name="manualUpstreamIds"]:checked').map(input => Number(input.value));
  const file = form.elements.mediaFile?.files?.[0];
  const mediaType = form.elements.mediaType?.value || 'FILE';
  const mediaUrl = form.elements.mediaUrl?.value?.trim() || '';

  showMessage('#push-message', '');
  if (!upstreamIds.length) {
    showMessage('#push-message', '请至少选择一个投递上游。');
    return;
  }
  if (mode === 'text' && !message) {
    showMessage('#push-message', '文本消息内容不能为空。');
    return;
  }
  if (mode === 'media' && !file && !mediaUrl && !message) {
    showMessage('#push-message', '富媒体模式必须提供本地文件、远程媒体 URL 或文本内容。');
    return;
  }

  const submitBtn = $('#push-submit');
  submitBtn.disabled = true;
  showMessage('#push-message', file ? '正在上传文件并投递…' : '正在提交消息…');

  try {
    let result;
    if (file) {
      const formData = new FormData();
      formData.append('upstreamIds', JSON.stringify(upstreamIds));
      formData.append('mediaType', mediaType);
      if (title) formData.append('title', title);
      if (message) formData.append('message', message);
      formData.append('file', file);
      result = await api('/admin/api/push', { method: 'POST', body: formData });
    } else {
      result = await api('/admin/api/push', {
        method: 'POST',
        body: JSON.stringify({
          title: title || undefined,
          message: message || undefined,
          upstreamIds,
          mediaType: mode === 'media' && mediaUrl ? mediaType : undefined,
          mediaUrl: mode === 'media' && mediaUrl ? mediaUrl : undefined
        })
      });
    }

    form.reset();
    syncPushMode();
    renderUpstreams();
    showMessage('#push-message', `消息投递成功！MessageIds: ${result.messageIds.join('、')}`, true);
    await fetchHistory(1);
  } catch (error) {
    showMessage('#push-message', error.message);
  } finally {
    submitBtn.disabled = false;
  }
});

// 删除代理事件
$('#upstream-list').addEventListener('click', event => {
  const button = event.target.closest('[data-delete-upstream]');
  if (!button) return;
  const id = Number(button.dataset.deleteUpstream);
  const item = state.upstreams.find(u => u.id === id);
  confirmAction(`确认删除上游通道“${item?.name || id}”？删除后关联凭证绑定也将被清理。`, async () => {
    await api(`/admin/api/upstreams/${id}`, { method: 'DELETE' });
    state.upstreams = state.upstreams.filter(u => u.id !== id);
    renderUpstreams();
    renderCredentials();
  }, '#upstream-message');
});

$('#credential-list').addEventListener('click', event => {
  const button = event.target.closest('[data-delete-credential]');
  if (!button) return;
  const id = Number(button.dataset.deleteCredential);
  const item = state.credentials.find(c => c.id === id);
  confirmAction(`确认删除接口凭据“${item?.name || id}”？删除后使用该凭据的调用方将无法继续鉴权。`, async () => {
    await api(`/admin/api/credentials/${id}`, { method: 'DELETE' });
    state.credentials = state.credentials.filter(c => c.id !== id);
    renderCredentials();
  }, '#credential-message');
});

// 导航与初始化
$$('.nav-item').forEach(button => button.addEventListener('click', () => activateView(button.dataset.view)));

async function copyToClipboard(text) {
  if (!text) return false;
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 降级使用 execCommand
    }
  }
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.position = 'fixed';
  textArea.style.left = '-999999px';
  textArea.style.top = '-999999px';
  textArea.setAttribute('readonly', '');
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  let successful = false;
  try {
    successful = document.execCommand('copy');
  } catch {
    successful = false;
  }
  document.body.removeChild(textArea);
  return successful;
}

$('#copy-secret').addEventListener('click', async () => {
  const secretNode = $('#created-secret');
  const text = secretNode.textContent.trim();
  if (!text) return;
  const ok = await copyToClipboard(text);
  if (ok) {
    $('#copy-secret').textContent = '已复制';
    setTimeout(() => { $('#copy-secret').textContent = '复制密钥'; }, 1500);
  } else {
    const range = document.createRange();
    const selection = window.getSelection();
    range.selectNodeContents(secretNode);
    selection.removeAllRanges();
    selection.addRange(range);
    $('#copy-secret').textContent = '请按 Ctrl+C 复制';
    setTimeout(() => { $('#copy-secret').textContent = '复制密钥'; }, 2500);
  }
});
$('#close-secret').addEventListener('click', () => $('#secret-dialog').close());
$('#secret-dialog').addEventListener('close', () => {
  $('#created-secret').textContent = '';
  $('#copy-secret').textContent = '复制密钥';
});

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
$('#logout-button').addEventListener('click', async () => {
  await api('/admin/api/logout', { method: 'POST' });
  location.reload();
});

// 初始化各子视图与系统模态弹窗的事件监听器
initModalListeners();
initTheme();
initHistoryView();
initLogsView();
initSettingsView();
syncPushMode();
authenticate();
