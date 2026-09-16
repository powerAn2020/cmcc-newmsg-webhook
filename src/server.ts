import 'dotenv/config';
import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import sensible from '@fastify/sensible';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { loadConfig, maskSecret, updateEnvFile, type AppConfig } from './config.js';
import { CmccClientPool } from './cmcc-client.js';
import { CmccUploader } from './cmcc-upload.js';
import { downloadRemoteMedia, inferMediaType, isCmccMediaUrl, MAX_MEDIA_BYTES, validateMedia, type StagedMediaFile } from './media.js';
import { Store } from './store.js';
import { chunkText, markdownToPlainText } from './text.js';
import type { CmccAccount, CredentialKind, GotifyRequest, MediaType, NativeSendRequest } from './types.js';

const sessionCookie = 'cmcc_admin_session';
const publicRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function payloadFor(body: NativeSendRequest, account?: CmccAccount): Omit<NativeSendRequest, 'apiKey'> {
  const { apiKey: _ignored, ...payload } = body;
  return { ...payload, type: 'send', to: body.to ?? account?.defaultTo };
}

function gotifyPayload(body: GotifyRequest, account?: CmccAccount): NativeSendRequest {
  const title = typeof body.title === 'string' ? body.title : '';
  const media = (body.extras as Record<string, any> | undefined)?.['cmcc-newmsg'];
  if (media?.mediaUrl || media?.mediaType) {
    const rawContent = typeof media.content === 'string' ? media.content : body.message;
    const content = title ? `${title}${rawContent ? `\n${rawContent}` : ''}` : rawContent;
    return {
      type: 'send', to: account?.defaultTo, content: content || undefined,
      mediaType: media.mediaType, mediaUrl: media.mediaUrl, thumbnailUrl: media.thumbnailUrl,
      mediaFileName: media.mediaFileName, mediaSize: media.mediaSize, mediaMimeType: media.mediaMimeType
    };
  }
  return { type: 'send', to: account?.defaultTo, content: title ? `${title}\n${body.message}` : body.message };
}

function gotifyResponse(body: GotifyRequest, messageId: string) {
  return { id: messageId, appid: 0, message: body.message, title: body.title ?? '', priority: Number.isInteger(body.priority) ? body.priority : 0, date: new Date().toISOString() };
}

type DispatchTarget = { credentialId?: number; upstreams: { id: number; name: string; apiKey: string }[] };
type Upstream = DispatchTarget['upstreams'][number];
type PoolLike = Pick<CmccClientPool, 'send' | 'verify' | 'close'>;
type UploaderLike = Pick<CmccUploader, 'upload'>;
type AppServices = { pool?: PoolLike; uploader?: UploaderLike };
type ManualPushBody = {
  title?: string;
  message?: string;
  upstreamIds?: number[];
  mediaType?: NativeSendRequest['mediaType'];
  mediaUrl?: string;
  thumbnailUrl?: string;
  mediaFileName?: string;
  mediaSize?: number;
  mediaMimeType?: string;
};
type StagedFile = { path: string; name: string; size: number; mimeType: string };

function outgoingPayloads(payload: Omit<NativeSendRequest, 'apiKey'>): Omit<NativeSendRequest, 'apiKey'>[] {
  const content = markdownToPlainText(payload.content ?? '');
  const chunks = chunkText(content);
  if (payload.mediaUrl) {
    const {
      content: _content,
      mediaType: _mediaType,
      mediaUrl: _mediaUrl,
      thumbnailUrl: _thumbnailUrl,
      mediaFileName: _mediaFileName,
      mediaSize: _mediaSize,
      mediaMimeType: _mediaMimeType,
      messageId: _messageId,
      timestamp: _timestamp,
      ...textPayload
    } = payload;
    return [
      ...chunks.map(chunk => ({ ...textPayload, type: 'send' as const, content: chunk })),
      { ...payload, content: undefined, timestamp: payload.timestamp ?? Date.now() }
    ];
  }
  return chunks.length > 0 ? chunks.map(chunk => ({ ...payload, content: chunk })) : [{ ...payload, content }];
}

