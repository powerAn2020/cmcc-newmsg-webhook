import { state, $, escapeHtml } from '../state.js';
import { api } from '../api.js';

export function renderHistory(data) {
  const items = Array.isArray(data) ? data : (data?.items || state.history || []);
  const total = typeof data?.total === 'number' ? data.total : items.length;
  const page = typeof data?.page === 'number' ? data.page : state.historyPage;
  const totalPages = typeof data?.totalPages === 'number' ? data.totalPages : Math.max(1, Math.ceil(total / state.historyPageSize));

  state.history = items;
  state.historyTotal = total;
  state.historyPage = page;
  state.historyTotalPages = totalPages;

  const rows = items;
  $('#history-list').innerHTML = rows.map(item => `<tr><td>${new Date(item.createdAt).toLocaleString()}</td><td>${escapeHtml(item.credentialName || (item.source === 'manual' ? '手动推送' : item.source))}</td><td>${escapeHtml(item.upstreamName || '-')}</td><td class="content-cell">${escapeHtml(item.title ? `${item.title}\n${item.content || ''}` : item.content || item.mediaType || '-')}</td><td><span class="badge ${item.status}">${item.status === 'success' ? '成功' : '失败'}</span></td><td class="result">${escapeHtml(item.messageId || item.error || '-')}</td></tr>`).join('');
  $('#history-empty').hidden = rows.length > 0;

  const pagination = $('#history-pagination');
  if (pagination) {
    pagination.hidden = rows.length === 0 && total === 0;
    const totalCountEl = $('#history-total-count');
    const currentPageEl = $('#history-current-page');
    const totalPagesEl = $('#history-total-pages');
    if (totalCountEl) totalCountEl.textContent = total;
    if (currentPageEl) currentPageEl.textContent = page;
    if (totalPagesEl) totalPagesEl.textContent = totalPages;

    const firstBtn = $('#history-first-page');
    const prevBtn = $('#history-prev-page');
    const nextBtn = $('#history-next-page');
    const lastBtn = $('#history-last-page');
    if (firstBtn) firstBtn.disabled = page <= 1;
    if (prevBtn) prevBtn.disabled = page <= 1;
    if (nextBtn) nextBtn.disabled = page >= totalPages;
    if (lastBtn) lastBtn.disabled = page >= totalPages;
  }

  $('#success-count').textContent = rows.filter(item => item.status === 'success').length;
  $('#failure-count').textContent = rows.filter(item => item.status === 'failed').length;
}

export async function fetchHistory(page = 1) {
  try {
    const data = await api(`/admin/api/history?page=${page}&pageSize=${state.historyPageSize}`);
    renderHistory(data);
  } catch (error) {
    console.error('Failed to load history:', error);
  }
}

export function initHistoryView() {
  $('#refresh-history')?.addEventListener('click', () => fetchHistory(state.historyPage));
  $('#history-first-page')?.addEventListener('click', () => fetchHistory(1));
  $('#history-prev-page')?.addEventListener('click', () => fetchHistory(state.historyPage - 1));
  $('#history-next-page')?.addEventListener('click', () => fetchHistory(state.historyPage + 1));
  $('#history-last-page')?.addEventListener('click', () => fetchHistory(state.historyTotalPages));
  $('#history-page-size')?.addEventListener('change', event => {
    state.historyPageSize = Number(event.target.value) || 20;
    state.historyPage = 1;
    fetchHistory(1);
  });
}
