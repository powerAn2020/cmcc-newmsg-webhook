import { state, $, escapeHtml } from '../state.js';

export function renderCredentials() {
  const names = new Map(state.upstreams.map(item => [item.id, item.name]));
  const list = (state.credentials || []).filter(Boolean);
  $('#credential-list').innerHTML = list.length
    ? list.map(item => `<div class="data-row"><div><h5>${escapeHtml(item.name || '')} <span class="badge ${item.kind === 'gotify' ? 'success' : 'failed'}">${item.kind === 'gotify' ? 'Gotify' : 'Webhook'}</span></h5><p>${escapeHtml(item.secretPreview || '')} · ${(item.upstreamIds || []).map(id => escapeHtml(names.get(id) || `#${id}`)).join('、')}</p></div><button class="delete" data-delete-credential="${item.id}" type="button">删除</button></div>`).join('')
    : '<p class="empty-list">尚未配置接口凭据。</p>';
  $('#credential-count').textContent = list.length;
}