function parseUpstreamIds(raw: unknown): number[] {
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number))];
}

async function readMultipartRequest(request: FastifyRequest): Promise<{ fields: Record<string, string>; file?: StagedFile }> {
  const fields: Record<string, string> = {};
  let file: StagedFile | undefined;
  let pendingPath: string | undefined;
  try {
    for await (const part of request.parts()) {
      if (part.type === 'field') {
        fields[part.fieldname] = String(part.value ?? '');
        continue;
      }
      if (file) throw new Error('only one media file is allowed');
      const filePath = path.join(os.tmpdir(), `cmcc-upload-${crypto.randomUUID()}`);
      pendingPath = filePath;
      const name = path.basename(part.filename || 'upload.bin').replace(/[\r\n"]/g, '_');
      await pipeline(part.file, createWriteStream(filePath, { flags: 'wx' }));
      if (part.file.truncated) throw new Error(`media file exceeds ${MAX_MEDIA_BYTES} bytes`);
      const info = await stat(filePath);
      file = { path: filePath, name, size: info.size, mimeType: part.mimetype };
      pendingPath = undefined;
    }
    return { fields, file };
  } catch (error) {
    if (file) await unlink(file.path).catch(() => undefined);
    if (pendingPath) await unlink(pendingPath).catch(() => undefined);
    throw error;
  }
}

async function readManualMultipart(request: FastifyRequest): Promise<{ body: ManualPushBody; file?: StagedFile }> {
  const { fields, file } = await readMultipartRequest(request);
  return {
    body: {
      title: fields.title,
      message: fields.message,
      upstreamIds: parseUpstreamIds(fields.upstreamIds),
      mediaType: fields.mediaType as NativeSendRequest['mediaType'] | undefined,
      mediaUrl: fields.mediaUrl,
      thumbnailUrl: fields.thumbnailUrl
    },
    file
  };
}

export async function createApp(config = loadConfig(), services: AppServices = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { redact: ['req.headers.authorization', 'req.query.token'] },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1024 * 1024
  });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (!text || text.trim() === '') {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  await app.register(cookie);
  await app.register(multipart, { limits: { files: 1, fields: 8, fileSize: MAX_MEDIA_BYTES } });
  await app.register(sensible);
  await app.register(fastifyStatic, { root: publicRoot, prefix: '/', index: ['index.html'] });

  const store = new Store(config.databasePath, config.encryptionKey, {
    loginFailLimit: config.adminLoginFailLimit,
    loginFailWindowMs: config.adminLoginFailWindowMs,
    loginBanDurationMs: config.adminLoginBanDurationMs
  });
  const pool = services.pool ?? new CmccClientPool(config.wsUrl, config.wsVersion, config.sendTimeoutMs);
  const uploader = services.uploader ?? new CmccUploader(config.uploadUrl, config.uploadTimeoutMs);
  app.addHook('onClose', async () => { pool.close(); store.close(); });

  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionId = request.cookies[sessionCookie];
    if (!sessionId || !store.hasSession(sessionId)) return reply.unauthorized('admin login required');
  };

  async function dispatch(
    source: CredentialKind | 'manual',
    target: DispatchTarget,
    body: NativeSendRequest,
    title: string | null,
    prepare?: (upstream: Upstream, payload: Omit<NativeSendRequest, 'apiKey'>) => Promise<Omit<NativeSendRequest, 'apiKey'>>
  ) {
    const basePayload = payloadFor(body);
    return Promise.all(target.upstreams.map(async upstream => {
      let payload = basePayload;
      const messageIds: string[] = [];
      try {
        if (prepare) payload = await prepare(upstream, basePayload);
        for (const outgoing of outgoingPayloads(payload)) {
          const messageId = await pool.send({ apiKey: upstream.apiKey }, outgoing);
          messageIds.push(messageId);
          store.addHistory({ source, credentialId: target.credentialId, upstreamId: upstream.id, status: 'success', title, content: outgoing.content ?? outgoing.mediaUrl ?? null, mediaType: outgoing.mediaType ?? null, messageId, error: null });
        }
        return { upstreamId: upstream.id, upstreamName: upstream.name, ok: true as const, messageId: messageIds[0], messageIds };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        store.addHistory({ source, credentialId: target.credentialId, upstreamId: upstream.id, status: 'failed', title, content: payload.content ?? payload.mediaUrl ?? null, mediaType: payload.mediaType ?? null, messageId: null, error: message });
        return { upstreamId: upstream.id, upstreamName: upstream.name, ok: false as const, error: message, messageIds };
      }
    }));
  }

  async function handleDispatchWithMedia(
    source: CredentialKind | 'manual',
    target: DispatchTarget,
    body: NativeSendRequest,
    title: string | null,
    localFile?: StagedFile
  ) {
    const basePayload = payloadFor(body);
    let tempRemoteFile: StagedMediaFile | undefined;

    try {
      let staged: StagedMediaFile | StagedFile | undefined = localFile;
      if (!staged && basePayload.mediaUrl && !isCmccMediaUrl(basePayload.mediaUrl, config.uploadUrl)) {
        staged = await downloadRemoteMedia(basePayload.mediaUrl, basePayload.mediaType, config.uploadTimeoutMs);
        tempRemoteFile = staged;
      }

      const prepare = staged
        ? async (upstream: Upstream, base: Omit<NativeSendRequest, 'apiKey'>) => ({
            ...base,
            mediaUrl: await uploader.upload(upstream.apiKey, staged!.path, staged!.name),
            mediaFileName: staged!.name,
            mediaSize: staged!.size,
            mediaMimeType: staged!.mimeType,
            timestamp: Date.now()
          })
        : undefined;

      return await dispatch(source, target, body, title, prepare);
    } finally {
      if (tempRemoteFile) {
        await unlink(tempRemoteFile.path).catch(() => undefined);
      }
      if (localFile) {
        await unlink(localFile.path).catch(() => undefined);
      }
    }
  }

  app.get('/healthz', async (request, reply) => {
    const sessionId = request.cookies[sessionCookie];
    if (sessionId && store.hasSession(sessionId)) {
      return { ok: true };
    }

    const authorization = request.headers.authorization;
    if (authorization?.startsWith('Bearer ')) {
      const secret = authorization.slice(7).trim();
      if (secret && (store.findCredential('webhook', secret) || store.findCredential('gotify', secret))) {
        return { ok: true };
      }
    }

    const gotifyKey = request.headers['x-gotify-key'];
    if (typeof gotifyKey === 'string' && gotifyKey.trim()) {
      if (store.findCredential('gotify', gotifyKey.trim())) {
        return { ok: true };
      }
    }

    const queryToken = (request.query as { token?: string } | undefined)?.token;
    if (typeof queryToken === 'string' && queryToken.trim()) {
      const token = queryToken.trim();
      if (store.findCredential('gotify', token) || store.findCredential('webhook', token)) {
        return { ok: true };
      }
    }

    return reply.code(404).send({ error: 'Not Found' });
  });

  app.post<{ Querystring: { token?: string }; Body: GotifyRequest }>('/message', async (request, reply) => {
    const token =
      request.query.token ||
      (typeof request.headers['x-gotify-key'] === 'string' ? request.headers['x-gotify-key'] : undefined) ||
      (request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7).trim() : undefined);
    const credential = token ? store.findCredential('gotify', token) : undefined;
    if (!credential || credential.upstreams.length === 0) return reply.unauthorized('invalid or unbound Gotify token');

    let body: GotifyRequest;
    let file: StagedFile | undefined;

    if (request.isMultipart()) {
      try {
        const parsed = await readMultipartRequest(request);
        file = parsed.file;
        const msg = parsed.fields.message || '';
        if (!msg && !file) {
          return reply.badRequest('message or file is required');
        }
        const inferredType = file ? inferMediaType(file.name, file.mimeType) : undefined;
        const mediaType = (parsed.fields.mediaType as MediaType) || inferredType;
        body = {
          title: parsed.fields.title,
          message: msg,
          priority: parsed.fields.priority ? Number(parsed.fields.priority) : undefined,
          extras: {
            'cmcc-newmsg': {
              mediaType,
              mediaUrl: parsed.fields.mediaUrl
            }
          }
        };
      } catch (err) {
        if (file) await unlink(file.path).catch(() => undefined);
        return reply.badRequest(err instanceof Error ? err.message : 'failed to parse multipart body');
      }
    } else {
      body = request.body;
      if (!body || typeof body.message !== 'string' || body.message.length === 0) return reply.badRequest('message is required');
    }

    const payload = gotifyPayload(body);
    const mediaError = validateMedia(payload);
    if (mediaError) {
      if (file) await unlink(file.path).catch(() => undefined);
      return reply.badRequest(mediaError);
    }

    let results: Awaited<ReturnType<typeof dispatch>>;
    try {
      results = await handleDispatchWithMedia('gotify', { credentialId: credential.id, upstreams: credential.upstreams }, payload, body.title ?? null, file);
    } catch (error) {
      if (file) await unlink(file.path).catch(() => undefined);
      return reply.badRequest(error instanceof Error ? error.message : 'failed to process media');
    }

    const success = results.filter(item => item.ok);
    if (success.length !== results.length) return reply.code(502).send({ error: 'one or more CMCC deliveries failed', results });
    return reply.send(gotifyResponse(body, success[0].messageId));
  });

  app.post<{ Body: NativeSendRequest }>('/webhook', async (request, reply) => {
    const authorization = request.headers.authorization;
    const secret = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    const credential = secret ? store.findCredential('webhook', secret) : undefined;
    if (!credential || credential.upstreams.length === 0) return reply.unauthorized('invalid or unbound webhook secret');

    let payload: NativeSendRequest;
    let file: StagedFile | undefined;

    if (request.isMultipart()) {
      try {
        const parsed = await readMultipartRequest(request);
        file = parsed.file;
        const rawContent = parsed.fields.content || parsed.fields.message || '';
        const mediaUrl = parsed.fields.mediaUrl;
        if (!rawContent && !file && !mediaUrl) {
          return reply.badRequest('content, file or mediaUrl is required');
        }
        const inferredType = file ? inferMediaType(file.name, file.mimeType) : undefined;
        const mediaType = (parsed.fields.mediaType as MediaType) || inferredType;
        payload = {
          type: 'send',
          content: rawContent || undefined,
          mediaType,
          mediaUrl,
          thumbnailUrl: parsed.fields.thumbnailUrl,
          mediaFileName: file?.name,
          mediaSize: file?.size,
          mediaMimeType: file?.mimeType
        };
      } catch (err) {
        if (file) await unlink(file.path).catch(() => undefined);
        return reply.badRequest(err instanceof Error ? err.message : 'failed to parse multipart body');
      }
    } else {
      const body = request.body;
      if (!body || body.type !== 'send') return reply.badRequest('type must be send');
      payload = payloadFor(body);
    }

    const mediaError = validateMedia(payload);
    if (mediaError) {
      if (file) await unlink(file.path).catch(() => undefined);
      return reply.badRequest(mediaError);
    }

    let results: Awaited<ReturnType<typeof dispatch>>;
    try {
      results = await handleDispatchWithMedia('webhook', { credentialId: credential.id, upstreams: credential.upstreams }, payload, null, file);
    } catch (error) {
      if (file) await unlink(file.path).catch(() => undefined);
      return reply.badRequest(error instanceof Error ? error.message : 'failed to process media');
    }

    if (results.some(item => !item.ok)) return reply.code(502).send({ ok: false, results });
    return reply.send({ ok: true, messageIds: results.flatMap(item => item.messageIds), results });
  });

  app.post<{ Body: { username?: string; password?: string } }>('/admin/api/login', async (request, reply) => {
    const ip = request.ip;
    const allowed = store.loginAllowed(ip);
    if (!allowed.allowed) return reply.code(429).header('Retry-After', String(allowed.retryAfter)).send({ error: 'too many login failures', retryAfter: allowed.retryAfter });
    const body = request.body ?? {};
    if (!safeEqual(body.username ?? '', config.adminUsername) || !safeEqual(body.password ?? '', config.adminPassword)) {
      store.recordLoginFailure(ip);
      return reply.unauthorized('invalid username or password');
    }
    store.clearLoginFailures(ip);
    const sessionId = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + 8 * 60 * 60_000);
    store.createSession(sessionId, expires);
    reply.setCookie(sessionCookie, sessionId, { httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, path: '/', expires });
    return { ok: true, username: config.adminUsername };
  });

  app.post('/admin/api/logout', { preHandler: requireAdmin }, async (request, reply) => {
    const sessionId = request.cookies[sessionCookie];
    if (sessionId) store.deleteSession(sessionId);
    reply.clearCookie(sessionCookie, { path: '/' });
    return { ok: true };
  });
  app.get('/admin/api/me', { preHandler: requireAdmin }, async () => ({ username: config.adminUsername }));

  app.get('/admin/api/settings', { preHandler: requireAdmin }, async () => {
    return {
      adminUsername: config.adminUsername,
      adminLoginFailLimit: config.adminLoginFailLimit,
      adminLoginFailWindowMin: config.adminLoginFailWindowMin,
      adminLoginBanDurationMin: config.adminLoginBanDurationMin,
      adminLoginFailWindowMs: config.adminLoginFailWindowMs,
      adminLoginBanDurationMs: config.adminLoginBanDurationMs,
      wsUrl: config.wsUrl,
      wsVersion: config.wsVersion,
      sendTimeoutMs: config.sendTimeoutMs,
      uploadUrl: config.uploadUrl,
      uploadTimeoutMs: config.uploadTimeoutMs
    };
  });

  app.post<{
    Body: {
      adminUsername?: string;
      adminPassword?: string;
      adminLoginFailLimit?: number;
      adminLoginFailWindowMin?: number;
      adminLoginFailWindowMs?: number;
      adminLoginBanDurationMin?: number;
      adminLoginBanDurationMs?: number;
      wsUrl?: string;
      wsVersion?: string;
      sendTimeoutMs?: number;
      uploadUrl?: string;
      uploadTimeoutMs?: number;
    };
  }>('/admin/api/settings', { preHandler: requireAdmin }, async (request, reply) => {
    const body = request.body ?? {};

    if (body.adminUsername !== undefined) {
      if (typeof body.adminUsername !== 'string' || body.adminUsername.trim().length === 0) {
        return reply.badRequest('adminUsername cannot be empty');
      }
    }
    if (body.adminPassword !== undefined) {
      if (typeof body.adminPassword !== 'string' || body.adminPassword.trim().length === 0) {
        return reply.badRequest('adminPassword cannot be empty');
      }
    }
    if (body.adminLoginFailLimit !== undefined) {
      if (!Number.isInteger(body.adminLoginFailLimit) || body.adminLoginFailLimit < 1) {
        return reply.badRequest('ADMIN_LOGIN_FAIL_LIMIT must be a positive integer');
      }
    }
    if (body.adminLoginFailWindowMin !== undefined) {
      if (!Number.isInteger(body.adminLoginFailWindowMin) || body.adminLoginFailWindowMin < 1) {
        return reply.badRequest('ADMIN_LOGIN_FAIL_WINDOW_MIN must be a positive integer (minutes)');
      }
    } else if (body.adminLoginFailWindowMs !== undefined) {
      if (!Number.isInteger(body.adminLoginFailWindowMs) || body.adminLoginFailWindowMs < 1000) {
        return reply.badRequest('ADMIN_LOGIN_FAIL_WINDOW_MS must be at least 1000');
      }
    }
    if (body.adminLoginBanDurationMin !== undefined) {
      if (!Number.isInteger(body.adminLoginBanDurationMin) || body.adminLoginBanDurationMin < 1) {
        return reply.badRequest('ADMIN_LOGIN_BAN_DURATION_MIN must be a positive integer (minutes)');
      }
    } else if (body.adminLoginBanDurationMs !== undefined) {
      if (!Number.isInteger(body.adminLoginBanDurationMs) || body.adminLoginBanDurationMs < 1000) {
        return reply.badRequest('ADMIN_LOGIN_BAN_DURATION_MS must be at least 1000');
      }
    }
    if (body.wsUrl !== undefined) {
      if (!z.string().url().safeParse(body.wsUrl).success || !/^wss?:\/\//.test(body.wsUrl)) {
        return reply.badRequest('CMCC_WS_URL must be a ws or wss URL');
      }
    }
    if (body.wsVersion !== undefined) {
      if (typeof body.wsVersion !== 'string' || body.wsVersion.trim().length === 0) {
        return reply.badRequest('CMCC_WS_VERSION is required');
      }
    }
    if (body.sendTimeoutMs !== undefined) {
      if (!Number.isInteger(body.sendTimeoutMs) || body.sendTimeoutMs < 1000 || body.sendTimeoutMs > 120000) {
        return reply.badRequest('CMCC_SEND_TIMEOUT_MS must be 1000-120000');
      }
    }
    if (body.uploadUrl !== undefined) {
      if (!z.string().url().safeParse(body.uploadUrl).success || !/^https?:\/\//.test(body.uploadUrl)) {
        return reply.badRequest('CMCC_UPLOAD_URL must be an http or https URL');
      }
    }
    if (body.uploadTimeoutMs !== undefined) {
      if (!Number.isInteger(body.uploadTimeoutMs) || body.uploadTimeoutMs < 1000 || body.uploadTimeoutMs > 600000) {
        return reply.badRequest('CMCC_UPLOAD_TIMEOUT_MS must be 1000-600000');
      }
    }

    const envUpdates: Record<string, string | number> = {};

    if (body.adminUsername !== undefined) {
      config.adminUsername = body.adminUsername.trim();
      envUpdates.ADMIN_USERNAME = config.adminUsername;
    }
    if (body.adminPassword !== undefined) {
      config.adminPassword = body.adminPassword;
      envUpdates.ADMIN_PASSWORD = config.adminPassword;
    }
    if (body.adminLoginFailLimit !== undefined) {
      config.adminLoginFailLimit = body.adminLoginFailLimit;
      envUpdates.ADMIN_LOGIN_FAIL_LIMIT = body.adminLoginFailLimit;
    }
    if (body.adminLoginFailWindowMin !== undefined) {
      config.adminLoginFailWindowMin = body.adminLoginFailWindowMin;
      config.adminLoginFailWindowMs = body.adminLoginFailWindowMin * 60_000;
      envUpdates.ADMIN_LOGIN_FAIL_WINDOW_MIN = body.adminLoginFailWindowMin;
    } else if (body.adminLoginFailWindowMs !== undefined) {
      config.adminLoginFailWindowMs = body.adminLoginFailWindowMs;
      config.adminLoginFailWindowMin = Math.round(body.adminLoginFailWindowMs / 60_000);
      envUpdates.ADMIN_LOGIN_FAIL_WINDOW_MIN = config.adminLoginFailWindowMin;
    }
    if (body.adminLoginBanDurationMin !== undefined) {
      config.adminLoginBanDurationMin = body.adminLoginBanDurationMin;
      config.adminLoginBanDurationMs = body.adminLoginBanDurationMin * 60_000;
      envUpdates.ADMIN_LOGIN_BAN_DURATION_MIN = body.adminLoginBanDurationMin;
    } else if (body.adminLoginBanDurationMs !== undefined) {
      config.adminLoginBanDurationMs = body.adminLoginBanDurationMs;
      config.adminLoginBanDurationMin = Math.round(body.adminLoginBanDurationMs / 60_000);
      envUpdates.ADMIN_LOGIN_BAN_DURATION_MIN = config.adminLoginBanDurationMin;
    }
    if (body.wsUrl !== undefined) {
      config.wsUrl = body.wsUrl;
      envUpdates.CMCC_WS_URL = body.wsUrl;
    }
    if (body.wsVersion !== undefined) {
      config.wsVersion = body.wsVersion;
      envUpdates.CMCC_WS_VERSION = body.wsVersion;
    }
    if (body.sendTimeoutMs !== undefined) {
      config.sendTimeoutMs = body.sendTimeoutMs;
      envUpdates.CMCC_SEND_TIMEOUT_MS = body.sendTimeoutMs;
    }
    if (body.uploadUrl !== undefined) {
      config.uploadUrl = body.uploadUrl;
      envUpdates.CMCC_UPLOAD_URL = body.uploadUrl;
    }
    if (body.uploadTimeoutMs !== undefined) {
      config.uploadTimeoutMs = body.uploadTimeoutMs;
      envUpdates.CMCC_UPLOAD_TIMEOUT_MS = body.uploadTimeoutMs;
    }

    store.updateBruteForceOptions({
      loginFailLimit: config.adminLoginFailLimit,
      loginFailWindowMs: config.adminLoginFailWindowMs,
      loginBanDurationMs: config.adminLoginBanDurationMs
    });

    updateEnvFile(envUpdates);

    return { ok: true };
  });

  app.get('/admin/api/upstreams', { preHandler: requireAdmin }, async () => store.listUpstreams());
  app.post<{ Body: { name?: string; apiKey?: string } }>('/admin/api/upstreams', { preHandler: requireAdmin }, async (request, reply) => {
    const name = request.body?.name?.trim();
    const apiKey = request.body?.apiKey?.trim();
    if (!name || !apiKey) return reply.badRequest('name and apiKey are required');
    try {
      await pool.verify(apiKey);
      return reply.code(201).send(store.addUpstream(name, apiKey));
    } catch {
      request.log.warn({ name, apiKey: maskSecret(apiKey) }, 'upstream verification failed');
      return reply.badRequest('upstream API Key verification failed');
    }
  });
  app.delete<{ Params: { id: string } }>('/admin/api/upstreams/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.badRequest('invalid upstream id');
    if (!store.deleteUpstream(id)) return reply.notFound('upstream not found');
    return reply.code(204).send();
  });

  app.get('/admin/api/credentials', { preHandler: requireAdmin }, async () => store.listCredentials());
  app.post<{ Body: { name?: string; kind?: CredentialKind; secret?: string; upstreamIds?: number[] } }>('/admin/api/credentials', { preHandler: requireAdmin }, async (request, reply) => {
    const name = request.body?.name?.trim();
    const kind = request.body?.kind;
    const secret = request.body?.secret?.trim() || crypto.randomBytes(24).toString('base64url');
    const upstreamIds = [...new Set(request.body?.upstreamIds ?? [])];
    if (!name || (kind !== 'gotify' && kind !== 'webhook') || upstreamIds.length === 0 || upstreamIds.some(id => !Number.isInteger(id))) return reply.badRequest('name, kind, and one or more upstreamIds are required');
    if (upstreamIds.some(id => !store.getUpstream(id))) return reply.badRequest('one or more upstreams do not exist');
    try {
      const credential = store.createCredential(name, kind, secret, upstreamIds);
      return reply.code(201).send({ ...credential, secret });
    } catch {
      return reply.badRequest('credential name or secret already exists');
    }
  });
  app.delete<{ Params: { id: string } }>('/admin/api/credentials/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.badRequest('invalid credential id');
    if (!store.deleteCredential(id)) return reply.notFound('credential not found');
    return reply.code(204).send();
  });

  app.post<{ Body: ManualPushBody }>('/admin/api/push', { preHandler: requireAdmin, bodyLimit: MAX_MEDIA_BYTES + 1024 * 1024 }, async (request, reply) => {
    let input: { body: ManualPushBody; file?: StagedFile };
    try {
      input = request.isMultipart() ? await readManualMultipart(request) : { body: request.body ?? {} };
    } catch (error) {
      return reply.badRequest(error instanceof Error ? error.message : 'invalid multipart request');
    }

    const title = input.body.title?.trim() ?? '';
    const message = input.body.message?.trim() ?? '';
    const upstreamIds = [...new Set(input.body.upstreamIds ?? [])];
    const mediaUrl = input.body.mediaUrl?.trim();
    const hasMedia = Boolean(input.file || mediaUrl);
    if ((!message && !hasMedia) || upstreamIds.length === 0 || upstreamIds.some(id => !Number.isInteger(id))) {
      if (input.file) await unlink(input.file.path).catch(() => undefined);
      return reply.badRequest('message or media and one or more upstreamIds are required');
    }
    if (input.file && mediaUrl) {
      await unlink(input.file.path).catch(() => undefined);
      return reply.badRequest('provide either an uploaded file or mediaUrl, not both');
    }

    const upstreams = upstreamIds.map(id => store.getUpstream(id));
    if (upstreams.some(item => !item)) {
      if (input.file) await unlink(input.file.path).catch(() => undefined);
      return reply.badRequest('one or more upstreams do not exist');
    }

    const content = title ? `${title}${message ? `\n${message}` : ''}` : message;
    const mediaType = input.body.mediaType ?? (input.file ? inferMediaType(input.file.name, input.file.mimeType) : undefined);
    const payload: NativeSendRequest = {
      type: 'send',
      content: content || undefined,
      mediaType,
      mediaUrl,
      thumbnailUrl: input.body.thumbnailUrl,
      mediaFileName: input.file?.name ?? input.body.mediaFileName,
      mediaSize: input.file?.size ?? input.body.mediaSize,
      mediaMimeType: input.file?.mimeType ?? input.body.mediaMimeType
    };
    const mediaError = validateMedia(payload);
    if (mediaError || (hasMedia && !mediaType)) {
      if (input.file) await unlink(input.file.path).catch(() => undefined);
      return reply.badRequest(mediaError ?? 'mediaType is required');
    }

    try {
      const results = await handleDispatchWithMedia(
        'manual',
        { upstreams: upstreams as Upstream[] },
        payload,
        title || null,
        input.file
      );
      if (results.some(item => !item.ok)) return reply.code(502).send({ ok: false, results });
      return reply.send({ ok: true, messageIds: results.flatMap(item => item.messageIds), results });
    } catch (error) {
      return reply.badRequest(error instanceof Error ? error.message : 'failed to deliver media message');
    } finally {
      if (input.file) await unlink(input.file.path).catch(() => undefined);
    }
  });

  app.get<{ Querystring: { limit?: string } }>('/admin/api/history', { preHandler: requireAdmin }, async request => {
    const requested = Number(request.query.limit ?? 100);
    return store.listHistory(Number.isInteger(requested) ? Math.max(1, Math.min(requested, 500)) : 100);
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const app = await createApp(config);
  const shutdown = async () => { await app.close(); process.exit(0); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  await app.listen({ host: config.host, port: config.port });
}
