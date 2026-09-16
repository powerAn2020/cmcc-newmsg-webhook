import fs from 'node:fs';
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
  adminLoginBanDurationMs: 1800000
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
  });
});

