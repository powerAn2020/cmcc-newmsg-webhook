import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import sensible from '@fastify/sensible';
import fastifyStatic from '@fastify/static';
import { loadConfig, maskSecret, type AppConfig } from './config.js';
import { CmccClientPool } from './cmcc-client.js';
import { validateMedia } from './media.js';
import { Store } from './store.js';
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

export async function createApp(config = loadConfig()): Promise<FastifyInstance> {
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
  await app.register(sensible);
  await app.register(fastifyStatic, { root: publicRoot, prefix: '/', index: ['index.html'] });

  const store = new Store(config.databasePath, config.encryptionKey);
  const pool = new CmccClientPool(config.wsUrl, config.wsVersion, config.sendTimeoutMs);
  app.addHook('onClose', async () => { pool.close(); store.close(); });

  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionId = request.cookies[sessionCookie];
    if (!sessionId || !store.hasSession(sessionId)) return reply.unauthorized('admin login required');
  };

  async function dispatch(source: CredentialKind | 'manual', target: DispatchTarget, body: NativeSendRequest, title: string | null) {
    const payload = payloadFor(body);
    return Promise.all(target.upstreams.map(async upstream => {
      try {
        const messageId = await pool.send({ apiKey: upstream.apiKey }, payload);
        store.addHistory({ source, credentialId: target.credentialId, upstreamId: upstream.id, status: 'success', title, content: payload.content ?? null, mediaType: payload.mediaType ?? null, messageId, error: null });
        return { upstreamId: upstream.id, upstreamName: upstream.name, ok: true as const, messageId };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        store.addHistory({ source, credentialId: target.credentialId, upstreamId: upstream.id, status: 'failed', title, content: payload.content ?? null, mediaType: payload.mediaType ?? null, messageId: null, error: message });
        return { upstreamId: upstream.id, upstreamName: upstream.name, ok: false as const, error: message };
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
    return reply.send({ ok: true, messageIds: results.map(item => item.messageId), results });
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

  app.post<{ Body: { title?: string; message?: string; upstreamIds?: number[] } }>('/admin/api/push', { preHandler: requireAdmin }, async (request, reply) => {
    const title = request.body?.title?.trim() ?? '';
    const message = request.body?.message?.trim();
    const upstreamIds = [...new Set(request.body?.upstreamIds ?? [])];
    if (!message || upstreamIds.length === 0 || upstreamIds.some(id => !Number.isInteger(id))) return reply.badRequest('message and one or more upstreamIds are required');
    const upstreams = upstreamIds.map(id => store.getUpstream(id));
    if (upstreams.some(item => !item)) return reply.badRequest('one or more upstreams do not exist');
    const payload: NativeSendRequest = { type: 'send', content: title ? `${title}\n${message}` : message };
    const results = await dispatch('manual', { upstreams: upstreams as { id: number; name: string; apiKey: string }[] }, payload, title || null);
    if (results.some(item => !item.ok)) return reply.code(502).send({ ok: false, results });
    return reply.send({ ok: true, messageIds: results.map(item => item.messageId), results });
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
