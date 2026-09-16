import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { createApp } from '../src/server.js';

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
  cookieSecure: false
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
    expect(pool.send.mock.calls[0][1]).not.toHaveProperty('mediaType');
    expect(pool.send).toHaveBeenNthCalledWith(
      2,
      { apiKey: 'ak_primary' },
      expect.objectContaining({ content: undefined, mediaType: 'FILE', mediaUrl: 'https://cdn.example/uploaded.txt', mediaFileName: 'report.txt' })
    );
  });
});
