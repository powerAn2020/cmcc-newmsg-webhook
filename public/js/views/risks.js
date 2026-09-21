import { state, $, $$, escapeHtml } from '../state.js';
import { api } from '../api.js';
import { showConfirm, showPrompt, showAlert } from '../modal.js';

let riskState = {
  alertsPage: 1,
  alertsTotalPages: 1,
  logsDate: '',
  logsPage: 1,
  logsTotalPages: 1,
  bannerDismissed: false,
  bannedIps: new Set()
};

export function isValidIp(ip) {
  if (!ip || typeof ip !== 'string') return false;
  const v4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  if (v4Regex.test(ip)) return true;
  if (ip.includes(':') && /^[0-9a-fA-F:]{3,39}$/.test(ip)) return true;
  return false;
}

export function extractIpFromText(text) {
  if (!text) return null;
  const labeled = text.match(/(?:来源\s*IP|登录\s*IP|拦截\s*IP|客户端\s*IP|IP)\s*[:：]\s*([0-9a-fA-F:.]+)/i);
  if (labeled && isValidIp(labeled[1].trim())) {
    return labeled[1].trim();
  }
  const v4Match = text.match(/\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/);
  if (v4Match && isValidIp(v4Match[0])) {
    return v4Match[0];
  }
  return null;
}

