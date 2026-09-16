import { state, $, escapeHtml } from '../state.js';
import { api } from '../api.js';

export function renderLogs(data) {
  const list = $('#logs-list');
  const empty = $('#logs-empty');
  const pagination = $('#logs-pagination');

  const items = Array.isArray(data) ? data : (data?.items || []);
  const total = typeof data?.total === 'number' ? data.total : items.length;
  const page = typeof data?.page === 'number' ? data.page : 1;
  const totalPages = typeof data?.totalPages === 'number' ? data.totalPages : 1;

  state.logTotal = total;
  state.logPage = page;
  state.logTotalPages = totalPages;

  if (!items.length) {
    list.innerHTML = '';
    empty.hidden = false;
    if (pagination) pagination.hidden = true;
    return;
  }
  empty.hidden = true;
  if (pagination) pagination.hidden = false;

  const totalCountEl = $('#logs-total-count');
  const currentPageEl = $('#logs-current-page');
  const totalPagesEl = $('#logs-total-pages');
  const firstBtn = $('#logs-first-page');
  const prevBtn = $('#logs-prev-page');
  const nextBtn = $('#logs-next-page');
  const lastBtn = $('#logs-last-page');

  if (totalCountEl) totalCountEl.textContent = total;
  if (currentPageEl) currentPageEl.textContent = page;
  if (totalPagesEl) totalPagesEl.textContent = totalPages;
  if (firstBtn) firstBtn.disabled = page <= 1;
  if (prevBtn) prevBtn.disabled = page <= 1;
  if (nextBtn) nextBtn.disabled = page >= totalPages;
  if (lastBtn) lastBtn.disabled = page >= totalPages;

  list.innerHTML = items.map(item => {
    let authDisplay = '-';
    if (item.authType) {
      const typeLabel = item.authType.startsWith('invalid_')
        ? `<span class="badge failed">${escapeHtml(item.authType)}</span>`
        : `<span class="badge success">${escapeHtml(item.authType)}</span>`;
      const namePart = item.credentialName ? ` (${escapeHtml(item.credentialName)})` : '';
      const secretPart = item.maskedSecret ? `<br><small style="color:var(--muted);">${escapeHtml(item.maskedSecret)}</small>` : '';
      authDisplay = `${typeLabel}${namePart}${secretPart}`;
    }

    let statusDisplay = `<span class="badge ${item.statusCode < 400 ? 'success' : 'failed'}">${item.statusCode}</span>`;
    const errDisplay = item.error ? `<br><small style="color:var(--red);">${escapeHtml(item.error)}</small>` : '';

    const rawTime = item.timestamp || item.time || '';
    const timeDisplay = rawTime && !isNaN(Date.parse(rawTime)) ? new Date(rawTime).toLocaleString() : (escapeHtml(rawTime) || '-');

    return `<tr>
      <td>${timeDisplay}</td>
      <td><code>${escapeHtml(item.ip)}</code></td>
      <td><strong>${escapeHtml(item.method)}</strong> <code>${escapeHtml(item.url)}</code></td>
      <td>${authDisplay}</td>
      <td>${statusDisplay}</td>
      <td>${item.durationMs} ms</td>
      <td>${errDisplay || '-'}</td>
    </tr>`;
  }).join('');
}

export async function fetchLogDates() {
  try {
    const res = await api('/admin/api/logs/dates');
    state.logDates = res.dates || [];
    const select = $('#logs-date-select');
    if (!select) return;
    if (state.logDates.length === 0) {
      select.innerHTML = '<option value="">暂无日志</option>';
      state.selectedLogDate = '';
      return;
    }
    select.innerHTML = state.logDates.map((d, i) => `<option value="${d}">${d}${i === 0 ? ' (最新)' : ''}</option>`).join('');
    state.selectedLogDate = state.logDates[0];
  } catch (error) {
    console.error('Failed to fetch log dates:', error);
  }
}

export async function refreshLogs(page = state.logPage) {
  try {
    const params = new URLSearchParams();
    if (state.selectedLogDate) params.set('date', state.selectedLogDate);
    params.set('page', String(Math.max(1, page)));
    params.set('pageSize', String(state.logPageSize));
    const data = await api(`/admin/api/logs?${params.toString()}`);
    renderLogs(data);
  } catch (error) {
    console.error('Failed to load logs:', error);
  }
}

export function initLogsView() {
  $('#refresh-logs')?.addEventListener('click', () => refreshLogs());
  $('#logs-date-select')?.addEventListener('change', event => {
    state.selectedLogDate = event.target.value;
    state.logPage = 1;
    refreshLogs(1);
  });
  $('#logs-page-size')?.addEventListener('change', event => {
    state.logPageSize = Number(event.target.value) || 50;
    state.logPage = 1;
    refreshLogs(1);
  });
  $('#logs-first-page')?.addEventListener('click', () => refreshLogs(1));
  $('#logs-prev-page')?.addEventListener('click', () => refreshLogs(state.logPage - 1));
  $('#logs-next-page')?.addEventListener('click', () => refreshLogs(state.logPage + 1));
  $('#logs-last-page')?.addEventListener('click', () => refreshLogs(state.logTotalPages));
}
