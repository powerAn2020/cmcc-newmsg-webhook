import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, maskSecret } from '../src/config.js';

const saved = { token: process.env.CMCC_TOKEN_MAP, webhook: process.env.CMCC_WEBHOOK_SECRETS, username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD, encryption: process.env.CONFIG_ENCRYPTION_KEY };
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
});
