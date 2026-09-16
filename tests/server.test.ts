import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { createApp } from '../src/server.js';

vi.mock('../src/config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...mod,
    updateEnvFile: vi.fn()
  };
});

const config: AppConfig = {
  host: '127.0.0.1',
  port: 3000,
  wsUrl: 'wss://cmcc.example/ws',
  wsVersion: '2.0',
  sendTimeoutMs: 5000,
  uploadUrl: 'https://cmcc.example/api',
  uploadTimeoutMs: 5000,
  gotifyTokens: {},
  webhookSecrets: {},
  databasePath: ':memory:',
  adminUsername: 'admin',
  adminPassword: 'password',
  encryptionKey: 'test-encryption-key',
  cookieSecure: false,
  adminLoginFailLimit: 5,
  adminLoginFailWindowMin: 15,
  adminLoginFailWindowMs: 900000,
  adminLoginBanDurationMin: 30,
  adminLoginBanDurationMs: 1800000,
  accessLogPath: './logs/test-access.log',
  accessLogFormat: 'text',
  accessLogRetentionDays: 30,
  notifyOnLogin: false,
  notifyOnLoginFailed: false,
  notifyOnAuthFailed: false,
  notifyUpstreamId: 0,
  notifyLoginFailThreshold: 3,
  notifyAuthFailThreshold: 3,
  notifyAuthFailWindowMin: 1,
  rateLimitPhoneMinIntervalSec: 0,
  rateLimitPhoneHourMax: 100,
  rateLimitPhoneDayMax: 200,
  rateLimitIpMinMax: 100,
  rateLimitDuplicateWindowSec: 0,
  notifyOnRateLimit: false
};

