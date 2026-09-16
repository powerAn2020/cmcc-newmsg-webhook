import { state, $, $$, escapeHtml } from '../state.js';
import { api } from '../api.js';

let riskState = {
  alertsPage: 1,
  alertsTotalPages: 1,
  logsDate: '',
  logsPage: 1,
  logsTotalPages: 1,
  bannerDismissed: false
};

export async function updateRiskSummaryAndBanner() {
  initRiskViewListeners();
  try {
    const summary = await api('/admin/api/risks/summary');
    const badge = $('#risk-nav-badge');
    const banner = $('#global-risk-alert-banner');
    const riskTotal = (summary.lockedCount || 0) + (summary.todayAlertsCount || 0);

    // 更新导航栏角标
    if (badge) {
      if (riskTotal > 0) {
        badge.textContent = riskTotal > 99 ? '99+' : riskTotal;
        badge.hidden = false;
      } else {
        badge.hidden = true;
      }
    }

    // 更新全局高亮横条
    if (banner) {
      if (riskTotal > 0 && !riskState.bannerDismissed) {
        const descEl = $('#risk-alert-desc');
        if (descEl) {
          const parts = [];
          if (summary.lockedCount > 0) parts.push(`当前有 ${summary.lockedCount} 个 IP 处于封禁期`);
          if (summary.todayAlertsCount > 0) parts.push(`今日累计触发 ${summary.todayAlertsCount} 起安全拦截告警`);
          descEl.textContent = `检测到系统异常：${parts.join('，')}，请尽快排查！`;
        }
        banner.hidden = false;
      } else {
        banner.hidden = true;
      }
    }

    // 若当前在风险页面，同步更新统计卡片
    const todayEl = $('#risk-today-alerts');
    const activeEl = $('#risk-active-bans');
    const totalEl = $('#risk-total-alerts');
    if (todayEl) todayEl.textContent = summary.todayAlertsCount || 0;
    if (activeEl) activeEl.textContent = summary.lockedCount || 0;
    if (totalEl) totalEl.textContent = summary.totalAlertsCount || 0;

    return summary;
  } catch (err) {
    console.error('Failed to fetch risk summary:', err);
    return null;
  }
}

