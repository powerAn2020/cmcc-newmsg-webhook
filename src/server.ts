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
import { loadConfig, maskSecret, type AppConfig } from './config.js';
import { CmccClientPool } from './cmcc-client.js';
import { CmccUploader } from './cmcc-upload.js';
import { inferMediaType, MAX_MEDIA_BYTES, validateMedia } from './media.js';
import { Store } from './store.js';
import { chunkText, markdownToPlainText } from './text.js';
import type { CmccAccount, CredentialKind, GotifyRequest, NativeSendRequest } from './types.js';

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
  if (media?.mediaUrl) {
    return {
      type: 'send', to: account?.defaultTo, content: typeof media.content === 'string' ? media.content : body.message,
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

async function readManualMultipart(request: FastifyRequest): Promise<{ body: ManualPushBody; file?: StagedFile }> {
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
    return {
      body: {
        title: fields.title,
        message: fields.message,
        upstreamIds: parseUpstreamIds(fields.upstreamIds),
        mediaType: fields.mediaType as NativeSendRequest['mediaType'] | undefined
      },
      file
    };
  } catch (error) {
    if (file) await unlink(file.path).catch(() => undefined);
    if (pendingPath) await unlink(pendingPath).catch(() => undefined);
    throw error;
  }
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

  const store = new Store(config.databasePath, config.encryptionKey);
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
          store.addHistory({ source, credentialId: target.credentialId, upstreamId: upstream.id, status: 'success', title, content: outgoing.content ?? null, mediaType: outgoing.mediaType ?? null, messageId, error: null });
        }
        return { upstreamId: upstream.id, upstreamName: upstream.name, ok: true as const, messageId: messageIds[0], messageIds };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        store.addHistory({ source, credentialId: target.credentialId, upstreamId: upstream.id, status: 'failed', title, content: payload.content ?? null, mediaType: payload.mediaType ?? null, messageId: null, error: message });
        return { upstreamId: upstream.id, upstreamName: upstream.name, ok: false as const, error: message, messageIds };
      }
    }));
  }

  app.get('/healthz', async () => ({ ok: true }));

  app.post<{ Querystring: { token?: string }; Body: GotifyRequest }>('/message', async (request, reply) => {
    const token = request.query.token;
    const credential = token ? store.findCredential('gotify', token) : undefined;
    if (!credential || credential.upstreams.length === 0) return reply.unauthorized('invalid or unbound Gotify token');
    const body = request.body;
    if (!body || typeof body.message !== 'string' || body.message.length === 0) return reply.badRequest('message is required');
    const payload = gotifyPayload(body);
    const mediaError = validateMedia(payload);
    if (mediaError) return reply.badRequest(mediaError);
    const results = await dispatch('gotify', { credentialId: credential.id, upstreams: credential.upstreams }, payload, body.title ?? null);
    const success = results.filter(item => item.ok);
    if (success.length !== results.length) return reply.code(502).send({ error: 'one or more CMCC deliveries failed', results });
    return reply.send(gotifyResponse(body, success[0].messageId));
  });

  app.post<{ Body: NativeSendRequest }>('/webhook', async (request, reply) => {
    const authorization = request.headers.authorization;
    const secret = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    const credential = secret ? store.findCredential('webhook', secret) : undefined;
    if (!credential || credential.upstreams.length === 0) return reply.unauthorized('invalid or unbound webhook secret');
    const body = request.body;
    if (!body || body.type !== 'send') return reply.badRequest('type must be send');
    const payload = payloadFor(body);
    const mediaError = validateMedia(payload);
    if (mediaError) return reply.badRequest(mediaError);
    const results = await dispatch('webhook', { credentialId: credential.id, upstreams: credential.upstreams }, payload, null);
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
      const results = await dispatch(
        'manual',
        { upstreams: upstreams as Upstream[] },
        payload,
        title || null,
        input.file
          ? async (upstream, base) => ({ ...base, mediaUrl: await uploader.upload(upstream.apiKey, input.file!.path, input.file!.name), timestamp: Date.now() })
          : undefined
      );
      if (results.some(item => !item.ok)) return reply.code(502).send({ ok: false, results });
      return reply.send({ ok: true, messageIds: results.flatMap(item => item.messageIds), results });
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
