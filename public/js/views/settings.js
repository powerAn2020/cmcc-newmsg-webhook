import { $, showMessage } from '../state.js';
import { api } from '../api.js';

export async function loadAndPopulateSettings() {
  try {
    const settings = await api('/admin/api/settings');
    const form = $('#settings-form');
    if (!form) return;
    form.elements.adminUsername.value = settings.adminUsername || '';
    form.elements.adminPassword.value = '';
    if (form.elements.adminPasswordConfirm) form.elements.adminPasswordConfirm.value = '';
    form.elements.adminLoginFailLimit.value = settings.adminLoginFailLimit;
    form.elements.adminLoginFailWindowMin.value = settings.adminLoginFailWindowMin ?? Math.round((settings.adminLoginFailWindowMs || 900000) / 60000);
    form.elements.adminLoginBanDurationMin.value = settings.adminLoginBanDurationMin ?? Math.round((settings.adminLoginBanDurationMs || 1800000) / 60000);
    form.elements.wsUrl.value = settings.wsUrl;
    form.elements.wsVersion.value = settings.wsVersion;
    form.elements.uploadUrl.value = settings.uploadUrl;
    form.elements.sendTimeoutMs.value = settings.sendTimeoutMs;
    form.elements.uploadTimeoutMs.value = settings.uploadTimeoutMs;
    form.elements.accessLogFormat.value = 'json';
    form.elements.accessLogRetentionDays.value = settings.accessLogRetentionDays ?? 30;

    if (form.elements.notifyUpstreamId) form.elements.notifyUpstreamId.value = settings.notifyUpstreamId ?? 0;
    if (form.elements.notifyOnLogin) form.elements.notifyOnLogin.checked = Boolean(settings.notifyOnLogin);
    if (form.elements.notifyOnLoginFailed) form.elements.notifyOnLoginFailed.checked = Boolean(settings.notifyOnLoginFailed);
    if (form.elements.notifyOnAuthFailed) form.elements.notifyOnAuthFailed.checked = Boolean(settings.notifyOnAuthFailed);
    if (form.elements.notifyLoginFailThreshold) form.elements.notifyLoginFailThreshold.value = settings.notifyLoginFailThreshold ?? 3;
    if (form.elements.notifyAuthFailThreshold) form.elements.notifyAuthFailThreshold.value = settings.notifyAuthFailThreshold ?? 3;
    if (form.elements.notifyAuthFailWindowMin) form.elements.notifyAuthFailWindowMin.value = settings.notifyAuthFailWindowMin ?? 1;

    if (form.elements.rateLimitMsgMinMax) form.elements.rateLimitMsgMinMax.value = settings.rateLimitMsgMinMax ?? 10;
    if (form.elements.rateLimitMsgMinIntervalSec) form.elements.rateLimitMsgMinIntervalSec.value = settings.rateLimitMsgMinIntervalSec ?? 0;
    if (form.elements.rateLimitMsgHourMax) form.elements.rateLimitMsgHourMax.value = settings.rateLimitMsgHourMax ?? 0;
    if (form.elements.rateLimitMsgDayMax) form.elements.rateLimitMsgDayMax.value = settings.rateLimitMsgDayMax ?? 0;
    if (form.elements.rateLimitIpMinMax) form.elements.rateLimitIpMinMax.value = settings.rateLimitIpMinMax ?? 30;
    if (form.elements.rateLimitDuplicateWindowSec) form.elements.rateLimitDuplicateWindowSec.value = settings.rateLimitDuplicateWindowSec ?? 300;
    if (form.elements.notifyOnRateLimit) form.elements.notifyOnRateLimit.checked = settings.notifyOnRateLimit !== false;
    if (form.elements.backupGotifyEnabled) form.elements.backupGotifyEnabled.checked = Boolean(settings.backupGotifyEnabled);
    if (form.elements.backupGotifyUrl) form.elements.backupGotifyUrl.value = settings.backupGotifyUrl || '';
    if (form.elements.backupGotifyToken) form.elements.backupGotifyToken.value = settings.backupGotifyToken || '';
    if (form.elements.backupGotifyThreshold) form.elements.backupGotifyThreshold.value = settings.backupGotifyThreshold ?? 3;
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
}

export function initSettingsView() {
  const form = $('#settings-form');
  if (!form) return;

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const adminUsername = form.elements.adminUsername.value.trim();
    const adminPassword = form.elements.adminPassword.value;
    const adminPasswordConfirm = form.elements.adminPasswordConfirm?.value;

    if (adminPassword) {
      if (adminPassword.length < 6) {
        showMessage('#settings-message', '管理员新密码长度不能少于 6 位。');
        return;
      }
      if (adminPassword !== adminPasswordConfirm) {
        showMessage('#settings-message', '两次输入的管理员新密码不一致，请核对后重试。');
        return;
      }
    }

    const adminLoginFailLimit = Number(form.elements.adminLoginFailLimit.value);
    const adminLoginFailWindowMin = Number(form.elements.adminLoginFailWindowMin.value);
    const adminLoginBanDurationMin = Number(form.elements.adminLoginBanDurationMin.value);
    const wsUrl = form.elements.wsUrl.value.trim();
    const wsVersion = form.elements.wsVersion.value.trim();
    const uploadUrl = form.elements.uploadUrl.value.trim();
    const sendTimeoutMs = Number(form.elements.sendTimeoutMs.value);
    const uploadTimeoutMs = Number(form.elements.uploadTimeoutMs.value);
    const accessLogFormat = 'json';
    const accessLogRetentionDays = Number(form.elements.accessLogRetentionDays?.value) || 30;
    const notifyUpstreamId = Number(form.elements.notifyUpstreamId?.value) || 0;
    const notifyOnLogin = Boolean(form.elements.notifyOnLogin?.checked);
    const notifyOnLoginFailed = Boolean(form.elements.notifyOnLoginFailed?.checked);
    const notifyOnAuthFailed = Boolean(form.elements.notifyOnAuthFailed?.checked);
    const notifyLoginFailThreshold = Number(form.elements.notifyLoginFailThreshold?.value) || 3;
    const notifyAuthFailThreshold = Number(form.elements.notifyAuthFailThreshold?.value) || 3;
    const notifyAuthFailWindowMin = Number(form.elements.notifyAuthFailWindowMin?.value) || 1;
    const rateLimitMsgMinMax = Number(form.elements.rateLimitMsgMinMax?.value ?? 10);
    const rateLimitMsgMinIntervalSec = Number(form.elements.rateLimitMsgMinIntervalSec?.value ?? 0);
    const rateLimitMsgHourMax = Number(form.elements.rateLimitMsgHourMax?.value ?? 0);
    const rateLimitMsgDayMax = Number(form.elements.rateLimitMsgDayMax?.value ?? 0);
    const rateLimitIpMinMax = Number(form.elements.rateLimitIpMinMax?.value ?? 30);
    const rateLimitDuplicateWindowSec = Number(form.elements.rateLimitDuplicateWindowSec?.value ?? 300);
    const notifyOnRateLimit = Boolean(form.elements.notifyOnRateLimit?.checked);
    const backupGotifyEnabled = Boolean(form.elements.backupGotifyEnabled?.checked);
    const backupGotifyUrl = form.elements.backupGotifyUrl?.value?.trim() || '';
    const backupGotifyToken = form.elements.backupGotifyToken?.value?.trim() || '';
    const backupGotifyThreshold = Number(form.elements.backupGotifyThreshold?.value) || 3;

    if (backupGotifyEnabled) {
      if (!backupGotifyUrl) {
        showMessage('#settings-message', '启用 Gotify 备用告警时，必须提供 Gotify 服务端 URL。');
        return;
      }
      if (!backupGotifyToken) {
        showMessage('#settings-message', '启用 Gotify 备用告警时，必须提供 Gotify App Token。');
        return;
      }
    }

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
    if (!accessLogRetentionDays || accessLogRetentionDays < 1) {
      showMessage('#settings-message', '日志保留天数必须是正整数。');
      return;
    }
    if (!notifyLoginFailThreshold || notifyLoginFailThreshold < 1) {
      showMessage('#settings-message', '登录失败告警阈值必须是正整数。');
      return;
    }
    if (!notifyAuthFailThreshold || notifyAuthFailThreshold < 1) {
      showMessage('#settings-message', '鉴权失败告警阈值必须是正整数。');
      return;
    }
    if (!notifyAuthFailWindowMin || notifyAuthFailWindowMin < 1) {
      showMessage('#settings-message', '鉴权观测窗口必须至少为 1 分钟。');
      return;
    }
    if (rateLimitMsgMinMax < 1 || rateLimitMsgMinIntervalSec < 0 || rateLimitMsgHourMax < 0 || rateLimitMsgDayMax < 0 || rateLimitIpMinMax < 0 || rateLimitDuplicateWindowSec < 0) {
      showMessage('#settings-message', '流量风控阈值不能为负数，且每分钟上限必须至少为 1。');
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
        uploadTimeoutMs,
        accessLogFormat,
        accessLogRetentionDays,
        notifyUpstreamId,
        notifyOnLogin,
        notifyOnLoginFailed,
        notifyOnAuthFailed,
        notifyLoginFailThreshold,
        notifyAuthFailThreshold,
        notifyAuthFailWindowMin,
        rateLimitMsgMinMax,
        rateLimitMsgMinIntervalSec,
        rateLimitMsgHourMax,
        rateLimitMsgDayMax,
        rateLimitIpMinMax,
        rateLimitDuplicateWindowSec,
        notifyOnRateLimit,
        backupGotifyEnabled,
        backupGotifyUrl,
        backupGotifyToken,
        backupGotifyThreshold
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
      if (form.elements.adminPasswordConfirm) form.elements.adminPasswordConfirm.value = '';
      showMessage('#settings-message', '系统参数设置已成功保存并生效！', true);
    } catch (error) {
      showMessage('#settings-message', error.message);
    } finally {
      button.disabled = false;
    }
  });
}
