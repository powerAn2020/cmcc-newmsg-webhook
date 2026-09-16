export const state = {
  upstreams: [],
  credentials: [],
  history: [],
  historyPage: 1,
  historyPageSize: 20,
  historyTotal: 0,
  historyTotalPages: 1,
  logDates: [],
  selectedLogDate: '',
  logPage: 1,
  logPageSize: 50,
  logTotal: 0,
  logTotalPages: 1,
  pendingConfirmation: null
};

export const $ = selector => document.querySelector(selector);
export const $$ = selector => [...document.querySelectorAll(selector)];

export function showMessage(selector, message, success = false) {
  const node = $(selector);
  if (!node) return;
  node.textContent = message;
  node.classList.toggle('success', success);
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  })[char]);
}
