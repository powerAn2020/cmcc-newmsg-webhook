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
import { Store, type IStore } from './store.js';
import { chunkText, markdownToPlainText } from './text.js';
import type { CmccAccount, CredentialKind, GotifyRequest, MediaType, NativeSendRequest } from './types.js';
import { AccessLogger, maskSecretKey } from './logger.js';
import { createCacheService, type ICacheService } from './cache.js';
import { MessageRateLimiter } from './rate-limiter.js';

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

function gotifyPayload(body: GotifyRequest & { to?: string; phone?: string }, account?: CmccAccount): NativeSendRequest {
  const title = typeof body.title === 'string' ? body.title : '';
  const media = (body.extras as Record<string, any> | undefined)?.['cmcc-newmsg'];
  const targetTo = body.to || body.phone || media?.to || media?.phone || account?.defaultTo;
  if (media?.mediaUrl || media?.mediaType) {
    const rawContent = typeof media.content === 'string' ? media.content : body.message;
    const content = title ? `${title}${rawContent ? `\n${rawContent}` : ''}` : rawContent;
    return {
      type: 'send', to: targetTo, content: content || undefined,
      mediaType: media.mediaType, mediaUrl: media.mediaUrl, thumbnailUrl: media.thumbnailUrl,
      mediaFileName: media.mediaFileName, mediaSize: media.mediaSize, mediaMimeType: media.mediaMimeType
    };
  }
  return { type: 'send', to: targetTo, content: title ? `${title}\n${body.message}` : body.message };
}

function gotifyResponse(body: GotifyRequest, messageId: string) {
  return { id: messageId, appid: 0, message: body.message, title: body.title ?? '', priority: Number.isInteger(body.priority) ? body.priority : 0, date: new Date().toISOString() };
}

