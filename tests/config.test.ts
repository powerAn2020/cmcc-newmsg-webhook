import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, maskSecret } from '../src/config.js';

const saved = {
  token: process.env.CMCC_TOKEN_MAP,
  webhook: process.env.CMCC_WEBHOOK_SECRETS,
  username: process.env.ADMIN_USERNAME,
  password: process.env.ADMIN_PASSWORD,
  encryption: process.env.CONFIG_ENCRYPTION_KEY,
  failLimit: process.env.ADMIN_LOGIN_FAIL_LIMIT,
  failWindowMin: process.env.ADMIN_LOGIN_FAIL_WINDOW_MIN,
  failWindowMs: process.env.ADMIN_LOGIN_FAIL_WINDOW_MS,
  banDurationMin: process.env.ADMIN_LOGIN_BAN_DURATION_MIN,
  banDurationMs: process.env.ADMIN_LOGIN_BAN_DURATION_MS
};
beforeEach(() => {
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'test-password';
  process.env.CONFIG_ENCRYPTION_KEY = 'test-encryption-key';
});
afterEach(() => {
  if (saved.token === undefined) delete process.env.CMCC_TOKEN_MAP; else process.env.CMCC_TOKEN_MAP = saved.token;
  if (saved.webhook === undefined) delete process.env.CMCC_WEBHOOK_SECRETS; else process.env.CMCC_WEBHOOK_SECRETS = saved.webhook;
  if (saved.username === undefined) delete process.env.ADMIN_USERNAME; else process.env.ADMIN_USERNAME = saved.username;
  if (saved.password === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = saved.password;
  if (saved.encryption === undefined) delete process.env.CONFIG_ENCRYPTION_KEY; else process.env.CONFIG_ENCRYPTION_KEY = saved.encryption;
  if (saved.failLimit === undefined) delete process.env.ADMIN_LOGIN_FAIL_LIMIT; else process.env.ADMIN_LOGIN_FAIL_LIMIT = saved.failLimit;
  if (saved.failWindowMin === undefined) delete process.env.ADMIN_LOGIN_FAIL_WINDOW_MIN; else process.env.ADMIN_LOGIN_FAIL_WINDOW_MIN = saved.failWindowMin;
  if (saved.failWindowMs === undefined) delete process.env.ADMIN_LOGIN_FAIL_WINDOW_MS; else process.env.ADMIN_LOGIN_FAIL_WINDOW_MS = saved.failWindowMs;
  if (saved.banDurationMin === undefined) delete process.env.ADMIN_LOGIN_BAN_DURATION_MIN; else process.env.ADMIN_LOGIN_BAN_DURATION_MIN = saved.banDurationMin;
  if (saved.banDurationMs === undefined) delete process.env.ADMIN_LOGIN_BAN_DURATION_MS; else process.env.ADMIN_LOGIN_BAN_DURATION_MS = saved.banDurationMs;
});

describe('configuration', () => {
  it('loads Gotify and Webhook maps and supports to alias', () => {
    process.env.CMCC_TOKEN_MAP = JSON.stringify({ t: { apiKey: 'ak_token', to: '13800138000' } });
    process.env.CMCC_WEBHOOK_SECRETS = JSON.stringify({ s: { apiKey: 'ak_webhook', defaultTo: '13900139000' } });
    const cfg = loadConfig();
    expect(cfg.gotifyTokens.t.defaultTo).toBe('13800138000');
    expect(cfg.webhookSecrets.s.apiKey).toBe('ak_webhook');
  });

  it('masks secrets', () => expect(maskSecret('ak_123456789')).toBe('ak_***789'));

  it('allows accounts without a recipient because CMCC routes by API key', () => {
    process.env.CMCC_TOKEN_MAP = JSON.stringify({ t: { apiKey: 'ak_token' } });
    expect(loadConfig().gotifyTokens.t.defaultTo).toBeUndefined();
  });

  it('requires admin access and encryption configuration', () => {
    delete process.env.ADMIN_PASSWORD;
    expect(loadConfig).toThrow('ADMIN_USERNAME');
  });

  it('loads default brute-force prevention configs', () => {
    delete process.env.ADMIN_LOGIN_FAIL_LIMIT;
    delete process.env.ADMIN_LOGIN_FAIL_WINDOW_MIN;
    delete process.env.ADMIN_LOGIN_FAIL_WINDOW_MS;
    delete process.env.ADMIN_LOGIN_BAN_DURATION_MIN;
    delete process.env.ADMIN_LOGIN_BAN_DURATION_MS;
    const cfg = loadConfig();
    expect(cfg.adminLoginFailLimit).toBe(5);
    expect(cfg.adminLoginFailWindowMin).toBe(15);
    expect(cfg.adminLoginFailWindowMs).toBe(900000);
    expect(cfg.adminLoginBanDurationMin).toBe(30);
    expect(cfg.adminLoginBanDurationMs).toBe(1800000);
  });

  it('loads custom brute-force prevention configs in minutes from env', () => {
    process.env.ADMIN_LOGIN_FAIL_LIMIT = '10';
    process.env.ADMIN_LOGIN_FAIL_WINDOW_MIN = '5';
    process.env.ADMIN_LOGIN_BAN_DURATION_MIN = '60';
    const cfg = loadConfig();
    expect(cfg.adminLoginFailLimit).toBe(10);
    expect(cfg.adminLoginFailWindowMin).toBe(5);
    expect(cfg.adminLoginFailWindowMs).toBe(300000);
    expect(cfg.adminLoginBanDurationMin).toBe(60);
    expect(cfg.adminLoginBanDurationMs).toBe(3600000);
  });

  it('supports legacy _MS environment variables for backwards compatibility', () => {
    delete process.env.ADMIN_LOGIN_FAIL_WINDOW_MIN;
    delete process.env.ADMIN_LOGIN_BAN_DURATION_MIN;
    process.env.ADMIN_LOGIN_FAIL_WINDOW_MS = '60000';
    process.env.ADMIN_LOGIN_BAN_DURATION_MS = '120000';
    const cfg = loadConfig();
    expect(cfg.adminLoginFailWindowMin).toBe(1);
    expect(cfg.adminLoginFailWindowMs).toBe(60000);
    expect(cfg.adminLoginBanDurationMin).toBe(2);
    expect(cfg.adminLoginBanDurationMs).toBe(120000);
  });

  it('validates brute-force prevention configs', () => {
    process.env.ADMIN_LOGIN_FAIL_LIMIT = '0';
    expect(loadConfig).toThrow('ADMIN_LOGIN_FAIL_LIMIT');

    process.env.ADMIN_LOGIN_FAIL_LIMIT = '5';
    process.env.ADMIN_LOGIN_FAIL_WINDOW_MIN = '0';
    expect(loadConfig).toThrow('ADMIN_LOGIN_FAIL_WINDOW_MIN');

    process.env.ADMIN_LOGIN_FAIL_WINDOW_MIN = '15';
    process.env.ADMIN_LOGIN_BAN_DURATION_MIN = '0';
    expect(loadConfig).toThrow('ADMIN_LOGIN_BAN_DURATION_MIN');
  });

  it('loads default accessLogPath or custom environment variable', () => {
    delete process.env.ACCESS_LOG_PATH;
    expect(loadConfig().accessLogPath).toBe('./logs/access.log');

    process.env.ACCESS_LOG_PATH = './custom/access.log';
    expect(loadConfig().accessLogPath).toBe('./custom/access.log');
    delete process.env.ACCESS_LOG_PATH;
  });
});