describe('admin push API', () => {
  let app: FastifyInstance;
  let cookie: string;
  let sent = 0;
  const pool = {
    verify: vi.fn(async () => undefined),
    send: vi.fn(async () => `msg_${++sent}`),
    close: vi.fn()
  };
  const uploader = { upload: vi.fn(async () => 'https://cdn.example/uploaded.txt') };

  beforeEach(async () => {
    sent = 0;
    vi.clearAllMocks();
    config.adminUsername = 'admin';
    config.adminPassword = 'password';
    config.adminLoginFailLimit = 5;
    config.adminLoginFailWindowMin = 15;
    config.adminLoginFailWindowMs = 900000;
    config.adminLoginBanDurationMin = 30;
    config.adminLoginBanDurationMs = 1800000;
    app = await createApp(config, { pool, uploader });
    const login = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { username: 'admin', password: 'password' } });
    cookie = String(login.headers['set-cookie']).split(';')[0];
    const upstream = await app.inject({
      method: 'POST',
      url: '/admin/api/upstreams',
      headers: { cookie },
      payload: { name: 'primary', apiKey: 'ak_primary' }
    });
    expect(upstream.statusCode).toBe(201);
  });

  afterEach(async () => {
    await app.close();
  });

  it('normalizes Markdown and splits text using the OpenClaw limit', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/api/push',
      headers: { cookie },
      payload: { message: `**Alert** ${'x'.repeat(2100)}`, upstreamIds: [1] }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().messageIds).toEqual(['msg_1', 'msg_2']);
    expect(pool.send).toHaveBeenCalledTimes(2);
    expect(pool.send.mock.calls[0][1].content.startsWith('Alert ')).toBe(true);
    expect(pool.send.mock.calls.every(call => call[1].content.length <= 2000)).toBe(true);
  });

  it('sends media text separately before the uploaded file and removes its temporary copy', async () => {
    const boundary = '----cmcc-test-boundary';
    const multipartBody = [
      `--${boundary}\r\nContent-Disposition: form-data; name="upstreamIds"\r\n\r\n[1]\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="mediaType"\r\n\r\nFILE\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\nAttached report\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="report.txt"\r\nContent-Type: text/plain\r\n\r\nreport body\r\n`,
      `--${boundary}--\r\n`
    ].join('');
    const response = await app.inject({
      method: 'POST',
      url: '/admin/api/push',
      headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody
    });

    expect(response.statusCode).toBe(200);
    expect(uploader.upload).toHaveBeenCalledWith('ak_primary', expect.any(String), 'report.txt');
    const temporaryPath = uploader.upload.mock.calls[0][1];
    expect(fs.existsSync(temporaryPath)).toBe(false);
    expect(pool.send).toHaveBeenNthCalledWith(
      1,
      { apiKey: 'ak_primary' },
      expect.objectContaining({ content: 'Attached report' })
    );
    expect(pool.send.mock.calls[0][1]).not.toHaveProperty('mediaUrl');
    expect(pool.send).toHaveBeenNthCalledWith(
      2,
      { apiKey: 'ak_primary' },
      expect.objectContaining({ content: undefined, mediaType: 'FILE', mediaUrl: 'https://cdn.example/uploaded.txt', mediaFileName: 'report.txt' })
    );
  });

  it('downloads external mediaUrl, uploads to cmcc, sends via ws, and deletes temporary file', async () => {
    const fakeBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('fake-remote-image'));
        controller.close();
      }
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-type': 'image/png'
      }),
      body: fakeBody
    } as unknown as Response);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/api/push',
      headers: { cookie },
      payload: {
        upstreamIds: [1],
        message: 'External banner',
        mediaType: 'IMAGE',
        mediaUrl: 'https://cdn.example.com/banner.png'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(uploader.upload).toHaveBeenCalledWith('ak_primary', expect.any(String), 'banner.png');
    const temporaryPath = uploader.upload.mock.calls[0][1];
    expect(fs.existsSync(temporaryPath)).toBe(false);

    expect(pool.send).toHaveBeenNthCalledWith(
      1,
      { apiKey: 'ak_primary' },
      expect.objectContaining({ content: 'External banner' })
    );
    expect(pool.send).toHaveBeenNthCalledWith(
      2,
      { apiKey: 'ak_primary' },
      expect.objectContaining({
        mediaType: 'IMAGE',
        mediaUrl: 'https://cdn.example/uploaded.txt',
        mediaFileName: 'banner.png'
      })
    );

    fetchSpy.mockRestore();
  });

  it('does not download or re-upload if mediaUrl is already a CMCC gateway URL', async () => {
    const cmccUrl = 'https://5gvas01.cmicmaap.com/aifile/already-uploaded.png';
    const response = await app.inject({
      method: 'POST',
      url: '/admin/api/push',
      headers: { cookie },
      payload: {
        upstreamIds: [1],
        mediaType: 'IMAGE',
        mediaUrl: cmccUrl
      }
    });

    expect(response.statusCode).toBe(200);
    expect(uploader.upload).not.toHaveBeenCalled();
    expect(pool.send).toHaveBeenCalledWith(
      { apiKey: 'ak_primary' },
      expect.objectContaining({
        mediaType: 'IMAGE',
        mediaUrl: cmccUrl
      })
    );
  });


  it('allows getting and setting system configuration', async () => {
    const getRes = await app.inject({
      method: 'GET',
      url: '/admin/api/settings',
      headers: { cookie }
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json()).toMatchObject({
      adminUsername: 'admin',
      adminLoginFailLimit: 5,
      adminLoginFailWindowMin: 15,
      adminLoginBanDurationMin: 30,
      adminLoginFailWindowMs: 900000,
      adminLoginBanDurationMs: 1800000,
      wsUrl: 'wss://cmcc.example/ws',
      wsVersion: '2.0',
      sendTimeoutMs: 5000,
      uploadUrl: 'https://cmcc.example/api',
      uploadTimeoutMs: 5000
    });

    const postRes = await app.inject({
      method: 'POST',
      url: '/admin/api/settings',
      headers: { cookie },
      payload: {
        adminUsername: 'newadmin',
        adminPassword: 'newpassword123',
        adminLoginFailLimit: 10,
        adminLoginFailWindowMin: 5,
        adminLoginBanDurationMin: 20,
        sendTimeoutMs: 15000,
        uploadTimeoutMs: 15000
      }
    });
    expect(postRes.statusCode).toBe(200);
    expect(postRes.json()).toEqual({ ok: true });

    expect(config.adminUsername).toBe('newadmin');
    expect(config.adminPassword).toBe('newpassword123');
    expect(config.adminLoginFailLimit).toBe(10);
    expect(config.adminLoginFailWindowMin).toBe(5);
    expect(config.adminLoginFailWindowMs).toBe(300000);
    expect(config.adminLoginBanDurationMin).toBe(20);
    expect(config.adminLoginBanDurationMs).toBe(1200000);

    const badPostRes = await app.inject({
      method: 'POST',
      url: '/admin/api/settings',
      headers: { cookie },
      payload: {
        adminLoginFailLimit: 0
      }
    });
    expect(badPostRes.statusCode).toBe(400);

    const badUserRes = await app.inject({
      method: 'POST',
      url: '/admin/api/settings',
      headers: { cookie },
      payload: {
        adminUsername: '   '
      }
    });
    expect(badUserRes.statusCode).toBe(400);
  });

  describe('health check auth', () => {
    it('returns 404 without valid auth and 200 with valid session or token', async () => {
      // 未鉴权
      const noAuth = await app.inject({ method: 'GET', url: '/healthz' });
      expect(noAuth.statusCode).toBe(404);

      // 无效鉴权
      const badAuth = await app.inject({
        method: 'GET',
        url: '/healthz?token=bad-token',
        headers: { authorization: 'Bearer bad-secret' }
      });
      expect(badAuth.statusCode).toBe(404);

      // 管理员 Cookie 鉴权
      const adminAuth = await app.inject({ method: 'GET', url: '/healthz', headers: { cookie } });
      expect(adminAuth.statusCode).toBe(200);
      expect(adminAuth.json()).toEqual({ ok: true });

      // 创建测试凭据
      const credRes = await app.inject({
        method: 'POST',
        url: '/admin/api/credentials',
        headers: { cookie },
        payload: { name: 'health-token', kind: 'gotify', secret: 'valid-gotify-token', upstreamIds: [1] }
      });
      expect(credRes.statusCode).toBe(201);

      // Gotify query token 鉴权
      const queryAuth = await app.inject({ method: 'GET', url: '/healthz?token=valid-gotify-token' });
      expect(queryAuth.statusCode).toBe(200);
      expect(queryAuth.json()).toEqual({ ok: true });

      // Gotify X-Gotify-Key header 鉴权
      const headerAuth = await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { 'x-gotify-key': 'valid-gotify-token' }
      });
      expect(headerAuth.statusCode).toBe(200);
      expect(headerAuth.json()).toEqual({ ok: true });

      // Webhook Bearer 鉴权
      await app.inject({
        method: 'POST',
        url: '/admin/api/credentials',
        headers: { cookie },
        payload: { name: 'health-webhook', kind: 'webhook', secret: 'valid-webhook-secret', upstreamIds: [1] }
      });
      const bearerAuth = await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { authorization: 'Bearer valid-webhook-secret' }
      });
      expect(bearerAuth.statusCode).toBe(200);
      expect(bearerAuth.json()).toEqual({ ok: true });
    });
  });

  describe('multipart local file sending via /message and /webhook', () => {
    it('supports local file upload via /message (Gotify)', async () => {
      await app.inject({
        method: 'POST',
        url: '/admin/api/credentials',
        headers: { cookie },
        payload: { name: 'gotify-file', kind: 'gotify', secret: 'gotify-file-secret', upstreamIds: [1] }
      });

      const boundary = '----cmcc-test-gotify-file';
      const multipartBody = [
        `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nGotify Title\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\nGotify Message\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="document.pdf"\r\nContent-Type: application/pdf\r\n\r\nfake-pdf-content\r\n`,
        `--${boundary}--\r\n`
      ].join('');

      const response = await app.inject({
        method: 'POST',
        url: '/message?token=gotify-file-secret',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: multipartBody
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        title: 'Gotify Title',
        message: 'Gotify Message'
      });

      expect(uploader.upload).toHaveBeenCalledWith('ak_primary', expect.any(String), 'document.pdf');
      const tempPath = uploader.upload.mock.calls[0][1];
      expect(fs.existsSync(tempPath)).toBe(false);

      expect(pool.send).toHaveBeenNthCalledWith(
        1,
        { apiKey: 'ak_primary' },
        expect.objectContaining({ content: 'Gotify Title\nGotify Message' })
      );
      expect(pool.send).toHaveBeenNthCalledWith(
        2,
        { apiKey: 'ak_primary' },
        expect.objectContaining({
          mediaType: 'FILE',
          mediaUrl: 'https://cdn.example/uploaded.txt',
          mediaFileName: 'document.pdf'
        })
      );
    });

    it('supports local file upload via /webhook', async () => {
      await app.inject({
        method: 'POST',
        url: '/admin/api/credentials',
        headers: { cookie },
        payload: { name: 'webhook-file', kind: 'webhook', secret: 'webhook-file-secret', upstreamIds: [1] }
      });

      const boundary = '----cmcc-test-webhook-file';
      const multipartBody = [
        `--${boundary}\r\nContent-Disposition: form-data; name="content"\r\n\r\nWebhook text content\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\nfake-jpg-content\r\n`,
        `--${boundary}--\r\n`
      ].join('');

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          authorization: 'Bearer webhook-file-secret',
          'content-type': `multipart/form-data; boundary=${boundary}`
        },
        payload: multipartBody
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        messageIds: expect.any(Array)
      });

      expect(uploader.upload).toHaveBeenCalledWith('ak_primary', expect.any(String), 'photo.jpg');
      const tempPath = uploader.upload.mock.calls[0][1];
      expect(fs.existsSync(tempPath)).toBe(false);

      expect(pool.send).toHaveBeenNthCalledWith(
        1,
        { apiKey: 'ak_primary' },
        expect.objectContaining({ content: 'Webhook text content' })
      );
      expect(pool.send).toHaveBeenNthCalledWith(
        2,
        { apiKey: 'ak_primary' },
        expect.objectContaining({
          mediaType: 'IMAGE',
          mediaUrl: 'https://cdn.example/uploaded.txt',
          mediaFileName: 'photo.jpg'
        })
      );
    });

    it('records request access log to file with masked secret and client IP', async () => {
      const testLogBase = path.resolve('./logs/test-server-access.log');
      const today = new Date().toISOString().slice(0, 10);
      const testLog = path.resolve(`./logs/test-server-access-${today}.log`);
      if (fs.existsSync(testLog)) fs.unlinkSync(testLog);
      if (fs.existsSync(testLogBase)) fs.unlinkSync(testLogBase);

      const customConfig = { ...config, accessLogPath: testLogBase };
      const testApp = await createApp(customConfig, { pool, uploader });
      try {
        const res = await testApp.inject({
          method: 'POST',
          url: '/message?token=tok_testsecret1234',
          payload: { message: 'hello' }
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await testApp.close();
      }

      expect(fs.existsSync(testLog)).toBe(true);
      const logContent = fs.readFileSync(testLog, 'utf8');
      expect(logContent).toContain('POST /message?token=tok_testsecret1234');
      expect(logContent).toContain('AUTH: invalid_gotify_token(key=tok_***1234)');
      if (fs.existsSync(testLog)) fs.unlinkSync(testLog);
      if (fs.existsSync(testLogBase)) fs.unlinkSync(testLogBase);
    });

    it('manages security settings and provides /admin/api/logs endpoint', async () => {
      // 1. GET settings
      const settingsRes = await app.inject({
        method: 'GET',
        url: '/admin/api/settings',
        headers: { cookie }
      });
      expect(settingsRes.statusCode).toBe(200);
      const initialSettings = settingsRes.json();
      expect(initialSettings).toHaveProperty('accessLogFormat', 'text');
      expect(initialSettings).toHaveProperty('notifyOnLogin', false);
      expect(initialSettings).toHaveProperty('notifyOnLoginFailed', false);
      expect(initialSettings).toHaveProperty('notifyOnAuthFailed', false);

      // 2. POST settings
      const updateRes = await app.inject({
        method: 'POST',
        url: '/admin/api/settings',
        headers: { cookie },
        payload: {
          accessLogFormat: 'json',
          notifyOnLogin: true,
          notifyOnLoginFailed: true,
          notifyOnAuthFailed: true,
          notifyUpstreamId: 1,
          notifyLoginFailThreshold: 2,
          notifyAuthFailThreshold: 2,
          notifyAuthFailWindowMin: 1
        }
      });
      expect(updateRes.statusCode).toBe(200);

      // 3. Verify settings updated
      const updatedSettings = (await app.inject({
        method: 'GET',
        url: '/admin/api/settings',
        headers: { cookie }
      })).json();
      expect(updatedSettings.accessLogFormat).toBe('json');
      expect(updatedSettings.notifyOnLogin).toBe(true);
      expect(updatedSettings.notifyOnLoginFailed).toBe(true);
      expect(updatedSettings.notifyOnAuthFailed).toBe(true);
      expect(updatedSettings.notifyUpstreamId).toBe(1);
      expect(updatedSettings.notifyLoginFailThreshold).toBe(2);
      expect(updatedSettings.notifyAuthFailThreshold).toBe(2);
      expect(updatedSettings.notifyAuthFailWindowMin).toBe(1);

      // 4. GET /admin/api/logs
      const logsRes = await app.inject({
        method: 'GET',
        url: '/admin/api/logs?limit=50',
        headers: { cookie }
      });
      expect(logsRes.statusCode).toBe(200);
      const logsData = logsRes.json();
      expect(logsData).toHaveProperty('items');
      expect(logsData).toHaveProperty('format', 'json');
      expect(Array.isArray(logsData.items)).toBe(true);
    });

    it('triggers security alerts to upstream on login success, brute force lock, and auth failure', async () => {
      // Enable all security alerts with threshold = 2
      await app.inject({
        method: 'POST',
        url: '/admin/api/settings',
        headers: { cookie },
        payload: {
          notifyOnLogin: true,
          notifyOnLoginFailed: true,
          notifyOnAuthFailed: true,
          notifyUpstreamId: 1,
          notifyLoginFailThreshold: 2,
          notifyAuthFailThreshold: 2,
          notifyAuthFailWindowMin: 1
        }
      });

      pool.send.mockClear();

      // Test 1: Login success alert
      const loginRes = await app.inject({
        method: 'POST',
        url: '/admin/api/login',
        payload: { username: 'admin', password: 'password' }
      });
      expect(loginRes.statusCode).toBe(200);

      // Wait a tick for async notification delivery
      await new Promise(r => setTimeout(r, 50));
      expect(pool.send).toHaveBeenCalledWith(
        { apiKey: 'ak_primary' },
        expect.objectContaining({
          type: 'send',
          content: expect.stringContaining('【安全提示】管理员登录成功')
        })
      );

      // Check history records system notification
      const histRes = await app.inject({
        method: 'GET',
        url: '/admin/api/history',
        headers: { cookie }
      });
      const historyItems = histRes.json();
      const loginHistory = historyItems.find((h: any) => h.source === 'system' && h.title?.includes('管理员登录成功'));
      expect(loginHistory).toBeDefined();
      expect(loginHistory.status).toBe('success');

      pool.send.mockClear();

      // Test 2: Auth failure alert with threshold = 2
      // Attempt 1: Below threshold (1 < 2) -> no alert
      await app.inject({
        method: 'POST',
        url: '/message?token=invalid_alert_tok_1',
        remoteAddress: '198.51.100.1',
        payload: { message: 'should fail 1' }
      });
      await new Promise(r => setTimeout(r, 50));
      expect(pool.send).not.toHaveBeenCalled();

      // Attempt 2: Reaches threshold (2 >= 2) -> triggers alert
      await app.inject({
        method: 'POST',
        url: '/message?token=invalid_alert_tok_2',
        remoteAddress: '198.51.100.1',
        payload: { message: 'should fail 2' }
      });
      await new Promise(r => setTimeout(r, 50));
      expect(pool.send).toHaveBeenCalledWith(
        { apiKey: 'ak_primary' },
        expect.objectContaining({
          type: 'send',
          content: expect.stringContaining('【安全预警】未授权接口访问拦截')
        })
      );

      pool.send.mockClear();

      // Test 3: Multiple login failure alert with threshold = 2 and limit = 5
      // Attempt 1: count 1 -> no alert
      await app.inject({
        method: 'POST',
        url: '/admin/api/login',
        payload: { username: 'admin', password: 'wrongpassword' }
      });
      expect(pool.send).not.toHaveBeenCalled();

      // Attempt 2: count 2 -> reaches threshold 2 -> triggers warning alert
      await app.inject({
        method: 'POST',
        url: '/admin/api/login',
        payload: { username: 'admin', password: 'wrongpassword' }
      });
      await new Promise(r => setTimeout(r, 50));
      expect(pool.send).toHaveBeenCalledWith(
        { apiKey: 'ak_primary' },
        expect.objectContaining({
          type: 'send',
          content: expect.stringContaining('【安全告警】管理员登录连续失败告警')
        })
      );

      pool.send.mockClear();

      // Attempt 3 & 4: count 3, 4 -> no duplicate alert before lockout
      for (let i = 0; i < 2; i++) {
        await app.inject({
          method: 'POST',
          url: '/admin/api/login',
          payload: { username: 'admin', password: 'wrongpassword' }
        });
      }
      expect(pool.send).not.toHaveBeenCalled();

      // Attempt 5: count 5 -> triggers lockout alert
      const lockRes = await app.inject({
        method: 'POST',
        url: '/admin/api/login',
        payload: { username: 'admin', password: 'wrongpassword' }
      });
      expect(lockRes.statusCode).toBe(401);
      await new Promise(r => setTimeout(r, 50));
      expect(pool.send).toHaveBeenCalledWith(
        { apiKey: 'ak_primary' },
        expect.objectContaining({
          type: 'send',
          content: expect.stringContaining('【安全告警】管理员多次登录失败触发封禁')
        })
      );
    });
  });

  describe('Rate limiting and anti-bombing protection', () => {
    let app: FastifyInstance;
    let cookie: string;
    let sent = 0;
    const pool = {
      verify: vi.fn(async () => undefined),
      send: vi.fn(async () => `msg_${++sent}`),
      close: vi.fn()
    };
    const uploader = { upload: vi.fn(async () => 'https://cdn.example/uploaded.txt') };

    beforeEach(async () => {
      sent = 0;
      vi.clearAllMocks();
      config.adminUsername = 'admin';
      config.adminPassword = 'password';
      config.rateLimitPhoneMinIntervalSec = 60;
      config.rateLimitPhoneHourMax = 5;
      config.rateLimitPhoneDayMax = 10;
      config.rateLimitIpMinMax = 30;
      config.rateLimitDuplicateWindowSec = 300;
      config.notifyOnRateLimit = true;
      config.notifyUpstreamId = 1;

      app = await createApp(config, { pool, uploader });
      const login = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { username: 'admin', password: 'password' } });
      cookie = String(login.headers['set-cookie']).split(';')[0];
      await app.inject({
        method: 'POST',
        url: '/admin/api/upstreams',
        headers: { cookie },
        payload: { name: 'primary', apiKey: 'ak_primary' }
      });
      await app.inject({
        method: 'POST',
        url: '/admin/api/credentials',
        headers: { cookie },
        payload: { name: 'test_token', kind: 'gotify', secret: 'valid_rate_token', upstreamIds: [1] }
      });
      pool.send.mockClear();
    });

    afterEach(async () => {
      await app.close();
    });

    it('blocks rapid successive messages to the same phone (anti-bombing) with 429 and sends alert', async () => {
      // First request: succeeds
      const res1 = await app.inject({
        method: 'POST',
        url: '/message?token=valid_rate_token',
        payload: { message: 'Verification code: 111111', phone: '13800138000' }
      });
      expect(res1.statusCode).toBe(200);
      expect(pool.send).toHaveBeenCalledTimes(1);

      pool.send.mockClear();

      // Second request immediately after: should be blocked by minimum interval
      const res2 = await app.inject({
        method: 'POST',
        url: '/message?token=valid_rate_token',
        payload: { message: 'Verification code: 222222', phone: '13800138000' }
      });
      expect(res2.statusCode).toBe(429);
      expect(res2.headers['retry-after']).toBeDefined();
      expect(res2.json().error).toContain('发送间隔不能少于');

      // Wait a tick for async security notification
      await new Promise(r => setTimeout(r, 50));
      expect(pool.send).toHaveBeenCalledWith(
        { apiKey: 'ak_primary' },
        expect.objectContaining({
          type: 'send',
          content: expect.stringContaining('【风控拦截】防消息轰炸/频率超限拦截')
        })
      );
    });

    it('blocks duplicate message content to the same phone within window with 429', async () => {
      // Disable minimum interval to isolate content deduplication
      config.rateLimitPhoneMinIntervalSec = 0;
      await app.inject({
        method: 'POST',
        url: '/admin/api/settings',
        headers: { cookie },
        payload: {
          rateLimitPhoneMinIntervalSec: 0,
          rateLimitDuplicateWindowSec: 300
        }
      });

      // First request
      const res1 = await app.inject({
        method: 'POST',
        url: '/message?token=valid_rate_token',
        payload: { message: 'Repeated content notice', phone: '13900139000' }
      });
      expect(res1.statusCode).toBe(200);

      // Second request with identical content to same phone
      const res2 = await app.inject({
        method: 'POST',
        url: '/message?token=valid_rate_token',
        payload: { message: 'Repeated content notice', phone: '13900139000' }
      });
      expect(res2.statusCode).toBe(429);
      expect(res2.json().error).toContain('已被拦截抑制');
    });

    it('manages risk summary, locked IP bans, unban, and dangerous logs API', async () => {
      // 1. Unauthenticated request should be rejected
      const unauth = await app.inject({ method: 'GET', url: '/admin/api/risks/summary' });
      expect(unauth.statusCode).toBe(401);

      // 2. Summary with admin auth
      const summaryRes = await app.inject({
        method: 'GET',
        url: '/admin/api/risks/summary',
        headers: { cookie }
      });
      expect(summaryRes.statusCode).toBe(200);
      const summary = summaryRes.json();
      expect(summary).toHaveProperty('lockedCount');
      expect(summary).toHaveProperty('todayAlertsCount');
      expect(summary).toHaveProperty('totalAlertsCount');
      expect(summary).toHaveProperty('recentAlerts');

      // 3. Trigger a lock on an IP
      const badIp = '198.51.100.99';
      for (let i = 0; i < 5; i++) {
        await app.inject({
          method: 'POST',
          url: '/admin/api/login',
          payload: { username: 'admin', password: 'wrong_password' },
          remoteAddress: badIp
        });
      }

      // Check bans
      const bansRes = await app.inject({
        method: 'GET',
        url: '/admin/api/risks/bans',
        headers: { cookie }
      });
      expect(bansRes.statusCode).toBe(200);
      const bans = bansRes.json();
      expect(bans.items.some((item: any) => item.ip === badIp)).toBe(true);

      // Unban IP
      const unbanRes = await app.inject({
        method: 'DELETE',
        url: `/admin/api/risks/bans/${badIp}`,
        headers: { cookie }
      });
      expect(unbanRes.statusCode).toBe(200);
      expect(unbanRes.json().ok).toBe(true);

      // Check bans again
      const bansAfter = await app.inject({
        method: 'GET',
        url: '/admin/api/risks/bans',
        headers: { cookie }
      });
      expect(bansAfter.json().items.some((item: any) => item.ip === badIp)).toBe(false);

      // 4. Alerts endpoint & resolution
      const alertsRes = await app.inject({
        method: 'GET',
        url: '/admin/api/risks/alerts?page=1&pageSize=10',
        headers: { cookie }
      });
      expect(alertsRes.statusCode).toBe(200);
      const alerts = alertsRes.json();
      expect(alerts).toHaveProperty('items');
      expect(alerts).toHaveProperty('total');

      if (alerts.items.length > 0) {
        const firstId = alerts.items[0].id;
        const resolveRes = await app.inject({
          method: 'POST',
          url: `/admin/api/risks/alerts/${firstId}/resolve`,
          headers: { cookie }
        });
        expect(resolveRes.statusCode).toBe(200);
        expect(resolveRes.json().ok).toBe(true);

        const resolveAllRes = await app.inject({
          method: 'POST',
          url: '/admin/api/risks/alerts/resolve-all',
          headers: { cookie }
        });
        expect(resolveAllRes.statusCode).toBe(200);
        expect(resolveAllRes.json().ok).toBe(true);

        const summaryAfter = await app.inject({
          method: 'GET',
          url: '/admin/api/risks/summary',
          headers: { cookie }
        });
        expect(summaryAfter.json().todayAlertsCount).toBe(0);
      }

      // 5. Dangerous logs endpoint
      const dangerousRes = await app.inject({
        method: 'GET',
        url: '/admin/api/risks/dangerous-logs?page=1&pageSize=10',
        headers: { cookie }
      });
      expect(dangerousRes.statusCode).toBe(200);
      expect(dangerousRes.json()).toHaveProperty('items');
      expect(dangerousRes.json()).toHaveProperty('total');
    });

    it('blocks IP after repeated invalid token/secret attempts on /message and /webhook', async () => {
      const badIp = '198.51.100.99';

      // 4 failed attempts on /message
      for (let i = 0; i < 4; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/message?token=invalid_gotify_token',
          remoteAddress: badIp,
          payload: { message: 'hello' }
        });
        expect(res.statusCode).toBe(401);
      }

      // 5th attempt triggers lock (limit is 5)
      const lockRes = await app.inject({
        method: 'POST',
        url: '/message?token=invalid_gotify_token',
        remoteAddress: badIp,
        payload: { message: 'hello' }
      });
      expect(lockRes.statusCode).toBe(401);

      // 6th attempt should immediately return 429 due to IP ban
      const blockedRes = await app.inject({
        method: 'POST',
        url: '/message?token=invalid_gotify_token',
        remoteAddress: badIp,
        payload: { message: 'hello' }
      });
      expect(blockedRes.statusCode).toBe(429);
      expect(blockedRes.headers['retry-after']).toBeDefined();
      expect(blockedRes.json().error).toContain('temporarily blocked');

      // Also blocked on /webhook from the same IP
      const blockedWebhook = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: { authorization: 'Bearer invalid_secret' },
        remoteAddress: badIp,
        payload: { type: 'send', content: 'hello' }
      });
      expect(blockedWebhook.statusCode).toBe(429);

      // Verify it appears in risk management banned IP list
      const bansRes = await app.inject({
        method: 'GET',
        url: '/admin/api/risks/bans',
        headers: { cookie }
      });
      expect(bansRes.statusCode).toBe(200);
      expect(bansRes.json().items.some((item: any) => item.ip === badIp)).toBe(true);

      // Unban IP
      const unbanRes = await app.inject({
        method: 'DELETE',
        url: `/admin/api/risks/bans/${badIp}`,
        headers: { cookie }
      });
      expect(unbanRes.statusCode).toBe(200);

      // Now request is allowed past IP check (returns 401 instead of 429)
      const afterUnbanRes = await app.inject({
        method: 'POST',
        url: '/message?token=invalid_gotify_token',
        remoteAddress: badIp,
        payload: { message: 'hello' }
      });
      expect(afterUnbanRes.statusCode).toBe(401);
    });
  });
});