type DispatchTarget = { credentialId?: number; upstreams: { id: number; name: string; apiKey: string }[] };
type Upstream = DispatchTarget['upstreams'][number];
type PoolLike = Pick<CmccClientPool, 'send' | 'verify' | 'close'>;
type UploaderLike = Pick<CmccUploader, 'upload'>;
type AppServices = {
  pool?: PoolLike;
  uploader?: UploaderLike;
  accessLogger?: AccessLogger;
  cache?: ICacheService;
  rateLimiter?: MessageRateLimiter;
  store?: IStore;
};
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

  const store = services.store ?? new Store(config.databasePath, config.encryptionKey, {
    loginFailLimit: config.adminLoginFailLimit,
    loginFailWindowMs: config.adminLoginFailWindowMs,
    loginBanDurationMs: config.adminLoginBanDurationMs
  });
  if (!store.getSetting('accessLogFormat')) store.setSetting('accessLogFormat', config.accessLogFormat);
  if (!store.getSetting('accessLogRetentionDays')) store.setSetting('accessLogRetentionDays', String(config.accessLogRetentionDays));
  if (!store.getSetting('notifyOnLogin')) store.setSetting('notifyOnLogin', String(config.notifyOnLogin));
  if (!store.getSetting('notifyOnLoginFailed')) store.setSetting('notifyOnLoginFailed', String(config.notifyOnLoginFailed));
  if (!store.getSetting('notifyOnAuthFailed')) store.setSetting('notifyOnAuthFailed', String(config.notifyOnAuthFailed));
  if (!store.getSetting('notifyUpstreamId')) store.setSetting('notifyUpstreamId', String(config.notifyUpstreamId));
  if (!store.getSetting('notifyLoginFailThreshold')) store.setSetting('notifyLoginFailThreshold', String(config.notifyLoginFailThreshold));
  if (!store.getSetting('notifyAuthFailThreshold')) store.setSetting('notifyAuthFailThreshold', String(config.notifyAuthFailThreshold));
  if (!store.getSetting('notifyAuthFailWindowMin')) store.setSetting('notifyAuthFailWindowMin', String(config.notifyAuthFailWindowMin));
  if (!store.getSetting('rateLimitPhoneMinIntervalSec')) store.setSetting('rateLimitPhoneMinIntervalSec', String(config.rateLimitPhoneMinIntervalSec));
  if (!store.getSetting('rateLimitPhoneHourMax')) store.setSetting('rateLimitPhoneHourMax', String(config.rateLimitPhoneHourMax));
  if (!store.getSetting('rateLimitPhoneDayMax')) store.setSetting('rateLimitPhoneDayMax', String(config.rateLimitPhoneDayMax));
  if (!store.getSetting('rateLimitIpMinMax')) store.setSetting('rateLimitIpMinMax', String(config.rateLimitIpMinMax));
  if (!store.getSetting('rateLimitDuplicateWindowSec')) store.setSetting('rateLimitDuplicateWindowSec', String(config.rateLimitDuplicateWindowSec));
  if (!store.getSetting('notifyOnRateLimit')) store.setSetting('notifyOnRateLimit', String(config.notifyOnRateLimit));
  const cache = services.cache ?? createCacheService();
  const rateLimiter = services.rateLimiter ?? new MessageRateLimiter(cache);
  const pool = services.pool ?? new CmccClientPool(config.wsUrl, config.wsVersion, config.sendTimeoutMs);
  const uploader = services.uploader ?? new CmccUploader(config.uploadUrl, config.uploadTimeoutMs);
  const securitySettings = store.getSecuritySettings();
  const accessLogger = services.accessLogger ?? new AccessLogger(config.accessLogPath, securitySettings.accessLogFormat);
  accessLogger.startCleanupTimer(securitySettings.accessLogRetentionDays);
  app.addHook('onClose', async () => {
    pool.close();
    store.close();
    await accessLogger.close();
    await cache.close();
  });

  const authFailTracker = new Map<string, { count: number; firstAt: number; lastAlertAt: number }>();

  async function sendSecurityAlert(
    type: 'login' | 'login_failed' | 'auth_failed' | 'rate_limit',
    title: string,
    content: string,
    ip: string
  ) {
    try {
      const settings = store.getSecuritySettings();
      if (type === 'login' && !settings.notifyOnLogin) return;
      if (type === 'login_failed' && !settings.notifyOnLoginFailed) return;
      if (type === 'auth_failed' && !settings.notifyOnAuthFailed) return;
      if (type === 'rate_limit' && !settings.notifyOnRateLimit) return;

      let targets: { id: number; apiKey: string }[] = [];
      if (settings.notifyUpstreamId > 0) {
        const up = store.getUpstream(settings.notifyUpstreamId);
        if (up) targets = [up];
      } else {
        const all = store.listUpstreams();
        targets = all
          .map(item => store.getUpstream(item.id))
          .filter(Boolean) as { id: number; apiKey: string }[];
      }

      if (targets.length === 0) return;

      const fullContent = `${title}\n${content}`;
      for (const upstream of targets) {
        pool.send({ apiKey: upstream.apiKey }, {
          type: 'send',
          content: fullContent,
          timestamp: Date.now()
        }).then(messageId => {
          store.addHistory({
            source: 'system',
            upstreamId: upstream.id,
            status: 'success',
            title,
            content: fullContent,
            mediaType: null,
            messageId,
            error: null
          });
        }).catch(err => {
          store.addHistory({
            source: 'system',
            upstreamId: upstream.id,
            status: 'failed',
            title,
            content: fullContent,
            mediaType: null,
            messageId: null,
            error: err instanceof Error ? err.message : String(err)
          });
        });
      }
    } catch (err) {
      console.error('sendSecurityAlert error:', err);
    }
  }

  app.addHook('onResponse', async (request, reply) => {
    const audit = (request as any).audit as {
      authType?: string;
      credentialName?: string;
      maskedSecret?: string;
      upstreams?: string[];
      error?: string;
    } | undefined;

    accessLogger.log({
      ip: request.ip,
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      durationMs: reply.elapsedTime,
      authType: audit?.authType,
      credentialName: audit?.credentialName,
      maskedSecret: audit?.maskedSecret,
      upstreams: audit?.upstreams,
      error: audit?.error
    });

    if (reply.statusCode === 401 && audit?.authType?.startsWith('invalid_')) {
      const settings = store.getSecuritySettings();
      if (settings.notifyOnAuthFailed) {
        const windowMs = settings.notifyAuthFailWindowMin * 60_000;
        const nowMs = Date.now();
        let tracker = authFailTracker.get(request.ip);
        if (!tracker || nowMs - tracker.firstAt > windowMs) {
          tracker = { count: 1, firstAt: nowMs, lastAlertAt: 0 };
        } else {
          tracker.count += 1;
        }
        authFailTracker.set(request.ip, tracker);

        if (tracker.count >= settings.notifyAuthFailThreshold && (tracker.lastAlertAt === 0 || nowMs - tracker.lastAlertAt >= windowMs)) {
          tracker.lastAlertAt = nowMs;
          sendSecurityAlert(
            'auth_failed',
            '【安全预警】未授权接口访问拦截',
            `请求端点: ${request.method} ${request.url}\n来源 IP: ${request.ip}\n统计周期: ${settings.notifyAuthFailWindowMin} 分钟内累计拦截 ${tracker.count} 次（阈值: ${settings.notifyAuthFailThreshold} 次）\n拦截原因: ${audit.authType}\n凭据脱敏: ${audit.maskedSecret || '未提供'}`,
            request.ip
          );
        }
      }
    }
  });

  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionId = request.cookies[sessionCookie];
    if (!sessionId || !store.hasSession(sessionId)) {
      (request as any).audit = { authType: 'invalid_admin_session' };
      return reply.unauthorized('admin login required');
    }
    (request as any).audit = { authType: 'admin_session', credentialName: config.adminUsername };
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
      (request as any).audit = { authType: 'admin_session', credentialName: config.adminUsername };
      return { ok: true };
    }

    const authorization = request.headers.authorization;
    if (authorization?.startsWith('Bearer ')) {
      const secret = authorization.slice(7).trim();
      const webhookCred = secret ? store.findCredential('webhook', secret) : undefined;
      const gotifyCred = !webhookCred && secret ? store.findCredential('gotify', secret) : undefined;
      if (webhookCred) {
        (request as any).audit = { authType: 'webhook', credentialName: webhookCred.name, maskedSecret: maskSecretKey(secret) };
        return { ok: true };
      }
      if (gotifyCred) {
        (request as any).audit = { authType: 'gotify', credentialName: gotifyCred.name, maskedSecret: maskSecretKey(secret) };
        return { ok: true };
      }
    }

    const gotifyKey = request.headers['x-gotify-key'];
    if (typeof gotifyKey === 'string' && gotifyKey.trim()) {
      const cred = store.findCredential('gotify', gotifyKey.trim());
      if (cred) {
        (request as any).audit = { authType: 'gotify', credentialName: cred.name, maskedSecret: maskSecretKey(gotifyKey) };
        return { ok: true };
      }
    }

    const queryToken = (request.query as { token?: string } | undefined)?.token;
    if (typeof queryToken === 'string' && queryToken.trim()) {
      const token = queryToken.trim();
      const gotifyCred = store.findCredential('gotify', token);
      const webhookCred = !gotifyCred ? store.findCredential('webhook', token) : undefined;
      if (gotifyCred) {
        (request as any).audit = { authType: 'gotify', credentialName: gotifyCred.name, maskedSecret: maskSecretKey(token) };
        return { ok: true };
      }
      if (webhookCred) {
        (request as any).audit = { authType: 'webhook', credentialName: webhookCred.name, maskedSecret: maskSecretKey(token) };
        return { ok: true };
      }
    }

    const triedKey = queryToken || (typeof gotifyKey === 'string' ? gotifyKey : undefined) || (authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : undefined);
    (request as any).audit = { authType: triedKey ? 'invalid_credential' : 'none', maskedSecret: triedKey ? maskSecretKey(triedKey) : undefined };
    return reply.code(404).send({ error: 'Not Found' });
  });

  app.post<{ Querystring: { token?: string }; Body: GotifyRequest }>('/message', async (request, reply) => {
    const ip = request.ip;
    const allowed = store.loginAllowed(ip);
    if (!allowed.allowed) {
      return reply.code(429).header('Retry-After', String(allowed.retryAfter)).send({
        error: 'IP is temporarily blocked due to too many failed attempts',
        retryAfter: allowed.retryAfter
      });
    }

    const token =
      request.query.token ||
      (typeof request.headers['x-gotify-key'] === 'string' ? request.headers['x-gotify-key'] : undefined) ||
      (request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7).trim() : undefined);
    const credential = token ? store.findCredential('gotify', token) : undefined;
    if (!credential || credential.upstreams.length === 0) {
      const failResult = store.recordLoginFailure(ip);
      (request as any).audit = { authType: 'invalid_gotify_token', maskedSecret: token ? maskSecretKey(token) : undefined };
      if (failResult.locked) {
        const settings = store.getSecuritySettings();
        if (settings.notifyOnAuthFailed) {
          sendSecurityAlert(
            'auth_failed',
            '【安全告警】消息接口多次鉴权失败触发 IP 封禁',
            `接口: POST /message\n来源 IP: ${ip}\n连续失败次数: ${failResult.count}\n封禁时长: ${Math.round(failResult.lockDurationMs / 60000)} 分钟\n凭据脱敏: ${token ? maskSecretKey(token) : '未提供'}`,
            ip
          );
        }
      }
      return reply.unauthorized('invalid or unbound Gotify token');
    }
    store.clearLoginFailures(ip);
    (request as any).audit = {
      authType: 'gotify',
      credentialName: credential.name,
      maskedSecret: maskSecretKey(token!),
      upstreams: credential.upstreams.map(u => u.name)
    };

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

    const targetPhone = payload.to || (body as any)?.phone || (body as any)?.to || (request.query as any)?.phone || (request.query as any)?.to;
    const msgContent = payload.content || body.message;
    const secSettings = store.getSecuritySettings();
    const rlCheck = await rateLimiter.check(
      { phone: targetPhone, ip: request.ip, content: msgContent, credentialId: credential.id },
      secSettings
    );
    if (!rlCheck.allowed) {
      if (file) await unlink(file.path).catch(() => undefined);
      if (rlCheck.retryAfterSeconds) reply.header('Retry-After', String(rlCheck.retryAfterSeconds));
      (request as any).audit.error = rlCheck.reason;
      if (secSettings.notifyOnRateLimit) {
        sendSecurityAlert(
          'rate_limit',
          '【风控拦截】防消息轰炸/频率超限拦截',
          `来源 IP: ${request.ip}\n目标手机号: ${targetPhone || '未指定'}\n凭据名称: ${credential.name}\n拦截说明: ${rlCheck.reason}`,
          request.ip
        );
      }
      return reply.code(429).send({ error: rlCheck.reason, retryAfter: rlCheck.retryAfterSeconds });
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
    await rateLimiter.recordSuccess(targetPhone, msgContent, secSettings);
    return reply.send(gotifyResponse(body, success[0].messageId));
  });

  app.post<{ Body: NativeSendRequest }>('/webhook', async (request, reply) => {
    const ip = request.ip;
    const allowed = store.loginAllowed(ip);
    if (!allowed.allowed) {
      return reply.code(429).header('Retry-After', String(allowed.retryAfter)).send({
        error: 'IP is temporarily blocked due to too many failed attempts',
        retryAfter: allowed.retryAfter
      });
    }

    const authorization = request.headers.authorization;
    const secret = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    const credential = secret ? store.findCredential('webhook', secret) : undefined;
    if (!credential || credential.upstreams.length === 0) {
      const failResult = store.recordLoginFailure(ip);
      (request as any).audit = { authType: 'invalid_webhook_secret', maskedSecret: secret ? maskSecretKey(secret) : undefined };
      if (failResult.locked) {
        const settings = store.getSecuritySettings();
        if (settings.notifyOnAuthFailed) {
          sendSecurityAlert(
            'auth_failed',
            '【安全告警】消息接口多次鉴权失败触发 IP 封禁',
            `接口: POST /webhook\n来源 IP: ${ip}\n连续失败次数: ${failResult.count}\n封禁时长: ${Math.round(failResult.lockDurationMs / 60000)} 分钟\n凭据脱敏: ${secret ? maskSecretKey(secret) : '未提供'}`,
            ip
          );
        }
      }
      return reply.unauthorized('invalid or unbound webhook secret');
    }
    store.clearLoginFailures(ip);
    (request as any).audit = {
      authType: 'webhook',
      credentialName: credential.name,
      maskedSecret: maskSecretKey(secret),
      upstreams: credential.upstreams.map(u => u.name)
    };

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

    const rawBody = request.body as any;
    const targetPhone = payload.to || rawBody?.to || rawBody?.phone || (request.query as any)?.phone || (request.query as any)?.to;
    const msgContent = payload.content;
    const secSettings = store.getSecuritySettings();
    const rlCheck = await rateLimiter.check(
      { phone: targetPhone, ip: request.ip, content: msgContent, credentialId: credential.id },
      secSettings
    );
    if (!rlCheck.allowed) {
      if (file) await unlink(file.path).catch(() => undefined);
      if (rlCheck.retryAfterSeconds) reply.header('Retry-After', String(rlCheck.retryAfterSeconds));
      (request as any).audit.error = rlCheck.reason;
      if (secSettings.notifyOnRateLimit) {
        sendSecurityAlert(
          'rate_limit',
          '【风控拦截】防消息轰炸/频率超限拦截',
          `来源 IP: ${request.ip}\n目标手机号: ${targetPhone || '未指定'}\n凭据名称: ${credential.name}\n拦截说明: ${rlCheck.reason}`,
          request.ip
        );
      }
      return reply.code(429).send({ error: rlCheck.reason, retryAfter: rlCheck.retryAfterSeconds });
    }

    let results: Awaited<ReturnType<typeof dispatch>>;
    try {
      results = await handleDispatchWithMedia('webhook', { credentialId: credential.id, upstreams: credential.upstreams }, payload, null, file);
    } catch (error) {
      if (file) await unlink(file.path).catch(() => undefined);
      return reply.badRequest(error instanceof Error ? error.message : 'failed to process media');
    }

    if (results.some(item => !item.ok)) return reply.code(502).send({ ok: false, results });
    await rateLimiter.recordSuccess(targetPhone, msgContent, secSettings);
    return reply.send({ ok: true, messageIds: results.flatMap(item => item.messageIds), results });
  });

  app.post<{ Body: { username?: string; password?: string } }>('/admin/api/login', async (request, reply) => {
    const ip = request.ip;
    const allowed = store.loginAllowed(ip);
    if (!allowed.allowed) return reply.code(429).header('Retry-After', String(allowed.retryAfter)).send({ error: 'too many login failures', retryAfter: allowed.retryAfter });
    const body = request.body ?? {};
    if (!safeEqual(body.username ?? '', config.adminUsername) || !safeEqual(body.password ?? '', config.adminPassword)) {
      const failResult = store.recordLoginFailure(ip);
      (request as any).audit = { authType: 'login_failed', credentialName: body.username || 'unknown' };
      const settings = store.getSecuritySettings();
      if (settings.notifyOnLoginFailed) {
        if (failResult.locked) {
          sendSecurityAlert(
            'login_failed',
            '【安全告警】管理员多次登录失败触发封禁',
            `来源 IP: ${ip}\n尝试用户名: ${body.username || 'unknown'}\n连续失败次数: ${failResult.count}\n封禁时长: ${Math.round(failResult.lockDurationMs / 60000)} 分钟`,
            ip
          );
        } else if (failResult.count === settings.notifyLoginFailThreshold) {
          sendSecurityAlert(
            'login_failed',
            '【安全告警】管理员登录连续失败告警',
            `来源 IP: ${ip}\n尝试用户名: ${body.username || 'unknown'}\n连续失败次数已达阈值: ${failResult.count} 次\n请注意排查是否存在未授权尝试`,
            ip
          );
        }
      }
      return reply.unauthorized('invalid username or password');
    }
    store.clearLoginFailures(ip);
    (request as any).audit = { authType: 'login_success', credentialName: config.adminUsername };
    sendSecurityAlert(
      'login',
      '【安全提示】管理员登录成功',
      `管理员账户: ${config.adminUsername}\n登录 IP: ${ip}\n登录时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      ip
    );
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
    const sec = store.getSecuritySettings();
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
      uploadTimeoutMs: config.uploadTimeoutMs,
      accessLogFormat: sec.accessLogFormat,
      accessLogRetentionDays: sec.accessLogRetentionDays,
      notifyOnLogin: sec.notifyOnLogin,
      notifyOnLoginFailed: sec.notifyOnLoginFailed,
      notifyOnAuthFailed: sec.notifyOnAuthFailed,
      notifyUpstreamId: sec.notifyUpstreamId,
      notifyLoginFailThreshold: sec.notifyLoginFailThreshold,
      notifyAuthFailThreshold: sec.notifyAuthFailThreshold,
      notifyAuthFailWindowMin: sec.notifyAuthFailWindowMin,
      rateLimitPhoneMinIntervalSec: sec.rateLimitPhoneMinIntervalSec,
      rateLimitPhoneHourMax: sec.rateLimitPhoneHourMax,
      rateLimitPhoneDayMax: sec.rateLimitPhoneDayMax,
      rateLimitIpMinMax: sec.rateLimitIpMinMax,
      rateLimitDuplicateWindowSec: sec.rateLimitDuplicateWindowSec,
      notifyOnRateLimit: sec.notifyOnRateLimit
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
      accessLogFormat?: 'text' | 'json';
      accessLogRetentionDays?: number;
      notifyOnLogin?: boolean;
      notifyOnLoginFailed?: boolean;
      notifyOnAuthFailed?: boolean;
      notifyUpstreamId?: number;
      notifyLoginFailThreshold?: number;
      notifyAuthFailThreshold?: number;
      notifyAuthFailWindowMin?: number;
      rateLimitPhoneMinIntervalSec?: number;
      rateLimitPhoneHourMax?: number;
      rateLimitPhoneDayMax?: number;
      rateLimitIpMinMax?: number;
      rateLimitDuplicateWindowSec?: number;
      notifyOnRateLimit?: boolean;
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
    if (body.accessLogFormat !== undefined) {
      if (body.accessLogFormat !== 'text' && body.accessLogFormat !== 'json') {
        return reply.badRequest('accessLogFormat must be text or json');
      }
    }
    if (body.accessLogRetentionDays !== undefined) {
      if (!Number.isInteger(body.accessLogRetentionDays) || body.accessLogRetentionDays < 1) {
        return reply.badRequest('accessLogRetentionDays must be a positive integer');
      }
    }
    if (body.notifyOnLogin !== undefined && typeof body.notifyOnLogin !== 'boolean') {
      return reply.badRequest('notifyOnLogin must be boolean');
    }
    if (body.notifyOnLoginFailed !== undefined && typeof body.notifyOnLoginFailed !== 'boolean') {
      return reply.badRequest('notifyOnLoginFailed must be boolean');
    }
    if (body.notifyOnAuthFailed !== undefined && typeof body.notifyOnAuthFailed !== 'boolean') {
      return reply.badRequest('notifyOnAuthFailed must be boolean');
    }
    if (body.notifyUpstreamId !== undefined) {
      if (!Number.isInteger(body.notifyUpstreamId) || body.notifyUpstreamId < 0) {
        return reply.badRequest('notifyUpstreamId must be an integer >= 0');
      }
      if (body.notifyUpstreamId > 0 && !store.getUpstream(body.notifyUpstreamId)) {
        return reply.badRequest('selected upstream does not exist');
      }
    }
    if (body.notifyLoginFailThreshold !== undefined) {
      if (!Number.isInteger(body.notifyLoginFailThreshold) || body.notifyLoginFailThreshold < 1) {
        return reply.badRequest('notifyLoginFailThreshold must be a positive integer');
      }
    }
    if (body.notifyAuthFailThreshold !== undefined) {
      if (!Number.isInteger(body.notifyAuthFailThreshold) || body.notifyAuthFailThreshold < 1) {
        return reply.badRequest('notifyAuthFailThreshold must be a positive integer');
      }
    }
    if (body.notifyAuthFailWindowMin !== undefined) {
      if (!Number.isInteger(body.notifyAuthFailWindowMin) || body.notifyAuthFailWindowMin < 1) {
        return reply.badRequest('notifyAuthFailWindowMin must be a positive integer');
      }
    }
    if (body.rateLimitPhoneMinIntervalSec !== undefined) {
      if (!Number.isInteger(body.rateLimitPhoneMinIntervalSec) || body.rateLimitPhoneMinIntervalSec < 0) {
        return reply.badRequest('rateLimitPhoneMinIntervalSec must be an integer >= 0');
      }
    }
    if (body.rateLimitPhoneHourMax !== undefined) {
      if (!Number.isInteger(body.rateLimitPhoneHourMax) || body.rateLimitPhoneHourMax < 0) {
        return reply.badRequest('rateLimitPhoneHourMax must be an integer >= 0');
      }
    }
    if (body.rateLimitPhoneDayMax !== undefined) {
      if (!Number.isInteger(body.rateLimitPhoneDayMax) || body.rateLimitPhoneDayMax < 0) {
        return reply.badRequest('rateLimitPhoneDayMax must be an integer >= 0');
      }
    }
    if (body.rateLimitIpMinMax !== undefined) {
      if (!Number.isInteger(body.rateLimitIpMinMax) || body.rateLimitIpMinMax < 0) {
        return reply.badRequest('rateLimitIpMinMax must be an integer >= 0');
      }
    }
    if (body.rateLimitDuplicateWindowSec !== undefined) {
      if (!Number.isInteger(body.rateLimitDuplicateWindowSec) || body.rateLimitDuplicateWindowSec < 0) {
        return reply.badRequest('rateLimitDuplicateWindowSec must be an integer >= 0');
      }
    }
    if (body.notifyOnRateLimit !== undefined && typeof body.notifyOnRateLimit !== 'boolean') {
      return reply.badRequest('notifyOnRateLimit must be boolean');
    }

    const envUpdates: Record<string, string | number | boolean> = {};

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
    if (body.accessLogFormat !== undefined) {
      envUpdates.ACCESS_LOG_FORMAT = body.accessLogFormat;
    }
    if (body.accessLogRetentionDays !== undefined) {
      envUpdates.ACCESS_LOG_RETENTION_DAYS = body.accessLogRetentionDays;
    }
    if (body.notifyOnLogin !== undefined) {
      envUpdates.NOTIFY_ON_LOGIN = body.notifyOnLogin;
    }
    if (body.notifyOnLoginFailed !== undefined) {
      envUpdates.NOTIFY_ON_LOGIN_FAILED = body.notifyOnLoginFailed;
    }
    if (body.notifyOnAuthFailed !== undefined) {
      envUpdates.NOTIFY_ON_AUTH_FAILED = body.notifyOnAuthFailed;
    }
    if (body.notifyUpstreamId !== undefined) {
      envUpdates.NOTIFY_UPSTREAM_ID = body.notifyUpstreamId;
    }
    if (body.notifyLoginFailThreshold !== undefined) {
      envUpdates.NOTIFY_LOGIN_FAIL_THRESHOLD = body.notifyLoginFailThreshold;
    }
    if (body.notifyAuthFailThreshold !== undefined) {
      envUpdates.NOTIFY_AUTH_FAIL_THRESHOLD = body.notifyAuthFailThreshold;
    }
    if (body.notifyAuthFailWindowMin !== undefined) {
      envUpdates.NOTIFY_AUTH_FAIL_WINDOW_MIN = body.notifyAuthFailWindowMin;
    }
    if (body.rateLimitPhoneMinIntervalSec !== undefined) {
      envUpdates.RATE_LIMIT_PHONE_MIN_INTERVAL_SEC = body.rateLimitPhoneMinIntervalSec;
    }
    if (body.rateLimitPhoneHourMax !== undefined) {
      envUpdates.RATE_LIMIT_PHONE_HOUR_MAX = body.rateLimitPhoneHourMax;
    }
    if (body.rateLimitPhoneDayMax !== undefined) {
      envUpdates.RATE_LIMIT_PHONE_DAY_MAX = body.rateLimitPhoneDayMax;
    }
    if (body.rateLimitIpMinMax !== undefined) {
      envUpdates.RATE_LIMIT_IP_MIN_MAX = body.rateLimitIpMinMax;
    }
    if (body.rateLimitDuplicateWindowSec !== undefined) {
      envUpdates.RATE_LIMIT_DUPLICATE_WINDOW_SEC = body.rateLimitDuplicateWindowSec;
    }
    if (body.notifyOnRateLimit !== undefined) {
      envUpdates.NOTIFY_ON_RATE_LIMIT = body.notifyOnRateLimit;
    }

    store.updateBruteForceOptions({
      loginFailLimit: config.adminLoginFailLimit,
      loginFailWindowMs: config.adminLoginFailWindowMs,
      loginBanDurationMs: config.adminLoginBanDurationMs
    });

    store.updateSecuritySettings({
      accessLogFormat: body.accessLogFormat,
      accessLogRetentionDays: body.accessLogRetentionDays,
      notifyOnLogin: body.notifyOnLogin,
      notifyOnLoginFailed: body.notifyOnLoginFailed,
      notifyOnAuthFailed: body.notifyOnAuthFailed,
      notifyUpstreamId: body.notifyUpstreamId,
      notifyLoginFailThreshold: body.notifyLoginFailThreshold,
      notifyAuthFailThreshold: body.notifyAuthFailThreshold,
      notifyAuthFailWindowMin: body.notifyAuthFailWindowMin,
      rateLimitPhoneMinIntervalSec: body.rateLimitPhoneMinIntervalSec,
      rateLimitPhoneHourMax: body.rateLimitPhoneHourMax,
      rateLimitPhoneDayMax: body.rateLimitPhoneDayMax,
      rateLimitIpMinMax: body.rateLimitIpMinMax,
      rateLimitDuplicateWindowSec: body.rateLimitDuplicateWindowSec,
      notifyOnRateLimit: body.notifyOnRateLimit
    });
    if (body.accessLogFormat !== undefined) {
      accessLogger.setFormat(body.accessLogFormat);
    }
    if (body.accessLogRetentionDays !== undefined) {
      accessLogger.startCleanupTimer(body.accessLogRetentionDays);
    }

    updateEnvFile(envUpdates);

    return { ok: true };
  });

  app.get('/admin/api/logs/dates', { preHandler: requireAdmin }, async () => {
    return { dates: accessLogger.listLogDates() };
  });

  app.get<{ Querystring: { date?: string; page?: string; pageSize?: string; limit?: string } }>(
    '/admin/api/logs',
    { preHandler: requireAdmin },
    async request => {
      const date = request.query.date?.trim() || accessLogger.getTodayDate();
      const page = Math.max(1, Number(request.query.page) || 1);
      const pageSize = Math.max(1, Math.min(Number(request.query.pageSize) || (request.query.limit ? Number(request.query.limit) : 50), 500));
      return accessLogger.readLogsByDate(date, page, pageSize);
    }
  );

  app.get('/admin/api/risks/summary', { preHandler: requireAdmin }, async () => {
    return store.getSecurityRiskSummary();
  });

  app.get('/admin/api/risks/bans', { preHandler: requireAdmin }, async () => {
    return { items: store.listLockedIps() };
  });

  app.delete<{ Params: { ip: string } }>('/admin/api/risks/bans/:ip', { preHandler: requireAdmin }, async (request, reply) => {
    const ip = request.params.ip?.trim();
    if (!ip) return reply.badRequest('IP is required');
    const unbanned = store.unbanIp(ip);
    return { ok: true, unbanned };
  });

  app.get<{ Querystring: { page?: string; pageSize?: string } }>('/admin/api/risks/alerts', { preHandler: requireAdmin }, async request => {
    const page = Math.max(1, Number(request.query.page) || 1);
    const pageSize = Math.max(1, Math.min(Number(request.query.pageSize) || 20, 100));
    return store.listSecurityAlerts(page, pageSize);
  });

  app.get<{ Querystring: { date?: string; page?: string; pageSize?: string } }>('/admin/api/risks/dangerous-logs', { preHandler: requireAdmin }, async request => {
    const date = request.query.date?.trim() || accessLogger.getTodayDate();
    const page = Math.max(1, Number(request.query.page) || 1);
    const pageSize = Math.max(1, Math.min(Number(request.query.pageSize) || 20, 100));
    return accessLogger.readDangerousLogs(date, page, pageSize);
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

  app.get<{ Querystring: { limit?: string; page?: string; pageSize?: string } }>('/admin/api/history', { preHandler: requireAdmin }, async request => {
    if (request.query.page !== undefined || request.query.pageSize !== undefined) {
      const page = Math.max(1, Number(request.query.page) || 1);
      const pageSize = Math.max(1, Math.min(Number(request.query.pageSize) || 20, 100));
      return store.listHistoryPaged(page, pageSize);
    }
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
