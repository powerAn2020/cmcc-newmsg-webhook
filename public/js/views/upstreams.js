import { state, $, escapeHtml } from '../state.js';

export function renderUpstreams() {
  const list = $('#upstream-list');
  list.innerHTML = state.upstreams.length
    ? state.upstreams.map(item => `<div class="data-row"><div><h5>${escapeHtml(item.name)}</h5><p>${escapeHtml(item.apiKeyPreview)}</p></div><button class="delete" data-delete-upstream="${item.id}" type="button">删除</button></div>`).join('')
    : '<p class="empty-list">尚未添加上游通道。</p>';

  $('#binding-options').innerHTML = state.upstreams.length
    ? state.upstreams.map(item => `<label class="check-option"><input type="checkbox" name="upstreamIds" value="${item.id}" /><span>${escapeHtml(item.name)}<br /><small>${escapeHtml(item.apiKeyPreview)}</small></span></label>`).join('')
    : '<p class="empty-list">请先新增并验证一个上游通道。</p>';

  $('#manual-upstream-options').innerHTML = state.upstreams.length
    ? state.upstreams.map(item => `<label class="check-option"><input type="checkbox" name="manualUpstreamIds" value="${item.id}" /><span>${escapeHtml(item.name)}<br /><small>${escapeHtml(item.apiKeyPreview)}</small></span></label>`).join('')
    : '<p class="empty-list">请先新增并验证一个上游通道。</p>';

  const notifySelect = $('#notify-upstream-select');
  if (notifySelect) {
    const currentVal = notifySelect.value;
    notifySelect.innerHTML = '<option value="0">全部通道 (广播)</option>' +
      state.upstreams.map(item => `<option value="${item.id}">${escapeHtml(item.name)} (${escapeHtml(item.apiKeyPreview)})</option>`).join('');
    if (currentVal !== undefined && currentVal !== '') {
      notifySelect.value = currentVal;
    }
  }

  $('#credential-submit').disabled = state.upstreams.length === 0;
  $('#push-submit').disabled = state.upstreams.length === 0;
  $('#upstream-count').textContent = state.upstreams.length;
}