export async function renderBans() {
  const list = $('#risk-bans-list');
  const empty = $('#risk-bans-empty');
  if (!list) return;

  try {
    const data = await api('/admin/api/risks/bans');
    const items = data.items || [];
    if (!items.length) {
      list.innerHTML = '';
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;

    list.innerHTML = items.map(item => {
      const lockExpiry = item.lockedUntil ? new Date(item.lockedUntil).toLocaleString() : '永久';
      const firstFail = item.firstFailedAt ? new Date(item.firstFailedAt).toLocaleString() : '-';
      return `
        <div class="data-row" style="align-items: flex-start;">
          <div>
            <h5 style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
              <span class="badge failed">${escapeHtml(item.ip)}</span>
              <span style="font-size:12px; font-weight:normal; color:var(--red);">连续失败 ${item.failedCount} 次</span>
            </h5>
            <p style="color:var(--muted); font-size:12px;">
              首次失败时间: ${firstFail} | 预计解封时间: <strong style="color:var(--ink);">${lockExpiry}</strong>
            </p>
          </div>
          <button class="button secondary compact unban-btn" data-ip="${escapeHtml(item.ip)}" type="button" style="color:var(--teal); font-weight:700;">
            立即解封
          </button>
        </div>
      `;
    }).join('');

    // 绑定解封按钮事件
    list.querySelectorAll('.unban-btn').forEach(btn => {
      btn.onclick = async () => {
        const ip = btn.dataset.ip;
        if (!ip) return;
        btn.disabled = true;
        btn.textContent = '解封中...';
        try {
          await api(`/admin/api/risks/bans/${encodeURIComponent(ip)}`, { method: 'DELETE' });
          await Promise.all([renderBans(), updateRiskSummaryAndBanner()]);
        } catch (err) {
          alert('解封失败: ' + (err instanceof Error ? err.message : String(err)));
          btn.disabled = false;
          btn.textContent = '立即解封';
        }
      };
    });
  } catch (err) {
    console.error('Failed to render bans:', err);
  }
}

export async function renderRiskAlerts(page = 1) {
  const tbody = $('#risk-alerts-tbody');
  const empty = $('#risk-alerts-empty');
  const pagination = $('#risk-alerts-pagination');
  if (!tbody) return;

  try {
    const data = await api(`/admin/api/risks/alerts?page=${page}&pageSize=10`);
    const items = data.items || [];
    riskState.alertsPage = data.page || 1;
    riskState.alertsTotalPages = data.totalPages || 1;

    if (!items.length) {
      tbody.innerHTML = '';
      if (empty) empty.hidden = false;
      if (pagination) pagination.hidden = true;
      return;
    }
    if (empty) empty.hidden = true;
    if (pagination) pagination.hidden = false;

    $('#risk-alerts-current-page').textContent = riskState.alertsPage;
    $('#risk-alerts-total-pages').textContent = riskState.alertsTotalPages;
    $('#risk-alerts-total-count').textContent = data.total || items.length;
    $('#risk-alerts-prev').disabled = riskState.alertsPage <= 1;
    $('#risk-alerts-next').disabled = riskState.alertsPage >= riskState.alertsTotalPages;

    tbody.innerHTML = items.map(item => {
      const timeStr = item.createdAt ? new Date(item.createdAt).toLocaleString() : '-';
      const statusBadge = item.status === 'success'
        ? '<span class="badge success">已通报</span>'
        : '<span class="badge failed">推送失败</span>';
      return `
        <tr>
          <td>${timeStr}</td>
          <td><strong style="color:var(--ink);">${escapeHtml(item.title || '系统告警')}</strong></td>
          <td class="content-cell" style="white-space: pre-line; font-size:12px;">${escapeHtml(item.content || '-')}</td>
          <td>${escapeHtml(item.upstreamName || '全部广播')}</td>
          <td>${statusBadge}</td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to render risk alerts:', err);
  }
}

export async function renderDangerousLogs(date, page = 1) {
  const tbody = $('#risk-logs-tbody');
  const empty = $('#risk-logs-empty');
  const pagination = $('#risk-logs-pagination');
  if (!tbody) return;

  try {
    const targetDate = date || riskState.logsDate || '';
    const data = await api(`/admin/api/risks/dangerous-logs?date=${encodeURIComponent(targetDate)}&page=${page}&pageSize=20`);
    const items = data.items || [];
    riskState.logsDate = data.date || targetDate;
    riskState.logsPage = data.page || 1;
    riskState.logsTotalPages = data.totalPages || 1;

    if (!items.length) {
      tbody.innerHTML = '';
      if (empty) empty.hidden = false;
      if (pagination) pagination.hidden = true;
      return;
    }
    if (empty) empty.hidden = true;
    if (pagination) pagination.hidden = false;

    $('#risk-logs-current-page').textContent = riskState.logsPage;
    $('#risk-logs-total-pages').textContent = riskState.logsTotalPages;
    $('#risk-logs-total-count').textContent = data.total || items.length;
    $('#risk-logs-prev').disabled = riskState.logsPage <= 1;
    $('#risk-logs-next').disabled = riskState.logsPage >= riskState.logsTotalPages;

    tbody.innerHTML = items.map(item => {
      const rawTime = item.timestamp || item.time || '';
      const timeDisplay = rawTime && !isNaN(Date.parse(rawTime)) ? new Date(rawTime).toLocaleString() : (escapeHtml(rawTime) || '-');
      const codeClass = item.statusCode === 429 ? 'failed' : (item.statusCode >= 400 ? 'failed' : 'success');
      const statusBadge = `<span class="badge ${codeClass}">${item.statusCode}</span>`;
      
      let reason = item.error || '';
      if (item.authType && item.authType.startsWith('invalid_')) {
        reason = `[未授权拦截] ${item.authType}${item.maskedSecret ? ` (${item.maskedSecret})` : ''} ${reason ? ' | ' + reason : ''}`;
      } else if (item.authType === 'login_failed') {
        reason = `[管理员密码错误] ${reason}`;
      }
      if (!reason) reason = '异常响应拦截';

      return `
        <tr>
          <td>${timeDisplay}</td>
          <td><code>${escapeHtml(item.ip)}</code></td>
          <td>${statusBadge}</td>
          <td><code>${escapeHtml(item.method)} ${escapeHtml(item.url)}</code></td>
          <td style="color:var(--red); font-size:12px;">${escapeHtml(reason)}</td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to render dangerous logs:', err);
  }
}

export function initRiskViewListeners() {
  // 刷新按钮
  const refreshBtn = $('#refresh-risks-btn');
  if (refreshBtn && !refreshBtn.dataset.bound) {
    refreshBtn.dataset.bound = 'true';
    refreshBtn.onclick = () => {
      loadAndRenderRisks();
    };
  }

  // 告警分页按钮
  const alertPrev = $('#risk-alerts-prev');
  const alertNext = $('#risk-alerts-next');
  if (alertPrev && !alertPrev.dataset.bound) {
    alertPrev.dataset.bound = 'true';
    alertPrev.onclick = () => {
      if (riskState.alertsPage > 1) renderRiskAlerts(riskState.alertsPage - 1);
    };
  }
  if (alertNext && !alertNext.dataset.bound) {
    alertNext.dataset.bound = 'true';
    alertNext.onclick = () => {
      if (riskState.alertsPage < riskState.alertsTotalPages) renderRiskAlerts(riskState.alertsPage + 1);
    };
  }

  // 危险日志日期切换与分页
  const logDateSelect = $('#risk-log-date');
  if (logDateSelect && !logDateSelect.dataset.bound) {
    logDateSelect.dataset.bound = 'true';
    logDateSelect.onchange = e => {
      renderDangerousLogs(e.target.value, 1);
    };
  }
  const logPrev = $('#risk-logs-prev');
  const logNext = $('#risk-logs-next');
  if (logPrev && !logPrev.dataset.bound) {
    logPrev.dataset.bound = 'true';
    logPrev.onclick = () => {
      if (riskState.logsPage > 1) renderDangerousLogs(riskState.logsDate, riskState.logsPage - 1);
    };
  }
  if (logNext && !logNext.dataset.bound) {
    logNext.dataset.bound = 'true';
    logNext.onclick = () => {
      if (riskState.logsPage < riskState.logsTotalPages) renderDangerousLogs(riskState.logsDate, riskState.logsPage + 1);
    };
  }

  // 全局警报 Banner 交互
  const dismissBtn = $('#risk-banner-dismiss');
  if (dismissBtn && !dismissBtn.dataset.bound) {
    dismissBtn.dataset.bound = 'true';
    dismissBtn.onclick = () => {
      riskState.bannerDismissed = true;
      const banner = $('#global-risk-alert-banner');
      if (banner) banner.hidden = true;
    };
  }
  const actionBtn = $('#risk-banner-action');
  if (actionBtn && !actionBtn.dataset.bound) {
    actionBtn.dataset.bound = 'true';
    actionBtn.onclick = () => {
      const risksNav = $('.nav-item[data-view="risks"]');
      if (risksNav) risksNav.click();
    };
  }
}

export async function loadAndRenderRisks() {
  initRiskViewListeners();

  // 同步日志日期列表到 risk-log-date
  const dateSelect = $('#risk-log-date');
  if (dateSelect) {
    try {
      const { dates } = await api('/admin/api/logs/dates');
      if (dates && dates.length) {
        dateSelect.innerHTML = dates.map(d => `<option value="${d}">${d}</option>`).join('');
        if (!riskState.logsDate || !dates.includes(riskState.logsDate)) {
          riskState.logsDate = dates[0];
        }
        dateSelect.value = riskState.logsDate;
      }
    } catch (err) {
      console.error('Failed to load log dates for risk view:', err);
    }
  }

  await Promise.all([
    updateRiskSummaryAndBanner(),
    renderBans(),
    renderRiskAlerts(1),
    renderDangerousLogs(riskState.logsDate, 1)
  ]);
}