export async function updateRiskSummaryAndBanner() {
  initRiskViewListeners();
  try {
    const summary = await api('/admin/api/risks/summary');
    const badge = $('#risk-nav-badge');
    const banner = $('#global-risk-alert-banner');
    // 菜单栏风险角标和全局横条只统计系统安全风险（自动防爆破封禁 IP + 今日待排查告警），排除管理员手动封禁
    const autoLockedCount = summary.autoLockedCount !== undefined ? (summary.autoLockedCount || 0) : 0;
    const todayAlertsCount = summary.todayAlertsCount || 0;
    const riskTotal = autoLockedCount + todayAlertsCount;

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
          if (autoLockedCount > 0) parts.push(`当前有 ${autoLockedCount} 个 IP 触发防暴力破解封禁`);
          if (todayAlertsCount > 0) parts.push(`今日累计触发 ${todayAlertsCount} 起安全拦截告警`);
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
    riskState.bannedIps = new Set(items.map(item => item.ip));
    if (!items.length) {
      list.innerHTML = '';
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;

    list.innerHTML = items.map(item => {
      const isManual = item.failedCount === 0 || item.reason === '手动封禁' || !item.lockedUntil;
      const reasonLabel = item.reason || (isManual ? '手动封禁' : `连续失败 ${item.failedCount} 次`);
      const timeLabel = isManual ? '封禁时间' : '首次失败时间';
      const timeValue = item.firstFailedAt ? new Date(item.firstFailedAt).toLocaleString() : '-';
      const statusLabel = isManual ? '解封方式' : '预计解封时间';
      const statusValue = isManual
        ? '<strong style="color:var(--red);">永久封禁（需手动解封）</strong>'
        : `<strong style="color:var(--ink);">${item.lockedUntil ? new Date(item.lockedUntil).toLocaleString() : '永久'}</strong>`;
      return `
        <div class="data-row" style="align-items: flex-start;">
          <div>
            <h5 style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
              <span class="badge failed">${escapeHtml(item.ip)}</span>
              <span style="font-size:12px; font-weight:normal; color:var(--red);">${escapeHtml(reasonLabel)}</span>
            </h5>
            <p style="color:var(--muted); font-size:12px;">
              ${timeLabel}: ${timeValue} | ${statusLabel}: ${statusValue}
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
        const ok = await showConfirm({
          eyebrow: '安全设置',
          title: '解除 IP 拦截限制',
          message: `确定要解除对 IP【${ip}】的全局拦截限制吗？\n\n解除后，该 IP 将恢复正常访问权限。`,
          confirmText: '确认解封',
          isDanger: false
        });
        if (!ok) return;
        btn.disabled = true;
        btn.textContent = '解封中...';
        try {
          await api(`/admin/api/risks/bans/${encodeURIComponent(ip)}`, { method: 'DELETE' });
          if (riskState.bannedIps) riskState.bannedIps.delete(ip);
          await Promise.all([renderBans(), renderRiskAlerts(riskState.alertsPage), updateRiskSummaryAndBanner()]);
        } catch (err) {
          showAlert({ title: '解封失败', message: (err instanceof Error ? err.message : String(err)), isError: true });
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
    if (!riskState.bannedIps || riskState.bannedIps.size === 0) {
      try {
        const bansData = await api('/admin/api/risks/bans');
        riskState.bannedIps = new Set((bansData.items || []).map(item => item.ip));
      } catch {}
    }

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
      const isHandled = !!item.handledAt;
      const handledBadge = isHandled
        ? '<span class="badge success">已排查</span>'
        : '<span class="badge warning">待排查</span>';

      let operationsHtml = '';
      if (!isHandled) {
        const targetIp = extractIpFromText(item.content) || extractIpFromText(item.title);
        let banBtnHtml = '';
        if (targetIp) {
          const isBanned = riskState.bannedIps && riskState.bannedIps.has(targetIp);
          if (isBanned) {
            banBtnHtml = `<button class="button secondary compact unban-alert-btn" data-ip="${escapeHtml(targetIp)}" type="button" style="font-size:11px; color:var(--teal); border-color:var(--teal); font-weight:700; white-space:nowrap;" title="该 IP 当前已被系统封禁，点击可解封">已封禁 (解封)</button>`;
          } else {
            banBtnHtml = `<button class="button danger compact ban-alert-btn" data-ip="${escapeHtml(targetIp)}" data-id="${item.id}" type="button" style="font-size:11px; font-weight:700; background:var(--red); color:#fff; border:none; white-space:nowrap;" title="将 IP【${escapeHtml(targetIp)}】加入黑名单，立即拦截访问并标记为已排查">封禁此 IP</button>`;
          }
        } else {
          banBtnHtml = `<button class="button secondary compact manual-ban-alert-btn" data-id="${item.id}" type="button" style="font-size:11px; color:var(--muted); white-space:nowrap;" title="手动指定 IP 进行封禁">封禁 IP...</button>`;
        }

        operationsHtml = `
          <div style="display:flex; flex-direction:column; gap:6px; align-items:center; justify-content:center;">
            <button class="button secondary compact resolve-alert-btn" data-id="${item.id}" type="button" style="font-size:12px; color:var(--teal); font-weight:700;">标为已排查</button>
            ${banBtnHtml}
          </div>
        `;
      } else {
        operationsHtml = `<span style="color:var(--muted); font-size:12px;">已完成</span>`;
      }

      return `
        <tr>
          <td>${timeStr}</td>
          <td><strong style="color:var(--ink);">${escapeHtml(item.title || '系统告警')}</strong></td>
          <td class="content-cell" style="white-space: pre-line; font-size:12px;">${escapeHtml(item.content || '-')}</td>
          <td>${handledBadge}</td>
          <td>${statusBadge}</td>
          <td style="text-align: center;">${operationsHtml}</td>
        </tr>
      `;
    }).join('');

    // 绑定单条标为已排查事件
    tbody.querySelectorAll('.resolve-alert-btn').forEach(btn => {
      btn.onclick = async () => {
        const id = btn.dataset.id;
        if (!id) return;
        btn.disabled = true;
        btn.textContent = '处理中...';
        try {
          await api(`/admin/api/risks/alerts/${encodeURIComponent(id)}/resolve`, { method: 'POST' });
          await Promise.all([
            renderRiskAlerts(riskState.alertsPage),
            updateRiskSummaryAndBanner()
          ]);
        } catch (err) {
          showAlert({ title: '操作失败', message: (err instanceof Error ? err.message : String(err)), isError: true });
          btn.disabled = false;
          btn.textContent = '标为已排查';
        }
      };
    });

    // 绑定封禁按钮事件
    tbody.querySelectorAll('.ban-alert-btn').forEach(btn => {
      btn.onclick = async () => {
        const ip = btn.dataset.ip;
        const alertId = btn.dataset.id ? Number(btn.dataset.id) : undefined;
        if (!ip) return;
        const ok = await showConfirm({
          eyebrow: '安全防御',
          title: '确认加入封禁黑名单',
          message: `确定要将可疑 IP【${ip}】加入封禁黑名单吗？\n\n封禁后，该 IP 将被系统全局永久拦截（需管理员手动解封，不会自动解封），且对应告警将自动标为已排查。`,
          confirmText: '确认封禁并标记',
          isDanger: true
        });
        if (!ok) return;
        btn.disabled = true;
        btn.textContent = '封禁中...';
        try {
          await api('/admin/api/risks/bans', { method: 'POST', body: JSON.stringify({ ip, alertId }) });
          if (!riskState.bannedIps) riskState.bannedIps = new Set();
          riskState.bannedIps.add(ip);
          await Promise.all([
            renderBans(),
            renderRiskAlerts(riskState.alertsPage),
            updateRiskSummaryAndBanner()
          ]);
        } catch (err) {
          showAlert({ title: '封禁失败', message: (err instanceof Error ? err.message : String(err)), isError: true });
          btn.disabled = false;
          btn.textContent = '封禁此 IP';
        }
      };
    });

    // 绑定已封禁解封按钮事件
    tbody.querySelectorAll('.unban-alert-btn').forEach(btn => {
      btn.onclick = async () => {
        const ip = btn.dataset.ip;
        if (!ip) return;
        const ok = await showConfirm({
          eyebrow: '安全设置',
          title: '解除 IP 拦截限制',
          message: `确定要解除对 IP【${ip}】的全局拦截限制吗？\n\n解除后，该 IP 将恢复正常访问权限。`,
          confirmText: '确认解封',
          isDanger: false
        });
        if (!ok) return;
        btn.disabled = true;
        btn.textContent = '解封中...';
        try {
          await api(`/admin/api/risks/bans/${encodeURIComponent(ip)}`, { method: 'DELETE' });
          if (riskState.bannedIps) riskState.bannedIps.delete(ip);
          await Promise.all([
            renderBans(),
            renderRiskAlerts(riskState.alertsPage),
            updateRiskSummaryAndBanner()
          ]);
        } catch (err) {
          showAlert({ title: '解封失败', message: (err instanceof Error ? err.message : String(err)), isError: true });
          btn.disabled = false;
          btn.textContent = '已封禁 (解封)';
        }
      };
    });

    // 绑定手动输入封禁事件
    tbody.querySelectorAll('.manual-ban-alert-btn').forEach(btn => {
      btn.onclick = async () => {
        const alertId = btn.dataset.id ? Number(btn.dataset.id) : undefined;
        const inputIp = await showPrompt({
          eyebrow: '安全防御',
          title: '封禁可疑客户端 IP',
          message: '请输入要加入全局黑名单拦截的客户端 IP 地址：',
          placeholder: '例如：192.168.1.100',
          confirmText: '立即封禁',
          isDanger: true,
          validator: val => isValidIp(val) ? '' : '请输入合法有效的 IPv4 或 IPv6 地址'
        });
        if (!inputIp) return;
        const ip = inputIp.trim();
        try {
          await api('/admin/api/risks/bans', { method: 'POST', body: JSON.stringify({ ip, alertId }) });
          if (!riskState.bannedIps) riskState.bannedIps = new Set();
          riskState.bannedIps.add(ip);
          await Promise.all([
            renderBans(),
            renderRiskAlerts(riskState.alertsPage),
            updateRiskSummaryAndBanner()
          ]);
          showAlert({ title: '封禁成功', message: `IP【${ip}】已成功加入系统全局封禁名单，关联告警已自动标为已排查！` });
        } catch (err) {
          showAlert({ title: '封禁失败', message: (err instanceof Error ? err.message : String(err)), isError: true });
        }
      };
    });
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

  // 手动封禁 IP 按钮
  const manualBanBtn = $('#risk-manual-ban-btn');
  if (manualBanBtn && !manualBanBtn.dataset.bound) {
    manualBanBtn.dataset.bound = 'true';
    manualBanBtn.onclick = async () => {
      const inputIp = await showPrompt({
        eyebrow: '安全防御',
        title: '手动添加封禁 IP',
        message: '请输入要加入全局拦截黑名单的客户端 IP 地址：',
        placeholder: '例如：203.0.113.195',
        confirmText: '立即封禁',
        isDanger: true,
        validator: val => isValidIp(val) ? '' : '请输入合法有效的 IPv4 或 IPv6 地址'
      });
      if (!inputIp) return;
      const ip = inputIp.trim();
      try {
        await api('/admin/api/risks/bans', { method: 'POST', body: JSON.stringify({ ip }) });
        if (!riskState.bannedIps) riskState.bannedIps = new Set();
        riskState.bannedIps.add(ip);
        await Promise.all([
          renderBans(),
          renderRiskAlerts(riskState.alertsPage),
          updateRiskSummaryAndBanner()
        ]);
        showAlert({ title: '封禁成功', message: `IP【${ip}】已成功加入系统全局封禁名单！` });
      } catch (err) {
        showAlert({ title: '封禁失败', message: (err instanceof Error ? err.message : String(err)), isError: true });
      }
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

  // 告警全部标为已排查
  const resolveAllBtn = $('#risk-alerts-resolve-all-btn');
  if (resolveAllBtn && !resolveAllBtn.dataset.bound) {
    resolveAllBtn.dataset.bound = 'true';
    resolveAllBtn.onclick = async () => {
      const ok = await showConfirm({
        eyebrow: '批量排查',
        title: '全部标为已排查确认',
        message: '确定要将当前所有待排查的安全告警批量标为已排查吗？',
        confirmText: '确认标记',
        isDanger: false
      });
      if (!ok) return;

      resolveAllBtn.disabled = true;
      resolveAllBtn.textContent = '处理中...';
      try {
        await api('/admin/api/risks/alerts/resolve-all', { method: 'POST' });
        await Promise.all([
          renderRiskAlerts(riskState.alertsPage),
          updateRiskSummaryAndBanner()
        ]);
      } catch (err) {
        showAlert({ title: '批量处理失败', message: (err instanceof Error ? err.message : String(err)), isError: true });
      } finally {
        resolveAllBtn.disabled = false;
        resolveAllBtn.textContent = '✓ 全部标为已排查';
      }
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
      // 标记收起并隐藏全局横条
      riskState.bannerDismissed = true;
      const banner = $('#global-risk-alert-banner');
      if (banner) banner.hidden = true;

      // 切换至异常风险页面
      const risksNav = $('.nav-item[data-view="risks"]');
      if (risksNav) risksNav.click();

      // 平滑滚动定位至安全告警排查面板
      setTimeout(() => {
        const target = $('#risk-alerts-section') || $('#risk-bans-list');
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }, 150);
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
